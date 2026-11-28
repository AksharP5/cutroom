import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  readdir,
  mkdir,
  symlink,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMatteService } from "../src/server/matte/service";
import type { MatteRequest, MatteService } from "../src/server/matte/service";
import { mattedVideos, prepareMatteExport } from "../src/server/matte/export";
import type { MatteJob, MatteStatus } from "../src/shared/matte";
import { MatteManifestSchema } from "../src/shared/matte";

const tools = !!Bun.which("ffmpeg") && !!Bun.which("ffprobe");
const segmenter = new URL("./fixtures/stub-segmenter.ts", import.meta.url);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** The stub model's weights, which the service checks byte for byte as it does the real ones. */
const stubWeights = {
  url: "http://127.0.0.1:9/never",
  bytes: 7,
  sha256: new Bun.CryptoHasher("sha256").update("weights").digest("hex"),
};

/** A project folder and a model cache with a runtime and weights the stub never reads. */
async function setup({ weights = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cutroom-mattes-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = { id: "p", path: join(root, "project") };
  await mkdir(project.path);
  const runtime = join(root, "cache", "runtime");
  await mkdir(join(runtime, "node_modules", "onnxruntime-node"), {
    recursive: true,
  });
  await writeFile(
    join(runtime, "node_modules", "onnxruntime-node", "package.json"),
    "{}",
  );
  const model = { weights: join(root, "cache", "weights.onnx"), runtime };
  if (weights) await writeFile(model.weights, "weights");
  return { root, project, model, modelFile: stubWeights };
}

/** 30 fps H.264 whose even frames are red and odd frames black, with keyframes every 12. */
async function alternating(path: string, colour = "if(mod(N\\,2)\\,0\\,255)") {
  const child = Bun.spawn(
    [
      ...["ffmpeg", "-v", "error", "-y", "-f", "lavfi"],
      ...[
        "-i",
        `color=black:s=64x64:r=30:d=3,format=rgb24,geq=r='${colour}':g=0:b=0`,
      ],
      ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12", path],
    ],
    { stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
}

/** Each matte frame's mean, 0 to 255. */
async function matteFrames(path: string) {
  const child = Bun.spawn(
    [
      ...["ffmpeg", "-v", "error", "-i", path],
      ...["-vf", "scale=1:1:flags=area,format=gray", "-f", "rawvideo", "-"],
    ],
    { stdout: "pipe" },
  );
  return [...new Uint8Array(await new Response(child.stdout).arrayBuffer())];
}

function settled(
  service: MatteService,
  project: { id: string; path: string },
  done: (status: MatteStatus) => boolean,
) {
  return new Promise<MatteStatus>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("The matte job did not settle.")),
      20_000,
    );
    const stop = service.subscribe(project, (status) => {
      if (!done(status)) return;
      clearTimeout(timeout);
      stop();
      resolve(status);
    });
  });
}
const busy = (job: MatteJob) => ["waiting", "running"].includes(job.status);
const idle = (status: MatteStatus) => !status.jobs.some(busy);

/**
 * Asks for a range and resolves once every job that request queued has finished. A status event
 * scheduled before the request can still show the project idle, so this follows the jobs by id.
 */
async function requestSettled(
  service: MatteService,
  project: { id: string; path: string },
  request: MatteRequest,
) {
  const { jobs } = await service.request(project, request);
  const queued = new Set(jobs.filter(busy).map(({ id }) => id));
  const finished = (status: MatteStatus) =>
    !status.jobs.some((job) => queued.has(job.id) && busy(job));
  const now = await service.status(project);
  return finished(now) ? now : settled(service, project, finished);
}

const manifest = async (project: { path: string }) =>
  MatteManifestSchema.parse(
    JSON.parse(
      await readFile(join(project.path, "mattes/mattes.json"), "utf8"),
    ),
  );

test.skipIf(!tools)(
  "a matte's frames line up with the source frames it was asked for, plus a handle",
  async () => {
    const { project, model, modelFile } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    // From frame 37, an odd frame in the middle of a GOP, to frame 57.
    const status = await requestSettled(service, project, {
      src: "talk.mp4",
      from: 37 / 30,
      to: 57 / 30,
    });
    expect(status.jobs).toMatchObject([
      { status: "done", first: 37, frames: 20, done: 20 },
    ]);
    const [entry] = (await manifest(project)).mattes;
    expect(entry).toMatchObject({
      src: "talk.mp4",
      first: 37,
      frames: 20,
      rate: 30,
      subject: true,
    });
    expect(entry!.file).toBe("mattes/talk 00-00-01 to 00-00-02.mp4");
    const means = await matteFrames(join(project.path, entry!.file));
    expect(means).toHaveLength(20);
    // Odd source frames are black, so the matte starts empty and alternates.
    expect(means.map((mean) => (mean > 128 ? 1 : 0))).toEqual(
      Array.from({ length: 20 }, (_, index) =>
        (37 + index) % 2 === 0 ? 1 : 0,
      ),
    );
  },
);

