import { availableParallelism } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { z } from "zod";
import { encodePeaks, peakSampleRate } from "./peaks";
import {
  FilmstripSchema,
  MediaEventSchema,
  MediaInfoSchema,
  MediaTaskSchema,
} from "./protocol";
import { mediaSettings } from "../../shared/media";
import { proxyFilter, scaleFilter, scrubFilter, tileWidth } from "./settings";
import { chromeColourGuess } from "../hyperframes/videoColour";
import { localMediaInputOptions } from "./input";

const task = MediaTaskSchema.parse(await Bun.stdin.json());
let cancelled = false;
let child: ReturnType<typeof Bun.spawn> | undefined;
process.on("SIGTERM", () => {
  cancelled = true;
  child?.kill("SIGTERM");
});
let writing: Promise<unknown> = Promise.resolve();
/** One JSON event per line; the last is done or error. */
const emit = (event: z.infer<typeof MediaEventSchema>) =>
  (writing = writing.then(() =>
    Bun.stdout.write(`${JSON.stringify(event)}\n`),
  ));
/** Alpha in the pixels, or VP8/VP9's sidecar plane. */
const transparent = (stream: {
  pix_fmt?: string;
  tags?: { alpha_mode?: string };
}) =>
  /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(stream.pix_fmt ?? "") ||
  stream.tags?.alpha_mode === "1";

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
/**
 * Tags every frame with the colours Chrome draws the source with: its own tags, and Chrome's
 * guess for those it lacks, since Chrome's guess for an untagged proxy of another size can differ
 * from its guess for the source. The frames carry them, because FFmpeg 8 and later write the
 * frames' tags over `-color_primaries` and `-color_trc`. Only FFmpeg's own names reach the graph.
 */
