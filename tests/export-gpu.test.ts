import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, extractMediaMetadata } from "@hyperframes/engine";
import {
  encodeSourceParts,
  partEncoderArgs,
  sourceEncoder,
} from "../src/server/hyperframes/directExport";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
import { probeNvenc } from "../src/server/hyperframes/nvenc";
import type { DirectPlan } from "../src/server/hyperframes/directSchema";
import { sourcePictures } from "../src/server/media/pictureIndex";

const fps = { num: 30, den: 1 };
const plan = (width: number, height: number): DirectPlan => ({
  width,
  height,
  durationFrames: 20,
  frames: { start: 0, end: 20 },
  segments: [],
});

/** The value after `flag` in an argument list. */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test("NVENC parts get their tier's settings, one GOP and the capture path's colour tags", () => {
  for (const [quality, preset, cq] of [
    ["draft", "p3", "30"],
    ["standard", "p5", "23"],
    ["high", "p5", "20"],
  ] as const) {
    const args = partEncoderArgs(
      sourceEncoder({ plan: plan(1920, 1080), fps, quality }, "h264_nvenc"),
      120,
      ["-i", "in.mp4"],
      "out.mp4",
    );
    expect(after(args, "-c:v")).toBe("h264_nvenc");
    expect(after(args, "-preset")).toBe(preset);
    expect(after(args, "-cq")).toBe(cq);
    // Concatenated parts must not reorder frames across a join, and each is one closed GOP.
    expect(after(args, "-bf")).toBe("0");
    expect(after(args, "-g")).toBe("120");
    expect(after(args, "-frames:v")).toBe("120");
    // The graph already converted the frames; the tags must still say BT.709 limited range.
    expect(args).not.toContain("-vf");
    expect(after(args, "-colorspace:v")).toBe("bt709");
    expect(after(args, "-color_range")).toBe("tv");
    expect(after(args, "-pix_fmt")).toBe("yuv420p");
  }
  const cpu = partEncoderArgs(
    sourceEncoder(
      { plan: plan(1920, 1080), fps, quality: "standard" },
      "libx264",
    ),
    120,
    ["-i", "in.mp4"],
    "out.mp4",
  );
  expect(after(cpu, "-c:v")).toBe("libx264");
  expect(after(cpu, "-crf")).toBe("18");
});

const isX264 = async (path: string) =>
  (await readFile(path)).includes("x264 - core");

/**
 * An NVENC failure, here a frame wider than NVENC's 4096 pixels (or no GPU at all, as in CI),
 * re-encodes every part with libx264 instead of failing the export or joining mixed encoders.
 * An explicit CRF is libx264's scale, so it never goes to the GPU.
 */
test.skipIf(!Bun.which("ffmpeg"))(
  "a failing NVENC hands every part to libx264, and a chosen CRF stays on libx264",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-gpu-"));
    try {
      const source = join(root, "source.mp4");
      const child = Bun.spawn(
        [
          "ffmpeg",
          ...["-v", "error", "-f", "lavfi", "-i"],
          "testsrc2=size=320x180:rate=30:duration=1",
          ...["-c:v", "libx264", "-preset", "ultrafast", source],
        ],
        { stderr: "pipe" },
      );
      expect(await child.exited).toBe(0);
      const metadata = await extractMediaMetadata(source);
      const index = await sourcePictures(source, metadata);
      if (!index) throw new Error("The generated source has no picture index.");
      // A gap between the runs makes two parts.
      const pieces = [
        { start: 0, end: 5, mediaStart: 0 },
        { start: 8, end: 14, mediaStart: 0.5 },
      ].map((run) => ({
        kind: "source" as const,
        src: "source.mp4",
        path: source,
        video: { metadata, source: index },
        ...run,
      }));
      const encode = (size: DirectPlan, workDir: string, crf?: number) => {
        let frames = 0;
        return encodeSourceParts({
          plan: size,
          pieces,
          workDir: join(root, workDir),
          fps,
          quality: "standard",
          crf,
          gpu: true,
          engineConfig: DEFAULT_CONFIG,
          signal: new AbortController().signal,
          onFrames: (done) => (frames += done),
        }).then((result) => ({ ...result, frames }));
      };

      const wide = await encode(plan(4160, 2340), "wide");
      expect(wide.encoder).toBe("libx264");
      expect(wide.parts.map(({ start, end }) => [start, end])).toEqual([
        [0, 5],
        [8, 14],
      ]);
      for (const part of wide.parts) expect(await isX264(part.path)).toBe(true);
      // Progress counts each frame once, whichever encoder finished it.
      expect(wide.frames).toBe(11);

      const chosen = await encode(plan(640, 360), "crf", 20);
      expect(chosen.encoder).toBe("libx264");

      const preset = await encode(plan(640, 360), "preset");
      expect(preset.encoder).toBe(
        (await probeNvenc()) ? "h264_nvenc" : "libx264",
      );
      for (const part of preset.parts)
        expect(await isX264(part.path)).toBe(preset.encoder === "libx264");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

/**
 * The dialog's GPU switch and export_start's `gpu: false` keep an export drawn from its sources
 * on libx264, without even probing the GPU. Left on, the server's probe decides.
 */
test.skipIf(!Bun.which("ffmpeg") || !Bun.which("node"))(
  "an export with the GPU turned off encodes on the CPU",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-gpu-off-"));
    let probes = 0;
    const workers = createRenderWorkers({
      scratchDir: `${root}-scratch`,
      gpu: () => {
        probes++;
        return probeNvenc();
      },
    });
    try {
      const child = Bun.spawn(
        [
          "ffmpeg",
          ...["-v", "error", "-f", "lavfi", "-i"],
          "testsrc2=size=320x180:rate=30:duration=1",
          ...["-c:v", "libx264", "-preset", "ultrafast"],
          join(root, "source.mp4"),
        ],
        { stderr: "pipe" },
      );
      expect(await child.exited).toBe(0);
      await writeFile(
        join(root, "index.html"),
        `<!doctype html><html><head><meta charset="utf-8"><style>html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; } body { background: #111111; } .stage { position: relative; width: 100%; height: 100%; overflow: hidden; }</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="0" class="stage"><video id="v" src="source.mp4" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" data-start="0" data-duration="1" data-media-start="0" data-track-index="0" muted></video></main></body></html>`,
      );
      const exported = async (gpu: boolean) => {
        const filename = `gpu-${gpu}.mp4`;
        const state = workers.start(
          {
            project: { id: "gpu", dir: root },
            outputPath: join(root, filename),
            format: "mp4",
            fps,
            quality: "standard",
            jobId: filename,
          },
          { filename, directory: root, range: null, gpu },
        );
        while (state.status === "rendering") await Bun.sleep(20);
        expect(state.error).toBeUndefined();
        expect(state.renderer).toBe("direct");
        return state.encoder;
      };
      expect(await exported(false)).toBe("libx264");
      expect(probes).toBe(0);
      expect(await exported(true)).toBe(
        (await probeNvenc()) ? "h264_nvenc" : "libx264",
      );
      expect(probes).toBe(1);
    } finally {
      await workers.cancelAll();
      await rm(root, { recursive: true, force: true });
      await rm(`${root}-scratch`, { recursive: true, force: true });
    }
  },
  60_000,
);
