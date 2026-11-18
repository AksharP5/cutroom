import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createHyperframesApi } from "../src/server/hyperframes/api";
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

/** A silent two-second shot: black on the left half, `color` on the right. */
const media = (path: string, color: string) =>
  run([
    "ffmpeg",
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${WIDTH}x${HEIGHT}:r=30:d=2,drawbox=x=${WIDTH / 2}:y=0:w=${WIDTH / 2}:h=${HEIGHT}:color=${color}:t=fill`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);

/** The middle row of an image, or of one frame of a video, as RGB triples. */
async function middleRow(input: Uint8Array, frame?: number) {
  const bytes = await run(
    [
      "ffmpeg",
      "-v",
      "error",
      "-i",
      "pipe:0",
      "-vf",
      `${frame === undefined ? "" : `select=eq(n\\,${frame}),`}crop=${WIDTH}:2:0:${HEIGHT / 2 - 1},format=rgb24`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    input,
  );
  return Array.from({ length: WIDTH }, (_, x) => [
    bytes[x * 3]!,
    bytes[x * 3 + 1]!,
    bytes[x * 3 + 2]!,
  ]);
}

/** The first column where the shot's colour shows, past the black half. */
const edge = (row: number[][]) =>
  row.findIndex((pixel) => Math.max(...pixel) > 128);
const brightness = (pixel: number[]) => Math.max(...pixel);

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "zoom, blur and highlight set over MCP draw the same frames in a fresh preview and in an export",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-regions-"));
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
    const client = new Client({ name: "region-test", version: "1" });
    try {
      const project = await store.create({
        name: "Regions",
        width: WIDTH,
        height: HEIGHT,
        duration: 6,
      });
      for (const [name, color] of [
        ["a", "blue"],
        ["b", "red"],
        ["c", "lime"],
      ])
        await media(join(project.path, `${name}.mp4`), color!);
      const box = `style="position:absolute;inset:0;width:100%;height:100%"`;
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head><body><main data-composition-id="main" data-width="${WIDTH}" data-height="${HEIGHT}" data-fps="30" data-duration="6" style="position:relative;width:${WIDTH}px;height:${HEIGHT}px;background:#000;overflow:hidden">
<video id="a" muted src="a.mp4" ${box} data-start="0" data-duration="2" data-track-index="0"></video>
<video id="b" muted src="b.mp4" ${box} data-start="2" data-duration="2" data-track-index="0"></video>
<video id="c" muted src="c.mp4" ${box} data-start="4" data-duration="2" data-track-index="0"></video>
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
          // A 2x zoom over both a and b, from frame 20 to 100, ramping linearly over 10 frames.
          // Its box spans x 128 to 288, so the fixed point is x 256.
          {
            type: "insert",
            track: 1,
            at: 20,
            clip: {
              kind: "adjustment",
              id: "zoom",
              duration: 80,
              region: {
                effect: "zoom",
                box: { x: 0.4, y: 0.25, width: 0.5, height: 0.5 },
                in: 10,
                out: 10,
                ease: "linear",
              },
            },
          },
          // Over c: a blur inside a box across its edge, then a highlight of the right half.
          {
            type: "insert",
            track: 1,
            at: 120,
            clip: {
              kind: "adjustment",
              id: "blur",
              duration: 30,
              region: {
                effect: "blur",
                box: { x: 0.375, y: 0.25, width: 0.25, height: 0.5 },
                blur: 12,
                in: 0,
                out: 0,
              },
            },
          },
          {
            type: "insert",
            track: 1,
            at: 150,
            clip: {
              kind: "adjustment",
              id: "highlight",
              duration: 30,
              region: {
                effect: "highlight",
                box: { x: 0.5, y: 0, width: 0.5, height: 1 },
                dim: 0.5,
                radius: 0,
                feather: 0,
                in: 0,
                out: 0,
              },
            },
          },
        ],
      });

      // Ramp start, middle and end; across the cut; the ramp out; blur; highlight.
      const frames = [20, 25, 30, 59, 60, 95, 135, 165];
      const viewed = await call("timeline_view", { frames });
      const preview = await Promise.all(
        viewed.content
          .flatMap((item) => (item.type === "image" ? [item.data] : []))
          .map((data) => middleRow(Buffer.from(data, "base64"))),
      );
      const at = (frame: number) => preview[frames.indexOf(frame)]!;
      // The edge at x 160 moves away from the fixed point at 256 by 1/s, where the box's share of
      // the frame s runs from 1 to 0.5: at the ramp's middle s is 0.75, so 256 - 96 / 0.75 = 128.
      expect(edge(at(20))).toBe(160);
      expect(Math.abs(edge(at(25)) - 128)).toBeLessThanOrEqual(1);
      expect(Math.abs(edge(at(30)) - 64)).toBeLessThanOrEqual(1);
      // The zoom runs straight across the cut onto b, and is half way out 5 frames from its end.
      expect(Math.abs(edge(at(59)) - 64)).toBeLessThanOrEqual(1);
      expect(Math.abs(edge(at(60)) - 64)).toBeLessThanOrEqual(1);
      expect(Math.abs(edge(at(95)) - 128)).toBeLessThanOrEqual(1);
      // The blur softens the edge inside its box: no hard step at x 160.
      expect(brightness(at(135)[150]!)).toBeGreaterThan(30);
      expect(brightness(at(135)[170]!)).toBeLessThan(230);
      expect(brightness(at(135)[300]!)).toBeGreaterThan(230);
      // The highlight keeps the right half and leaves the rest as dark as it was.
      expect(brightness(at(165)[300]!)).toBeGreaterThan(230);

      const exported = z.object({ jobId: z.string() }).parse(
        await (
          await fetch(
            `${server.url.origin}/api/projects/${project.id}/export`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                range: { start: 0, end: 180 },
                quality: "high",
                directory: project.path,
                filename: "regions.mp4",
              }),
            },
          )
        ).json(),
      );
      const progress = await fetch(
        `${server.url.origin}/api/render/${exported.jobId}/progress`,
      );
      expect(await progress.text()).toContain('"status":"complete"');
      const video = await Bun.file(join(project.path, "regions.mp4")).bytes();
      for (const [index, frame] of frames.entries()) {
        const shown = await middleRow(video, frame);
        expect(
          Math.abs(edge(shown) - edge(preview[index]!)),
        ).toBeLessThanOrEqual(1);
        const difference =
          shown.reduce(
            (sum, pixel, x) =>
              sum +
              pixel.reduce(
                (total, value, channel) =>
                  total + Math.abs(value - preview[index]![x]![channel]!),
                0,
              ),
            0,
          ) /
          (WIDTH * 3);
        expect(difference).toBeLessThan(4);
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
