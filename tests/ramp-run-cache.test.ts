import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
import { prepareRampExport } from "../src/server/hyperframes/rampExport";
import { createMediaService } from "../src/server/media/service";
import { createReviewService } from "../src/server/projects/review";
import { createProjectStore } from "../src/server/projects/store";
import { placedMedia } from "../src/shared/timeline/placedMedia";
import {
  documentRampRuns,
  runBuildFrames,
} from "../src/shared/timeline/rampRuns";

const RAMP = JSON.stringify({
  version: 1,
  lanes: [
    {
      target: "rate",
      points: [
        { t: 0, v: 0.5 },
        { t: 4, v: 2 },
      ],
    },
  ],
});
/** A 2 s ramp clip; each in-point is a different run. */
const clip = (mediaStart: number, attributes = "") =>
  `<audio id="snd" src="tone.wav" data-start="0" data-duration="2" data-media-start="${mediaStart}" data-track-index="0" data-automation='${RAMP}'${attributes}></audio>`;
const page = (body: string) =>
  `<!doctype html><html><body><main data-composition-id="main" data-fps="30" data-width="160" data-height="120" data-duration="2">${body}</main></body></html>`;
const runOf = (mediaStart: number) =>
  documentRampRuns(placedMedia(page(clip(mediaStart)))).get("audio:snd")!;
/** A run file for one 2 s clip. */
const RUN_BYTES = 44 + runBuildFrames(2 * 48_000) * 4;
const tools = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

async function tone(path: string, seconds = 20) {
  const child = Bun.spawn(
    [
      ...["ffmpeg", "-v", "error", "-f", "lavfi", "-i"],
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      ...["-ac", "2", "-c:a", "pcm_s16le", "-y", path],
    ],
    { stderr: "pipe" },
  );
  if ((await child.exited) !== 0)
    throw new Error(await new Response(child.stderr).text());
}

const project = (path: string) => ({
  id: "project",
  name: "Project",
  path,
  createdAt: "",
  updatedAt: "",
});

const runFiles = async (dir: string) =>
  (await readdir(join(dir, ".cutroom/cache/ramp-runs")).catch(() => []))
    .filter((name) => name.endsWith(".wav"))
    .sort();