test.skipIf(!tools)(
  "asking again makes nothing, and a longer range queues only the frames it lacks",
  async () => {
    const { project, model, modelFile } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    await requestSettled(service, project, { src: "talk.mp4", from: 0, to: 1 });
    const again = await service.request(project, {
      src: "talk.mp4",
      from: 0,
      to: 1,
    });
    expect(again.jobs).toEqual([]);
    const longer = await requestSettled(service, project, {
      src: "talk.mp4",
      from: 0.5,
      to: 2,
    });
    expect(longer.jobs).toMatchObject([{ first: 30, frames: 30 }]);
    expect(
      (await manifest(project)).mattes.map(({ first, frames }) => [
        first,
        frames,
      ]),
    ).toEqual([
      [0, 30],
      [30, 30],
    ]);
  },
);

test.skipIf(!tools)(
  "a clip with no subject says so once, and replacing the source makes its mattes stale",
  async () => {
    const { project, model, modelFile } = await setup();
    const source = join(project.path, "empty.mp4");
    await alternating(source, "0");
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    expect(
      (
        await requestSettled(service, project, {
          src: "empty.mp4",
          from: 0,
          to: 1,
        })
      ).jobs,
    ).toMatchObject([{ status: "no-subject" }]);
    expect((await manifest(project)).mattes).toMatchObject([
      { subject: false, file: "" },
    ]);
    expect(
      existsSync(join(project.path, "mattes/empty 00-00-00 to 00-00-01.mp4")),
    ).toBe(false);
    // Nothing to retry until the clip changes.
    expect(
      (await service.request(project, { src: "empty.mp4", from: 0, to: 1 }))
        .jobs,
    ).toMatchObject([{ status: "no-subject" }]);

    await alternating(source);
    await utimes(source, new Date(), new Date(Date.now() + 5000));
    const remade = await requestSettled(service, project, {
      src: "empty.mp4",
      from: 0,
      to: 1,
    });
    expect(remade.jobs).toMatchObject([
      { first: 0, frames: 30, status: "done" },
    ]);
    // The stale entry is gone; only the new source's matte is listed.
    expect((await manifest(project)).mattes).toMatchObject([{ subject: true }]);
  },
);

test.skipIf(!tools)(
  "jobs wait for the model until it is downloaded, and a short, oversized or altered download is never used",
  async () => {
    const { project, model } = await setup({ weights: false });
    await alternating(join(project.path, "talk.mp4"));
    const body = new Uint8Array(4096).fill(7);
    let reply = body.subarray(0, 1000);
    const server = Bun.serve({ port: 0, fetch: () => new Response(reply) });
    cleanup.push(async () => server.stop(true));
    const modelFile = {
      url: server.url.href,
      bytes: body.length,
      sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
    };
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    const waiting = await service.request(project, {
      src: "talk.mp4",
      from: 0,
      to: 0.5,
    });
    expect(waiting.model).toEqual({ status: "missing", bytes: 4096 });
    await Bun.sleep(50);
    expect((await service.status(project)).jobs).toMatchObject([
      { status: "needs-model" },
    ]);

    for (const wrong of [
      body.subarray(0, 1000),
      new Uint8Array(8192).fill(7),
      new Uint8Array(4096).fill(8),
    ]) {
      reply = wrong;
      await service.downloadModel();
      expect((await service.status(project)).model).toMatchObject({
        status: "failed",
      });
      expect(existsSync(model.weights)).toBe(false);
    }
    // A file left on disk that is not the model counts as missing, so Download comes back.
    await writeFile(model.weights, new Uint8Array(4096).fill(9));
    expect(
      (
        await createMatteService({ model, segmenter, modelFile }).status(
          project,
        )
      ).model,
    ).toEqual({
      status: "missing",
      bytes: 4096,
    });
    await rm(model.weights);

    reply = body;
    const finished = settled(service, project, (status) =>
      status.jobs.some((job) => job.status === "done"),
    );
    await service.downloadModel();
    expect(await readFile(model.weights)).toEqual(Buffer.from(body));
    expect((await finished).model).toEqual({ status: "ready" });
  },
);

