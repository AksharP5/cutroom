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

/** A silent colour clip, four seconds long. */
const media = (path: string, color: string) =>
  run([
    "ffmpeg",
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${WIDTH}x${HEIGHT}:r=30:d=4`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);

/** The middle row of an image (a 2 px crop, as 4:2:0 needs), or of one frame of a video, as RGB triples. */
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

/** What a frame shows: its centre colour and the first column where blue shows. */
const read = (row: number[][]) => ({
  centre: row[WIDTH / 2]!,
  blueFrom: row.findIndex(([, , blue]) => blue! > 128),
});

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "keyframes set over MCP draw the same frames in a fresh preview and in an export, under a dissolve too",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-keyframes-"));
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
    const client = new Client({ name: "keyframe-test", version: "1" });
    try {
      const project = await store.create({
        name: "Keyframes",
        width: WIDTH,
        height: HEIGHT,
        duration: 4,
      });
      await media(join(project.path, "red.mp4"), "red");
      await media(join(project.path, "blue.mp4"), "blue");
      const box = `style="position:absolute;inset:0;width:100%;height:100%"`;
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head><body><main data-composition-id="main" data-width="${WIDTH}" data-height="${HEIGHT}" data-fps="30" data-duration="4" style="position:relative;width:${WIDTH}px;height:${HEIGHT}px;background:#000;overflow:hidden">
<video id="a" muted src="red.mp4" ${box} data-start="0" data-duration="2" data-media-start="1" data-track-index="0"></video>
<video id="b" muted src="blue.mp4" ${box} data-start="2" data-duration="2" data-media-start="1" data-track-index="0"></video>
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
          // The red shot fades up over its first second.
          {
            type: "setKeyframe",
            clipId: "a",
            property: "opacity",
            frame: 0,
            value: 0,
          },
          {
            type: "setKeyframe",
            clipId: "a",
            property: "opacity",
            frame: 30,
            value: 1,
          },
          // The blue shot slides 80 px right over its first second, eased in and out.
          {
            type: "setKeyframe",
            clipId: "b",
            property: "position",
            frame: 0,
            value: { x: 0, y: 0 },
            ease: "ease-in-out",
          },
          {
            type: "setKeyframe",
            clipId: "b",
            property: "position",
            frame: 30,
            value: { x: 80 },
          },
          // A dissolve from frame 45 to 75 brings the blue shot in from half a second before its start.
          {
            type: "setTransition",
            from: "a",
            to: "b",
            transition: { duration: 30 },
          },
        ],
      });

      // Frame 40 shows only the red shot and frame 100 only the blue one, as the files decode.
      const frames = [15, 40, 52, 60, 75, 90, 100];
      const viewed = await call("timeline_view", { frames });
      const preview = await Promise.all(
        viewed.content
          .flatMap((item) => (item.type === "image" ? [item.data] : []))
          .map(async (data) =>
            read(await middleRow(Buffer.from(data, "base64"))),
          ),
      );
      const at = (frame: number) => preview[frames.indexOf(frame)]!;
      const [red, blue] = [at(40).centre, at(100).centre];
      const mix = (from: number[], to: number[], amount: number) =>
        from.map((value, channel) => value + (to[channel]! - value) * amount);
      const near = (actual: number[], expected: number[], within: number) =>
        actual.forEach((value, channel) =>
          expect(Math.abs(value - expected[channel]!)).toBeLessThanOrEqual(
            within,
          ),
        );
      // Half way up the fade, the red shot is half its brightness over black.
      near(at(15).centre, mix([0, 0, 0], red, 0.5), 8);
      // Before its first keyframe the blue shot holds it while the dissolve brings it in.
      near(at(52).centre, mix(red, blue, 7 / 30), 8);
      near(at(60).centre, mix(red, blue, 0.5), 8);
      // Half way through the ease-in-out the shot is half way across; at its last keyframe it holds.
      expect(Math.abs(at(75).blueFrom - 40)).toBeLessThanOrEqual(1);
      expect(Math.abs(at(90).blueFrom - 80)).toBeLessThanOrEqual(1);

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
                filename: "keyframes.mp4",
              }),
            },
          )
        ).json(),
      );
      const progress = await fetch(
        `${server.url.origin}/api/render/${exported.jobId}/progress`,
      );
      expect(await progress.text()).toContain('"status":"complete"');
      const video = await Bun.file(join(project.path, "keyframes.mp4")).bytes();
      for (const [index, frame] of frames.entries()) {
        const shown = read(await middleRow(video, frame));
        near(shown.centre, preview[index]!.centre, 6);
        expect(
          Math.abs(shown.blueFrom - preview[index]!.blueFrom),
        ).toBeLessThanOrEqual(1);
      }
    } finally {
      await client.close();
      await api.dispose();
      await store.close();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
