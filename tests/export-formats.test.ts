import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
import { browserExecutable } from "../src/server/hyperframes/render";
import type { ExportFormat } from "../src/shared/export";
import type { Fps } from "../src/shared/timeline/schema";

const WIDTH = 320;
const HEIGHT = 180;

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [bytes, error, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return Buffer.from(bytes);
}

/**
 * Two seconds at 30 fps over a page background the starter also paints: an orange box that
 * appears at 0.5 s and stays, a half-transparent green box, a white circle and a tone.
 */
async function project() {
  const root = await mkdtemp(join(tmpdir(), "export-formats-"));
  await command([
    "ffmpeg",
    ...["-v", "error", "-f", "lavfi", "-i"],
    "sine=frequency=440:sample_rate=48000:duration=2",
    join(root, "tone.wav"),
  ]);
  await writeFile(
    join(root, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;overflow:hidden;background:#111}
.box{position:absolute;top:20px;width:60px;height:60px}
#title{left:20px;background:#ff8000}
#half{left:100px;background:#00ff00;opacity:.5}
#dot{position:absolute;left:200px;top:40px;width:100px;height:100px;border-radius:50%;background:#fff}
</style></head><body><main data-composition-id="main" data-width="${WIDTH}" data-height="${HEIGHT}" data-fps="30" data-duration="2" style="position:relative;width:${WIDTH}px;height:${HEIGHT}px">
<div id="title" class="clip box" data-start="0.5" data-duration="1.5" data-track-index="0"></div>
<div id="half" class="clip box" data-start="0" data-duration="2" data-track-index="1"></div>
<div id="dot" class="clip" data-start="0" data-duration="2" data-track-index="2"></div>
<audio id="tone" class="clip" src="tone.wav" data-start="0" data-duration="2" data-track-index="3"></audio>
</main></body></html>`,
  );
  return root;
}

async function render(
  root: string,
  name: string,
  options: {
    format: ExportFormat;
    fps?: Fps;
    range?: { start: number; end: number } | null;
    outputResolution?: "landscape";
    frameCache?: string;
  },
) {
  const workers = createRenderWorkers({
    scratchDir: `${root}-scratch`,
    frameCache: options.frameCache
      ? { dir: options.frameCache, maxBytes: 16 * 1024 ** 2 }
      : undefined,
  });
  const filename = `${name}.${options.format}`;
  const state = workers.start(
    {
      project: { id: "formats", dir: root },
      outputPath: join(root, filename),
      format: options.format,
      fps: options.fps ?? { num: 30, den: 1 },
      quality: "standard",
      jobId: name,
      outputResolution: options.outputResolution,
    },
    { filename, directory: root, range: options.range ?? null },
  );
  const deadline = Date.now() + 120_000;
  while (state.status === "rendering" && Date.now() < deadline)
    await Bun.sleep(50);
  expect(state.error).toBeUndefined();
  expect(state.status).toBe("complete");
  return join(root, filename);
}

const Streams = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string(),
      profile: z.string().optional(),
      pix_fmt: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      tags: z.record(z.string(), z.string()).optional(),
    }),
  ),
});
const probe = async (path: string) =>
  Streams.parse(
    JSON.parse(
      String(
        await command([
          "ffprobe",
          ...["-v", "error", "-show_streams", "-of", "json", path],
        ]),
      ),
    ),
  ).streams;

/** Every frame as RGBA, decoded the way an editor reads the file's alpha. */
async function frames(path: string, width = WIDTH, height = HEIGHT) {
  const bytes = await command([
    "ffmpeg",
    "-v",
    "error",
    // FFmpeg's own VP9 decoder drops the alpha layer; libvpx reads it.
    ...(path.endsWith(".webm") ? ["-c:v", "libvpx-vp9"] : []),
    ...["-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
  ]);
  const size = width * height * 4;
  return Array.from({ length: bytes.length / size }, (_, index) => {
    const frame = bytes.subarray(index * size, (index + 1) * size);
    return {
      at: (x: number, y: number) => {
        const offset = (y * width + x) * 4;
        return [...frame.subarray(offset, offset + 4)] as [
          number,
          number,
          number,
          number,
        ];
      },
      frame,
    };
  });
}

/** A pixel laid over pure blue, as an editor composites an overlay. */
const overBlue = ([r, g, b, a]: [number, number, number, number]) => [
  Math.round((r * a) / 255),
  Math.round((g * a) / 255),
  Math.round((b * a + 255 * (255 - a)) / 255),
];
const near = (actual: number[], expected: number[], tolerance: number) =>
  actual.every(
    (value, index) => Math.abs(value - expected[index]!) <= tolerance,
  );

const ready = browserExecutable() && Bun.which("ffmpeg");

test.skipIf(!ready)(
  "MOV, WebM and GIF keep full chroma when extracting SDR footage for browser capture",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-chroma-formats-"));
    try {
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=96x64:r=30:d=0.2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        join(root, "source.mp4"),
      ]);
      await writeFile(
        join(root, "index.html"),
        `<!doctype html><style>body{margin:0}</style>
<main data-composition-id="main" data-width="96" data-height="64" data-duration="0.2">
  <video id="picture" class="clip" src="source.mp4" muted data-start="0" data-duration="0.2" data-track-index="0"
    style="position:absolute;inset:0;width:100%;height:100%"></video>
</main>`,
      );
      for (const format of ["mov", "webm", "gif"] as const) {
        // Give each export a cold cache so it has to extract its own frame.
        const frameCache = join(`${root}-scratch`, format + "-frames");
        await render(root, format, { format, frameCache });
        const frame = (await readdir(frameCache, { recursive: true })).find(
          (name) => name.endsWith("frame_00001.jpg"),
        );
        if (!frame) throw new Error(`${format} did not extract a JPEG.`);
        expect((await probe(join(frameCache, frame)))[0], format).toMatchObject(
          {
            codec_name: "mjpeg",
            pix_fmt: "yuvj444p",
          },
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}-scratch`, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!ready)(
  "MOV and WebM exports key over a colour, whole or marked, with their codecs and sound",
  async () => {
    const root = await project();
    try {
      for (const format of ["mov", "webm"] as const)
        for (const range of [null, { start: 10, end: 40 }]) {
          const path = await render(
            root,
            `${format}-${range ? "marked" : "whole"}`,
            { format, range },
          );
          const streams = await probe(path);
          const video = streams.find((s) => s.codec_type === "video");
          const audio = streams.find((s) => s.codec_type === "audio");
          if (format === "mov") {
            expect(video?.codec_name).toBe("prores");
            expect(video?.profile).toBe("4444");
            expect(video?.pix_fmt).toStartWith("yuva444p");
            expect(audio?.codec_name).toBe("aac");
          } else {
            expect(video?.codec_name).toBe("vp9");
            expect(video?.tags?.ALPHA_MODE).toBe("1");
            expect(audio?.codec_name).toBe("opus");
          }
          const decoded = await frames(path);
          expect(decoded.length).toBe(range ? 30 : 60);
          const first = range?.start ?? 0;
          const before = decoded[12 - first]!; // 0.4 s
          const after = decoded[30 - first]!; // 1.0 s
          // The page's own background is cleared, so empty areas are transparent.
          expect(after.at(10, 170)[3]).toBe(0);
          expect(overBlue(after.at(10, 170))).toEqual([0, 0, 255]);
          expect(before.at(50, 50)[3]).toBe(0);
          expect(
            near(overBlue(after.at(50, 50)), [255, 128, 0], 4),
            String(after.at(50, 50)),
          ).toBe(true);
          // Partial transparency survives: half green over blue.
          expect(Math.abs(after.at(130, 50)[3] - 128)).toBeLessThanOrEqual(3);
          expect(
            near(overBlue(after.at(130, 50)), [0, 128, 127], 6),
            String(after.at(130, 50)),
          ).toBe(true);
        }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}-scratch`, { recursive: true, force: true });
    }
  },
  300_000,
);

test.skipIf(!ready)(
  "GIF exports keep the colours of a title that appears and stays, whole or marked",
  async () => {
    const root = await project();
    try {
      for (const range of [null, { start: 10, end: 40 }]) {
        const path = await render(root, `gif-${range ? "marked" : "whole"}`, {
          format: "gif",
          range,
        });
        expect((await probe(path))[0]?.codec_name).toBe("gif");
        const decoded = await frames(path);
        expect(decoded.length).toBe(range ? 30 : 60);
        const last = decoded.at(-1)!;
        // HyperFrames' own GIF palette leaves these out and draws the box black.
        expect(near(last.at(50, 50), [255, 128, 0, 255], 12)).toBe(true);
        expect(last.at(10, 170)[3]).toBe(0);
        expect(decoded[0]!.at(50, 50)[3]).toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}-scratch`, { recursive: true, force: true });
    }
  },
  300_000,
);