test.skipIf(!tools)(
  "stopping keeps the frames already made, and asking again makes only the rest",
  async () => {
    const { project, model, modelFile } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    process.env.STUB_SEGMENTER_DELAY_MS = "20";
    cleanup.push(async () => delete process.env.STUB_SEGMENTER_DELAY_MS);
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    const started = settled(
      service,
      project,
      (status) => (status.jobs[0]?.done ?? 0) >= 5,
    );
    const [job] = (
      await service.request(project, { src: "talk.mp4", from: 0, to: 3 })
    ).jobs;
    await started;
    const stopped = settled(service, project, idle);
    service.stop("p", job!.id);
    const [result] = (await stopped).jobs;
    expect(result).toMatchObject({ status: "stopped" });
    expect(result!.done).toBeGreaterThan(0);
    expect(result!.done).toBeLessThan(90);
    const [entry] = (await manifest(project)).mattes;
    expect(entry).toMatchObject({ first: 0, frames: result!.done });
    expect(await matteFrames(join(project.path, entry!.file))).toHaveLength(
      result!.done,
    );
    delete process.env.STUB_SEGMENTER_DELAY_MS;
    const rest = await service.request(project, {
      src: "talk.mp4",
      from: 0,
      to: 3,
    });
    expect(rest.jobs).toMatchObject([
      { first: result!.done, frames: 90 - result!.done },
    ]);
  },
);

/** H.264 at an exact rate whose even frames are red, with `frames` frames in all. */
async function alternatingAt(path: string, rate: string, frames: number) {
  const child = Bun.spawn(
    [
      ...["ffmpeg", "-v", "error", "-y", "-f", "lavfi"],
      ...[
        "-i",
        `color=black:s=64x64:r=${rate},format=rgb24,geq=r='if(mod(N\\,2)\\,0\\,255)':g=0:b=0`,
      ],
      ...[
        "-frames:v",
        String(frames),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
      ],
      ...["-g", "12", path],
    ],
    { stderr: "pipe" },
  );
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
}

test.skipIf(!tools)(
  "29.97, 23.976 and 59.94 fps sources matte on their exact grid",
  async () => {
    const { project, model, modelFile } = await setup();
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    for (const [rate, name] of [
      ["30000/1001", "ntsc.mp4"],
      ["24000/1001", "film.mp4"],
      ["60000/1001", "high.mp4"],
    ] as const) {
      await alternatingAt(join(project.path, name), rate, 90);
      const [num, den] = rate.split("/").map(Number) as [number, number];
      // From frame 31, an odd frame, for 20 frames.
      const [job] = (
        await requestSettled(service, project, {
          src: name,
          from: (31 * den) / num,
          to: (51 * den) / num,
        })
      ).jobs;
      expect(job, rate).toMatchObject({
        status: "done",
        first: 31,
        frames: 20,
      });
      const entry = (await manifest(project)).mattes.find(
        ({ src }) => src === name,
      )!;
      expect(entry.rate).toBeCloseTo(num / den, 9);
      const means = await matteFrames(join(project.path, entry.file));
      expect(
        means.map((mean) => (mean > 128 ? 1 : 0)),
        rate,
      ).toEqual(
        Array.from({ length: 20 }, (_, index) =>
          (31 + index) % 2 === 0 ? 1 : 0,
        ),
      );
    }
  },
);

