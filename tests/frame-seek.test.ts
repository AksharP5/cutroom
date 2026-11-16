import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
import { frameGrid } from "../src/server/media/frames";
import { frameSeek } from "../src/shared/frames";
import type { Fps } from "../src/shared/timeline/schema";

const WIDTH = 640;
const HEIGHT = 360;

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

/** Each frame's number in 16 blocks along its top, white for 1, on a millisecond clock as OBS writes. */
async function recording(path: string, rate: string) {
  const bits = Array.from(
    { length: 16 },
    (_, bit) =>
      `drawbox=x=${bit * 40}:y=0:w=40:h=36:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
  );
  await command([
    "ffmpeg",
    ...["-v", "error", "-f", "lavfi", "-i"],
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${rate}:duration=4`,
    ...["-vf", `drawbox=x=0:y=0:w=${WIDTH}:h=36:color=black:t=fill,${bits}`],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-g", "30"],
    ...(path.endsWith(".mp4") ? ["-video_track_timescale", "1000"] : []),
    path,
  ]);
}

/** Every frame's presentation time, in order. */
const frameTimes = async (path: string) =>
  String(
    await command([
      "ffprobe",
      ...["-v", "error", "-select_streams", "v:0"],
      ...["-show_entries", "packet=pts_time", "-of", "csv=p=0", path],
    ]),
  )
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);

/** The number each exported frame carries. */
async function exportedFrames(path: string) {
  const bytes = await command([
    "ffmpeg",
    ...["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24"],
    "pipe:1",
  ]);
  const size = WIDTH * HEIGHT * 3;
  return Array.from({ length: bytes.length / size }, (_, frame) => {
    let value = 0;
    for (let bit = 0; bit < 16; bit++) {
      const at = (frame * size + (18 * WIDTH + bit * 40 + 20) * 3) | 0;
      if (bytes[at]! + bytes[at + 1]! + bytes[at + 2]! > 3 * 128)
        value |= 1 << bit;
    }
    return value;
  });
}

test.skipIf(!Bun.which("ffmpeg"))(
  "the place the preview seeks to shows the frame export writes, at every frame, for millisecond clocks",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "frame-seek-"));
    const scratchDir = `${root}-scratch`;
    const workers = createRenderWorkers({ scratchDir });
    try {
      // OBS's 60 fps Matroska, NTSC in Matroska on a 60 fps timeline (the grids drift apart),
      // NTSC in an MP4 on a whole-millisecond clock on its own rate, and 30 on 60.
      const cases: {
        file: string;
        rate: string;
        fps: Fps;
        mediaStart: number;
      }[] = [
        {
          file: "obs.mkv",
          rate: "60",
          fps: { num: 60, den: 1 },
          mediaStart: 1,
        },
        {
          file: "ntsc.mkv",
          rate: "60000/1001",
          fps: { num: 60, den: 1 },
          mediaStart: 0,
        },
        {
          file: "ntsc.mp4",
          rate: "30000/1001",
          fps: { num: 30000, den: 1001 },
          mediaStart: 0,
        },
        {
          file: "thirty.mkv",
          rate: "30",
          fps: { num: 60, den: 1 },
          mediaStart: 0.25,
        },
      ];
      const frames = 90;
      for (const { file, rate, fps, mediaStart } of cases) {
        const source = join(root, file);
        await recording(source, rate);
        const seconds = (frame: number) =>
          String(Math.round(((frame * fps.den) / fps.num) * 1e6) / 1e6);
        await writeFile(
          join(root, "index.html"),
          `<!doctype html><html><head><style>html,body{margin:0;background:#111111}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="${WIDTH}" data-height="${HEIGHT}" data-duration="0"><video id="v" src="${file}" style="position:absolute;inset:0;width:100%;height:100%" data-start="0" data-duration="${seconds(frames)}" data-media-start="${mediaStart}" data-track-index="0" muted></video></main></body></html>`,
        );
        const filename = `${file}.mp4`;
        const state = workers.start(
          {
            project: { id: "frames", dir: root },
            outputPath: join(root, filename),
            format: "mp4",
            fps,
            quality: "high",
            jobId: filename,
          },
          { filename, directory: root, range: null },
        );
        while (state.status === "rendering") await Bun.sleep(50);
        expect(state.error).toBeUndefined();
        const exported = await exportedFrames(state.outputPath);
        expect(exported).toHaveLength(frames);

        const times = await frameTimes(source);
        const grid = await frameGrid(source);
        if (!grid) throw new Error(`${file} has no frame grid.`);
        // Where each player puts a paused video seeked to `time`: Chromium's MP4 and Matroska
        // players and the footage pipeline show the last frame starting at or before it, a
        // Matroska frame can start a millisecond late, and the HLS player of an editing
        // proxy's later pieces shows the frame nearest it.
        const atOrBefore = (time: number, late = 0) =>
          times.findLastIndex((start) => start + late <= time + 1e-6);
        const nearest = (time: number) =>
          times.reduce(
            (best, start, index) =>
              Math.abs(start - time) < Math.abs(times[best]! - time)
                ? index
                : best,
            0,
          );
        const shown = {
          atOrBefore: [] as number[],
          lateMatroska: [] as number[],
          nearest: [] as number[],
          unsnapped: [] as number[],
        };
        for (let frame = 0; frame < frames; frame++) {
          // The runtime asks for the slot's media time with its 10 microsecond lead.
          const time = mediaStart + (frame * fps.den) / fps.num + 1e-5;
          const seek = frameSeek(grid, time);
          shown.atOrBefore.push(atOrBefore(seek));
          shown.lateMatroska.push(atOrBefore(seek, 0.001));
          shown.nearest.push(nearest(seek));
          shown.unsnapped.push(atOrBefore(time));
        }
        expect(shown.atOrBefore, file).toEqual(exported);
        expect(shown.lateMatroska, file).toEqual(exported);
        expect(shown.nearest, file).toEqual(exported);
        // The fixture's clock is rounded: seeking to the slot itself shows another frame somewhere.
        expect(shown.unsnapped, file).not.toEqual(exported);
      }
    } finally {
      await workers.cancelAll();
      await rm(root, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
    }
  },
  120_000,
);
