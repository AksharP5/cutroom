import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createReviewService } from "../src/server/projects/review";
import { createProjectStore } from "../src/server/projects/store";
import { browserExecutable } from "../src/server/hyperframes/render";

async function pixel(path: string) {
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      "crop=2:2:160:120,format=rgb24",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const bytes = new Uint8Array(
    await new Response(process.stdout).arrayBuffer(),
  );
  const error = await new Response(process.stderr).text();
  if ((await process.exited) !== 0) throw new Error(error);
  return [...bytes.slice(0, 3)];
}

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "a saved canvas edit appears identically in frame capture and an encoded MP4",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-render-"));
    const store = await createProjectStore({ dataDir: root });
    const project = await store.create({
      name: "Render parity",
      width: 320,
      height: 240,
      duration: 1,
    });
    const source = join(project.path, "index.html");
    await writeFile(
      source,
      '<!doctype html><html><head><meta charset="utf-8"><title>Render parity</title><style>html,body{margin:0;overflow:hidden}</style></head><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="1" style="position:relative;width:320px;height:240px"><div id="swatch" class="clip" data-start="0" data-duration="1" data-track-index="0" style="position:absolute;inset:0;background:rgb(255,0,0)"></div></main></body></html>',
    );
    const api = createHyperframesApi(store, createReviewService(store));
    const app = new Hono().route("/api", api);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 120,
      fetch: app.fetch,
    });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const patch = await fetch(
        `${origin}/api/projects/${project.id}/file-mutations/patch-element/index.html`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            target: { id: "swatch" },
            operations: [
              {
                type: "inline-style",
                property: "background",
                value: "rgb(0, 0, 255)",
              },
            ],
          }),
        },
      );
      expect(patch.status).toBe(200);
      expect(await readFile(source, "utf8")).toContain("rgb(0, 0, 255)");
      const frame = await fetch(
        `${origin}/api/projects/${project.id}/thumbnail/index.html?t=0.5&format=png&output=source`,
      );
      expect(frame.status).toBe(200);
      const framePath = join(root, "preview.png");
      await Bun.write(framePath, frame);
      const previewPixel = await pixel(framePath);
      expect(previewPixel[2]).toBeGreaterThan(240);
      expect(previewPixel[0]).toBeLessThan(15);
      const render = await fetch(
        `${origin}/api/projects/${project.id}/render`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fps: 12,
            quality: "draft",
            format: "mp4",
            telemetryOptOut: true,
          }),
        },
      );
      expect(render.status).toBe(200);
      const { jobId } = z
        .object({ jobId: z.string() })
        .parse(await render.json());
      const progress = await fetch(`${origin}/api/render/${jobId}/progress`);
      const result = await progress.text();
      expect(result).toContain('"status":"complete"');
      const video = await fetch(`${origin}/api/render/${jobId}/download`);
      expect(video.status).toBe(200);
      const videoPath = join(root, "render.mp4");
      await Bun.write(videoPath, video);
      const renderPixel = await pixel(videoPath);
      expect(renderPixel[2]).toBeGreaterThan(230);
      expect(renderPixel[0]).toBeLessThan(20);
    } finally {
      server.stop(true);
      await api.dispose();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  // Captures Chromium frames, encodes an MP4, and decodes both outputs for pixel checks.
  90_000,
);