test.skipIf(!tools)(
  "a variable-rate source mattes the frame shown at each slot of its average rate",
  async () => {
    const { project, model, modelFile } = await setup();
    // 30 fps with every third frame dropped: frames sit at uneven times, 20 a second on average.
    const child = Bun.spawn(
      [
        ...["ffmpeg", "-v", "error", "-y", "-f", "lavfi"],
        ...[
          "-i",
          "color=black:s=64x64:r=30:d=3,format=rgb24,geq=r='if(mod(N\\,2)\\,0\\,255)':g=0:b=0",
        ],
        ...["-vf", "select='not(eq(mod(n\\,3)\\,2))'", "-fps_mode", "vfr"],
        ...[
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          join(project.path, "vfr.mp4"),
        ],
      ],
      { stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    expect(
      (
        await requestSettled(service, project, {
          src: "vfr.mp4",
          from: 0,
          to: 1,
        })
      ).jobs,
    ).toMatchObject([{ status: "done" }]);
    const [entry] = (await manifest(project)).mattes;
    expect(entry).toMatchObject({ first: 0 });
    // The average rate, as FFmpeg measures it over the file.
    expect(Math.abs(entry!.rate - 20)).toBeLessThan(0.5);
    // Source frame n (before the drop) is red when n is even, and was shown from n / 30 s.
    const kept = Array.from({ length: 90 }, (_, n) => n).filter(
      (n) => n % 3 !== 2,
    );
    const shownAt = (seconds: number) =>
      kept.findLast((n) => n / 30 <= seconds + 1e-6)!;
    const means = await matteFrames(join(project.path, entry!.file));
    expect(means.map((mean) => (mean > 128 ? 1 : 0))).toEqual(
      Array.from({ length: means.length }, (_, slot) =>
        shownAt(slot / entry!.rate) % 2 === 0 ? 1 : 0,
      ),
    );
  },
);

test.skipIf(!tools)(
  "a range export neither waits for nor makes the cutout of a clip outside it",
  async () => {
    const { project, model, modelFile } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    const html =
      '<main data-composition-id="main"><video id="v" muted src="talk.mp4" data-start="0" data-duration="0.5" data-media-start="1.2" data-track-index="0" data-cutroom-matte="shrink:0;soften:0"></video></main>';
    const prepared = await prepareMatteExport({
      project,
      composition: "index.html",
      html,
      range: { start: 0.5, end: 2 },
      mattes: service,
      signal: new AbortController().signal,
      onWait: () => {},
    });
    expect(prepared).toBeNull();
    expect((await service.status(project)).jobs).toEqual([]);
  },
);

test("an unknown end in a timing reference chain cannot rule out a cutout", () => {
  const html = `<main data-composition-id="main">
    <video id="intro" src="intro.mp4" data-start="0"></video>
    <video id="direct" src="one.mp4" data-start="intro" data-duration="1" data-cutroom-matte="shrink:0;soften:0"></video>
    <video id="chained" src="two.mp4" data-start="direct" data-duration="1" data-cutroom-matte="shrink:0;soften:0"></video>
    <video id="early" src="three.mp4" data-start="0" data-duration="1" data-cutroom-matte="shrink:0;soften:0"></video>
  </main>`;
  const range = { start: 10, end: 12 };
  expect(mattedVideos(html, range).map(({ src }) => src)).toEqual([
    "one.mp4",
    "two.mp4",
  ]);
  const fixedLength = html.replace(
    'src="intro.mp4"',
    'src="intro.mp4" data-duration="3"',
  );
  expect(mattedVideos(fixedLength, range)).toEqual([]);
});

test.skipIf(!tools)(
  "a marked export's relatively timed cutout carries each source frame's own matte as alpha, and the clip points at it",
  async () => {
    const { project, model, modelFile } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    const html =
      '<main data-composition-id="main"><div id="intro" data-start="0" data-duration="2"></div><video id="v" muted src="talk.mp4" data-start="intro" data-duration="0.5" data-media-start="1.2" data-track-index="0" data-cutroom-matte="shrink:0;soften:0"></video></main>';
    const prepared = await prepareMatteExport({
      project,
      composition: "index.html",
      html,
      range: { start: 2, end: 2.5 },
      mattes: service,
      signal: new AbortController().signal,
      onWait: () => {},
    });
    expect(prepared).not.toBeNull();
    cleanup.push(() => prepared!.cleanup());
    const src = /src="([^"]+)"/.exec(prepared!.html)![1]!;
    expect(src).toMatch(/^mattes\/\.export\/[^/]+\/0\.mov$/);
    expect(prepared!.html).toContain('data-media-start="0.000000"');
    // The marker stays, which keeps the clip off the direct FFmpeg path.
    expect(prepared!.html).toContain("data-cutroom-matte");
    const child = Bun.spawn(
      [
        ...["ffmpeg", "-v", "error", "-i", join(project.path, src)],
        ...[
          "-vf",
          "alphaextract,scale=1:1:flags=area,format=gray",
          "-f",
          "rawvideo",
          "-",
        ],
      ],
      { stdout: "pipe" },
    );
    const alpha = [
      ...new Uint8Array(await new Response(child.stdout).arrayBuffer()),
    ];
    // Frames 36 to 50: even frames are red, the stub's subject.
    expect(alpha).toHaveLength(15);
    expect(alpha.map((value) => (value > 128 ? 1 : 0))).toEqual(
      Array.from({ length: 15 }, (_, index) =>
        (36 + index) % 2 === 0 ? 1 : 0,
      ),
    );
    await prepared!.cleanup();
    expect(existsSync(join(project.path, src))).toBe(false);
  },
);