test.skipIf(!ready)(
  "a 24 fps export of a 30 fps composition shows each moment at its own time",
  async () => {
    const root = await project();
    const fps = { num: 24, den: 1 };
    try {
      // The box appears at 0.5 s: frame 12 at 24 fps. Frames 8 to 32 are 10 to 40 at 30 fps.
      for (const [range, count, appears] of [
        [null, 48, 12],
        [{ start: 8, end: 32 }, 24, 4],
      ] as const) {
        const path = await render(root, `rate-${range ? "marked" : "whole"}`, {
          format: "mov",
          fps,
          range,
        });
        const decoded = await frames(path);
        expect(decoded.length).toBe(count);
        expect(decoded[appears - 1]!.at(50, 50)[3]).toBe(0);
        expect(decoded[appears]!.at(50, 50)[3]).toBe(255);
        const stream = z
          .object({ streams: z.array(z.object({ r_frame_rate: z.string() })) })
          .parse(
            JSON.parse(
              String(
                await command([
                  "ffprobe",
                  ...["-v", "error", "-select_streams", "v:0"],
                  ...["-show_entries", "stream=r_frame_rate", "-of", "json"],
                  path,
                ]),
              ),
            ),
          ).streams[0];
        expect(stream?.r_frame_rate).toBe("24/1");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}-scratch`, { recursive: true, force: true });
    }
  },
  300_000,
);

test.skipIf(!ready)(
  "a 1080p export of a smaller composition draws the page at 1080p instead of stretching it",
  async () => {
    const root = await project();
    try {
      const path = await render(root, "supersampled", {
        format: "mp4",
        range: { start: 0, end: 3 },
        outputResolution: "landscape",
      });
      const video = (await probe(path)).find((s) => s.codec_type === "video");
      expect([video?.width, video?.height]).toEqual([1920, 1080]);
      // The circle's edge: drawn at 1080p it is about a pixel wide; stretched six times from
      // 320 x 180 it would be about six. Count the pixels between black and white.
      const { frame } = (await frames(path, 1920, 1080))[0]!;
      let edge = 0;
      for (let y = 240; y < 840; y++)
        for (let x = 1200; x < 1800; x++) {
          const luma = frame[(y * 1920 + x) * 4]!;
          if (luma > 40 && luma < 215) edge++;
        }
      const circumference = 2 * Math.PI * 300;
      expect(edge).toBeLessThan(circumference * 2);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}-scratch`, { recursive: true, force: true });
    }
  },
  300_000,
);

