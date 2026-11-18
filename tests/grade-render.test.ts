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
import { createGradeRoutes } from "../src/server/grade/routes";

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

/** One frame of an image or a video as RGB bytes, decoded from its colour tags. */
const pixels = (input: Uint8Array, frame?: number) =>
  run(
    [
      "ffmpeg",
      ...["-v", "error", "-i", "pipe:0", "-vf"],
      `${frame === undefined ? "" : `select=eq(n\\,${frame}),`}format=rgb24`,
      ...["-frames:v", "1", "-f", "rawvideo", "pipe:1"],
    ],
    input,
  );

/**
 * Mean and largest channel difference, in 8-bit levels, inside the chart's three bands. Where they
 * meet, 4:2:0 chroma straddles a hard edge that browsers and FFmpeg site differently, ungraded too.
 */
function difference(a: Uint8Array, b: Uint8Array) {
  let total = 0;
  let count = 0;
  let largest = 0;
  for (let y = 4; y < HEIGHT - 4; y++) {
    if (Math.abs(y - 120) < 6 || Math.abs(y - 180) < 6) continue;
    for (let x = 4; x < WIDTH - 4; x++)
      for (let channel = 0; channel < 3; channel++) {
        const at = (y * WIDTH + x) * 3 + channel;
        const step = Math.abs(a[at]! - b[at]!);
        total += step;
        count++;
        largest = Math.max(largest, step);
      }
  }
  return { mean: total / count, max: largest };
}

/**
 * A colour chart: a hue sweep over a brightness ramp on top, a grey ramp in the middle and a
 * skin-tone ramp below, smooth enough that 4:2:0 chroma keeps whole-pixel colours.
 */
const chart = `nullsrc=s=${WIDTH}x${HEIGHT}:r=30:d=2,format=gbrp,geq=r='X*255/${WIDTH - 1}':g='if(lt(Y\\,120)\\,Y*255/119\\,X*255/${WIDTH - 1})':b='if(lt(Y\\,120)\\,255-X*255/${WIDTH - 1}\\,if(lt(Y\\,180)\\,X*255/${WIDTH - 1}\\,X*150/${WIDTH - 1}))'`;

