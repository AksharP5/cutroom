import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createStudioApi } from "@hyperframes/studio-server";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { browserExecutable } from "../src/server/hyperframes/render";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createReviewService } from "../src/server/projects/review";
import { createProjectStore } from "../src/server/projects/store";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { frameCaptureUrl } from "../src/client/review";
import { posterUrl } from "../src/client/home";

async function captureFixture({ neverReady = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cutroom-frame-seek-"));
  const store = await createProjectStore({ dataDir: root });
  const project = await store.create({
    name: "Frame seek",
    width: 320,
    height: 240,
    duration: 3,
  });
  await writeFile(join(project.path, "scene.json"), "{}");
  await copyFile(
    Bun.resolveSync("gsap/dist/gsap.min.js", import.meta.dir),
    join(project.path, "gsap.min.js"),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>
      html,body{margin:0}#swatch{position:absolute;inset:0;background:red;color:white;font:48px sans-serif}
    </style><script src="gsap.min.js"></script></head>
    <body><main data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="3">
      <div id="swatch" class="clip" data-start="0" data-duration="3" data-track-index="0">0</div>
    </main><script>
      window.__hf ??= {};
      window.__hf.buildReady = {scene: fetch("scene.json").then(response => response.json()).then(() => {
        if (${neverReady}) return new Promise(() => {});
        window.__timelines.main = gsap.timeline({paused:true})
          .set("#swatch", {backgroundColor:"red", textContent:"0"}, 0)
          .set("#swatch", {backgroundColor:"lime", textContent:"30"}, 1)
          .set("#swatch", {backgroundColor:"blue", textContent:"60"}, 2)
          .to({}, {duration:1}, 2);
      })};
    </script></body></html>`,
  );
  const review = createReviewService(store);
  const api = createHyperframesApi(store, review);
  const app = new Hono()
    .route("/api", api)
    .route("/api/cutroom", createTimelineRoutes(store, review));
  let rejectSetup = false;
  const sceneRequested = Promise.withResolvers<void>();
  const mcpSignals: (AbortSignal | null | undefined)[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 4961,
    idleTimeout: 120,
    async fetch(request) {
      // A local asset can finish after load. Exercise the real runtime's buildReady
      // contract without replacing its player or seek implementation.
      if (new URL(request.url).pathname.endsWith("/scene.json")) {
        sceneRequested.resolve();
        await Bun.sleep(300);
        if (rejectSetup) return new Response("invalid scene JSON");
      }
      return app.fetch(request);
    },
  });
  const mcp = createMcpHttpHandler({
    baseUrl: server.url.origin,
    fetch(url, init) {
      mcpSignals.push(init?.signal);
      return fetch(url, init);
    },
  });
  app.all("/mcp", (c) => mcp(c.req.raw));
  return {
    root,
    project,
    store,
    sceneRequested: sceneRequested.promise,
    mcpSignals,
    baseUrl: server.url.origin,
    rejectSetup() {
      rejectSetup = true;
    },
    async close() {
      await api.dispose();
      await store.close();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function frameColor(image: Uint8Array, time = 0) {
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-threads",
      "1",
      "-i",
      "pipe:0",
      "-ss",
      String(time),
      "-vf",
      "crop=2:2:160:120,format=rgb24",
      "-threads",
      "1",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  process.stdin.write(image);
  process.stdin.end();
  const bytes = new Uint8Array(
    await new Response(process.stdout).arrayBuffer(),
  );
  const error = await new Response(process.stderr).text();
  if ((await process.exited) !== 0) throw new Error(error);
  const [r = 0, g = 0, b = 0] = bytes;
  return r > 230 ? "red" : g > 230 ? "green" : b > 230 ? "blue" : "unknown";
}

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "MCP, editor frames, and MP4 exports seek after asynchronous scene setup",
  async () => {
    const fixture = await captureFixture();
    const client = new Client({ name: "frame-seek-test", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${fixture.baseUrl}/mcp`)),
      );
      for (const [frame, expected] of [
        [45, "green"],
        [75, "blue"],
        [15, "red"],
        [60, "blue"],
        [30, "green"],
        [0, "red"],
      ] as const) {
        const result = CallToolResultSchema.parse(
          await client.callTool({
            name: "timeline_view",
            arguments: { projectId: fixture.project.id, frame },
          }),
        );
        expect(result.isError).not.toBe(true);
        const image = result.content.find((item) => item.type === "image");
        if (!image || image.type !== "image")
          throw new Error("MCP returned no frame");
        expect(await frameColor(Buffer.from(image.data, "base64"))).toBe(
          expected,
        );
      }
      const frame = await fetch(
        `${fixture.baseUrl}${frameCaptureUrl(fixture.project.id, {
          time: 1.5,
          compositionPath: "index.html",
        })}`,
      );
      expect(frame.status).toBe(200);
      expect(await frameColor(new Uint8Array(await frame.arrayBuffer()))).toBe(
        "green",
      );

      // MP4 uses the producer's separate readiness gate, not thumbnails.capture.
      const render = await fetch(
        `${fixture.baseUrl}/api/projects/${fixture.project.id}/render`,
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
      const progress = await fetch(
        `${fixture.baseUrl}/api/render/${jobId}/progress`,
      );
      expect(await progress.text()).toContain('"status":"complete"');
      const video = await fetch(
        `${fixture.baseUrl}/api/render/${jobId}/download`,
      );
      expect(video.status).toBe(200);
      expect(
        await frameColor(new Uint8Array(await video.arrayBuffer()), 1.5),
      ).toBe("green");
    } finally {
      await client.close();
      await fixture.close();
    }
  },
  90_000,
);

