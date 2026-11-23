import { matchProjectRate } from "../../shared/projectFormat";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { encodePeaks, peakSampleRate } from "./peaks";
import {
  FilmstripSchema,
  MediaEventSchema,
  MediaInfoSchema,
  MediaTaskSchema,
  PiecesSchema,
} from "./protocol";
import {
  cutPieces,
  firstTrack,
  fragmentStart,
  pieceAt,
  pieceSpans,
  proxySamplesFile,
  streamBoxes,
} from "./pieces";
import { mediaSettings } from "../../shared/media";
import { proxyFilter, scaleFilter, scrubFilter, tileWidth } from "./settings";
import { chromeColourGuess } from "../hyperframes/videoColour";
import { localMediaInputOptions } from "./input";
import { mediaClock, mediaStreamsArgs, sourcePictures } from "./pictureIndex";
import {
  AUDIO_SAMPLE_RATE,
  fraction,
  sampleOf,
  secondsOf,
  subtract,
} from "../../shared/timeline/piece";

const task = MediaTaskSchema.parse(await Bun.stdin.json());
const abort = new AbortController();
let cancelled = false;
let child: ReturnType<typeof Bun.spawn> | undefined;
process.on("SIGTERM", () => {
  cancelled = true;
  abort.abort();
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
  {
    consume,
    onLine,
    feed,
  }: {
    consume?: (stream: ReadableStream<Uint8Array>) => Promise<unknown>;
    onLine?: (line: string) => void;
    /** Writes the process's input, for a file made of pieces. */
    feed?: (stdin: Bun.FileSink) => Promise<void>;
  } = {},
) {
  if (cancelled) throw new Error("Media job cancelled.");
  const process = Bun.spawn(args, {
    cwd: task.directory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child = process;
  const fed = feed ? feed(process.stdin) : process.stdin.end();
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
    const [result] = await Promise.all([
      consume ? consume(process.stdout) : new Response(process.stdout).text(),
      fed,
    ]);
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
    const reportedFps =
      rational(video?.avg_frame_rate, "/") ||
      rational(video?.r_frame_rate, "/");
    const info = MediaInfoSchema.parse({
      channels: audio?.channels,
      video: video && {
        width: rotated ? video.height : video.width,
        height: rotated ? video.width : video.height,
        pixelAspect: rotated ? 1 / aspect : aspect,
        fps: reportedFps || 30,
        duration: Number(video.duration ?? probe.format.duration ?? 0),
        matchFps: matchProjectRate(reportedFps),
        codec: video.codec_name ?? "unknown",
        alpha: transparent(video),
        hdr: ["smpte2084", "arib-std-b67"].includes(video.color_transfer ?? ""),
      },
    });
    await Bun.write(join(task.directory, "probe.json"), JSON.stringify(info));
  } else if (task.kind === "ramp") {
    if (!task.ramp) throw new Error("A ramp job needs its run.");
    const { prepareLocalRun } = await import("../hyperframes/rampSource");
    const result = await prepareLocalRun(
      task.source,
      join(task.directory, "ramp.wav"),
      task.ramp.run,
      task.ramp.frames,
      abort.signal,
    );
    if (!result?.success)
      throw new Error(result?.stderr || "Could not prepare ramp audio.");
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
      {
        consume: async (stream) => {
          await Bun.write(
            join(task.directory, "peaks.bin"),
            await encodePeaks(stream, channels),
          );
        },
      },
    );
  } else if (task.kind === "pcm") {
    if (!task.info?.channels) throw new Error("The media has no audio stream.");
    const probe = (args: string[]) =>
      run([task.ffprobe, "-v", "error", ...args, task.source]).then((raw) =>
        z.string().parse(raw),
      );
    const { zero } = mediaClock(await probe(mediaStreamsArgs));
    // The first decoded sound, after any priming the container trims.
    const first = z
      .object({
        streams: z.tuple([z.object({ time_base: z.string() })]),
        frames: z.array(
          z.object({ best_effort_timestamp: z.coerce.bigint().optional() }),
        ),
      })
      .parse(
        JSON.parse(
          await probe([
            ...localMediaInputOptions,
            "-select_streams",
            "a:0",
            "-read_intervals",
            "%+#8",
            "-show_entries",
            "stream=time_base:frame=best_effort_timestamp",
            "-of",
            "json",
          ]),
        ),
      );
    const [num, den] = first.streams[0].time_base.split("/").map(BigInt);
    const pts = first.frames.find(
      (frame) => frame.best_effort_timestamp !== undefined,
    )?.best_effort_timestamp;
    if (pts === undefined || !num || !den)
      throw new Error("The audio stream has no timestamps.");
    // Sample k is media time k / 48000, so the time before the first sound is silence.
    const lead = sampleOf(subtract(fraction(pts * num, den), zero));
    const file = Bun.file(join(task.directory, "audio.pcm")).writer();
    const silence = new Uint8Array(1 << 20);
    for (let bytes = lead > 0n ? Number(lead) * 2 : 0; bytes > 0;) {
      const size = Math.min(bytes, silence.length);
      file.write(silence.subarray(0, size));
      await file.flush();
      bytes -= size;
    }
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
        String(AUDIO_SAMPLE_RATE),
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
      ],
      {
        consume: async (stream) => {
          for await (const chunk of stream) {
            file.write(chunk);
            await file.flush();
          }
          await file.end();
        },
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
    } else if (task.kind === "pieces") {
      const pictures = await sourcePictures(task.source, {
        projectDir: task.projectDir,
        signal: abort.signal,
        probe: async (args) =>
          z
            .string()
            .parse(
              await run([task.ffprobe, "-v", "error", ...args, task.source]),
            ),
      });
      if (!pictures)
        throw new Error("The video has no presentation timestamps.");
      const { timeBase, start, audio } = pictures.proxy;
      const tick = secondsOf(pictures.tick);
      // Editing proxies use FFmpeg's relative clock. Export keeps the native ticks.
      const startTicks = BigInt(
        Math.sign(start) * Math.round(Math.abs(start) / tick),
      );
      const times = [
        ...new Set(
          pictures.packets.map(({ pts }) => Number(pts - startTicks) * tick),
        ),
      ];
      const { sampleOffsets, ...plan } = cutPieces(times, 1 / video.fps);
      const samples = new Float64Array(sampleOffsets.length + times.length);
      samples.set(sampleOffsets);
      samples.set(times, sampleOffsets.length);
      await Bun.write(join(task.directory, proxySamplesFile), samples);
      await Bun.write(
        join(task.directory, "pieces.json"),
        JSON.stringify(
          PiecesSchema.parse({
            timeBase,
            start,
            audio,
            ...plan,
          }),
        ),
      );
    } else if (task.kind === "proxy") {
      const step = task.proxy;
      if (!step) throw new Error("The editing proxy step is missing.");
      const { pieces } = step;
      const sound = pieces.audio === "aac";
      const directory = join(task.directory, "pieces");
      if (step.step === "encode") {
        const { first, end } = step;
        const from = first ? pieces.cuts[first - 1] : undefined;
        const to = pieces.cuts[end - 1];
        const filters = [
          await colourTags(video),
          proxyFilter(video),
          "format=yuv420p",
        ];
        if (
          first === 0 &&
          pieces.cuts.length &&
          !sound &&
          pieces.videoStart > 0
        ) {
          // Chromium rebases a video-only HLS stream to its first picture. Hold that
          // picture at zero. On the first original frame, save the delay tpad added
          // so every original keeps its presentation time, including on VFR input.
          const padTicks = `st(0,PTS-round(${pieces.videoStart}/TB))`;
          filters.push(
            "tpad=start=1:start_mode=clone",
            `setpts='if(eq(N,0),0,PTS-if(eq(N,1),${padTicks},ld(0)))'`,
          );
        }
        const encoders = {
          nvenc: [
            ...["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq"],
            ...["-rc", "vbr", "-cq", "25", "-b:v", "0"],
          ],
          // About libx264's CRF 20: a picture for editing, while export reads the source.
          x264: [
            ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"],
            ...["-threads", "4"],
          ],
        };
        await mkdir(directory, { recursive: true });
        // Each fragment goes to the piece its first frame's time falls in. A piece is whole
        // once the next one begins, or, for the run's last, once FFmpeg finishes.
        let piece: { index: number; file: Bun.FileSink } | undefined;
        await run(
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
            // The source's own timestamps from its start, as export reads them, from whichever
            // piece this run starts at. Seeking decodes from the keyframe before and keeps
            // only the frames after the cut.
            "-copyts",
            "-start_at_zero",
            ...(from === undefined ? [] : ["-ss", String(from)]),
            "-i",
            task.source,
            ...(to === undefined ? [] : ["-to", String(to)]),
            "-map",
            "0:v:0",
            ...(sound ? ["-map", "0:a:0"] : []),
            "-sn",
            "-dn",
            "-vf",
            filters.join(","),
            // Keep every source frame at its own timestamp so the preview and export agree.
            "-fps_mode",
            "passthrough",
            // The source's own clock, so a Matroska file's millisecond times stay as they are.
            "-enc_time_base:v",
            pieces.timeBase,
            ...encoders[task.encoder ?? "x264"],
            "-profile:v",
            "high",
            // A keyframe every half second bounds what a seek decodes; no B-frames, so a decoder
            // puts out each frame at once. Each piece starts on a keyframe of its own.
            "-g",
            String(Math.max(1, Math.round(video.fps / 2))),
            "-bf",
            "0",
            "-forced-idr",
            "1",
            ...(end - first > 1
              ? [
                  "-force_key_frames",
                  pieces.cuts
                    .slice(first, end - 1)
                    .map(String)
                    .join(","),
                ]
              : []),
            // AAC pieces carry the source's packets from the cut on, as the joined file does.
            ...(sound
              ? [
                  "-c:a",
                  "copy",
                  "-bsf:a",
                  `noise=drop=lt(pts*tb\\,${from ?? 0})`,
                ]
              : ["-an"]),
            "-avoid_negative_ts",
            "disabled",
            "-fflags",
            "+bitexact",
            // A fragment at every keyframe, each carrying its own time, so any piece plays after
            // the shared header and the pieces in order are one file.
            "-f",
            "mp4",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof+frag_discont+skip_trailer",
            "pipe:1",
          ],
          {
            consume: async (stream) => {
              const header: Uint8Array[] = [];
              let track: ReturnType<typeof firstTrack> | undefined;
              for await (const box of streamBoxes(stream)) {
                const type = String.fromCharCode(...box.subarray(4, 8));
                if (!track) {
                  header.push(box);
                  if (type !== "moov") continue;
                  track = firstTrack(box.subarray(8));
                  // Every run writes the same header; it is kept from the first.
                  const init = Bun.file(join(directory, "init.mp4"));
                  if (!(await init.exists())) {
                    await Bun.write(
                      join(directory, "init.tmp"),
                      Buffer.concat(header),
                    );
                    await rename(join(directory, "init.tmp"), init.name!);
                  }
                  continue;
                }
                if (type === "moof") {
                  const index = pieceAt(
                    pieces,
                    fragmentStart(box.subarray(8), track.id) / track.timescale,
                  );
                  // Pieces outside this run may be made already; they are never written here.
                  if (index < first || index >= end)
                    throw new Error(
                      `The editing proxy run for pieces ${first} to ${end - 1} made a frame of piece ${index}.`,
                    );
                  if (piece?.index !== index) {
                    if (piece) {
                      await piece.file.end();
                      emit({ type: "piece", index: piece.index });
                    }
                    piece = {
                      index,
                      file: Bun.file(join(directory, `${index}.mp4`)).writer(),
                    };
                  }
                }
                piece?.file.write(box);
              }
            },
          },
        );
        if (piece) {
          await piece.file.end();
          emit({ type: "piece", index: piece.index });
        }
      } else {
        const files = [
          "init.mp4",
          ...pieceSpans(pieces).map((_, index) => `${index}.mp4`),
        ].map((name) => Bun.file(join(directory, name)));
        await run(
          [
            task.ffmpeg,
            "-nostdin",
            "-v",
            "error",
            "-copyts",
            ...localMediaInputOptions,
            "-f",
            "mp4",
            "-i",
            "pipe:0",
            ...localMediaInputOptions,
            // The sound from the source on the pieces' clock: the source's own, from its start.
            ...(pieces.start ? ["-itsoffset", String(-pieces.start)] : []),
            "-i",
            task.source,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0?",
            "-c:v",
            "copy",
            // AAC copies exactly; anything else becomes AAC, which MP4 and every browser hold.
            "-c:a",
            sound ? "copy" : "aac",
            ...(sound ? [] : ["-b:a", "256k"]),
            "-movflags",
            "+faststart",
            "-y",
            "proxy.mp4",
          ],
          {
            // The header, then every piece's fragments in order: one fragmented file.
            feed: async (stdin) => {
              for (const file of files)
                for await (const chunk of file.stream()) {
                  stdin.write(chunk);
                  await stdin.flush();
                }
              await stdin.end();
            },
          },
        );
      }
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
        {
          onLine: (line) => {
            if (!line.includes("showinfo")) return;
            const match = /pts_time:([\d.eE+-]+)/.exec(line);
            if (!match) return;
            const time = Number(match[1]);
            maxGap = Math.max(maxGap, time - lastKey);
            lastKey = time;
          },
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
