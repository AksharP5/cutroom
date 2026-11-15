import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
import { browserExecutable } from "../src/server/hyperframes/render";
import type { Fps } from "../src/shared/timeline/schema";

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
const frameNumber = (frame: Uint8Array) => {
  let value = 0;
  for (let bit = 0; bit < 16; bit++) {
    const at = ((BAND / 2) * WIDTH + (bit + 0.5) * (WIDTH / 16)) * 3;
    if (frame[at]! + frame[at + 1]! + frame[at + 2]! > 3 * 128)
      value |= 1 << bit;
  }
  return value;
};

type Clip = { src: string; start: number; frames: number; mediaStart: number };

/** The document Cutroom writes for linked cuts over a music bed, at the given rate. */
function project(fps: Fps, clips: Clip[]) {
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
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<style>* { box-sizing: border-box; } html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; } body { background: #111111; } .stage { position: relative; width: 100%; height: 100%; overflow: hidden; }</style></head>
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
async function expectParity(direct: string, capture: string, frames: number) {
  const [a, b] = await Promise.all([decode(direct), decode(capture)]);
  const size = WIDTH * HEIGHT * 3;
  expect(a.length / size).toBe(frames);
  expect(b.length / size).toBe(frames);
  for (let frame = 0; frame < frames; frame++) {
    const x = a.subarray(frame * size, (frame + 1) * size);
    const y = b.subarray(frame * size, (frame + 1) * size);
    expect(frameNumber(x), `frame ${frame}`).toBe(frameNumber(y));
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
  "plain footage exports straight from the source with the frames, colours and sound frame capture gives",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-direct-"));
    const scratchDir = `${root}-scratch`;
    const direct = createRenderWorkers({ scratchDir });
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
        },
        {
          fps: { num: 24000, den: 1001 },
          clips: [
            { src: "ntsc.mp4", start: 0, frames: 36, mediaStart: 0.7 },
            { src: "small.mp4", start: 36, frames: 36, mediaStart: 1 },
          ],
          ranges: [null],
        },
      ];
      let exported = 0;
      for (const { fps, clips, ranges } of cases) {
        await writeFile(join(root, "index.html"), project(fps, clips));
        for (const range of ranges) {
          const outputs = [];
          for (const [workers, renderer] of [
            [direct, "direct"],
            [capture, "capture"],
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
            outputs.push(state.outputPath);
          }
          const end = Math.max(
            ...clips.map((clip) => clip.start + clip.frames),
          );
          await expectParity(
            outputs[0]!,
            outputs[1]!,
            range ? range.end - range.start : end,
          );
        }
      }
    } finally {
      await Promise.all([direct.cancelAll(), capture.cancelAll()]);
      await rm(root, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
    }
  },
  // Six exports, three of them capturing up to 105 frames in Chromium.
  300_000,
);