test.skipIf(!browserExecutable())(
  "a failed scene setup returns an error instead of caching a time-zero frame",
  async () => {
    const fixture = await captureFixture();
    fixture.rejectSetup();
    try {
      const frame = await fetch(
        `${fixture.baseUrl}${frameCaptureUrl(fixture.project.id, {
          time: 1.5,
          compositionPath: "index.html",
        })}`,
      );
      expect(frame.status).toBe(500);
      expect(await frame.text()).toContain("buildReady");
    } finally {
      await fixture.close();
    }
  },
  15_000,
);

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "upgrading the renderer invalidates legacy cached MCP, poster, note and download frames",
  async () => {
    const fixture = await captureFixture();
    const client = new Client({ name: "cache-upgrade-test", version: "1" });
    try {
      const redFrames = new Map<string, Buffer>();
      for (const format of ["jpeg", "png"]) {
        const response = await fetch(
          `${fixture.baseUrl}/api/projects/${fixture.project.id}/thumbnail/index.html?t=0&format=${format}&output=source`,
        );
        expect(response.status).toBe(200);
        redFrames.set(format, Buffer.from(await response.arrayBuffer()));
      }
      // Seed the pre-upgrade cache through the upstream route, using the actual
      // time-zero image as the old renderer's result. No cache-key internals.
      const project = { id: fixture.project.id, dir: fixture.project.path };
      const legacy = createStudioApi({
        listProjects: () => [project],
        resolveProject: () => project,
        bundle: async () => null,
        lint: () => ({ findings: [] }),
        runtimeUrl: "/runtime.js",
        rendersDir: () => fixture.root,
        startRender: () => {
          throw new Error("This fixture only captures frames.");
        },
        generateThumbnail: async ({ format }) =>
          redFrames.get(format ?? "jpeg") ?? null,
      });
      const note = frameCaptureUrl(project.id, {
        time: 1.5,
        compositionPath: "index.html",
      });
      const paths = [
        `/api/projects/${project.id}/thumbnail/index.html?t=1.5&format=jpeg&output=source`,
        posterUrl(fixture.project, { duration: 3 }),
        note,
        `${note}&v=download-stamp`,
      ];
      for (const path of paths) {
        const seeded = await legacy.request(
          `${fixture.baseUrl}${path.replace(/^\/api/, "")}`,
        );
        expect(seeded.status).toBe(200);
        expect(
          await frameColor(new Uint8Array(await seeded.arrayBuffer())),
        ).toBe("red");
        const cached = await legacy.request(
          `${fixture.baseUrl}${path.replace(/^\/api/, "")}&cached=1`,
        );
        expect(cached.status).toBe(200);
      }
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${fixture.baseUrl}/mcp`)),
      );
      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: "timeline_view",
          arguments: { projectId: project.id, frame: 45 },
        }),
      );
      const image = result.content.find((item) => item.type === "image");
      if (!image || image.type !== "image")
        throw new Error("MCP returned no frame");
      expect(await frameColor(Buffer.from(image.data, "base64"))).toBe("green");
      for (const path of paths.slice(1)) {
        const frame = await fetch(`${fixture.baseUrl}${path}`);
        expect(frame.status).toBe(200);
        expect(
          await frameColor(new Uint8Array(await frame.arrayBuffer())),
        ).toBe("green");
        const cached = await fetch(`${fixture.baseUrl}${path}&cached=1`);
        expect(cached.status).toBe(200);
      }
      // The renderer namespace must preserve the caller's own version as well.
      const differentVersion = await fetch(
        `${fixture.baseUrl}${note}&v=another-stamp&cached=1`,
      );
      expect(differentVersion.status).toBe(204);
    } finally {
      await client.close();
      await fixture.close();
    }
  },
  30_000,
);

test.skipIf(!browserExecutable())(
  "cancelling timeline_view aborts both fetches and releases the capture queue",
  async () => {
    const fixture = await captureFixture({ neverReady: true });
    const client = new Client({ name: "cancel-capture-test", version: "1" });
    try {
      const healthy = await fixture.store.create({
        name: "Healthy",
        width: 320,
        height: 240,
        duration: 3,
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${fixture.baseUrl}/mcp`)),
      );
      const controller = new AbortController();
      const pending = client
        .callTool(
          {
            name: "timeline_view",
            arguments: { projectId: fixture.project.id, frame: 45 },
          },
          undefined,
          { signal: controller.signal },
        )
        .catch((error: unknown) => error);
      await fixture.sceneRequested;
      controller.abort();
      expect(await pending).toBeInstanceOf(Error);
      // Generous queue-release bound, not a capture speed budget. The old handler
      // holds this healthy request behind the cancelled scene for about 20 s.
      const next = CallToolResultSchema.parse(
        await client.callTool(
          {
            name: "timeline_view",
            arguments: { projectId: healthy.id, frame: 45 },
          },
          undefined,
          { signal: AbortSignal.timeout(3000) },
        ),
      );
      expect(next.isError).not.toBe(true);
      expect(next.content.some((item) => item.type === "image")).toBe(true);
      expect(fixture.mcpSignals).toHaveLength(4);
      expect(
        fixture.mcpSignals.slice(0, 2).every((signal) => signal?.aborted),
      ).toBe(true);
    } finally {
      await client.close();
      await fixture.close();
    }
  },
  15_000,
);

test.skipIf(!browserExecutable())(
  "a readiness timeout names the composition and the 20-second limit",
  async () => {
    const fixture = await captureFixture({ neverReady: true });
    try {
      const response = await fetch(
        `${fixture.baseUrl}${frameCaptureUrl(fixture.project.id, {
          time: 1.5,
          compositionPath: "index.html",
        })}`,
      );
      expect(response.status).toBe(500);
      const { error } = z
        .object({ error: z.string() })
        .parse(await response.json());
      expect(error).toContain(
        'HyperFrames readiness for "index.html" did not complete within 20 s.',
      );
    } finally {
      await fixture.close();
    }
  },
  30_000,
);
