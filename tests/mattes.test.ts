import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
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
import type { MatteStatus } from "../src/shared/matte";
import { MatteManifestSchema } from "../src/shared/matte";

const tools = !!Bun.which("ffmpeg") && !!Bun.which("ffprobe");
const segmenter = new URL("./fixtures/stub-segmenter.ts", import.meta.url);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

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
  return { root, project, model };
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
  service: ReturnType<typeof createMatteService>,
  done: (status: MatteStatus) => boolean,
) {
  return new Promise<MatteStatus>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("The matte job did not settle.")),
      20_000,
    );
    const stop = service.subscribe("p", (status) => {
      if (!done(status)) return;
      clearTimeout(timeout);
      stop();
      resolve(status);
    });
  });
}
const idle = (status: MatteStatus) =>
  status.jobs.every((job) => !["waiting", "running"].includes(job.status));

const manifest = async (project: { path: string }) =>
  MatteManifestSchema.parse(
    JSON.parse(
      await readFile(join(project.path, "mattes/mattes.json"), "utf8"),
    ),
  );

test.skipIf(!tools)(
  "a matte's frames line up with the source frames it was asked for, plus a handle",
  async () => {
    const { project, model } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    const service = createMatteService({ model, segmenter });
    cleanup.push(() => service.close());
    const finished = settled(service, idle);
    // From frame 37, an odd frame in the middle of a GOP, to frame 57.
    await service.request(project, {
      src: "talk.mp4",
      from: 37 / 30,
      to: 57 / 30,
    });
    const status = await finished;
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
    const { project, model } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    const service = createMatteService({ model, segmenter });
    cleanup.push(() => service.close());
    let finished = settled(service, idle);
    await service.request(project, { src: "talk.mp4", from: 0, to: 1 });
    await finished;
    const again = await service.request(project, {
      src: "talk.mp4",
      from: 0,
      to: 1,
    });
    expect(again.jobs).toEqual([]);
    finished = settled(service, idle);
    const longer = await service.request(project, {
      src: "talk.mp4",
      from: 0.5,
      to: 2,
    });
    expect(longer.jobs).toMatchObject([{ first: 30, frames: 30 }]);
    await finished;
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
    const { project, model } = await setup();
    const source = join(project.path, "empty.mp4");
    await alternating(source, "0");
    const service = createMatteService({ model, segmenter });
    cleanup.push(() => service.close());
    let finished = settled(service, idle);
    await service.request(project, { src: "empty.mp4", from: 0, to: 1 });
    expect((await finished).jobs).toMatchObject([{ status: "no-subject" }]);
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
    finished = settled(service, idle);
    const remade = await service.request(project, {
      src: "empty.mp4",
      from: 0,
      to: 1,
    });
    expect(remade.jobs).toMatchObject([{ first: 0, frames: 30 }]);
    expect((await finished).jobs).toMatchObject([{ status: "done" }]);
    // The stale entry is gone; only the new source's matte is listed.
    expect((await manifest(project)).mattes).toMatchObject([{ subject: true }]);
  },
);

test.skipIf(!tools)(
  "jobs wait for the model until it is downloaded, and a short download is never used",
  async () => {
    const { project, model } = await setup({ weights: false });
    await alternating(join(project.path, "talk.mp4"));
    const body = new Uint8Array(4096).fill(7);
    let short = true;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(short ? body.subarray(0, 1000) : body, {
          headers: { "content-length": String(short ? 1000 : body.length) },
        }),
    });
    cleanup.push(async () => server.stop(true));
    const service = createMatteService({
      model,
      segmenter,
      modelUrl: server.url.href,
      modelBytes: body.length,
    });
    cleanup.push(() => service.close());
    const waiting = await service.request(project, {
      src: "talk.mp4",
      from: 0,
      to: 0.5,
    });
    expect(waiting.model).toEqual({ status: "missing", bytes: 4096 });
    await Bun.sleep(50);
    expect((await service.status("p")).jobs).toMatchObject([
      { status: "needs-model" },
    ]);

    await service.downloadModel();
    expect((await service.status("p")).model).toMatchObject({
      status: "failed",
    });
    expect(existsSync(model.weights)).toBe(false);

    short = false;
    const finished = settled(service, (status) =>
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
    const { project, model } = await setup();
    await alternating(join(project.path, "talk.mp4"));
    process.env.STUB_SEGMENTER_DELAY_MS = "20";
    cleanup.push(async () => delete process.env.STUB_SEGMENTER_DELAY_MS);
    const service = createMatteService({ model, segmenter });
    cleanup.push(() => service.close());
    const started = settled(
      service,
      (status) => (status.jobs[0]?.done ?? 0) >= 5,
    );
    const [job] = (
      await service.request(project, { src: "talk.mp4", from: 0, to: 3 })
    ).jobs;
    await started;
    const stopped = settled(service, idle);
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
