import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("The export did not settle.");
    await Bun.sleep(10);
  }
}

for (const range of [null, { start: 30, end: 60 }])
  test(`cancelling a ${range ? "marked" : "whole"} export removes the producer's scratch beside its output`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-export-cancel-"));
    const workerPath = join(root, "worker.mjs");
    // Like the producer, the worker writes work and transaction folders beside its output.
    await writeFile(
      workerPath,
      `import {mkdir,writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';let raw='';for await(const chunk of process.stdin)raw+=chunk;const {outputPath}=JSON.parse(raw);const beside=dirname(outputPath);await mkdir(join(beside,'work-test-1'));await mkdir(join(beside,'.My cut.hf-transaction-1'));await writeFile(outputPath,'partial');await writeFile(join(beside,'..','worker.pid'),String(process.pid));console.log('CUTROOM_RENDER:'+JSON.stringify({type:'progress',progress:50,stage:'Capturing frames',stageProgress:{code:'capture',done:15,total:30}}));setInterval(()=>{},1000);`,
    );
    const workers = createRenderWorkers({
      scratchDir: join(root, "scratch"),
      workerPath,
      stopTimeoutMs: 40,
    });
    try {
      const state = workers.start(
        {
          project: { id: "test", dir: root },
          outputPath: join(root, "internal.mp4"),
          format: "mp4",
          fps: { num: 30, den: 1 },
          quality: "standard",
          jobId: "test",
        },
        { filename: "My cut.mp4", directory: root, range },
      );
      await until(() => state.stage === "Capturing frames");
      expect(state.stageProgress).toEqual({
        code: "capture",
        done: 15,
        total: 30,
      });
      const pid = Number(await readFile(join(root, "worker.pid"), "utf8"));
      await state.cancel?.();
      expect(state.status).toBe("cancelled");
      expect(() => process.kill(pid, 0)).toThrow();
      expect((await readdir(root)).sort()).toEqual([
        "scratch",
        "worker.mjs",
        "worker.pid",
      ]);
      expect(await readdir(join(root, "scratch"))).toEqual([]);
    } finally {
      await workers.cancelAll();
      await rm(root, { recursive: true, force: true });
    }
  });

test("a finished export moves into place and leaves no scratch beside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-export-done-"));
  const workerPath = join(root, "worker.mjs");
  await writeFile(
    workerPath,
    `import {mkdir,writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';let raw='';for await(const chunk of process.stdin)raw+=chunk;const {outputPath}=JSON.parse(raw);await mkdir(join(dirname(outputPath),'work-test-1'));await writeFile(outputPath,'video');console.log('CUTROOM_RENDER:'+JSON.stringify({type:'complete'}));`,
  );
  const workers = createRenderWorkers({
    scratchDir: join(root, "scratch"),
    workerPath,
  });
  try {
    const state = workers.start(
      {
        project: { id: "test", dir: root },
        outputPath: join(root, "internal.mp4"),
        format: "mp4",
        fps: { num: 30, den: 1 },
        quality: "standard",
        jobId: "test",
      },
      { filename: "My cut.mp4", directory: root, range: null },
    );
    await until(() => state.status !== "rendering");
    expect(state.status).toBe("complete");
    expect(state.sizeBytes).toBe(5);
    expect(state.stage).toBe("Finished");
    expect(await readFile(join(root, "My cut.mp4"), "utf8")).toBe("video");
    expect((await readdir(root)).sort()).toEqual([
      "My cut.mp4",
      "internal.meta.json",
      "scratch",
      "worker.mjs",
    ]);
    expect(await readdir(join(root, "scratch"))).toEqual([]);
  } finally {
    await workers.cancelAll();
    await rm(root, { recursive: true, force: true });
  }
});

