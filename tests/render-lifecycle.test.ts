import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioApi } from "@hyperframes/studio-server";
import { z } from "zod";
import {
  STAGING_PREFIX,
  createRenderWorkers,
} from "../src/server/hyperframes/jobs";
import { createThumbnailRenderer } from "../src/server/hyperframes/thumbnails";

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error(
        "The test render worker did not reach its observable state.",
      );
    await Bun.sleep(5);
  }
}

test.skipIf(process.platform !== "linux")(
  "render shutdown reaps an uncooperative worker and its descendants before removing output",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cutroom-render-lifecycle-"),
    );
    const workerPath = join(directory, "worker.mjs");
    await writeFile(
      workerPath,
      `import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
let body = ""; for await (const chunk of process.stdin) body += chunk;
const { outputPath: rendered } = JSON.parse(body);
// The worker renders into a staging folder beside the destination.
const outputPath = join(dirname(dirname(rendered)), basename(rendered));
await writeFile(rendered, "partial render");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)'], {stdio:["ignore","pipe","ignore"]});
const pid = await new Promise(resolve => child.stdout.once("data", chunk => resolve(chunk.toString().trim())));
await writeFile(outputPath+".pid", pid);
console.log('CUTROOM_RENDER:' + JSON.stringify({type:"progress",progress:1,stage:"ready"}));
setInterval(() => {}, 1000);
`,
    );
    const workers = createRenderWorkers({
      scratchDir: join(directory, "scratch"),
      workerPath,
      stopTimeoutMs: 40,
    });
    const outputPath = join(directory, "render.mp4");
    try {
      const state = workers.start({
        project: { id: "test", dir: directory },
        outputPath,
        format: "mp4",
        fps: { num: 1, den: 1 },
        quality: "draft",
        jobId: "test",
      });
      await waitFor(() => state.stage === "ready");
      // The destination stays untouched until the finished file is linked into place.
      expect(existsSync(outputPath)).toBe(false);
      // The upstream HTTP cancel route writes status before invoking cancel().
      state.status = "cancelled";
      await workers.cancelAll();
      expect(state.status).toBe("cancelled");
      expect(existsSync(outputPath)).toBe(false);
      const childPid = Number(await readFile(`${outputPath}.pid`, "utf8"));
      await waitFor(() => {
        try {
          return (
            readFileSync(`/proc/${childPid}/stat`, "utf8")
              .split(") ")[1]
              ?.startsWith("Z ") ?? false
          );
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return true;
          throw error;
        }
      });
      expect(() =>
        workers.start({
          project: { id: "late", dir: directory },
          outputPath,
          format: "mp4",
          fps: { num: 1, den: 1 },
          quality: "draft",
          jobId: "late",
        }),
      ).toThrow("shutting down");
    } finally {
      await workers.cancelAll();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a closed thumbnail renderer cannot reopen Chromium for a late capture", async () => {
  const renderer = createThumbnailRenderer();
  await renderer.close();
  const capture = await renderer.capture({
    project: { id: "closed", dir: "/unused" },
    compPath: "index.html",
    seekTime: 0,
    width: 320,
    height: 240,
    outputWidth: 320,
    outputHeight: 240,
    previewUrl: "http://127.0.0.1:1/unused",
    signal: new AbortController().signal,
  });
  expect(capture).toBeNull();
  await renderer.close();
});

