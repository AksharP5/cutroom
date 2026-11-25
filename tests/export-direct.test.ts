import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
import { browserExecutable } from "../src/server/hyperframes/render";
import { probeNvenc } from "../src/server/hyperframes/nvenc";
import type { Fps } from "../src/shared/timeline/schema";
import { defaultTitle } from "../src/shared/timeline/title";
import { titleAttributes, titleStyle } from "../src/server/timeline/titles";
import { planDirectExport } from "../src/server/hyperframes/directPlan";
import {
  parseComposition,
  patchComposition,
} from "../src/server/timeline/composition";
import { applyAll } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";

const WIDTH = 640;
const HEIGHT = 360;
/** Each source frame shows its own number as 16 bits across the top band, white for 1. */
const BAND = 32;

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

const BT709 =
  "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";
const UNTAGGED = "format=yuv420p";
/** A PNG without colour chunks, which the browser draws as stored. */
const UNTAGGED_RGB =
  "setparams=color_primaries=unknown:color_trc=unknown:colorspace=unknown";

async function source(
  path: string,
  size: string,
  rate: string,
  colour: string,
  audio = false,
) {
  const width = Number(size.split("x")[0]);
  const band = (BAND * width) / WIDTH;
  const bits = Array.from(
    { length: 16 },
    (_, bit) =>
      `drawbox=x=${(bit * width) / 16}:y=0:w=${width / 16}:h=${band}:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
  );
  await command([
    "ffmpeg",
    ...["-v", "error", "-nostdin", "-f", "lavfi", "-i"],
    `testsrc2=size=${size}:rate=${rate}:duration=5`,
    ...(audio
      ? [
          "-f",
          "lavfi",
          "-i",
          "aevalsrc=0.3*sin(2*PI*(200*t+60*t*t)):s=48000:d=5",
        ]
      : []),
    "-vf",
    `drawbox=x=0:y=0:w=${width}:h=${band}:color=black:t=fill,${bits.join(",")},${colour}`,
    ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-g", "15"],
    ...(audio ? ["-c:a", "aac", "-b:a", "192k", "-shortest"] : ["-an"]),
    path,
  ]);
}

const decode = async (path: string) =>
  new Uint8Array(
    await command([
      "ffmpeg",
      ...["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24"],
      "pipe:1",
    ]),
  );
const sound = async (path: string) => {
  const bytes = await command([
    "ffmpeg",
    ...["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "48000"],
    ...["-f", "f32le", "pipe:1"],
  ]);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
};
/** Where a point of the source picture lands in the output frame. */
type Drawn = (x: number, y: number) => [number, number];
/** The number burned into the frame's band; cells drawn outside the frame read as zero. */
const frameNumber = (frame: Uint8Array, drawn: Drawn = (x, y) => [x, y]) => {
  let value = 0;
  for (let bit = 0; bit < 16; bit++) {
    const [x, y] = drawn((bit + 0.5) * (WIDTH / 16), BAND / 2).map(Math.round);
    if (x! < 0 || y! < 0 || x! >= WIDTH || y! >= HEIGHT) continue;
    const at = (y! * WIDTH + x!) * 3;
    if (frame[at]! + frame[at + 1]! + frame[at + 2]! > 3 * 128)
      value |= 1 << bit;
  }
  return value;
};

type Clip = { src: string; start: number; frames: number; mediaStart: number };

/**
 * The document Cutroom writes for linked cuts over a music bed, at the given rate, with optional
 * picture-only b-roll on the track above and a title on the track above that.
 */
function project(
  fps: Fps,
  clips: Clip[],
  extras: { broll?: Clip; titles?: { start: number; frames: number }[] } = {},
) {
  const seconds = (frames: number) =>
    String(Math.round(((frames * fps.den) / fps.num) * 1e6) / 1e6);
  const end = Math.max(...clips.map((clip) => clip.start + clip.frames));
  const timing = (clip: Clip) =>
    `data-start="${seconds(clip.start)}" data-duration="${seconds(clip.frames)}" data-media-start="${clip.mediaStart}"`;
  const pictures = clips.map(
    (clip, index) =>
      `<video id="v${index}" src="${clip.src}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" ${timing(clip)} data-track-index="0" muted></video>`,
  );
  const voice = clips[0]!;
  if (extras.broll)
    pictures.push(
      `<video id="broll" src="${extras.broll.src}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" ${timing(extras.broll)} data-track-index="1" muted></video>`,
    );
  for (const [index, title] of (extras.titles ?? []).entries())
    pictures.push(
      `<div id="title-${index}" class="clip" data-start="${seconds(title.start)}" data-duration="${seconds(title.frames)}" data-track-index="2"${titleAttributes(
        defaultTitle(fps),
        fps,
      )
        .map(([name, value]) => (value === null ? "" : ` ${name}="${value}"`))
        .join("")}>Alex Rivera</div>`,
    );
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<style>* { box-sizing: border-box; } html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; } body { background: #111111; } .stage { position: relative; width: 100%; height: 100%; overflow: hidden; }</style>${extras.titles ? titleStyle([]) : ""}</head>
<body><main id="main" data-composition-id="main" data-no-timeline data-width="${WIDTH}" data-height="${HEIGHT}" data-duration="0" class="stage">
${pictures.join("\n")}
<audio id="voice" src="${voice.src}" ${timing(voice)} data-track-index="1"></audio>
<audio id="bed" src="bed.wav" data-start="0" data-duration="${seconds(end)}" data-track-index="2" data-volume="0.5"></audio>
</main></body></html>`;
}

/**
 * The browser-free export of every frame must match frame capture: the same source frame in
 * every output frame, the same colours, and the same sound at the same samples.
 *
 * Pixel tolerance: capture reads each source frame through a JPEG extraction and a JPEG
 * screenshot, so its frames carry about 1.5/255 of mean error that FFmpeg's direct frames do not
 * (on the interview, direct frames are 48 dB from the source and captured ones 34 dB). A wrong
 * matrix, range, scale or offset moves frames by 5/255 or more, and a wrong frame by far more.
 */
async function expectParity(
  direct: string,
  capture: string,
  frames: number,
  drawn: (frame: number) => Drawn | undefined = () => undefined,
) {
  const [a, b] = await Promise.all([decode(direct), decode(capture)]);
  const size = WIDTH * HEIGHT * 3;
  expect(a.length / size).toBe(frames);
  expect(b.length / size).toBe(frames);
  for (let frame = 0; frame < frames; frame++) {
    const x = a.subarray(frame * size, (frame + 1) * size);
    const y = b.subarray(frame * size, (frame + 1) * size);
    expect(frameNumber(x, drawn(frame)), `frame ${frame}`).toBe(
      frameNumber(y, drawn(frame)),
    );
    const bias = [0, 0, 0];
    let difference = 0;
    for (let i = 0; i < size; i++) {
      bias[i % 3]! += x[i]! - y[i]!;
      difference += Math.abs(x[i]! - y[i]!);
    }
    expect(difference / size, `frame ${frame} difference`).toBeLessThan(4);
    for (const channel of bias)
      expect(
        Math.abs(channel / (size / 3)),
        `frame ${frame} bias`,
      ).toBeLessThan(1.5);
  }
  const [heard, reference] = await Promise.all([sound(direct), sound(capture)]);
  expect(heard.length).toBe(reference.length);
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < reference.length; i++) {
    signal += reference[i]! ** 2;
    noise += (heard[i]! - reference[i]!) ** 2;
  }
  // Two AAC encodes of the same mix differ by about -40 dB; one sample of lag on the chirp costs far more.
  expect(10 * Math.log10(signal / noise)).toBeGreaterThan(30);
}

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "direct upscale keeps source chroma detail until the delivery frame is sized",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-chroma-"));
    const scratchDir = `${root}-scratch`;
    const workers = createRenderWorkers({ scratchDir });
    const filename = "export.mp4";
    try {
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `nullsrc=s=${WIDTH / 2}x${HEIGHT / 2}:r=30:d=1,format=yuv444p,geq=lum=128:cb='if(mod(X,2),80,176)':cr=128`,
        "-c:v",
        "libx264",
        "-crf",
        "0",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        join(root, "stripes.mp4"),
      ]);
      await writeFile(
        join(root, "index.html"),
        `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}main{position:relative;width:100%;height:100%;overflow:hidden}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="${WIDTH}" data-height="${HEIGHT}" data-duration="1"><video id="video" src="stripes.mp4" muted data-start="0" data-duration="1" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"></video></main></body></html>`,
      );
      const outputPath = join(root, filename);
      const state = workers.start(
        {
          project: { id: "direct", dir: root },
          outputPath,
          format: "mp4",
          fps: { num: 30, den: 1 },
          quality: "high",
          jobId: filename,
        },
        { filename, directory: root, range: null },
      );
      const deadline = Date.now() + 15_000;
      while (state.status === "rendering" && Date.now() < deadline)
        await Bun.sleep(50);
      expect(state.error).toBeUndefined();
      expect(state.renderer).toBe("direct");
      const frame = await command([
        "ffmpeg",
        "-v",
        "error",
        "-i",
        outputPath,
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "rawvideo",
        "pipe:1",
      ]);
      // Each source stripe is a full chroma sample wide in the delivery frame.
      const chroma = WIDTH * HEIGHT + (WIDTH / 2) * 50;
      for (let x = 40; x < 48; x += 2)
        expect(
          Math.abs(frame[chroma + x]! - frame[chroma + x + 1]!),
        ).toBeGreaterThan(30);
    } finally {
      await workers.cancelAll();
      await rm(root, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "plain footage exports straight from the source with the frames, colours and sound frame capture gives",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-direct-"));
    const scratchDir = `${root}-scratch`;
    const direct = createRenderWorkers({ scratchDir });
    // Where the probe finds no GPU, as in CI, these encode with libx264 too.
    const gpu = createRenderWorkers({ scratchDir, gpu: probeNvenc });
    const nvenc = (await probeNvenc()) ? "h264_nvenc" : "libx264";
    const capture = createRenderWorkers({ scratchDir, directExport: false });
    try {
      await Promise.all([
        // 29.97 BT.709 at the timeline's size, with sound.
        source(join(root, "ntsc.mp4"), "640x360", "30000/1001", BT709, true),
        // 25 fps untagged SD, which Chromium draws as BT.601.
        source(join(root, "sd.mp4"), "640x360", "25", UNTAGGED),
        // 59.94 BT.709 at twice the size.
        source(join(root, "hd.mp4"), "1280x720", "60000/1001", BT709),
        // 23.976 untagged at half the size.
        source(join(root, "small.mp4"), "320x180", "24000/1001", UNTAGGED),
        command([
          "ffmpeg",
          ...["-v", "error", "-f", "lavfi", "-i"],
          "aevalsrc=0.2*sin(2*PI*(150*t+40*t*t)):s=48000:c=stereo:d=6",
          join(root, "bed.wav"),
        ]),
      ]);
      const cases = [
        {
          fps: { num: 30000, den: 1001 },
          clips: [
            { src: "ntsc.mp4", start: 0, frames: 40, mediaStart: 1.2 },
            { src: "sd.mp4", start: 40, frames: 35, mediaStart: 0.52 },
            { src: "hd.mp4", start: 75, frames: 30, mediaStart: 2 },
          ],
          ranges: [null, { start: 20, end: 90 }],
          renderer: "direct",
        },
        {
          // B-roll over the first cut draws from its source; both titles' frames are captured by
          // one set of browsers, with source frames between them.
          fps: { num: 30000, den: 1001 },
          clips: [
            { src: "ntsc.mp4", start: 0, frames: 40, mediaStart: 1.2 },
            { src: "sd.mp4", start: 40, frames: 35, mediaStart: 0.52 },
          ],
          broll: { src: "hd.mp4", start: 10, frames: 15, mediaStart: 3 },
          titles: [
            { start: 28, frames: 6 },
            { start: 50, frames: 15 },
          ],
          ranges: [null, { start: 5, end: 60 }],
          renderer: "mixed",
        },
        {
          fps: { num: 24000, den: 1001 },
          clips: [
            { src: "ntsc.mp4", start: 0, frames: 36, mediaStart: 0.7 },
            { src: "small.mp4", start: 36, frames: 36, mediaStart: 1 },
          ],
          ranges: [null],
          renderer: "direct",
        },
      ] as const;
      let exported = 0;
      for (const testCase of cases) {
        const { fps, clips, ranges } = testCase;
        await writeFile(
          join(root, "index.html"),
          project(fps, [...clips], {
            broll: "broll" in testCase ? testCase.broll : undefined,
            titles: "titles" in testCase ? [...testCase.titles] : undefined,
          }),
        );
        for (const range of ranges) {
          const outputs = [];
          // Captured parts are libx264, so a mixed export's source parts are too.
          const gpuEncoder = testCase.renderer === "direct" ? nvenc : "libx264";
          for (const [workers, renderer, encoder] of [
            [capture, "capture", undefined],
            [direct, testCase.renderer, "libx264"],
            [gpu, testCase.renderer, gpuEncoder],
          ] as const) {
            const filename = `export-${exported++}.mp4`;
            const state = workers.start(
              {
                project: { id: "direct", dir: root },
                outputPath: join(root, filename),
                format: "mp4",
                fps,
                quality: "high",
                jobId: filename,
              },
              { filename, directory: root, range },
            );
            const deadline = Date.now() + 90_000;
            while (state.status === "rendering" && Date.now() < deadline)
              await Bun.sleep(50);
            expect(state.error).toBeUndefined();
            expect(state.renderer).toBe(renderer);
            expect(state.encoder).toBe(encoder);
            outputs.push(state.outputPath);
          }
          const end = Math.max(
            ...clips.map((clip) => clip.start + clip.frames),
          );
          for (const output of outputs.slice(1))
            await expectParity(
              output,
              outputs[0]!,
              range ? range.end - range.start : end,
            );
        }
      }
    } finally {
      await Promise.all([
        direct.cancelAll(),
        gpu.cancelAll(),
        capture.cancelAll(),
      ]);
      await rm(root, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
    }
  },
  // Fifteen exports, five of them capturing up to 105 frames in Chromium.
  300_000,
);

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "zoom, blur, highlight, a graded dissolve and a title capture only their own frames",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-effects-"));
    const scratchDir = `${root}-scratch`;
    const direct = createRenderWorkers({ scratchDir });
    const capture = createRenderWorkers({ scratchDir, directExport: false });
    const fps = { num: 60, den: 1 };
    const range = { start: 0, end: 240 };
    const settings = emptyTimelineSettings();
    try {
      await Promise.all([
        source(join(root, "a.mp4"), "640x360", "60", BT709, true),
        source(join(root, "b.mp4"), "640x360", "60", BT709),
        command([
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "aevalsrc=0.15*sin(2*PI*(180*t+30*t*t)):s=48000:c=stereo:d=4",
          join(root, "bed.wav"),
        ]),
      ]);
      const base = parseComposition(
        project(
          fps,
          [
            { src: "a.mp4", start: 0, frames: 120, mediaStart: 0 },
            { src: "b.mp4", start: 120, frames: 120, mediaStart: 1 },
          ],
          { titles: [{ start: 170, frames: 15 }] },
        )
          .replace('data-duration="0"', 'data-duration="0" data-fps="60"')
          .replace(
            'data-track-index="2" data-volume=',
            'data-track-index="4" data-volume=',
          ),
        settings,
      );
      const origins = new Map<string, ClipOrigin>();
      const box = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
      const timeline = applyAll(
        base.timeline,
        CommandSchema.array().parse([
          {
            type: "setClip",
            clipId: "v0",
            grade: { adjust: { exposure: 0.2, contrast: 0.1 } },
          },
          {
            type: "setTransition",
            from: "v0",
            to: "v1",
            transition: { duration: 24 },
          },
          {
            type: "insert",
            track: 3,
            at: 20,
            clip: {
              kind: "adjustment",
              id: "zoom",
              duration: 30,
              region: { effect: "zoom", box, in: 6, out: 6 },
            },
          },
          {
            type: "insert",
            track: 3,
            at: 55,
            clip: {
              kind: "adjustment",
              id: "blur",
              duration: 15,
              region: { effect: "blur", box, blur: 9 },
            },
          },
          {
            type: "insert",
            track: 3,
            at: 80,
            clip: {
              kind: "adjustment",
              id: "highlight",
              duration: 15,
              region: { effect: "highlight", box, dim: 0.45 },
            },
          },
        ]),
        {
          mediaLengths: new Map([
            ["a.mp4", 5],
            ["b.mp4", 5],
            ["bed.wav", 4],
          ]),
          onCreate: (id, origin) => origins.set(id, origin),
        },
      );
      const html = patchComposition(base, timeline, origins);
      const plan = planDirectExport(html, fps, range);
      if ("reason" in plan) throw new Error(plan.reason);
      expect(plan.segments.filter(({ kind }) => kind === "capture")).toEqual([
        { kind: "capture", start: 20, end: 50 },
        { kind: "capture", start: 55, end: 70 },
        { kind: "capture", start: 80, end: 95 },
        { kind: "capture", start: 108, end: 132 },
        { kind: "capture", start: 170, end: 185 },
      ]);
      expect(
        planDirectExport(
          html.replace("perspective:1000px", "perspective:900px"),
          fps,
          range,
        ),
      ).toHaveProperty("reason");
      expect(
        planDirectExport(
          html.replace(
            "</head>",
            "<style>@keyframes cutroom-dissolve-in{to{opacity:.2}}</style></head>",
          ),
          fps,
          range,
        ),
      ).toHaveProperty("reason");
      await writeFile(join(root, "index.html"), html);
      const outputs = [];
      for (const [workers, renderer] of [
        [capture, "capture"],
        [direct, "mixed"],
      ] as const) {
        const filename = `${renderer}.mp4`;
        const state = workers.start(
          {
            project: { id: "effects", dir: root },
            outputPath: join(root, filename),
            format: "mp4",
            fps,
            quality: "high",
            jobId: renderer,
          },
          { filename, directory: root, range },
        );
        while (state.status === "rendering") await Bun.sleep(50);
        expect(state.error).toBeUndefined();
        expect(state.renderer).toBe(renderer);
        outputs.push(state.outputPath);
      }
      const [reference, mixed] = await Promise.all(outputs.map(decode));
      expect(reference!.length).toBe(range.end * WIDTH * HEIGHT * 3);
      expect(mixed!.length).toBe(reference!.length);
      const max = [0, 0, 0];
      const mean = [0, 0, 0];
      for (let i = 0; i < reference!.length; i++) {
        const channel = i % 3;
        const error = Math.abs(reference![i]! - mixed![i]!);
        mean[channel]! += error;
        max[channel] = Math.max(max[channel]!, error);
      }
      for (const error of mean)
        expect(error / (reference!.length / 3)).toBeLessThan(4);
      const [referenceAudio, mixedAudio] = await Promise.all(
        outputs.map(sound),
      );
      expect(mixedAudio!.length).toBe(referenceAudio!.length);
      const power = (samples: Float32Array) =>
        samples.reduce((sum, sample) => sum + sample ** 2, 0);
      const audioDb =
        10 * Math.log10(power(mixedAudio!) / power(referenceAudio!));
      expect(Math.abs(audioDb)).toBeLessThanOrEqual(0.1);
      console.info("Effect export parity", {
        meanRgb: mean.map((sum) => sum / (reference!.length / 3)),
        maxRgb: max,
        audioDb,
      });
    } finally {
      await Promise.all([direct.cancelAll(), capture.cancelAll()]);
      await rm(root, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
    }
  },
  120_000,
);