for (const ending of ["finish", "cancel"] as const)
  test(`a file that appears at the destination during an export is kept when it ${ending}s`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-export-replaced-"));
    const workerPath = join(root, "worker.mjs");
    // The worker finishes once the test lets it, after the destination has been taken.
    await writeFile(
      workerPath,
      `import {existsSync} from 'node:fs';import {writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';let raw='';for await(const chunk of process.stdin)raw+=chunk;const {outputPath}=JSON.parse(raw);await writeFile(outputPath,'new render');console.log('CUTROOM_RENDER:'+JSON.stringify({type:'progress',progress:50,stage:'Encoding'}));const go=join(dirname(outputPath),'..','go');while(!existsSync(go))await new Promise(r=>setTimeout(r,10));console.log('CUTROOM_RENDER:'+JSON.stringify({type:'complete'}));`,
    );
    const workers = createRenderWorkers({
      scratchDir: join(root, "scratch"),
      workerPath,
      stopTimeoutMs: 40,
    });
    const destination = join(root, "Keep.mp4");
    try {
      const state = workers.start(
        {
          project: { id: "test", dir: root },
          outputPath: join(root, "internal.mp4"),
          format: "mp4",
          fps: { num: 30, den: 1 },
          quality: "standard",
          jobId: "test",
        },
        { filename: "Keep.mp4", directory: root, range: null },
      );
      await until(() => state.stage === "Encoding");
      await writeFile(destination, "older export");
      if (ending === "cancel") await state.cancel?.();
      else {
        await writeFile(join(root, "go"), "");
        await until(() => state.status !== "rendering");
        expect(state.status).toBe("failed");
        expect(state.error).toContain("appeared there during the export");
      }
      expect(await readFile(destination, "utf8")).toBe("older export");
      expect(
        (await readdir(root)).filter((name) => name.startsWith(".cutroom-")),
      ).toEqual([]);
    } finally {
      await workers.cancelAll();
      await rm(root, { recursive: true, force: true });
    }
  });

