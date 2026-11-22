import { expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createMediaRoutes } from "../src/server/media/routes";
import { createMediaService } from "../src/server/media/service";
import { encodePeaks } from "../src/server/media/peaks";
import { FilmstripSchema } from "../src/server/media/protocol";
import { JobStateSchema } from "../src/shared/jobs";
import { fileFingerprint } from "../src/shared/media";
import { projectFixture } from "./project-fixture";

async function ffmpeg(args: string[]) {
  const child = Bun.spawn(["ffmpeg", "-v", "error", "-nostdin", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const errors = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(errors);
}

async function ready(request: () => Promise<Response> | Response) {
  const deadline = performance.now() + 10000;
  while (true) {
    const response = await request();
    if (response.status !== 202) return response;
    if (performance.now() > deadline)
      throw new Error("The media job did not finish.");
    await Bun.sleep(10);
  }
}

const PendingSchema = z.object({ key: z.string(), job: JobStateSchema });

test("PCM extrema survive chunk boundaries, partial buckets, and every mip", async () => {
  const pcm = Buffer.alloc(97 * 2);
  pcm.writeInt16LE(-32768, 0);
  pcm.writeInt16LE(32767, 190);
  pcm.writeInt16LE(-123, 192);
  const bytes = await encodePeaks(
    new ReadableStream({
      start(controller) {
        controller.enqueue(pcm.subarray(0, 3));
        controller.enqueue(pcm.subarray(3, 159));
        controller.enqueue(pcm.subarray(159));
        controller.close();
      },
    }),
  );
  expect(bytes.toString("ascii", 0, 4)).toBe("CRPK");
  expect(bytes.readUInt32LE(4)).toBe(2);
  expect(bytes.readDoubleLE(16)).toBe(97);
  expect(bytes.readUInt32LE(36)).toBe(2);
  expect(bytes.readInt16LE(bytes.readUInt32LE(40))).toBe(-32768);
  expect(bytes.readInt16LE(bytes.readUInt32LE(40) + 2)).toBe(32767);
  expect(bytes.readInt16LE(bytes.readUInt32LE(40) + 4)).toBe(-123);
  expect(bytes.readInt16LE(bytes.readUInt32LE(40) + 6)).toBe(-123);
  for (let level = 1; level < bytes.readUInt32LE(8); level++) {
    const entry = 32 + 16 * level;
    expect(bytes.readUInt32LE(entry)).toBe(96 * 4 ** level);
    expect(bytes.readUInt32LE(entry + 4)).toBe(1);
    const offset = bytes.readUInt32LE(entry + 8);
    expect(bytes.readInt16LE(offset)).toBe(-32768);
    expect(bytes.readInt16LE(offset + 2)).toBe(32767);
  }
});

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "media routes generate real peaks and filmstrips, revalidate edits, and reuse disk cache after restart",
  async () => {
    const fixture = await projectFixture();
    const routes = createMediaRoutes(fixture.store);
    fixture.app.route("/api/cutroom", routes);
    let restarted: ReturnType<typeof createMediaService> | undefined;
    try {
      const project = await fixture.store.create({ name: "Media cache" });
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=10:duration=4.1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=8000:duration=4.1",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-threads",
        "1",
        "-c:a",
        "pcm_s16le",
        join(project.path, "sample.mkv"),
      ]);
      const base = `/projects/${project.id}/media`;
      const peaksUrl = `${base}/peaks?path=sample.mkv`;
      const first = await fixture.request(peaksUrl);
      expect(first.status).toBe(202);
      expect(first.headers.get("cache-control")).toBe("no-store");
      const pending = PendingSchema.parse(await first.json());
      const duplicate = await fixture.request(peaksUrl);
      expect(PendingSchema.parse(await duplicate.json()).key).toBe(pending.key);
      const peaks = await ready(() => fixture.request(peaksUrl));
      expect(peaks.status).toBe(200);
      expect(peaks.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(peaks.headers.get("cache-control")).toBe(
        "private, max-age=0, must-revalidate",
      );
      const bytes = Buffer.from(await peaks.arrayBuffer());
      expect(bytes.toString("ascii", 0, 4)).toBe("CRPK");
      expect(bytes.readUInt32LE(36)).toBe(2050);
      expect(bytes.length).toBeLessThan(12000);
      const etag = peaks.headers.get("etag")!;
      expect(
        (
          await fixture.app.request(`/api/cutroom${peaksUrl}`, {
            headers: { "if-none-match": etag },
          })
        ).status,
      ).toBe(304);
      const filmstrip = await ready(() =>
        fixture.request(`${base}/filmstrip?path=sample.mkv`),
      );
      expect(filmstrip.status).toBe(200);
      const metadata = FilmstripSchema.extend({
        key: z.string(),
        sheets: z.array(
          FilmstripSchema.shape.sheets.element.extend({
            spriteUrl: z.string(),
          }),
        ),
      }).parse(await filmstrip.json());
      expect(metadata.count).toBe(3);
      expect(metadata.sheets[0]!.columns).toBe(3);
      expect(metadata.sheets[0]!.rows).toBe(1);
      const sprite = await fixture.app.request(metadata.sheets[0]!.spriteUrl);
      expect(sprite.status).toBe(200);
      expect(sprite.headers.get("cache-control")).toContain("immutable");
      const image = Buffer.from(await sprite.arrayBuffer());
      expect([...image.subarray(0, 2)]).toEqual([255, 216]);
      await routes.dispose();
      restarted = createMediaService({
        workerUrl: new URL("file:///missing-worker.ts"),
      });
      const warm = await restarted.request(project, "sample.mkv", "peaks");
      expect(warm.state.status).toBe("done");
      expect(warm.artifact && (await readFile(warm.artifact))).toEqual(bytes);
      const warmStrip = await restarted.request(
        project,
        "sample.mkv",
        "filmstrip",
      );
      expect(warmStrip.metadata?.count).toBe(3);
      await utimes(
        join(project.path, "sample.mkv"),
        new Date(),
        new Date(Date.now() + 1000),
      );
      const changed = await restarted.request(project, "sample.mkv", "peaks");
      expect(changed.key).not.toBe(pending.key);
      expect(changed.state.status).toBe("running");
    } finally {
      await restarted?.dispose();
      await routes.dispose();
      await fixture.close();
    }
  },
  15000,
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "outside paths, linked caches, and playlist indirection cannot escape the project",
  async () => {
    const fixture = await projectFixture();
    const media = createMediaService();
    try {
      const project = await fixture.store.create({ name: "Media boundaries" });
      await writeFile(join(fixture.directory, "outside.wav"), "private");
      await symlink(
        join(fixture.directory, "outside.wav"),
        join(project.path, "link.wav"),
      );
      await expect(
        media.request(project, "../../outside.wav", "peaks"),
      ).rejects.toThrow("outside the project");
      await expect(media.request(project, "link.wav", "peaks")).rejects.toThrow(
        "Links outside",
      );
      await expect(
        media.request(project, "/etc/passwd", "peaks"),
      ).rejects.toThrow("project-relative");
      await writeFile(
        join(project.path, "list.m3u8"),
        "#EXTM3U\n#EXTINF:1,\n" + join(fixture.directory, "outside.wav"),
      );
      await media.request(project, "list.m3u8", "peaks");
      let result = await media.request(project, "list.m3u8", "peaks");
      const deadline = performance.now() + 5000;
      while (result.state.status === "running") {
        if (performance.now() > deadline)
          throw new Error("The playlist job did not fail.");
        await Bun.sleep(10);
        result = await media.request(project, "list.m3u8", "peaks");
      }
      expect(result.state.status).toBe("failed");
      expect(
        (await readdir(join(project.path, ".cutroom/cache"))).filter((name) =>
          name.startsWith(".media-"),
        ),
      ).toEqual([]);
      const other = await fixture.store.create({ name: "Linked cache" });
      await writeFile(join(other.path, "sample.wav"), "invalid media");
      await symlink(fixture.directory, join(other.path, ".cutroom"));
      await expect(media.request(other, "sample.wav", "peaks")).rejects.toThrow(
        "Links outside",
      );
    } finally {
      await media.dispose();
      await fixture.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "media work shares a key, runs two workers, and cancels queued and running jobs before shutdown returns",
  async () => {
    const fixture = await projectFixture();
    const workerPath = join(fixture.directory, "controlled-worker.ts");
    const eventsPath = join(fixture.directory, "events.jsonl");
    await writeFile(
      workerPath,
      `
import { appendFile } from "node:fs/promises";
import {join} from "node:path";
const data = await Bun.stdin.json();
if(data.kind === "probe") {
 await Bun.write(join(data.directory,"probe.json"),JSON.stringify({channels:1}));
 console.log(JSON.stringify({type:"done"}));
} else {
 let cancelled=false;
 process.on("SIGTERM",()=>{cancelled=true;});
 await appendFile(${JSON.stringify(eventsPath)}, JSON.stringify({type:"start",source:data.source})+"\\n");
 while (!cancelled) await Bun.sleep(5);
 await appendFile(${JSON.stringify(eventsPath)}, JSON.stringify({type:"stop",source:data.source})+"\\n");
 console.log(JSON.stringify({type:"error",error:"cancelled"}));
}`,
    );
    const media = createMediaService({
      workerUrl: new URL(`file://${workerPath}`),
    });
    try {
      const project = await fixture.store.create({ name: "Media queue" });
      for (const name of ["one.wav", "two.wav", "three.wav"])
        await writeFile(join(project.path, name), "fixture");
      for (const name of ["one.wav", "two.wav", "three.wav"]) {
        let probe = await media.request(project, name, "probe");
        while (!probe.artifact) {
          await Bun.sleep(5);
          probe = await media.request(project, name, "probe");
        }
      }
      const [one, duplicate] = await Promise.all([
        media.request(project, "one.wav", "peaks"),
        media.request(project, "one.wav", "peaks"),
      ]);
      expect(one.key).toBe(duplicate.key);
      expect(one.state.status).toBe("running");
      await media.request(project, "two.wav", "peaks");
      const queued = await media.request(project, "three.wav", "peaks");
      expect(queued.state.status).toBe("queued");
      const deadline = performance.now() + 3000;
      while (true) {
        const events = await readFile(eventsPath, "utf8").catch(() => "");
        if (events.trim().split("\n").length === 2) break;
        if (performance.now() > deadline)
          throw new Error("Workers never started.");
        await Bun.sleep(5);
      }
      await media.dispose();
      const events = z
        .array(z.object({ type: z.string(), source: z.string() }))
        .parse(
          (await readFile(eventsPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
      expect(events.filter((event) => event.type === "start")).toHaveLength(2);
      expect(events.filter((event) => event.type === "stop")).toHaveLength(2);
      expect(events.some((event) => event.source.endsWith("three.wav"))).toBe(
        false,
      );
      expect(
        (await readdir(join(project.path, ".cutroom/cache"))).filter((name) =>
          name.startsWith(".media-"),
        ),
      ).toEqual([]);
      await expect(media.request(project, "one.wav", "peaks")).rejects.toThrow(
        "shutting down",
      );
    } finally {
      await media.dispose();
      await fixture.close();
    }
  },
  5000,
);

test.skipIf(!Bun.which("ffmpeg"))(
  "filmstrip count follows decoded video when audio is longer, and audio-only filmstrips fail without leaving cache files",
  async () => {
    const fixture = await projectFixture();
    const media = createMediaService();
    try {
      const project = await fixture.store.create({ name: "Unequal streams" });
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=red:size=160x90:rate=10:duration=0.1",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=4.1",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-c:a",
        "pcm_s16le",
        join(project.path, "long-audio.mkv"),
      ]);
      let result = await media.request(project, "long-audio.mkv", "filmstrip");
      const deadline = performance.now() + 5000;
      while (!result.artifact && result.state.status !== "failed") {
        if (performance.now() > deadline)
          throw new Error("The filmstrip did not finish.");
        await Bun.sleep(10);
        result = await media.request(project, "long-audio.mkv", "filmstrip");
      }
      expect(result.state.status).toBe("done");
      expect(result.metadata?.count).toBe(1);
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "sine=duration=0.2",
        join(project.path, "audio.wav"),
      ]);
      let probe = await media.request(project, "audio.wav", "probe");
      while (!probe.artifact) {
        if (performance.now() > deadline)
          throw new Error("The audio probe did not finish.");
        await Bun.sleep(10);
        probe = await media.request(project, "audio.wav", "probe");
      }
      await expect(
        media.request(project, "audio.wav", "filmstrip"),
      ).rejects.toThrow("no video stream");
      expect(
        (await readdir(join(project.path, ".cutroom/cache"))).filter((name) =>
          name.startsWith(".media-"),
        ),
      ).toEqual([]);
    } finally {
      await media.dispose();
      await fixture.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "waveform extrema retain audible high frequencies before bucket reduction",
  async () => {
    const fixture = await projectFixture();
    const media = createMediaService();
    try {
      const project = await fixture.store.create({
        name: "High-frequency waveform",
      });
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=6000:sample_rate=48000:duration=0.1",
        join(project.path, "tone.wav"),
      ]);
      let result = await media.request(project, "tone.wav", "peaks");
      const deadline = performance.now() + 5000;
      while (!result.artifact && result.state.status !== "failed") {
        if (performance.now() > deadline)
          throw new Error("The peaks did not finish.");
        await Bun.sleep(10);
        result = await media.request(project, "tone.wav", "peaks");
      }
      expect(result.state.status).toBe("done");
      const bytes = await readFile(result.artifact!);
      // The input sine has a known 1/8 full-scale amplitude, including at 6 kHz.
      expect(bytes.readInt16LE(bytes.readUInt32LE(40))).toBeLessThan(-4000);
      expect(bytes.readInt16LE(bytes.readUInt32LE(40) + 2)).toBeGreaterThan(
        4000,
      );
    } finally {
      await media.dispose();
      await fixture.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "repeated file versions change every derived key and bound persisted artifacts after restart",
  async () => {
    const fixture = await projectFixture();
    let media = createMediaService({ maxCacheEntries: 4 });
    try {
      const project = await fixture.store.create({ name: "Replacement cache" });
      const path = join(project.path, "card.mkv");
      const keys = new Map<string, string>();
      for (const color of ["red", "blue", "green"]) {
        await ffmpeg([
          "-f",
          "lavfi",
          "-i",
          `color=${color}:size=160x90:rate=10:duration=0.2`,
          "-f",
          "lavfi",
          "-i",
          "sine=duration=0.2",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-c:a",
          "pcm_s16le",
          "-y",
          path,
        ]);
        // A new process must also prune older versions already on disk.
        await media.dispose();
        media = createMediaService({ maxCacheEntries: 4 });
        for (const kind of ["probe", "peaks", "filmstrip", "frame"] as const) {
          const deadline = Date.now() + 5000;
          let result = await media.request(project, "card.mkv", kind);
          while (!result.artifact) {
            if (result.state.status === "failed" || Date.now() > deadline)
              throw new Error(`Could not prepare ${kind}`);
            await Bun.sleep(10);
            result = await media.request(project, "card.mkv", kind);
          }
          expect(result.key).not.toBe(keys.get(kind));
          keys.set(kind, result.key);
          expect((await media.request(project, "card.mkv", kind)).key).toBe(
            result.key,
          );
        }
        const cache = (
          await readdir(join(project.path, ".cutroom/cache"))
        ).filter((name) => /^[a-f0-9]{64}$/.test(name));
        expect(cache.length).toBeLessThanOrEqual(4);
        expect(cache.sort()).toEqual([...keys.values()].sort());
      }
    } finally {
      await media.dispose();
      await fixture.close();
    }
  },
  15000,
);

/** Eight-bit frame numbers, from `first`, as black and white blocks along the top. */
async function numberedVideo(path: string, first: number) {
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30:duration=2",
    "-f",
    "lavfi",
    "-i",
    "nullsrc=size=8x1:rate=30:duration=2",
    "-filter_complex",
    `[1:v]format=gray,geq=lum='255*mod(floor((N+${first})/pow(2\\,X))\\,2)',scale=1280:36:flags=neighbor[bar];[0:v][bar]overlay=0:0,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    "30",
    "-threads",
    "1",
    "-y",
    path,
  ]);
}

/** Reads every frame's number back from its blocks. */
async function frameNumbers(path: string) {
  const child = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      "crop=iw:ih/80:0:ih/80,scale=8:1:flags=area,format=gray",
      "-f",
      "rawvideo",
      "-",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
  await child.exited;
  return Array.from({ length: bytes.length / 8 }, (_, frame) =>
    Array.from(bytes.subarray(frame * 8, frame * 8 + 8)).reduce(
      (value, level, bit) => value | (level > 128 ? 1 << bit : 0),
      0,
    ),
  );
}

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "scrub proxies are small all-intra copies whose frame N is source frame N, remade when the source changes",
  async () => {
    const fixture = await projectFixture();
    const routes = createMediaRoutes(fixture.store);
    fixture.app.route("/api/cutroom", routes);
    try {
      const project = await fixture.store.create({ name: "Scrub proxies" });
      const source = join(project.path, "talk.mp4");
      await numberedVideo(source, 0);
      const url = `/projects/${project.id}/media/scrub?path=talk.mp4`;
      const first = PendingSchema.parse(
        await (await fixture.request(url)).json(),
      );
      const proxy = join(fixture.directory, "proxy.mp4");
      const response = await ready(() => fixture.request(url));
      expect(response.headers.get("content-type")).toBe("video/mp4");
      await writeFile(proxy, Buffer.from(await response.arrayBuffer()));
      const probe = Bun.spawnSync([
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate:frame=pict_type",
        "-of",
        "json",
        proxy,
      ]);
      const facts = z
        .object({
          streams: z.tuple([
            z.object({
              width: z.number(),
              height: z.number(),
              r_frame_rate: z.string(),
            }),
          ]),
          frames: z.array(z.object({ pict_type: z.string() })),
        })
        .parse(JSON.parse(probe.stdout.toString()));
      expect(facts.streams[0]).toEqual({
        width: 960,
        height: 540,
        r_frame_rate: "30/1",
      });
      expect(facts.frames).toHaveLength(60);
      expect(facts.frames.every(({ pict_type }) => pict_type === "I")).toBe(
        true,
      );
      const numbers = Array.from({ length: 60 }, (_, frame) => frame);
      expect(await frameNumbers(source)).toEqual(numbers);
      expect(await frameNumbers(proxy)).toEqual(numbers);

      await numberedVideo(source, 100);
      const changed = PendingSchema.parse(
        await (await fixture.request(url)).json(),
      );
      expect(changed.key).not.toBe(first.key);
      await writeFile(
        proxy,
        Buffer.from(
          await (await ready(() => fixture.request(url))).arrayBuffer(),
        ),
      );
      expect(await frameNumbers(proxy)).toEqual(
        numbers.map((frame) => frame + 100),
      );
    } finally {
      await routes.dispose();
      await fixture.close();
    }
  },
  30000,
);

test("the footage pipeline reads a project's videos in byte ranges, and nothing else", async () => {
  const fixture = await projectFixture();
  fixture.app.route("/api/cutroom", createMediaRoutes(fixture.store));
  const server = Bun.serve({ port: 0, fetch: fixture.app.fetch });
  try {
    const project = await fixture.store.create({ name: "Pipeline reads" });
    const bytes = crypto.getRandomValues(new Uint8Array(4096));
    await writeFile(join(project.path, "clip.mp4"), bytes);
    await mkdir(join(project.path, "folder.mov"));
    await writeFile(join(project.path, "notes.txt"), "private");
    await writeFile(join(project.path, ".env"), "private");
    await symlink(join(project.path, ".env"), join(project.path, "env.mp4"));
    await writeFile(join(fixture.directory, "outside.mp4"), "private");
    await symlink(
      join(fixture.directory, "outside.mp4"),
      join(project.path, "link.mp4"),
    );
    const url = (path: string) =>
      `http://127.0.0.1:${server.port}/api/cutroom/projects/${project.id}/media/source?path=${encodeURIComponent(path)}`;
    const ranged = await fetch(url("clip.mp4"), {
      headers: { range: "bytes=100-199" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 100-199/4096");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(
      bytes.subarray(100, 200),
    );
    for (const path of [
      "notes.txt",
      ".env",
      "env.mp4",
      "link.mp4",
      "../../outside.mp4",
      "folder.mov",
      "missing.mp4",
    ]) {
      const response = await fetch(url(path));
      expect(response.ok, path).toBe(false);
      expect(await response.text()).not.toContain("private");
    }
  } finally {
    await server.stop(true);
    await fixture.close();
  }
});

/** 48 kHz mono 16-bit samples whose values name their own index, wrapping at 32768. */
function countingSamples(count: number) {
  return Buffer.from(
    Int16Array.from({ length: count }, (_, index) => index % 32768).buffer,
  );
}

async function pcmOf(
  media: ReturnType<typeof createMediaService>,
  project: Awaited<
    ReturnType<Awaited<ReturnType<typeof projectFixture>>["store"]["create"]>
  >,
  path: string,
) {
  const deadline = performance.now() + 10000;
  while (true) {
    const result = await media.request(project, path, "pcm");
    if (result.artifact)
      return { key: result.key, bytes: await readFile(result.artifact) };
    if (result.state.status === "failed")
      throw new Error(`${path}: ${result.state.error}`);
    if (performance.now() > deadline)
      throw new Error("The PCM job did not finish.");
    await Bun.sleep(10);
  }
}

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "scrub audio puts source sample k at byte 2k, on the media clock with any late sound padded as silence",
  async () => {
    const fixture = await projectFixture();
    const media = createMediaService();
    try {
      const project = await fixture.store.create({ name: "Scrub audio" });
      const seconds = 2;
      const counting = countingSamples(48000 * seconds);
      await writeFile(join(fixture.directory, "counting.raw"), counting);
      const raw = [
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-i",
        join(fixture.directory, "counting.raw"),
      ];
      const picture = [
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=320x180:rate=25:duration=${seconds + 1}`,
      ];
      const video = [
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-threads",
        "1",
      ];
      await ffmpeg([
        ...raw,
        "-c:a",
        "pcm_s16le",
        join(project.path, "counting.wav"),
      ]);
      const wav = ["-i", join(project.path, "counting.wav")];
      const late = ["-itsoffset", "0.25", ...wav];
      const shifted = ["-itsoffset", "0.25", ...picture, ...late];
      const pcm = [...video, "-c:a", "pcm_s16le"];
      // MPEG-TS starts its clock at 1.4 s; Blu-ray PCM carries the samples in it unchanged.
      const ts = [
        ...video,
        "-c:a",
        "pcm_bluray",
        "-f",
        "mpegts",
        "-mpegts_m2ts_mode",
        "1",
      ];
      for (const [name, args] of [
        // The sound a quarter second after the picture.
        ["late.mkv", [...picture, ...late, ...pcm]],
        ["late.m2ts", [...picture, ...late, ...ts]],
        // Both a quarter second after timestamp zero, which MP4 plays from.
        ["shifted.mov", [...shifted, ...pcm, "-avoid_negative_ts", "disabled"]],
        // Both at the transport stream's start, which is media time zero.
        ["together.m2ts", [...picture, ...wav, ...ts]],
      ] as const)
        await ffmpeg([...args, join(project.path, name)]);

      const whole = await pcmOf(media, project, "counting.wav");
      expect(whole.bytes.length).toBe(counting.length);
      for (const k of [0, 1, 255, 32767, 32768, 47999, 48000, 95999])
        expect(whole.bytes.readInt16LE(2 * k)).toBe(k % 32768);
      expect(whole.bytes.equals(counting)).toBe(true);

      for (const [path, lead] of [
        ["late.mkv", 12000],
        ["late.m2ts", 12000],
        ["shifted.mov", 12000],
        ["together.m2ts", 0],
      ] as const) {
        const { bytes } = await pcmOf(media, project, path);
        expect(bytes.length, path).toBe(2 * (lead + counting.length / 2));
        // Source sample 0 is silent too; sample 1 is the first that sounds.
        const first = Int16Array.from({ length: bytes.length / 2 }, (_, k) =>
          bytes.readInt16LE(2 * k),
        ).findIndex((sample) => sample !== 0);
        expect(first, path).toBe(lead + 1);
        expect(bytes.subarray(2 * lead).equals(counting), path).toBe(true);
      }

      await ffmpeg([...picture, ...video, join(project.path, "silent.mp4")]);
      await media.request(project, "silent.mp4", "probe");
      let refused: unknown;
      const deadline = performance.now() + 5000;
      while (!refused && performance.now() < deadline) {
        refused = await media.request(project, "silent.mp4", "pcm").then(
          () => undefined,
          (error: unknown) => error,
        );
        await Bun.sleep(10);
      }
      expect(String(refused)).toContain("no audio stream");
    } finally {
      await media.dispose();
      await fixture.close();
    }
  },
  30000,
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "the scrub audio route serves byte ranges in either direction from the project's own media",
  async () => {
    const fixture = await projectFixture();
    const routes = createMediaRoutes(fixture.store);
    fixture.app.route("/api/cutroom", routes);
    const server = Bun.serve({ port: 0, fetch: fixture.app.fetch });
    try {
      const project = await fixture.store.create({ name: "Scrub ranges" });
      const counting = countingSamples(48000);
      await writeFile(join(fixture.directory, "counting.raw"), counting);
      await ffmpeg([
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-i",
        join(fixture.directory, "counting.raw"),
        "-c:a",
        "pcm_s16le",
        join(project.path, "voice.wav"),
      ]);
      await writeFile(join(fixture.directory, "outside.wav"), "private");
      await symlink(
        join(fixture.directory, "outside.wav"),
        join(project.path, "link.wav"),
      );
      // The listing's file version, as a scrub plan segment carries it.
      const version = fileFingerprint(
        "voice.wav",
        await stat(join(project.path, "voice.wav")),
      );
      const url = (path: string) =>
        `http://127.0.0.1:${server.port}/api/cutroom/projects/${project.id}/media/pcm?path=${encodeURIComponent(path)}&v=${encodeURIComponent(version)}`;
      const read = (range: string) =>
        fetch(url("voice.wav"), { headers: { range } });

      expect((await fetch(url("voice.wav"))).status).toBe(202);
      const whole = await ready(() => fetch(url("voice.wav")));
      expect(whole.status).toBe(200);
      expect(whole.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(Buffer.from(await whole.arrayBuffer()).equals(counting)).toBe(
        true,
      );

      const size = counting.length;
      const sample = (k: number) => `bytes=${2 * k}-${2 * k + 1}`;
      for (const [range, first, end] of [
        [sample(0), 0, 2],
        [sample(1000), 2000, 2002],
        [sample(47999), size - 2, size],
        ["bytes=-2", size - 2, size],
        [`bytes=${size - 4}-`, size - 4, size],
        // A read past the end stops at it.
        [`bytes=${size - 2}-${size + 1000}`, size - 2, size],
      ] as const) {
        const response = await read(range);
        expect(response.status, range).toBe(206);
        expect(response.headers.get("content-range"), range).toBe(
          `bytes ${first}-${end - 1}/${size}`,
        );
        expect(
          Buffer.from(await response.arrayBuffer()).equals(
            counting.subarray(first, end),
          ),
          range,
        ).toBe(true);
      }
      // Reverse playback reads chunks from the end towards the start.
      const chunk = 2 * 4096;
      const chunks: Buffer[] = [];
      for (let end = size; end > 0; end -= chunk) {
        const first = Math.max(0, end - chunk);
        const response = await read(`bytes=${first}-${end - 1}`);
        expect(response.status).toBe(206);
        chunks.unshift(Buffer.from(await response.arrayBuffer()));
      }
      expect(Buffer.concat(chunks).equals(counting)).toBe(true);

      for (const range of [
        `bytes=${size}-`,
        `bytes=${size + 100}-${size + 200}`,
      ])
        expect((await read(range)).status, range).toBe(416);

      for (const path of [
        "../../outside.wav",
        "link.wav",
        "/etc/passwd",
        "missing.wav",
      ]) {
        const response = await fetch(url(path));
        expect(response.ok, path).toBe(false);
        expect(await response.text()).not.toContain("private");
      }
    } finally {
      await server.stop(true);
      await routes.dispose();
      await fixture.close();
    }
  },
  30000,
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "scrub audio is cached by source fingerprint and evicted with the other media artifacts",
  async () => {
    const fixture = await projectFixture();
    let media = createMediaService({ maxCacheEntries: 2 });
    try {
      const project = await fixture.store.create({ name: "Scrub cache" });
      await writeFile(
        join(fixture.directory, "counting.raw"),
        countingSamples(4800),
      );
      for (const name of ["a.wav", "b.wav"])
        await ffmpeg([
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "1",
          "-i",
          join(fixture.directory, "counting.raw"),
          "-c:a",
          "pcm_s16le",
          join(project.path, name),
        ]);
      const first = await pcmOf(media, project, "a.wav");
      const entry = join(project.path, ".cutroom/cache", first.key);

      // A hit is answered from disk, even by a service that cannot start a worker.
      await media.dispose();
      media = createMediaService({
        maxCacheEntries: 2,
        workerUrl: new URL("file:///missing-worker.ts"),
      });
      const hit = await media.request(project, "a.wav", "pcm");
      expect(hit.key).toBe(first.key);
      expect(hit.state.status).toBe("done");
      expect(await readFile(hit.artifact!)).toEqual(first.bytes);

      // Changing the source is a miss under a new key.
      await utimes(
        join(project.path, "a.wav"),
        new Date(),
        new Date(Date.now() + 1000),
      );
      const changed = await media.request(project, "a.wav", "pcm");
      expect(changed.artifact).toBeUndefined();
      expect(changed.key).not.toBe(first.key);
      await media.dispose();

      // Newer artifacts push the oldest entries out, the PCM file with them.
      media = createMediaService({ maxCacheEntries: 2 });
      await pcmOf(media, project, "b.wav");
      expect(await readdir(entry).catch(() => null)).toBeNull();
    } finally {
      await media.dispose();
      await fixture.close();
    }
  },
  30000,
);
