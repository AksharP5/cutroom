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

/** A colour clip with a steady tone, four seconds long. */
const media = (path: string, color: string, hz: number) =>
  run([
    "ffmpeg",
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=320x240:r=30:d=4`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${hz}:sample_rate=48000:d=4`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    path,
  ]);

/** The centre pixel of an image, or of one frame of a video. */
async function centre(input: Uint8Array, frame?: number) {
  const [r = 0, g = 0, b = 0] = await run(
    [
      "ffmpeg",
      "-v",
      "error",
      "-i",
      "pipe:0",
      "-vf",
      `${frame === undefined ? "" : `select=eq(n\\,${frame}),`}crop=2:2:159:119,format=rgb24`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    input,
  );
  return [r, g, b];
}

/** Amplitude of one frequency in a window, by correlation with a sine and a cosine. */
function tone(samples: Float32Array, hz: number, from: number, to: number) {
  let sine = 0;
  let cosine = 0;
  for (let i = from; i < to; i++) {
    const phase = (2 * Math.PI * hz * i) / 48000;
    sine += samples[i]! * Math.sin(phase);
    cosine += samples[i]! * Math.cos(phase);
  }
  return (2 * Math.hypot(sine, cosine)) / (to - from);
}

const rms = (samples: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! ** 2;
  return Math.sqrt(sum / (to - from));
};

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "a cross dissolve set over MCP mixes the pictures in preview and export, and its crossfade keeps the level",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-transition-"));
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
    const client = new Client({ name: "transition-test", version: "1" });
    try {
      const project = await store.create({
        name: "Dissolve",
        width: 320,
        height: 240,
        duration: 4,
      });
      await media(join(project.path, "red.mp4"), "red", 440);
      await media(join(project.path, "blue.mp4"), "blue", 660);
      // Each shot starts a second into its file, so both have a second of media past the cut.
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}video{position:absolute;inset:0;width:320px;height:240px}</style></head><body><main data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="4" style="position:relative;width:320px;height:240px;background:#000">
<video id="a" muted src="red.mp4" data-start="0" data-duration="2" data-media-start="1" data-track-index="0" data-link="la"></video>
<video id="b" muted src="blue.mp4" data-start="2" data-duration="2" data-media-start="1" data-track-index="0" data-link="lb"></video>
<audio id="sa" src="red.mp4" data-start="0" data-duration="2" data-media-start="1" data-track-index="1" data-link="la"></audio>
<audio id="sb" src="blue.mp4" data-start="2" data-duration="2" data-media-start="1" data-track-index="1" data-link="lb"></audio>
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
      const structured = (result: z.infer<typeof CallToolResultSchema>) =>
        z
          .object({
            result: z.object({ revision: z.string() }).passthrough(),
          })
          .parse(result.structuredContent).result;
      const { revision } = structured(await call("timeline_read", {}));
      const edited = structured(
        await call("timeline_edit", {
          expectedRevision: revision,
          commands: [
            {
              type: "setTransition",
              from: "a",
              to: "b",
              transition: { duration: 30 },
            },
          ],
        }),
      );
      // The linked sound got the same transition, so the agent sees the whole change.
      const transition = {
        kind: "dissolve",
        duration: 30,
        alignment: "center",
      };
      expect(
        z
          .object({
            changes: z.object({
              clips: z.object({
                changed: z.array(z.record(z.string(), z.unknown())),
              }),
            }),
          })
          .parse(edited).changes.clips.changed,
      ).toEqual([
        { id: "a", transitionOut: transition },
        { id: "b", transitionIn: transition },
        { id: "sa", transitionOut: transition },
        { id: "sb", transitionIn: transition },
      ]);

      // The transition runs from frame 45 to 75, centred on the cut at 60.
      const frames = [30, 50, 60, 70, 90];
      const viewed = await call("timeline_view", { frames });
      const preview = await Promise.all(
        viewed.content
          .flatMap((item) => (item.type === "image" ? [item.data] : []))
          .map((data) => centre(Buffer.from(data, "base64"))),
      );
      const [before, , , , after] = preview;
      const mix = (frame: number) => {
        const progress = Math.min(1, Math.max(0, (frame - 45) / 30));
        return before!.map((value, channel) =>
          Math.round(value + (after![channel]! - value) * progress),
        );
      };
      expect(before![0]).toBeGreaterThan(200);
      expect(after![2]).toBeGreaterThan(200);
      for (const [index, frame] of frames.entries())
        for (const [channel, value] of preview[index]!.entries())
          expect(Math.abs(value - mix(frame)[channel]!)).toBeLessThanOrEqual(8);

      // A real export of frames 30 to 90 shows the same mix.
      const exported = z.object({ jobId: z.string() }).parse(
        await (
          await fetch(
            `${server.url.origin}/api/projects/${project.id}/export`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                range: { start: 30, end: 90 },
                quality: "high",
                directory: project.path,
                filename: "dissolve.mp4",
              }),
            },
          )
        ).json(),
      );
      const progress = await fetch(
        `${server.url.origin}/api/render/${exported.jobId}/progress`,
      );
      expect(await progress.text()).toContain('"status":"complete"');
      const video = await Bun.file(join(project.path, "dissolve.mp4")).bytes();
      for (const [index, frame] of frames.entries()) {
        if (frame >= 90) continue;
        const pixel = await centre(video, frame - 30);
        for (const [channel, value] of pixel.entries())
          expect(Math.abs(value - preview[index]![channel]!)).toBeLessThan(6);
      }

      // Across the cut the red shot's 440 Hz falls as the blue shot's 660 Hz rises, and the two
      // together hold the level: frame by frame it stays within half a decibel of either side.
      const samples = new Float32Array(
        (
          await run(
            [
              "ffmpeg",
              "-v",
              "error",
              "-i",
              "pipe:0",
              "-ac",
              "1",
              "-ar",
              "48000",
              "-f",
              "f32le",
              "pipe:1",
            ],
            video,
          )
        ).buffer,
      );
      const window = (frame: number) =>
        [(frame - 30) * 1600, (frame - 29) * 1600] as const;
      const level = rms(samples, ...window(32));
      expect(level).toBeGreaterThan(0.05);
      for (let frame = 33; frame < 88; frame++) {
        const db = 20 * Math.log10(rms(samples, ...window(frame)) / level);
        expect(Math.abs(db)).toBeLessThan(0.5);
      }
      // At the cut each tone plays at a quarter-sine 0.707 of its full amplitude.
      const full = level * Math.SQRT2;
      for (const hz of [440, 660])
        expect(tone(samples, hz, ...window(60)) / full).toBeCloseTo(
          Math.SQRT1_2,
          1,
        );
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