/** The browser's CSS: translate, then rotate, then scale, about the frame's centre. */
const placedAt =
  (x: number, y: number, scale: number, degrees: number, squeeze = 1): Drawn =>
  (source, v) => {
    const u = WIDTH / 2 + (source - WIDTH / 2) * squeeze;
    const [cos, sin] = [
      Math.cos((degrees * Math.PI) / 180),
      Math.sin((degrees * Math.PI) / 180),
    ];
    const [dx, dy] = [(u - WIDTH / 2) * scale, (v - HEIGHT / 2) * scale];
    return [
      WIDTH / 2 + x + dx * cos - dy * sin,
      HEIGHT / 2 + y + dx * sin + dy * cos,
    ];
  };

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "clips the inspector moved, scaled, rotated, cropped or faded, and stills, export from the source as frame capture draws them",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-placed-"));
    const scratchDir = `${root}-scratch`;
    const direct = createRenderWorkers({ scratchDir });
    const gpu = createRenderWorkers({ scratchDir, gpu: probeNvenc });
    const nvenc = (await probeNvenc()) ? "h264_nvenc" : "libx264";
    const capture = createRenderWorkers({ scratchDir, directExport: false });
    try {
      await Promise.all([
        source(join(root, "ntsc.mp4"), "640x360", "30000/1001", BT709, true),
        command([
          "ffmpeg",
          ...["-v", "error", "-f", "lavfi", "-i"],
          "aevalsrc=0.2*sin(2*PI*(150*t+40*t*t)):s=48000:c=stereo:d=6",
          join(root, "bed.wav"),
        ]),
      ]);
      // Stills of source frame 50: one at the frame's shape, one squeezed to 4:3 as a JPEG, and
      // one whose lower half is half transparent.
      const still = (output: string, filter: string, extra: string[] = []) =>
        command([
          "ffmpeg",
          ...["-v", "error", "-i", join(root, "ntsc.mp4"), "-vf"],
          `select=eq(n\\,50),${filter}`,
          ...["-frames:v", "1", ...extra, join(root, output)],
        ]);
      await Promise.all([
        still("still.png", `format=rgb24,${UNTAGGED_RGB}`),
        still("still.jpg", "scale=480:360", ["-q:v", "2"]),
        still(
          "alpha.png",
          `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(Y,180),255,110)',${UNTAGGED_RGB}`,
        ),
      ]);
      const fps = { num: 30000, den: 1001 };
      const seconds = (frames: number) =>
        String(Math.round(((frames * fps.den) / fps.num) * 1e6) / 1e6);
      const box = "position:absolute;inset:0;width:100%;height:100%";
      const position = (x: number, y: number) =>
        ` data-x="${x}" data-y="${y}" data-hf-edit-base-x="0" data-hf-edit-base-y="0"`;
      const runs = [
        // A plain cut, then the kinds the inspector writes, each on its own.
        { frames: 8, style: "", drawn: undefined },
        {
          // A punch-in that still covers the frame.
          frames: 12,
          attributes: position(60, 40),
          style: ";scale:1.25",
          drawn: placedAt(60, 40, 1.25, 0),
        },
        {
          // Smaller, turned and moved, over the page colour.
          frames: 12,
          attributes: position(20, 15),
          style: ";scale:0.7;rotate:8deg",
          drawn: placedAt(20, 15, 0.7, 8),
        },
        {
          // Cropped on three sides and faded over the page colour.
          frames: 12,
          style: ";clip-path:inset(0px 40px 30px 20px);opacity:0.6",
          drawn: undefined,
        },
        { frames: 8, still: "still.png", style: "", drawn: undefined },
        {
          // Squeezed to 4:3, so it is letterboxed over the page colour.
          frames: 8,
          still: "still.jpg",
          style: "",
          drawn: placedAt(0, 0, 1, 0, 0.75),
        },
        {
          frames: 8,
          still: "alpha.png",
          style: ";scale:0.8",
          drawn: placedAt(0, 0, 0.8, 0),
        },
      ] as const;
      let start = 0;
      const clips = runs.map((run, index) => {
        const timing = `data-start="${seconds(start)}" data-duration="${seconds(run.frames)}" data-track-index="0"`;
        const at = start;
        start += run.frames;
        return "still" in run
          ? `<img id="c${index}" class="clip" src="${run.still}" style="${box};object-fit:contain${run.style}" ${timing}>`
          : `<video id="c${index}" src="ntsc.mp4" muted style="${box};object-fit:contain${run.style}" ${timing} data-media-start="${seconds(at)}"${"attributes" in run ? run.attributes : ""}></video>`;
      });
      await writeFile(
        join(root, "index.html"),
        `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<style>* { box-sizing: border-box; } html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; } body { background: #111111; } .stage { position: relative; width: 100%; height: 100%; overflow: hidden; }</style></head>
<body><main id="main" data-composition-id="main" data-no-timeline data-width="${WIDTH}" data-height="${HEIGHT}" data-duration="0" class="stage">
${clips.join("\n")}
<audio id="voice" src="ntsc.mp4" data-start="0" data-duration="${seconds(start)}" data-track-index="1"></audio>
<audio id="bed" src="bed.wav" data-start="0" data-duration="${seconds(start)}" data-track-index="2" data-volume="0.5"></audio>
</main></body></html>`,
      );
      const outputs = [];
      for (const [workers, renderer, encoder] of [
        [capture, "capture", undefined],
        [direct, "direct", "libx264"],
        [gpu, "direct", nvenc],
      ] as const) {
        const filename = `${renderer}-${outputs.length}.mp4`;
        const state = workers.start(
          {
            project: { id: "placed", dir: root },
            outputPath: join(root, filename),
            format: "mp4",
            fps,
            quality: "high",
            jobId: filename,
          },
          { filename, directory: root, range: null },
        );
        const deadline = Date.now() + 90_000;
        while (state.status === "rendering" && Date.now() < deadline)
          await Bun.sleep(50);
        expect(state.error).toBeUndefined();
        expect(state.renderer).toBe(renderer);
        expect(state.encoder).toBe(encoder);
        outputs.push(state.outputPath);
      }
      const runOf = (frame: number) => {
        let end = 0;
        return runs.find((run) => (end += run.frames) > frame);
      };
      for (const output of outputs.slice(1))
        await expectParity(
          output,
          outputs[0]!,
          start,
          (frame) => runOf(frame)?.drawn,
        );
    } finally {
      await Promise.all([
        direct.cancelAll(),
        gpu.cancelAll(),
        capture.cancelAll(),
      ]);
      await rm(root, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
    }
  },
  300_000,
);

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "direct adjustment grades match capture after downscaling and placement",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-adjustment-"));
    const scratchDir = `${root}-scratch`;
    const direct = createRenderWorkers({ scratchDir });
    const capture = createRenderWorkers({ scratchDir, directExport: false });
    const fps = { num: 30, den: 1 };
    const range = { start: 12, end: 18 };
    try {
      // Each pair of source columns averages to a gradient. A nonlinear LUT applied
      // before that average produces a different picture from grading after resize.
      const luma = "95+75*X/W+12*Y/H+if(mod(X,2),22,-22)";
      const gradient = `geq=r='${luma}':g='${luma}':b='${luma}'`;
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        `nullsrc=s=${WIDTH * 2}x${HEIGHT * 2}:r=30`,
        "-vf",
        `format=gbrp,${gradient},${BT709},loop=loop=29:size=1:start=0,setpts=N/(30*TB)`,
        "-t",
        "1",
        "-threads",
        "2",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "12",
        join(root, "plate.mp4"),
      ]);
      const fill =
        "position:absolute;inset:0;width:100%;height:100%;object-fit:cover";
      const html = `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;background:#30a060}main{position:relative;width:100%;height:100%}</style></head><body><main data-composition-id="main" data-width="${WIDTH}" data-height="${HEIGHT}" data-duration="1" data-fps="30">
  <video id="plain" muted src="plate.mp4" data-start="0" data-duration="0.5" data-track-index="0" style="${fill}"></video>
  <video id="placed" muted src="plate.mp4" data-start="0.5" data-duration="0.5" data-track-index="0" style="${fill};scale:0.8;opacity:0.6" data-color-grading='{"adjust":{"temperature":0.15}}'></video>
  <div id="lift" class="clip" data-start="0.2" data-duration="0.6" data-track-index="1" data-cutroom-adjustment data-color-grading='{"adjust":{"exposure":0.45}}'></div>
  <div id="look" class="clip" data-start="0.2" data-duration="0.6" data-track-index="2" data-cutroom-adjustment data-color-grading='{"curves":{"master":[[0,0],[0.32,0.24],[0.58,0.64],[0.78,0.88],[1,1]]}}'></div>
</main></body></html>`;
      const plan = planDirectExport(html, fps, range);
      if ("reason" in plan) throw new Error(plan.reason);
      expect(
        plan.segments.map(({ start, end, ...segment }) => [
          start,
          end,
          segment.kind === "source" && Boolean(segment.placement),
        ]),
      ).toEqual([
        [12, 15, false],
        [15, 18, true],
      ]);
      await writeFile(join(root, "index.html"), html);
      const outputs: string[] = [];
      for (const [name, workers] of [
        ["direct", direct],
        ["capture", capture],
      ] as const) {
        const filename = name + ".mp4";
        const state = workers.start(
          {
            project: { id: name, dir: root },
            outputPath: join(root, filename),
            format: "mp4",
            fps,
            quality: "high",
            jobId: name,
          },
          { filename, directory: root, range },
        );
        const deadline = Date.now() + 20_000;
        while (state.status === "rendering" && Date.now() < deadline)
          await Bun.sleep(50);
        expect(state.error).toBeUndefined();
        expect(state.renderer).toBe(name);
        outputs.push(state.outputPath);
      }
      const [fast, browser] = await Promise.all(outputs.map(decode));

      const frameSize = WIDTH * HEIGHT * 3;
      const frames = range.end - range.start;
      expect(fast!.length).toBe(frames * frameSize);
      expect(browser!.length).toBe(frames * frameSize);
      for (let frame = 0; frame < frames; frame++) {
        const errors = new Uint32Array(256);
        let total = 0;
        const offset = frame * frameSize;
        for (let i = offset; i < offset + frameSize; i++) {
          const error = Math.abs(fast![i]! - browser![i]!);
          errors[error]!++;
          total += error;
        }
        let remaining = Math.ceil(frameSize * 0.99);
        const p99 = errors.findIndex((count) => (remaining -= count) <= 0);
        expect(
          total / frameSize,
          `frame ${frame + range.start} mean`,
        ).toBeLessThanOrEqual(1.5);
        expect(p99, `frame ${frame + range.start} p99`).toBeLessThanOrEqual(10);
      }
    } finally {
      await Promise.all([direct.cancelAll(), capture.cancelAll()]);
      await rm(root, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
    }
  },
  45_000,
);

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "marked and mixed exports keep off-range elements in the page",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-dom-"));
    const scratchDir = root + "-scratch";
    const capture = createRenderWorkers({ scratchDir, directExport: false });
    const direct = createRenderWorkers({ scratchDir });
    const fps = { num: 30, den: 1 };
    const section = { start: 60, end: 90 };
    const page = (clip: string, css: string, script = "") =>
      `<!doctype html><html><head><style>
      html,body{margin:0;width:100%;height:100%;overflow:hidden}
      .stage{position:relative;width:100%;height:100%;overflow:hidden}
      #title{position:absolute;inset:0;background:#00f}
      ${css}
      </style></head><body><main id="main" class="stage" data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-duration="3">
      ${clip}
      <div id="title" class="clip" data-start="2" data-duration="1" data-track-index="1"></div>
      ${script}</main></body></html>`;
    const logo =
      '<img id="logo" class="clip" src="logo.png" data-start="0" data-duration="1" data-track-index="0">';
    const video =
      '<video id="v1" muted src="shot.mp4" data-start="0" data-duration="1" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"></video>';
    let output = 0;
    try {
      await source(join(root, "shot.mp4"), "640x360", "30", BT709);
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=white:s=16x16",
        "-frames:v",
        "1",
        "-threads",
        "1",
        join(root, "logo.png"),
      ]);
      const render = async (
        html: string,
        renderer: "mixed" | "capture",
        range: typeof section | null,
        format: "mp4" | "mov" = "mp4",
      ) => {
        await writeFile(join(root, "index.html"), html);
        const filename = `output-${++output}.${format}`;
        const workers = renderer === "mixed" ? direct : capture;
        const state = workers.start(
          {
            project: { id: "export-dom", dir: root },
            outputPath: join(root, filename),
            format,
            fps,
            quality: "draft",
            jobId: filename,
          },
          { filename, directory: root, range },
        );
        const deadline = Date.now() + 45_000;
        while (state.status === "rendering" && Date.now() < deadline)
          await Bun.sleep(50);
        expect(state.error).toBeUndefined();
        expect(state.status).toBe("complete");
        expect(state.renderer).toBe(renderer);
        const bytes = await command([
          "ffmpeg",
          "-v",
          "error",
          "-i",
          state.outputPath,
          "-vf",
          "format=rgba,crop=1:1:320:180",
          "-pix_fmt",
          "rgba",
          "-f",
          "rawvideo",
          "pipe:1",
        ]);
        expect(bytes.length / 4).toBe(range ? 30 : 90);
        return Array.from({ length: 30 }, (_, index) => {
          const offset = (bytes.length / 4 - 30 + index) * 4;
          const [red, green, blue, alpha] = bytes.subarray(offset, offset + 4);
          return red! > 240 && green! < 16 && blue! < 16 && alpha === 255;
        });
      };
      const expected = Array.from({ length: 30 }, () => true);
      const nextVideo = video
        .replace('id="v1"', 'id="v2"')
        .replace('data-start="0"', 'data-start="1"');
      for (const [name, html, renderer, range, format] of [
        [
          "marked CSS",
          page(logo, "#main > :nth-child(2){background:#f00}"),
          "capture",
          section,
          "mp4",
        ],
        [
          "marked script",
          page(
            logo,
            "",
            '<script>if (document.getElementById("logo").getAttribute("src") === "logo.png") document.getElementById("title").style.background = "#f00";</script>',
          ),
          "capture",
          section,
          "mp4",
        ],
        [
          "mixed CSS",
          page(video + nextVideo, "#v1 ~ #title{background:#f00}"),
          "mixed",
          null,
          "mp4",
        ],
        [
          "marked ProRes",
          page(logo, "#main > :nth-child(2){background:#f00}"),
          "capture",
          section,
          "mov",
        ],
      ] as const) {
        const whole = await render(html, "capture", null, format);
        expect(whole, name).toEqual(expected);
        expect(await render(html, renderer, range, format), name).toEqual(
          whole,
        );
      }
    } finally {
      await Promise.all([direct.cancelAll(), capture.cancelAll()]);
      await rm(root, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
    }
  },
  180_000,
);
