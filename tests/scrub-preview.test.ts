import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createMediaService } from "../src/server/media/service";
import { createReviewService } from "../src/server/projects/review";
import { createProjectStore } from "../src/server/projects/store";

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "the sandboxed preview reads its project's scrub proxies by key, with byte ranges, and nothing else from the cache",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-scrub-"));
    const projects = await createProjectStore({
      dataDir: root,
      projectsDir: join(root, "projects"),
    });
    const media = createMediaService();
    const app = new Hono().route(
      "/api",
      createHyperframesApi(projects, createReviewService(projects), media),
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
    });
    try {
      const project = await projects.create({ name: "Scrub preview" });
      const ffmpeg = Bun.spawnSync([
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30:duration=1",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        join(project.path, "talk.mp4"),
      ]);
      expect(ffmpeg.exitCode).toBe(0);
      const base = `http://127.0.0.1:${server.port}`;
      const redirect = await fetch(
        `${base}/api/projects/${project.id}/isolated-preview`,
        { redirect: "manual" },
      );
      const capability = /^(\/api\/isolated\/[^/]+\/)preview/.exec(
        new URL(redirect.headers.get("location")!).pathname,
      )![1];
      const status = `${base}${capability}scrub?path=talk.mp4`;
      let response = await fetch(status);
      const deadline = Date.now() + 10_000;
      while (response.status === 202 && Date.now() < deadline) {
        await Bun.sleep(20);
        response = await fetch(status);
      }
      expect(response.status).toBe(200);
      // The opaque preview fetches with origin "null".
      expect(response.headers.get("access-control-allow-origin")).toBe("null");
      const { key } = z
        .object({ key: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(await response.json());
      const range = await fetch(`${base}${capability}scrub/${key}`, {
        headers: { range: "bytes=0-99" },
      });
      expect(range.status).toBe(206);
      expect(range.headers.get("content-type")).toBe("video/mp4");
      expect((await range.arrayBuffer()).byteLength).toBe(100);

      const probe = await media.request(project, "talk.mp4", "probe");
      for (const path of [`scrub/${probe.key}`, "scrub?path=../outside.mp4"])
        expect((await fetch(`${base}${capability}${path}`)).ok).toBe(false);
      expect(
        (await fetch(`${base}/api/isolated/not-a-capability/scrub/${key}`))
          .status,
      ).toBe(404);
    } finally {
      await server.stop(true);
      await media.dispose();
      await projects.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
