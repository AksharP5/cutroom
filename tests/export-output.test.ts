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
    const workers = createRenderWorkers({ workerPath, stopTimeoutMs: 40 });
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
        "worker.mjs",
        "worker.pid",
      ]);
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
  const workers = createRenderWorkers({ workerPath });
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
      "worker.mjs",
    ]);
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
    const workers = createRenderWorkers({ workerPath, stopTimeoutMs: 40 });
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
  const workers = createRenderWorkers({ workerPath, stopTimeoutMs: 40 });
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
  const workers = createRenderWorkers();
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