test("a malformed worker event fails the job and still reaps the worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-render-malformed-"));
  const workerPath = join(directory, "worker.mjs");
  await writeFile(
    workerPath,
    `process.on("SIGTERM", () => {}); console.log('CUTROOM_RENDER:{"type":"unknown"}'); setInterval(() => {}, 1000);`,
  );
  const workers = createRenderWorkers({
    scratchDir: join(directory, "scratch"),
    workerPath,
    stopTimeoutMs: 40,
  });
  try {
    const state = workers.start({
      project: { id: "test", dir: directory },
      outputPath: join(directory, "render.mp4"),
      format: "mp4",
      fps: { num: 1, den: 1 },
      quality: "draft",
      jobId: "test",
    });
    await waitFor(() => state.status === "failed");
    await workers.cancelAll();
    expect(String(state.status)).toBe("failed");
    expect(state.error).toContain("Invalid");
  } finally {
    await workers.cancelAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the HTTP render-cancel route stops its worker without shutdown and propagates cleanup failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-render-cancel-"));
  const workerPath = join(directory, "worker.mjs");
  await writeFile(
    workerPath,
    `import {writeFile} from 'node:fs/promises';import {basename,dirname,join} from 'node:path';let raw='';for await(const chunk of process.stdin)raw+=chunk;const {outputPath}=JSON.parse(raw);await writeFile(outputPath,'partial');await writeFile(join(dirname(dirname(outputPath)),basename(outputPath))+'.pid',String(process.pid));console.log('CUTROOM_RENDER:'+JSON.stringify({type:'progress',progress:1,stage:'ready'}));setInterval(()=>{},1000);`,
  );
  try {
    for (const failCleanup of [false, true]) {
      const workers = createRenderWorkers({
        scratchDir: join(directory, "scratch"),
        workerPath,
        removeScratch: async (path) => {
          await rm(path, { recursive: true, force: true });
          if (failCleanup) throw new Error("Disk refused cleanup");
        },
      });
      let state: ReturnType<typeof workers.start> | undefined;
      const project = { id: "test", dir: directory };
      const api = createStudioApi({
        listProjects: () => [project],
        resolveProject: () => project,
        bundle: async () => null,
        lint: () => ({ findings: [] }),
        runtimeUrl: "/runtime.js",
        rendersDir: () => directory,
        generateThumbnail: async () => null,
        startRender: (options) => {
          state = workers.start(options);
          return state;
        },
      });
      api.onError((error, c) => c.json({ error: error.message }, 500));
      try {
        const response = await api.request("/projects/test/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(response.status).toBe(200);
        const { jobId } = z
          .object({ jobId: z.string() })
          .parse(await response.json());
        await waitFor(() => state?.stage === "ready");
        if (!state) throw new Error("The HTTP route did not start a worker.");
        const outputPath = state.outputPath;
        const cancelled = await api.request(`/render/${jobId}/cancel`, {
          method: "POST",
        });
        const workerPid = Number(await readFile(`${outputPath}.pid`, "utf8"));
        expect(() => process.kill(workerPid, 0)).toThrow();
        if (failCleanup) {
          expect(cancelled.status).toBe(500);
          expect(await cancelled.text()).toContain("Disk refused cleanup");
          expect(state.status).toBe("failed");
          expect(state.error).toContain("Disk refused cleanup");
          expect(existsSync(outputPath)).toBe(false);
        } else {
          expect(cancelled.status).toBe(200);
          expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
          expect(existsSync(outputPath)).toBe(false);
        }
      } finally {
        await workers.cancelAll().catch(() => {});
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a worker startup failure retains its cause instead of only the Node version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-render-startup-"));
  const workerPath = join(directory, "worker.mjs");
  await writeFile(workerPath, 'import "./missing-worker-dependency.mjs";');
  const workers = createRenderWorkers({
    scratchDir: join(directory, "scratch"),
    workerPath,
  });
  try {
    const state = workers.start({
      project: { id: "test", dir: directory },
      outputPath: join(directory, "output.mp4"),
      format: "mp4",
      fps: { num: 30, den: 1 },
      quality: "standard",
      jobId: "startup-failure",
    });
    await waitFor(() => state.status === "failed");
    expect(state.error).toContain("missing-worker-dependency.mjs");
    expect(workers.get(state.id)?.error).toBe(state.error);
  } finally {
    await workers.cancelAll();
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * A worker that launches a stand-in browser through Puppeteer's real launcher under the
 * render isolation hooks, reports browser startup, then stops running JavaScript, so its
 * SIGTERM handlers and Puppeteer's exit handlers never run. The browser keeps writing
 * into the worker's temporary folder, as Chromium writes its profile there.
 */
async function stalledStartup(directory: string) {
  const workerPath = join(directory, "worker.mjs");
  await writeFile(
    workerPath,
    `import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { registerRenderIsolation } from ${JSON.stringify(join(import.meta.dir, "../src/server/hyperframes/renderIsolation.ts"))};
let body = ""; for await (const chunk of process.stdin) body += chunk;
const { outputPath: rendered } = JSON.parse(body);
registerRenderIsolation();
const { launch } = await import(${JSON.stringify(import.meta.resolve("@puppeteer/browsers"))});
const browser = launch({
  executablePath: "/bin/sh",
  args: ["-c", 'while :; do mkdir -p "$TMPDIR/profile" && date > "$TMPDIR/profile/state"; sleep 0.01; done'],
  env: process.env,
});
await writeFile(join(dirname(dirname(rendered)), basename(rendered)) + ".json", JSON.stringify({ browser: browser.nodeProcess.pid, scratch: process.env.TMPDIR }));
console.log("CUTROOM_RENDER:" + JSON.stringify({ type: "progress", progress: 20, stage: "Starting browsers (0/1 ready)", stageProgress: { code: "start_browsers", done: 0, total: 1 } }));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`,
  );
  return workerPath;
}

async function startStalled(
  workers: ReturnType<typeof createRenderWorkers>,
  directory: string,
) {
  const outputPath = join(directory, "render.mp4");
  const state = workers.start({
    project: { id: "stalled", dir: directory },
    outputPath,
    format: "mp4",
    fps: { num: 30, den: 1 },
    quality: "draft",
    jobId: "stalled",
  });
  await waitFor(() => state.stageProgress?.code === "start_browsers");
  const owned = z
    .object({ browser: z.number(), scratch: z.string() })
    .parse(JSON.parse(await readFile(`${outputPath}.json`, "utf8")));
  return { state, ...owned };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.skipIf(process.platform !== "linux")(
  "cancelling a stalled browser startup ends cancelled with its browser and scratch gone",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cutroom-render-stall-"));
    const workers = createRenderWorkers({
      scratchDir: join(directory, "scratch"),
      workerPath: await stalledStartup(directory),
      stopTimeoutMs: 100,
    });
    let browser: number | undefined;
    try {
      const { state, scratch, ...started } = await startStalled(
        workers,
        directory,
      );
      browser = started.browser;
      await state.cancel();
      expect(state.status).toBe("cancelled");
      expect(state.error).toBeUndefined();
      expect(alive(browser)).toBe(false);
      expect(existsSync(scratch)).toBe(false);
      expect(
        readdirSync(directory).filter((name) =>
          name.startsWith(STAGING_PREFIX),
        ),
      ).toEqual([]);
    } finally {
      if (browser && alive(browser)) process.kill(browser, "SIGKILL");
      await workers.cancelAll().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a browser startup that never finishes fails the export with a clear cause and cleans up",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cutroom-render-stall-"));
    const workers = createRenderWorkers({
      scratchDir: join(directory, "scratch"),
      workerPath: await stalledStartup(directory),
      stopTimeoutMs: 100,
      startupTimeoutMs: 300,
    });
    let browser: number | undefined;
    try {
      const { state, scratch, ...started } = await startStalled(
        workers,
        directory,
      );
      browser = started.browser;
      await waitFor(() => state.status !== "rendering");
      expect(state.status).toBe("failed");
      expect(state.error).toContain("browsers made no progress starting");
      expect(alive(browser)).toBe(false);
      expect(existsSync(scratch)).toBe(false);
    } finally {
      if (browser && alive(browser)) process.kill(browser, "SIGKILL");
      await workers.cancelAll().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("the startup limit spares a slow startup that keeps advancing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-render-slow-"));
  const workerPath = join(directory, "worker.mjs");
  // HyperFrames reports a retry with fewer browsers when a capture page gets stuck.
  await writeFile(
    workerPath,
    `import { writeFile } from "node:fs/promises";
let body = ""; for await (const chunk of process.stdin) body += chunk;
const { outputPath } = JSON.parse(body);
const send = (event) => console.log("CUTROOM_RENDER:" + JSON.stringify(event));
for (const [stage, total] of [["Starting browsers (0/2 ready)", 2], ["Starting browsers (0/1 ready)", 1]]) {
  send({ type: "progress", progress: 20, stage, stageProgress: { code: "start_browsers", done: 0, total } });
  await new Promise((resolve) => setTimeout(resolve, 300));
}
await writeFile(outputPath, "video");
send({ type: "complete" });
`,
  );
  const workers = createRenderWorkers({
    scratchDir: join(directory, "scratch"),
    workerPath,
    startupTimeoutMs: 450,
  });
  try {
    const state = workers.start({
      project: { id: "slow", dir: directory },
      outputPath: join(directory, "render.mp4"),
      format: "mp4",
      fps: { num: 30, den: 1 },
      quality: "draft",
      jobId: "slow",
    });
    await waitFor(() => state.status !== "rendering");
    expect(state.error).toBeUndefined();
    expect(state.status).toBe("complete");
  } finally {
    await workers.cancelAll();
    await rm(directory, { recursive: true, force: true });
  }
});