async function colourTags(video: { height: number; codec: string }) {
  const raw = await run([
    task.ffprobe,
    "-v",
    "error",
    ...localMediaInputOptions,
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=color_space,color_primaries,color_transfer,color_range",
    "-of",
    "json",
    task.source,
  ]);
  const stream = z
    .object({
      streams: z.tuple([
        z.object({
          color_space: z.string().optional(),
          color_primaries: z.string().optional(),
          color_transfer: z.string().optional(),
          color_range: z.string().optional(),
        }),
      ]),
    })
    .parse(JSON.parse(z.string().parse(raw))).streams[0];
  const guess = chromeColourGuess(video.height, video.codec);
  const tag = (value: string | undefined, fallback: string) =>
    value && value !== "unknown" && /^[a-z0-9-]+$/.test(value)
      ? value
      : fallback;
  return `setparams=colorspace=${tag(stream.color_space, guess)}:color_primaries=${tag(stream.color_primaries, guess)}:color_trc=${tag(stream.color_transfer, "bt709")}:range=${stream.color_range === "pc" ? "pc" : "tv"}`;
}
try {
  if (task.kind === "probe") {
    const raw = await run([
      task.ffprobe,
      "-v",
      "error",
      ...localMediaInputOptions,
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,pix_fmt,color_transfer,channels,width,height,avg_frame_rate,r_frame_rate,sample_aspect_ratio,duration:stream_tags=alpha_mode:stream_side_data=rotation",
      "-of",
      "json",
      task.source,
    ]);
    const probe = z
      .object({
        streams: z.array(
          z.object({
            codec_type: z.string(),
            codec_name: z.string().optional(),
            pix_fmt: z.string().optional(),
            color_transfer: z.string().optional(),
            tags: z.object({ alpha_mode: z.string().optional() }).optional(),
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
        codec: video.codec_name ?? "unknown",
        alpha: transparent(video),
        hdr: ["smpte2084", "arib-std-b67"].includes(video.color_transfer ?? ""),
      },
    });
    await Bun.write(join(task.directory, "probe.json"), JSON.stringify(info));
  } else if (task.kind === "peaks") {
    const channels = task.info?.channels;
    if (!channels) throw new Error("The media has no audio stream.");
    await run(
      [
        ...ffmpeg,
        ...localMediaInputOptions,
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
    if (task.kind === "scrub") {
      // An opaque proxy would draw black where the clip is transparent.
      if (video.alpha)
        throw new Error("Transparent video scrubs from the source.");
      // Every frame is a keyframe at the source's timestamps, so a seek decodes one small
      // picture and proxy frame N is source frame N.
      await run([
        ...ffmpeg,
        ...localMediaInputOptions,
        "-i",
        task.source,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        `${await colourTags(video)},${scrubFilter(video)}`,
        "-fps_mode",
        "passthrough",
        "-c:v",
        "libx264",
        "-preset",
        "superfast",
        "-crf",
        "28",
        "-g",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "1",
        "-movflags",
        "+faststart",
        "scrub.mp4",
      ]);
    } else if (task.kind === "proxy") {
      const streams = z
        .object({
          streams: z.array(
            z.object({
              codec_type: z.string(),
              codec_name: z.string().optional(),
              time_base: z.string().regex(/^\d+\/\d+$/),
            }),
          ),
        })
        .parse(
          JSON.parse(
            z
              .string()
              .parse(
                await run([
                  task.ffprobe,
                  "-v",
                  "error",
                  ...localMediaInputOptions,
                  "-show_entries",
                  "stream=codec_type,codec_name,time_base",
                  "-of",
                  "json",
                  task.source,
                ]),
              ),
          ),
        ).streams;
      const audio = streams.find((stream) => stream.codec_type === "audio");
      const timeBase = streams.find(
        (stream) => stream.codec_type === "video",
      )!.time_base;
      const filter = `${await colourTags(video)},${proxyFilter(video)},format=yuv420p`;
      // Every source frame at its own timestamp, so the preview's frame N is the source's frame N
      // and export, which reads the source, shows what the preview did. A keyframe every half
      // second bounds what a seek decodes; no B-frames, so a decoder puts out each frame at once.
      const gop = String(Math.max(1, Math.round(video.fps / 2)));
      const encoders = {
        nvenc: ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq"],
        x264: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"],
      };
      // About libx264's CRF 20: a picture for editing, while export reads the source.
      const nvencRate = ["-rc", "vbr", "-cq", "25", "-b:v", "0"];
      const encode = (encoder: keyof typeof encoders) =>
        run(
          [
            task.ffmpeg,
            "-nostdin",
            "-v",
            "error",
            // Decoding a 4K source is most of the work; a few cores make it about 5x real time.
            "-threads",
            String(Math.min(6, Math.max(2, availableParallelism() >> 1))),
            "-filter_threads",
            "2",
            ...localMediaInputOptions,
            "-i",
            task.source,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-sn",
            "-dn",
            "-vf",
            filter,
            "-fps_mode",
            "passthrough",
            // The source's own clock, so a Matroska file's millisecond times stay as they are.
            "-enc_time_base:v",
            timeBase,
            ...encoders[encoder],
            ...(encoder === "nvenc" ? nvencRate : ["-threads", "4"]),
            "-profile:v",
            "high",
            "-g",
            gop,
            "-bf",
            "0",
            // AAC copies exactly; anything else becomes AAC, which MP4 and every browser hold.
            "-c:a",
            audio?.codec_name === "aac" ? "copy" : "aac",
            ...(audio?.codec_name === "aac" ? [] : ["-b:a", "256k"]),
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-stats_period",
            "0.5",
            "-y",
            "proxy.mp4",
          ],
          async (stream) => {
            const decoder = new TextDecoder();
            let reported = 0;
            for await (const chunk of stream) {
              const done = /out_time_us=(\d+)/.exec(
                decoder.decode(chunk, { stream: true }),
              );
              const progress =
                done && video.duration
                  ? Math.min(0.99, Number(done[1]) / 1e6 / video.duration)
                  : 0;
              if (progress - reported < 0.01) continue;
              reported = progress;
              emit({ type: "progress", progress });
            }
          },
        );
      // NVENC can still fail on a frame wider than 4096 pixels or at the driver's session limit.
      await encode(task.encoder ?? "x264").catch((error: unknown) => {
        if (cancelled || task.encoder !== "nvenc") throw error;
        return encode("x264");
      });
    } else if (task.kind === "frame") {
      await run([
        ...ffmpeg,
        ...localMediaInputOptions,
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
          ...localMediaInputOptions,
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
          ...localMediaInputOptions,
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
  await emit({ type: "done" });
} catch (error) {
  await emit({
    type: "error",
    error: error instanceof Error ? error.message : String(error),
  });
}