test.skipIf(!tools)(
  "a clip that plays to its source's last frame gets a matte through that frame",
  async () => {
    const { project, model, modelFile } = await setup();
    await alternatingAt(join(project.path, "short.mp4"), "30", 73);
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    const finished = await requestSettled(service, project, {
      src: "short.mp4",
      from: 1,
      to: 73 / 30 + 1,
    });
    expect(finished.jobs).toMatchObject([{ status: "done" }]);
    const [entry] = (await manifest(project)).mattes;
    expect(entry!.first + entry!.frames).toBe(73);
    expect(entry!.count).toBe(73);
  },
);

test.skipIf(!tools)(
  "a job whose project is gone fails on its own, and a model that prints to stdout still finishes",
  async () => {
    const { project, model, modelFile, root } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    const other = { id: "q", path: join(root, "other") };
    await mkdir(other.path);
    await alternating(join(other.path, "talk.mp4"));
    process.env.STUB_SEGMENTER_DELAY_MS = "20";
    cleanup.push(async () => delete process.env.STUB_SEGMENTER_DELAY_MS);
    const noisy = new URL("./fixtures/noisy-segmenter.ts", import.meta.url);
    const service = createMatteService({ model, segmenter: noisy, modelFile });
    cleanup.push(() => service.close());
    const done = settled(service, project, idle);
    const gone = new Promise<MatteStatus>((resolve) => {
      const stop = service.subscribe(other, (status) => {
        if (!status.jobs.some((job) => job.status === "failed")) return;
        stop();
        resolve(status);
      });
    });
    await service.request(project, { src: "talk.mp4", from: 0, to: 1 });
    await service.request(other, { src: "talk.mp4", from: 0, to: 1 });
    // The second project goes while its job waits behind the first.
    await rm(other.path, { recursive: true, force: true });
    expect((await gone).jobs).toMatchObject([{ status: "failed" }]);
    expect((await done).jobs).toMatchObject([{ status: "done", done: 30 }]);
  },
);

test.skipIf(!tools)(
  "two requests for the same frames at once queue them once",
  async () => {
    const { project, model, modelFile } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    const request = { src: "talk.mp4", from: 0, to: 2 };
    await Promise.all([
      service.request(project, request),
      service.request(project, request),
    ]);
    const { jobs } = await service.status(project);
    expect(jobs.map(({ first, frames }) => [first, frames])).toEqual([[0, 60]]);
  },
);

test.skipIf(!tools)(
  "a link planted at a matte's name is never written through, and a manifest naming files outside mattes/ is ignored",
  async () => {
    const { project, model, modelFile, root } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    await mkdir(join(project.path, "mattes"));
    const outside = join(root, "outside.mp4");
    await symlink(
      outside,
      join(project.path, "mattes/talk 00-00-00 to 00-00-01.mp4"),
    );
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    expect(
      (
        await requestSettled(service, project, {
          src: "talk.mp4",
          from: 0,
          to: 1,
        })
      ).jobs,
    ).toMatchObject([{ status: "done" }]);
    expect(existsSync(outside)).toBe(false);
    const [entry] = (await manifest(project)).mattes;
    expect(entry!.file).toBe("mattes/talk 00-00-00 to 00-00-01 2.mp4");
    expect((await lstat(join(project.path, entry!.file))).isFile()).toBe(true);

    const planted = JSON.stringify({
      version: 1,
      mattes: [{ ...entry, file: "mattes/../../outside.mp4" }],
    });
    expect(() => MatteManifestSchema.parse(JSON.parse(planted))).toThrow();
  },
);

test.skipIf(!tools)(
  "remaking a replaced source's matte deletes the stale file",
  async () => {
    const { project, model, modelFile } = await setup();
    const source = join(project.path, "talk.mp4");
    await alternating(source);
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    await requestSettled(service, project, { src: "talk.mp4", from: 0, to: 1 });
    const [old] = (await manifest(project)).mattes;
    await alternating(source, "255");
    await utimes(source, new Date(), new Date(Date.now() + 5000));
    await requestSettled(service, project, { src: "talk.mp4", from: 0, to: 2 });
    const mattes = (await manifest(project)).mattes;
    expect(mattes).toHaveLength(1);
    expect(existsSync(join(project.path, old!.file))).toBe(false);
    expect(existsSync(join(project.path, mattes[0]!.file))).toBe(true);
  },
);

