import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { planDirectExport } from "../src/server/hyperframes/directPlan";
import { browserExecutable } from "../src/server/hyperframes/render";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createReviewService } from "../src/server/projects/review";
import { createProjectStore } from "../src/server/projects/store";
import { createTimelineRoutes } from "../src/server/timeline/routes";

const WIDTH = 320;
const HEIGHT = 240;

async function run(args: string[], input?: Uint8Array) {
  const child = Bun.spawn(args, {
    stdin: input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [bytes, error, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return new Uint8Array(bytes);
}

/** One frame of an image or a video as RGB bytes, row by row. */
const pixels = (input: Uint8Array, frame?: number) =>
  run(
    [
      "ffmpeg",
      "-v",
      "error",
      "-i",
      "pipe:0",
      "-vf",
      `${frame === undefined ? "" : `select=eq(n\\,${frame}),`}format=rgb24`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    input,
  );
const at = (frame: Uint8Array, x: number, y: number) =>
  Array.from(frame.subarray((y * WIDTH + x) * 3, (y * WIDTH + x) * 3 + 3));

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "styles set over MCP draw the same frames in the preview and in an export, captured and direct",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-style-"));
    const store = await createProjectStore({ dataDir: root });
    const review = createReviewService(store);
    const api = createHyperframesApi(store, review);
    const app = new Hono()
      .route("/api", api)
      .route("/api/cutroom", createTimelineRoutes(store, review));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 120,
      fetch: (request) => app.fetch(request),
    });
    const mcp = createMcpHttpHandler({ baseUrl: server.url.origin });
    app.all("/mcp", (c) => mcp(c.req.raw));
    const client = new Client({ name: "style-test", version: "1" });
    try {
      const project = await store.create({
        name: "Styles",
        width: WIDTH,
        height: HEIGHT,
        duration: 4,
      });
      // A wide shot, twice as wide as it is tall: green on the left half, magenta on the right.
      await run([
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        `color=c=green:s=320x160:r=30:d=4`,
        "-f",
        "lavfi",
        "-i",
        `color=c=magenta:s=320x160:r=30:d=4`,
        "-filter_complex",
        "[0][1]hstack",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        join(project.path, "wide.mp4"),
      ]);
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#000}main{position:relative;width:100%;height:100%;overflow:hidden}#headline{position:absolute;left:0;top:60px;width:${WIDTH}px;margin:0;font:400 24px sans-serif;color:#888}#badge{position:absolute;left:60px;top:60px;width:40px;height:40px;background:#444}</style></head><body><main data-composition-id="main" data-width="${WIDTH}" data-height="${HEIGHT}" data-fps="30" data-duration="4">
<video id="wide" muted src="wide.mp4" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" data-start="0" data-duration="4" data-track-index="0"></video>
<h1 id="headline" class="clip" data-start="0" data-duration="1" data-track-index="1">Launch</h1>
<div id="badge" class="clip" data-start="1" data-duration="1" data-track-index="2"></div>
</main></body></html>`,
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${server.url.origin}/mcp`)),
      );
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = CallToolResultSchema.parse(
          await client.callTool({
            name,
            arguments: { projectId: project.id, ...args },
          }),
        );
        if (result.isError) throw new Error(JSON.stringify(result.content));
        return result;
      };
      const { revision } = z
        .object({ result: z.object({ revision: z.string() }) })
        .parse((await call("timeline_read", {})).structuredContent).result;
      await call("timeline_edit", {
        expectedRevision: revision,
        commands: [
          { type: "setClip", clipId: "wide", style: { objectFit: "cover" } },
          {
            type: "setClip",
            clipId: "headline",
            style: {
              fontSize: 64,
              fontWeight: 900,
              color: "#ffcc00",
              textAlign: "center",
              textTransform: "uppercase",
              letterSpacing: 0.05,
              lineHeight: 1,
            },
          },
          {
            type: "setClip",
            clipId: "badge",
            style: {
              width: 200,
              height: 100,
              borderRadius: 50,
              fill: { from: "#ff0000", to: "#0000ff", angle: 90 },
              shadow: { x: 0, y: 20, blur: 0, color: "#ffffff" },
            },
          },
        ],
      });
      const source = await readFile(join(project.path, "index.html"), "utf8");
      expect(source).toContain(
        `style="position:absolute; inset:0; width:100%; height:100%; object-fit: cover"`,
      );
      // FFmpeg draws the shot alone straight from its source, with the fit the agent set.
      expect(planDirectExport(source, { num: 30, den: 1 }, null)).toMatchObject(
        {
          segments: [
            { kind: "capture", start: 0, end: 60 },
            { kind: "source", start: 60, end: 120, src: "wide.mp4" },
          ],
        },
      );

      // Frame 15 shows the headline over the shot, 45 the badge, 90 the shot alone.
      const frames = [15, 45, 90];
      const viewed = await call("timeline_view", { frames });
      const preview = await Promise.all(
        viewed.content
          .flatMap((item) => (item.type === "image" ? [item.data] : []))
          .map((data) => pixels(Buffer.from(data, "base64"))),
      );
      const [headline, badge, shot] = preview as [
        Uint8Array,
        Uint8Array,
        Uint8Array,
      ];
      // Cover fills the frame: no bars above or below, and the halves meet in the middle.
      for (const frame of preview) {
        expect(at(frame, 80, 4)[1]).toBeGreaterThan(80);
        expect(at(frame, 240, 236)[0]).toBeGreaterThan(160);
      }
      // The headline is yellow capitals somewhere on its line, and nothing grey is left of it.
      const line = Array.from({ length: WIDTH }, (_, x) =>
        at(headline, x, 100),
      );
      expect(line.some(([r, g, b]) => r! > 200 && g! > 160 && b! < 80)).toBe(
        true,
      );
      // The badge is 200 px wide from x = 60, red to blue, with a white shadow 20 px below.
      expect(at(badge, 75, 110)[0]).toBeGreaterThan(160);
      expect(at(badge, 245, 110)[2]).toBeGreaterThan(160);
      expect(Math.min(...at(badge, 160, 165))).toBeGreaterThan(200);
      expect(at(shot, 160, 110)).not.toEqual(at(badge, 160, 110));

      const exported = z.object({ jobId: z.string() }).parse(
        await (
          await fetch(
            `${server.url.origin}/api/projects/${project.id}/export`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                range: { start: 0, end: 120 },
                quality: "high",
                directory: project.path,
                filename: "styles.mp4",
              }),
            },
          )
        ).json(),
      );
      const progress = await fetch(
        `${server.url.origin}/api/render/${exported.jobId}/progress`,
      );
      expect(await progress.text()).toContain('"status":"complete"');
      const video = await Bun.file(join(project.path, "styles.mp4")).bytes();
      for (const [index, frame] of frames.entries()) {
        const shown = await pixels(video, frame);
        let total = 0;
        for (let byte = 0; byte < shown.length; byte++)
          total += Math.abs(shown[byte]! - preview[index]![byte]!);
        // Encoding softens edges; a missing style would move whole regions.
        expect(total / shown.length).toBeLessThan(4);
      }
    } finally {
      await client.close();
      await api.dispose();
      await store.close();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