/** A look LUT: lifted, cooled shadows and warmed highlights, as a 17-point cube. */
function lookCube() {
  const size = 17;
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const [red, green, blue] = [r, g, b].map((v) => v / (size - 1)) as [
          number,
          number,
          number,
        ];
        lines.push(
          [red ** 0.85, green * 0.95 + 0.02, blue * 0.8 + 0.1 * (1 - red)]
            .map((value) => value.toFixed(6))
            .join(" "),
        );
      }
  return `${lines.join("\n")}\n`;
}

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "a grade set over MCP draws the same picture in the preview and the direct export, and its baked LUT draws it again",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-grade-"));
    const store = await createProjectStore({ dataDir: root });
    const review = createReviewService(store);
    const api = createHyperframesApi(store, review);
    const app = new Hono()
      .route("/api", api)
      .route("/api/cutroom", createTimelineRoutes(store, review))
      .route("/api/cutroom", createGradeRoutes(store, review));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 120,
      fetch: (request) => app.fetch(request),
    });
    const mcp = createMcpHttpHandler({ baseUrl: server.url.origin });
    app.all("/mcp", (c) => mcp(c.req.raw));
    const client = new Client({ name: "grade-test", version: "1" });
    try {
      const project = await store.create({
        name: "Grade",
        width: WIDTH,
        height: HEIGHT,
        duration: 2,
      });
      await run([
        "ffmpeg",
        ...["-v", "error", "-nostdin", "-f", "lavfi", "-i", chart],
        "-vf",
        "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
        ...["-c:v", "libx264", "-preset", "medium", "-crf", "4"],
        join(project.path, "chart.mp4"),
      ]);
      // The LUT starts outside the project, as one downloaded or made in another editor would.
      await writeFile(join(root, "Cool Shadows.cube"), lookCube());
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#000}main{position:relative;width:100%;height:100%;overflow:hidden}</style></head><body><main data-composition-id="main" data-width="${WIDTH}" data-height="${HEIGHT}" data-fps="30" data-duration="2">
<video id="chart" muted src="chart.mp4" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" data-start="0" data-duration="2" data-track-index="0"></video>
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
      const resultOf = <T extends z.ZodType>(
        schema: T,
        result: Awaited<ReturnType<typeof call>>,
      ): z.infer<T> =>
        schema.parse(
          z.object({ result: z.unknown() }).parse(result.structuredContent)
            .result,
        );
      const lut = resultOf(
        z.object({ path: z.string() }),
        await call("lut_import", { path: join(root, "Cool Shadows.cube") }),
      );
      expect(lut.path).toBe("luts/cool-shadows.cube");
      const edit = async (commands: unknown[]) => {
        const { revision } = resultOf(
          z.object({ revision: z.string() }),
          await call("timeline_read", {}),
        );
        await call("timeline_edit", { expectedRevision: revision, commands });
      };
      const view = async () => {
        const viewed = await call("timeline_view", { frames: [15] });
        const [image] = viewed.content.flatMap((item) =>
          item.type === "image" ? [item.data] : [],
        );
        return pixels(Buffer.from(image!, "base64"));
      };
      const ungraded = await view();

      await edit([
        {
          type: "setClip",
          clipId: "chart",
          grade: {
            lut: { src: lut.path, intensity: 0.8 },
            adjust: { exposure: 0.25, contrast: 0.2, temperature: 0.3 },
            curves: {
              master: [
                [0, 0],
                [0.25, 0.2],
                [0.75, 0.82],
                [1, 1],
              ],
              red: [
                [0, 0],
                [0.5, 0.55],
                [1, 1],
              ],
            },
          },
        },
      ]);
      const source = await readFile(join(project.path, "index.html"), "utf8");
      expect(planDirectExport(source, { num: 30, den: 1 }, null)).toMatchObject(
        { segments: [{ kind: "source", src: "chart.mp4" }] },
      );
      const graded = await view();
      // The grade moves the picture a long way; the checks below are far tighter.
      expect(difference(graded, ungraded).mean).toBeGreaterThan(15);

      const exported = z.object({ jobId: z.string() }).parse(
        await (
          await fetch(
            `${server.url.origin}/api/projects/${project.id}/export`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                range: { start: 0, end: 60 },
                quality: "high",
                directory: project.path,
                filename: "graded.mp4",
              }),
            },
          )
        ).json(),
      );
      const progress = await fetch(
        `${server.url.origin}/api/render/${exported.jobId}/progress`,
      );
      expect(await progress.text()).toContain('"status":"complete"');
      const video = await Bun.file(join(project.path, "graded.mp4")).bytes();
      // FFmpeg's LUT against the browser's shader, through two 4:2:0 encodes.
      const drawn = difference(graded, await pixels(video, 15));
      // Measured: mean 1.4, max 12.
      expect(drawn.mean).toBeLessThan(2);
      expect(drawn.max).toBeLessThan(20);

      // The whole grade, baked into a project LUT, is the same look as a LUT alone.
      const saved = resultOf(
        z.object({ path: z.string(), size: z.number() }),
        await call("grade_save_lut", { clipId: "chart", size: 65 }),
      );
      expect(saved).toMatchObject({ path: "luts/chart-grade.cube", size: 65 });
      await edit([
        { type: "setClip", clipId: "chart", grade: null },
        {
          type: "setClip",
          clipId: "chart",
          grade: { lut: { src: saved.path } },
        },
      ]);
      const again = difference(graded, await view());
      // Measured: mean 0.5, max 7, where an 8-bit 65-point LUT bends with the curves.
      expect(again.mean).toBeLessThan(1);
      expect(again.max).toBeLessThan(12);
    } finally {
      await client.close();
      await api.dispose();
      await store.close();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