test.skipIf(!tools)(
  "a linked run folder is refused: nothing is written or removed outside the project",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ramp-run-link-"));
    const dir = join(root, "project");
    const outside = join(root, "outside");
    const media = createMediaService({ rampRunBytes: 1 });
    try {
      await mkdir(join(dir, ".cutroom/cache"), { recursive: true });
      await mkdir(outside);
      await writeFile(join(outside, "precious.wav"), "keep me");
      await tone(join(dir, "tone.wav"), 4);
      const { run, frames } = runOf(0);
      for (const target of [outside, join(dir, "elsewhere")]) {
        await mkdir(target, { recursive: true });
        await rm(join(dir, ".cutroom/cache/ramp-runs"), {
          recursive: true,
          force: true,
        });
        await symlink(target, join(dir, ".cutroom/cache/ramp-runs"));
        await expect(
          media.rampRun(project(dir), "tone.wav", run, frames),
        ).rejects.toMatchObject({ status: 403 });
        // A run file reached through the link is not served either.
        const name = `${"0".repeat(64)}.wav`;
        await writeFile(join(target, name), "");
        await expect(
          media.rampRunFile(project(dir), "0".repeat(64)),
        ).rejects.toMatchObject({ status: 403 });
        await rm(join(target, name));
      }
      expect(await readdir(outside)).toEqual(["precious.wav"]);
      expect(await readFile(join(outside, "precious.wav"), "utf8")).toBe(
        "keep me",
      );
      expect(await readdir(join(dir, "elsewhere"))).toEqual([]);
    } finally {
      await media.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!tools)(
  "a run made while its folder is swapped for a link is not moved through the link",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ramp-run-swap-"));
    const dir = join(root, "project");
    const outside = join(root, "outside");
    let swap = async () => {};
    const media = createMediaService({
      // Called as the job removes its scratch folder, after the stretch and before the move.
      removeDirectory: async (path) => {
        await swap();
        await rm(path, { recursive: true, force: true });
      },
    });
    try {
      await mkdir(dir, { recursive: true });
      await mkdir(outside);
      await tone(join(dir, "tone.wav"), 4);
      const { run, frames } = runOf(0);
      swap = async () => {
        swap = async () => {};
        await rm(join(dir, ".cutroom/cache/ramp-runs"), {
          recursive: true,
          force: true,
        });
        await symlink(outside, join(dir, ".cutroom/cache/ramp-runs"));
      };
      const result = await media.rampRun(project(dir), "tone.wav", run, frames);
      expect(await result.pending).toBe(false);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await media.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!tools)(
  "a follow-up never loops or crashes: an evicted run is not made again, and a failing ask resolves false",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ramp-run-follow-"));
    let jobs = 0;
    let armed = async () => {};
    const media = createMediaService({
      // Smaller than any run: every unpinned run is evicted as soon as it is made.
      rampRunBytes: 1,
      removeDirectory: async (path) => {
        if (path.includes(".media-")) {
          jobs++;
          await armed();
        }
        await rm(path, { recursive: true, force: true });
      },
    });
    try {
      await tone(join(dir, "tone.wav"), 20);
      const { run } = runOf(0);
      const evicted = await media.rampRun(
        project(dir),
        "tone.wav",
        run,
        2 * 48_000,
      );
      expect(await evicted.pending).toBe(false);
      await Bun.sleep(500);
      expect(jobs).toBe(1);
      expect(await runFiles(dir)).toEqual([]);

      // Two asks join one job; the longer one finds the run too short and asks again, which
      // fails because the source is gone by then. It resolves false; nothing is unhandled.
      armed = async () => {
        armed = async () => {};
        await rm(join(dir, "tone.wav"));
      };
      const short = await media.rampRun(
        project(dir),
        "tone.wav",
        run,
        2 * 48_000,
      );
      const long = await media.rampRun(
        project(dir),
        "tone.wav",
        run,
        12 * 48_000,
      );
      expect(await long.pending).toBe(false);
      expect(await short.pending).toBe(false);
    } finally {
      await media.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!tools)(
  "an export's run does not wait behind the background queue",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ramp-run-foreground-"));
    const media = createMediaService();
    try {
      await tone(join(dir, "tone.wav"), 400);
      const finished: string[] = [];
      const long = documentRampRuns(
        placedMedia(
          page(
            `<audio id="snd" src="tone.wav" data-start="0" data-duration="300" data-media-start="1" data-track-index="0" data-automation='${RAMP}'></audio>`,
          ),
        ),
      ).get("audio:snd")!;
      const background = await media.rampRun(
        project(dir),
        "tone.wav",
        long.run,
        long.frames,
      );
      const queued = await media.rampRun(
        project(dir),
        "tone.wav",
        runOf(2).run,
        runOf(2).frames,
      );
      const exported = await media.rampRun(
        project(dir),
        "tone.wav",
        runOf(3).run,
        runOf(3).frames,
        undefined,
        true,
      );
      await Promise.all(
        [
          ["background", background],
          ["queued", queued],
          ["export", exported],
        ].map(async ([name, result]) => {
          const { pending } = result as typeof background;
          await pending;
          finished.push(name as string);
        }),
      );
      // The export's run started beside the long background run instead of after it.
      expect(finished[0]).toBe("export");
      expect(finished.at(-1)).toBe("queued");
    } finally {
      await media.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

test("CUTROOM_RAMP_CACHE_MB must be a positive number", () => {
  const before = process.env.CUTROOM_RAMP_CACHE_MB;
  try {
    for (const value of ["-5", "0", "lots"]) {
      process.env.CUTROOM_RAMP_CACHE_MB = value;
      expect(() => createMediaService()).toThrow(
        `CUTROOM_RAMP_CACHE_MB must be a positive number of MiB, not "${value}".`,
      );
    }
    process.env.CUTROOM_RAMP_CACHE_MB = "512";
    expect(() => createMediaService()).not.toThrow();
  } finally {
    if (before === undefined) delete process.env.CUTROOM_RAMP_CACHE_MB;
    else process.env.CUTROOM_RAMP_CACHE_MB = before;
  }
});

test("hidden clips, and clips in a hidden scene, join no family", () => {
  const html = page(
    clip(0, " data-hidden") +
      `<div data-composition-id="s" data-start="0" data-duration="2" data-hidden>${clip(0).replace('id="snd"', 'id="inner"')}</div>` +
      clip(0).replace('id="snd"', 'id="heard"'),
  );
  expect([...documentRampRuns(placedMedia(html)).keys()]).toEqual([
    "audio:heard",
  ]);
});

/**
 * The editor's API over a real media service, with a budget of one and a half runs: a run
 * nothing pins goes as soon as another is made.
 */
async function server() {
  const root = await mkdtemp(join(tmpdir(), "ramp-run-pins-"));
  const projects = await createProjectStore({
    dataDir: root,
    projectsDir: join(root, "projects"),
  });
  const media = createMediaService({ rampRunBytes: 1.5 * RUN_BYTES });
  const app = new Hono();
  app.route(
    "/api",
    createHyperframesApi(projects, createReviewService(projects), media),
  );
  const listening = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  const base = listening.url.origin;
  const created = await projects.create({ name: "Ramp pins" });
  await tone(join(created.path, "tone.wav"));
  const write = (mediaStart: number) =>
    writeFile(join(created.path, "index.html"), page(clip(mediaStart)));
  /** Opens the preview as the editor's iframe does, as document `id`. */
  const open = async (id: string, query = "") => {
    const redirect = await fetch(
      `${base}/api/projects/${created.id}/isolated-preview?document=${id}${query}`,
      { redirect: "manual" },
    );
    const response = await fetch(
      new URL(redirect.headers.get("location")!, base),
      {
        headers: {
          "sec-fetch-dest": "iframe",
          "sec-fetch-site": "same-origin",
        },
      },
    );
    return { response, html: await response.text() };
  };
  /** Waits for the run of the clip at `mediaStart`, joining whatever job makes it. */
  const made = async (mediaStart: number) => {
    const { run, frames } = runOf(mediaStart);
    const result = await media.rampRun(created, "tone.wav", run, frames);
    await result.pending;
    return `${result.key}.wav`;
  };
  return {
    media,
    projects,
    project: created,
    base,
    write,
    open,
    made,
    files: () => runFiles(created.path),
    async close() {
      await listening.stop(true);
      await media.dispose();
      await projects.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(!tools)(
  "pins through the API: the newest preview keeps its run; a replaced, mix-only or superseded document and a cancelled export keep nothing",
  async () => {
    const api = await server();
    const renders = createRenderWorkers({
      scratchDir: join(tmpdir(), `ramp-run-pins-${process.pid}`),
      prepareRampRuns: async (input) =>
        prepareRampExport({
          ...input,
          project: await api.projects.get(input.projectId),
          media: api.media,
        }),
    });
    try {
      // The open preview's run survives a newer unpinned run.
      await api.write(0);
      await api.open("a");
      const a = await api.made(0);
      const loose = await api.made(9);
      expect(await api.files()).toEqual([a]);
      expect(loose).not.toBe(a);

      // A newer document replaces it: its run goes once another is made.
      await api.write(1);
      await api.open("b");
      const b = await api.made(1);
      expect(await api.files()).toEqual([b]);

      // The mix read is not a preview: its run is not kept.
      await api.write(2);
      const mix = await api.open("mix", "&cutroom-mix=1");
      expect(mix.response.ok).toBe(true);
      await api.made(2);
      expect(await api.files()).toEqual([b]);

      // A document superseded before its run is made keeps nothing when the run arrives late.
      await api.write(3);
      await api.open("c");
      await api.write(4);
      await api.open("d");
      const [, d] = await Promise.all([api.made(3), api.made(4)]);
      await api.made(8);
      expect(await api.files()).toEqual([d]);

      // An export cancelled while it waits for its run keeps nothing either.
      await api.write(5);
      const state = renders.start(
        {
          project: { id: api.project.id, dir: api.project.path },
          outputPath: join(api.project.path, "out.mp4"),
          format: "mp4",
          fps: { num: 30, den: 1 },
          quality: "draft",
          jobId: "cancelled",
        },
        {
          filename: "out.mp4",
          directory: api.project.path,
          range: null,
        },
      );
      const deadline = Date.now() + 20_000;
      while (
        !String(state.stage ?? "").startsWith("Preparing ramp audio") &&
        Date.now() < deadline
      )
        await Bun.sleep(5);
      await state.cancel();
      expect(state.status).toBe("cancelled");
      await api.made(5);
      await api.made(7);
      expect(await api.files()).toEqual([d]);
    } finally {
      await renders.cancelAll();
      await api.close();
    }
  },
  120_000,
);

test.skipIf(!tools)(
  "the slice route makes a run cut short on disk again for the document that uses it",
  async () => {
    const api = await server();
    try {
      await api.write(0);
      await api.open("first");
      const key = (await api.made(0)).replace(/\.wav$/, "");
      // The document opened now has the prepared sound.
      const { html } = await api.open("second");
      const src = /src="([^"]*ramp-audio\/[a-f0-9]{64}-\d+-\d+\.wav)"/.exec(
        html,
      )![1]!;
      const file = join(
        api.project.path,
        ".cutroom/cache/ramp-runs",
        `${key}.wav`,
      );
      const whole = await readFile(file);
      await truncate(file, 44);
      const served = await fetch(new URL(src, api.base));
      expect(served.status).toBe(200);
      const [, from, to] = /-(\d+)-(\d+)\.wav$/.exec(src)!.map(Number);
      expect((await served.arrayBuffer()).byteLength).toBe(
        44 + (to! - from!) * 4,
      );
      expect((await readFile(file)).equals(whole)).toBe(true);
    } finally {
      await api.close();
    }
  },
  60_000,
);