test.skipIf(!ready)(
  "cancelling a MOV while it captures, or a GIF while it encodes, leaves no file behind",
  async () => {
    const root = await project();
    const workers = createRenderWorkers({ scratchDir: `${root}-scratch` });
    try {
      for (const [format, when] of [
        ["mov", (stage?: string, code?: string) => code === "capture"],
        // At 1080p the GIF's own encode takes long enough to stop it there.
        ["gif", (stage?: string) => stage === "Encoding GIF"],
      ] as const) {
        const filename = `cancelled.${format}`;
        const state = workers.start(
          {
            project: { id: "formats", dir: root },
            outputPath: join(root, filename),
            format,
            fps: { num: 30, den: 1 },
            quality: "standard",
            jobId: filename,
            outputResolution: format === "gif" ? "landscape" : undefined,
          },
          { filename, directory: root, range: null },
        );
        while (
          state.status === "rendering" &&
          !when(state.stage, state.stageProgress?.code)
        )
          await Bun.sleep(5);
        expect(state.status).toBe("rendering");
        await state.cancel();
        expect(state.status).toBe("cancelled");
        expect(
          (await readdir(root)).filter((name) => name !== "tone.wav"),
        ).toEqual(["index.html"]);
        expect(await readdir(`${root}-scratch`)).toEqual([]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(`${root}-scratch`, { recursive: true, force: true });
    }
  },
  300_000,
);
