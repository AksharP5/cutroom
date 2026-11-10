import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
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
import { spawn } from "node:child_process";
let body = ""; for await (const chunk of process.stdin) body += chunk;
const { outputPath } = JSON.parse(body);
await writeFile(outputPath, "partial render");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)'], {stdio:["ignore","pipe","ignore"]});
const pid = await new Promise(resolve => child.stdout.once("data", chunk => resolve(chunk.toString().trim())));
await writeFile(outputPath+".pid", pid);
console.log('CUTROOM_RENDER:' + JSON.stringify({type:"progress",progress:1,stage:"ready"}));
setInterval(() => {}, 1000);
`,
    );
    const workers = createRenderWorkers({ workerPath, stopTimeoutMs: 40 });
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
      expect(existsSync(outputPath)).toBe(true);
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
  const workers = createRenderWorkers({ workerPath, stopTimeoutMs: 40 });
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
    expect(state.status).toBe("failed");
    expect(state.error).toContain("Invalid");
  } finally {
    await workers.cancelAll();
    await rm(directory, { recursive: true, force: true });
  }
});