test.skipIf(!tools)(
  "a model that fails mid-job fails that job, leaves no file, and says when memory ran out",
  async () => {
    const { project, model, modelFile } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    const failing = createMatteService({
      model,
      modelFile,
      segmenter: new URL("./fixtures/failing-segmenter.ts", import.meta.url),
    });
    cleanup.push(() => failing.close());
    expect(
      (
        await requestSettled(failing, project, {
          src: "talk.mp4",
          from: 0,
          to: 1,
        })
      ).jobs,
    ).toMatchObject([{ status: "failed", memory: true }]);
    expect(
      existsSync(join(project.path, "mattes/talk 00-00-00 to 00-00-01.mp4")),
    ).toBe(false);
  },
);

const exportHtml = (src: string, extra = "") =>
  `<main data-composition-id="main"><video id="v" muted src="${src}" data-start="0" data-duration="0.5" data-media-start="1.2" data-track-index="0" data-cutroom-matte="shrink:0;soften:0"${extra}></video></main>`;
const prepare = (
  project: { id: string; path: string },
  service: ReturnType<typeof createMatteService>,
  html: string,
  signal = new AbortController().signal,
) =>
  prepareMatteExport({
    project,
    composition: "index.html",
    html,
    mattes: service,
    signal,
    onWait: () => {},
  });

test.skipIf(!tools)(
  "an export stops with a reason when a matte job is stopped or cannot run, rather than waiting forever",
  async () => {
    const { project, model, modelFile } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    process.env.STUB_SEGMENTER_DELAY_MS = "40";
    cleanup.push(async () => delete process.env.STUB_SEGMENTER_DELAY_MS);
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    const exported = prepare(project, service, exportHtml("talk.mp4"));
    const running = settled(service, project, (status) =>
      status.jobs.some((job) => job.done > 2),
    );
    const [job] = (await running).jobs;
    service.stop(project.id, job!.id);
    await expect(exported).rejects.toThrow("was stopped");
    await expect(
      prepare(project, service, exportHtml("missing.mp4")),
    ).rejects.toThrow("cannot be removed");
    await expect(
      prepare(
        project,
        service,
        exportHtml(
          "talk.mp4",
          ` data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":0.5},{"t":1,"v":2}]}]}'`,
        ),
      ),
    ).rejects.toThrow("speed ramp");
  },
);

test.skipIf(!tools)(
  "a clip whose removal failed exports as shot, as the viewer shows it",
  async () => {
    const { project, model, modelFile } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    const service = createMatteService({
      model,
      modelFile,
      segmenter: new URL("./fixtures/failing-segmenter.ts", import.meta.url),
    });
    cleanup.push(() => service.close());
    const html = exportHtml("talk.mp4");
    const prepared = await prepare(project, service, html);
    cleanup.push(async () => prepared?.cleanup());
    expect(prepared?.html).toBe(html);
  },
);

test.skipIf(!tools)(
  "an export never writes its cutouts through a link planted at mattes/.export",
  async () => {
    const { project, model, modelFile, root } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(join(project.path, "mattes"));
    await symlink(outside, join(project.path, "mattes/.export"));
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    await expect(
      prepare(project, service, exportHtml("talk.mp4")),
    ).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  },
);

test.skipIf(!tools)(
  "a timeline read lets go of jobs no clip needs any more, keeping the frames made",
  async () => {
    const { project, model, modelFile } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    await alternating(join(project.path, "other.mp4"));
    process.env.STUB_SEGMENTER_DELAY_MS = "40";
    cleanup.push(async () => delete process.env.STUB_SEGMENTER_DELAY_MS);
    const service = createMatteService({ model, segmenter, modelFile });
    cleanup.push(() => service.close());
    const talk = { src: "talk.mp4", from: 0, to: 3, composition: "index.html" };
    await service.request(project, talk);
    await service.request(project, { ...talk, src: "other.mp4" });
    const running = settled(service, project, (status) =>
      status.jobs.some((job) => job.done > 2),
    );
    await running;
    // The clip went back to Keep: nothing on the timeline needs either job.
    const stopped = settled(service, project, (status) =>
      status.jobs.every((job) => job.status === "stopped"),
    );
    await service.release(project, "index.html", []);
    const { jobs } = await stopped;
    expect(jobs).toHaveLength(1);
    expect((await manifest(project)).mattes).toHaveLength(1);
  },
);