test("cancelling after the export folder moved reports that its partial render remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-export-moved-"));
  const destination = join(root, "out");
  await mkdir(destination);
  const workerPath = join(root, "worker.mjs");
  await writeFile(
    workerPath,
    `import {writeFile} from 'node:fs/promises';let raw='';for await(const chunk of process.stdin)raw+=chunk;const {outputPath}=JSON.parse(raw);await writeFile(outputPath,'partial');console.log('CUTROOM_RENDER:'+JSON.stringify({type:'progress',progress:50,stage:'Encoding'}));setInterval(()=>{},1000);`,
  );
  const workers = createRenderWorkers({
    scratchDir: join(root, "scratch"),
    workerPath,
    stopTimeoutMs: 40,
  });
  try {
    const state = workers.start(
      {
        project: { id: "test", dir: root },
        outputPath: join(root, "internal.mp4"),
        format: "mp4",
        fps: { num: 30, den: 1 },
        quality: "standard",
        jobId: "test",
      },
      { filename: "Cut.mp4", directory: destination, range: null },
    );
    await until(() => state.stage === "Encoding");
    await rename(destination, join(root, "moved"));
    await mkdir(destination);
    await Promise.resolve(state.cancel?.()).catch(() => {});
    expect(state.status).toBe("failed");
    expect(state.error).toContain("moved during the export");
  } finally {
    await workers.cancelAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancel that arrives once the file is published leaves the export complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-export-late-cancel-"));
  const workerPath = join(root, "worker.mjs");
  await writeFile(
    workerPath,
    `import {writeFile} from 'node:fs/promises';let raw='';for await(const chunk of process.stdin)raw+=chunk;const {outputPath}=JSON.parse(raw);await writeFile(outputPath,'video');console.log('CUTROOM_RENDER:'+JSON.stringify({type:'complete'}));`,
  );
  // Slow cleanup holds the job open after the file is linked into place.
  const workers = createRenderWorkers({
    scratchDir: join(root, "scratch"),
    workerPath,
    removeScratch: async (path) => {
      await Bun.sleep(300);
      await rm(path, { recursive: true, force: true });
    },
  });
  const destination = join(root, "Cut.mp4");
  try {
    const state = workers.start(
      {
        project: { id: "test", dir: root },
        outputPath: join(root, "internal.mp4"),
        format: "mp4",
        fps: { num: 30, den: 1 },
        quality: "standard",
        jobId: "test",
      },
      { filename: "Cut.mp4", directory: root, range: null },
    );
    await until(() => existsSync(destination));
    await state.cancel?.();
    expect(state.status).toBe("complete");
    expect(await readFile(destination, "utf8")).toBe("video");
  } finally {
    await workers.cancelAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("a colliding output file is kept and the real error reaches the job", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-export-existing-"));
  const outputPath = join(root, "Keep.mp4");
  await writeFile(outputPath, "previous export");
  const workers = createRenderWorkers({ scratchDir: join(root, "scratch") });
  try {
    const state = workers.start(
      {
        project: { id: "test", dir: root },
        outputPath: join(root, "internal.mp4"),
        format: "mp4",
        fps: { num: 30, den: 1 },
        quality: "standard",
        jobId: "test",
      },
      { filename: "Keep.mp4", directory: root, range: null },
    );
    await until(() => state.status === "failed");
    expect(state.error).toContain("is already there");
    expect(await readFile(outputPath, "utf8")).toBe("previous export");
  } finally {
    await workers.cancelAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("an export's frames and range work go to the configured scratch folder, not the system's temporary folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-export-scratch-"));
  const workerPath = join(root, "worker.mjs");
  await writeFile(
    workerPath,
    `import {mkdir,writeFile} from 'node:fs/promises';import {basename,dirname,join} from 'node:path';let raw='';for await(const chunk of process.stdin)raw+=chunk;const {outputPath,scratchDir}=JSON.parse(raw);await mkdir(process.env.HYPERFRAMES_EXTRACT_CACHE_DIR,{recursive:true});await writeFile(join(process.env.HYPERFRAMES_EXTRACT_CACHE_DIR,'frame_00001.jpg'),'frame');await writeFile(join(dirname(dirname(outputPath)),'given.json'),JSON.stringify({scratchDir,frames:process.env.HYPERFRAMES_EXTRACT_CACHE_DIR}));await writeFile(outputPath,'video');console.log('CUTROOM_RENDER:'+JSON.stringify({type:'complete'}));`,
  );
  const scratchDir = join(root, "scratch");
  const workers = createRenderWorkers({ scratchDir, workerPath });
  try {
    const state = workers.start(
      {
        project: { id: "test", dir: root },
        outputPath: join(root, "internal.mp4"),
        format: "mp4",
        fps: { num: 30, den: 1 },
        quality: "standard",
        jobId: "test",
      },
      { filename: "Cut.mp4", directory: root, range: { start: 0, end: 30 } },
    );
    await until(() => state.status !== "rendering");
    expect(state.status).toBe("complete");
    const given = z
      .object({ scratchDir: z.string(), frames: z.string() })
      .parse(JSON.parse(await readFile(join(root, "given.json"), "utf8")));
    expect(given.scratchDir).toStartWith(join(scratchDir, "render-"));
    expect(given.frames).toStartWith(given.scratchDir);
    expect(await readdir(scratchDir)).toEqual([]);
  } finally {
    await workers.cancelAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("starting the renderer removes scratch that a crashed server left behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-export-sweep-"));
  const owner = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
  await owner.exited;
  const crashed = join(root, `render-${owner.pid}-abcdef`);
  const running = join(root, `render-${process.pid}-abcdef`);
  for (const path of [crashed, running]) {
    await mkdir(join(path, "frames"), { recursive: true });
    await writeFile(join(path, "frames", "frame_00001.jpg"), "frame");
  }
  const workers = createRenderWorkers({ scratchDir: root });
  try {
    await until(() => !existsSync(crashed));
    expect(existsSync(join(running, "frames", "frame_00001.jpg"))).toBe(true);
  } finally {
    await workers.cancelAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("an export sized beyond free memory fails with the reason before starting a worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-export-memory-"));
  const workerPath = join(root, "worker.mjs");
  await writeFile(
    workerPath,
    `import {writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';let raw='';for await(const chunk of process.stdin)raw+=chunk;const {outputPath}=JSON.parse(raw);await writeFile(join(dirname(dirname(outputPath)),'limits.json'),JSON.stringify({max:process.env.PRODUCER_MAX_WORKERS,min:process.env.PRODUCER_MIN_PARALLEL_FRAMES}));await writeFile(outputPath,'video');console.log('CUTROOM_RENDER:'+JSON.stringify({type:'complete'}));`,
  );
  try {
    for (const mediaClips of [1_000_000, 2]) {
      const workers = createRenderWorkers({
        scratchDir: join(root, "scratch"),
        workerPath,
        workload: async () => ({ mediaClips, durationFrames: 300 }),
      });
      try {
        const state = workers.start(
          {
            project: { id: "test", dir: root },
            outputPath: join(root, "internal.mp4"),
            format: "mp4",
            fps: { num: 30, den: 1 },
            quality: "standard",
            jobId: "test",
          },
          {
            filename: `Cut ${mediaClips}.mp4`,
            directory: root,
            range: { start: 0, end: 30 },
          },
        );
        await until(() => state.status !== "rendering");
        if (mediaClips > 2) {
          expect(state.status).toBe("failed");
          expect(state.error).toContain("GB of free memory");
          expect(existsSync(join(root, "limits.json"))).toBe(false);
        } else {
          expect(state.status).toBe("complete");
          // One browser for 30 frames, and no HyperFrames minimum that could raise it.
          const limits = z
            .object({ max: z.string(), min: z.string() })
            .parse(
              JSON.parse(await readFile(join(root, "limits.json"), "utf8")),
            );
          expect(limits.max).toBe("1");
          expect(Number(limits.min)).toBeGreaterThan(30);
        }
      } finally {
        await workers.cancelAll();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a timeline too big to capture still exports from its sources, and a fallback keeps the refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-export-direct-memory-"));
  const workerPath = join(root, "worker.mjs");
  await writeFile(
    workerPath,
    `import {writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);await writeFile(join(dirname(dirname(input.outputPath)),'input.json'),JSON.stringify({refusal:input.direct?.captureRefusal,segments:input.direct?.plan.segments.length,min:process.env.PRODUCER_MIN_PARALLEL_FRAMES??null}));await writeFile(input.outputPath,'video');console.log('CUTROOM_RENDER:'+JSON.stringify({type:'complete'}));`,
  );
  await writeFile(
    join(root, "index.html"),
    `<!doctype html><html><head></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="0"><video id="v" src="v.mp4" muted data-start="0" data-duration="10" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video></main></body></html>`,
  );
  const workers = createRenderWorkers({
    scratchDir: join(root, "scratch"),
    workerPath,
    workload: async () => ({ mediaClips: 1_000_000, durationFrames: 300 }),
  });
  try {
    const state = workers.start(
      {
        project: { id: "test", dir: root },
        outputPath: join(root, "internal.mp4"),
        format: "mp4",
        fps: { num: 30, den: 1 },
        quality: "standard",
        jobId: "test",
      },
      { filename: "Cut.mp4", directory: root, range: { start: 0, end: 30 } },
    );
    await until(() => state.status !== "rendering");
    expect(state.status).toBe("complete");
    const input = z
      .object({ refusal: z.string(), segments: z.number(), min: z.null() })
      .parse(JSON.parse(await readFile(join(root, "input.json"), "utf8")));
    expect(input.segments).toBe(1);
    expect(input.refusal).toContain("GB of free memory");
  } finally {
    await workers.cancelAll();
    await rm(root, { recursive: true, force: true });
  }
});
