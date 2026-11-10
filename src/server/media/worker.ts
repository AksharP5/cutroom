import { join } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { z } from "zod";
import { encodePeaks, peakSampleRate } from "./peaks";
import { FilmstripSchema, MediaInfoSchema, MediaTaskSchema } from "./protocol";
import { mediaSettings } from "../../shared/media";
import { scaleFilter, tileWidth } from "./settings";

const task = MediaTaskSchema.parse(await Bun.stdin.json());
let cancelled = false;
let child: ReturnType<typeof Bun.spawn> | undefined;
process.on("SIGTERM", () => {
  cancelled = true;
  child?.kill("SIGTERM");
});
const inputOptions = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,mp3,wav,flac,aac,ogg,aiff,avi,asf,mpeg,mpegts,flv,mxf,w64,caf",
];
async function run(
  args: string[],
  consume?: (stream: ReadableStream<Uint8Array>) => Promise<unknown>,
  onLine?: (line: string) => void,
) {
  if (cancelled) throw new Error("Media job cancelled.");
  const process = Bun.spawn(args, {
    cwd: task.directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  child = process;
  let tail = "";
  const errors = (async () => {
    const decoder = new TextDecoder();
    let remaining = "";
    for await (const chunk of process.stderr) {
      const text = decoder.decode(chunk, { stream: true });
      tail = (tail + text).slice(-8000);
      if (!onLine) continue;
      const lines = (remaining + text).split("\n");
      remaining = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
    if (onLine && remaining) onLine(remaining);
  })();
  try {
    const result = await (consume
      ? consume(process.stdout)
      : new Response(process.stdout).text());
    const code = await process.exited;
    await errors;
    if (cancelled) throw new Error("Media job cancelled.");
    if (code !== 0)
      throw new Error(tail.trim() || `FFmpeg exited with code ${code}.`);
    return result;
  } finally {
    if (process.exitCode === null) process.kill("SIGKILL");
    await process.exited;
    await errors;
    child = undefined;
  }
}
const ffmpeg = [
  task.ffmpeg,
  "-nostdin",
  "-v",
  "error",
  "-threads",
  "1",
  "-filter_threads",
  "1",
];
const rational = (value: string | undefined, separator: string) => {
  if (!value) return 0;
  const [num, den] = value.split(separator).map(Number);
  return num && den ? num / den : 0;
};
try {
  if (task.kind === "probe") {
    const raw = await run([
      task.ffprobe,
      "-v",
      "error",
      ...inputOptions,
      "-show_entries",
      "format=duration:stream=codec_type,channels,width,height,avg_frame_rate,r_frame_rate,sample_aspect_ratio,duration:stream_side_data=rotation",
      "-of",
      "json",
      task.source,
    ]);
    const probe = z
      .object({
        streams: z.array(
          z.object({
            codec_type: z.string(),
            channels: z.number().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
            avg_frame_rate: z.string().optional(),
            r_frame_rate: z.string().optional(),
            sample_aspect_ratio: z.string().optional(),
            duration: z.string().optional(),
            side_data_list: z
              .array(z.object({ rotation: z.number().optional() }))
              .optional(),
          }),
        ),
        format: z.object({ duration: z.string().optional() }),
      })
      .parse(JSON.parse(z.string().parse(raw)));
    const audio = probe.streams.find((stream) => stream.codec_type === "audio");
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const rotated =
      Math.abs(
        video?.side_data_list?.find((data) => data.rotation !== undefined)
          ?.rotation ?? 0,
      ) %
        180 ===
      90;
    const aspect = rational(video?.sample_aspect_ratio, ":") || 1;
    const info = MediaInfoSchema.parse({
      channels: audio?.channels,
      video: video && {
        width: rotated ? video.height : video.width,
        height: rotated ? video.width : video.height,
        pixelAspect: rotated ? 1 / aspect : aspect,
        fps:
          rational(video.avg_frame_rate, "/") ||
          rational(video.r_frame_rate, "/") ||
          30,
        duration: Number(video.duration ?? probe.format.duration ?? 0),
      },
    });
    await Bun.write(join(task.directory, "probe.json"), JSON.stringify(info));
  } else if (task.kind === "peaks") {
    const channels = task.info?.channels;
    if (!channels) throw new Error("The media has no audio stream.");
    await run(
      [
        ...ffmpeg,
        ...inputOptions,
        "-i",
        task.source,
        "-map",
        "0:a:0",
        "-vn",
        "-ar",
        String(peakSampleRate),
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
      ],
      async (stream) => {
        await Bun.write(
          join(task.directory, "peaks.bin"),
          await encodePeaks(stream, channels),
        );
      },
    );
  } else {
    const video = task.info?.video;
    if (!video) throw new Error("The media has no video stream.");
    if (task.kind === "frame") {
      await run([
        ...ffmpeg,
        ...inputOptions,
        "-ss",
        String(task.time),
        "-i",
        task.source,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        scaleFilter(video),
        "-frames:v",
        "1",
        "-threads",
        "1",
        "-q:v",
        String(mediaSettings.jpegQuality),
        "-update",
        "1",
        "frame.jpg",
      ]);
      if (!(await Bun.file(join(task.directory, "frame.jpg")).exists()))
        throw new Error("No video frame exists at that time.");
    } else {
      await mkdir(join(task.directory, "frames"));
      let lastKey = 0;
      let maxGap = 0;
      // Map a 2.002 s NTSC keyframe to its 2 s slot, while retaining the last keyframe at EOF.
      await run(
        [
          ...ffmpeg,
          "-v",
          "info",
          ...inputOptions,
          "-skip_frame",
          "nokey",
          "-i",
          task.source,
          "-map",
          "0:v:0",
          "-an",
          "-vf",
          `showinfo,fps=1/${mediaSettings.filmstripInterval}:start_time=0:round=near:eof_action=pass,${scaleFilter(video)}`,
          "-threads",
          "1",
          "frames/frame-%06d.png",
        ],
        undefined,
        (line) => {
          if (!line.includes("showinfo")) return;
          const match = /pts_time:([\d.eE+-]+)/.exec(line);
          if (!match) return;
          const time = Number(match[1]);
          maxGap = Math.max(maxGap, time - lastKey);
          lastKey = time;
        },
      );
      let count = (await readdir(join(task.directory, "frames"))).length;
      maxGap = Math.max(maxGap, video.duration - lastKey);
      if (maxGap > mediaSettings.filmstripInterval + 1 / video.fps) {
        await rm(join(task.directory, "frames"), { recursive: true });
        await mkdir(join(task.directory, "frames"));
        count = 0;
      }
      // Keep the keyframe overview and decode only slots beyond its last tile.
      for (
        let time = count * mediaSettings.filmstripInterval;
        time < video.duration;
        time += mediaSettings.filmstripInterval
      ) {
        const seekTime = Math.floor(time * video.fps + 1e-7) / video.fps;
        const name = `frames/frame-${String(count + 1).padStart(6, "0")}.png`;
        await run([
          ...ffmpeg,
          ...inputOptions,
          "-ss",
          String(seekTime),
          "-i",
          task.source,
          "-map",
          "0:v:0",
          "-an",
          "-vf",
          scaleFilter(video),
          "-frames:v",
          "1",
          "-threads",
          "1",
          "-update",
          "1",
          name,
        ]);
        if (!(await Bun.file(join(task.directory, name)).exists())) break;
        count++;
      }
      if (!count) throw new Error("The media has no decoded video frames.");
      const sheets: z.infer<typeof FilmstripSchema>["sheets"] = [];
      for (let start = 0; start < count; start += mediaSettings.tilesPerSheet) {
        const tiles = Math.min(mediaSettings.tilesPerSheet, count - start);
        const columns = Math.min(mediaSettings.columns, tiles);
        const sheet = {
          index: sheets.length,
          start,
          count: tiles,
          columns,
          rows: Math.ceil(tiles / columns),
        };
        await run([
          ...ffmpeg,
          "-framerate",
          "1",
          "-start_number",
          String(start + 1),
          "-i",
          "frames/frame-%06d.png",
          "-vf",
          `tile=${columns}x${sheet.rows}:nb_frames=${tiles}`,
          "-frames:v",
          "1",
          "-threads",
          "1",
          "-q:v",
          String(mediaSettings.jpegQuality),
          "-update",
          "1",
          `sprite-${sheet.index}.jpg`,
        ]);
        sheets.push(sheet);
      }
      await rm(join(task.directory, "frames"), { recursive: true });
      const metadata = FilmstripSchema.parse({
        version: 2,
        interval: mediaSettings.filmstripInterval,
        tileHeight: mediaSettings.tileHeight,
        tileWidth: tileWidth(video),
        count,
        sheets,
      });
      await Bun.write(
        join(task.directory, "filmstrip.json"),
        JSON.stringify(metadata),
      );
    }
  }
  await Bun.stdout.write(JSON.stringify({ type: "done" }));
} catch (error) {
  await Bun.stdout.write(
    JSON.stringify({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
