import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runFfmpeg, runFfprobe } from "@hyperframes/engine";
import { decodableAudioStream } from "@hyperframes/parsers/media-streams";
import { sourceTimeAt } from "@hyperframes/core";
import type { RateSpec } from "@hyperframes/core";
import { z } from "zod";
import { localMediaInputOptions } from "../media/input.ts";
import { prepareRampRun, prepareStretch, sliceRun } from "./rampAudio.ts";
import type { RampRun, RunSlice } from "../../shared/timeline/rampRuns.ts";

const clockProbe = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string().optional(),
      codec_name: z.string().optional(),
      start_time: z.string().optional(),
      channels: z.number().optional(),
      disposition: z.object({ attached_pic: z.number().optional() }).optional(),
    }),
  ),
  format: z.object({ format_name: z.string().optional() }),
});

/** Reads a local source's audio as stereo 48 kHz PCM on the clock the preview and export mixers use. */
async function localDecoder(
  source: string,
  signal?: AbortSignal,
  timeout?: number,
) {
  const probe = clockProbe.parse(
    JSON.parse(
      await runFfprobe(
        source,
        [
          ...localMediaInputOptions,
          "-show_entries",
          "stream=codec_type,codec_name,start_time,channels:stream_disposition=attached_pic:format=format_name",
          "-of",
          "json",
        ],
        signal,
      ),
    ),
  );
  const stream = decodableAudioStream(probe.streams);
  if (stream === null)
    throw new Error("The ramp source has no decodable audio.");
  const channels = probe.streams.filter(
    (entry) => entry.codec_type === "audio",
  )[stream]?.channels;
  // Chrome presents these containers from timestamp zero. Other inputs start at
  // their first stream. An input seek before a later stream starts can skip valid
  // samples, so trim by timestamp in that case.
  const times = probe.streams
    .filter(
      (entry) =>
        (entry.codec_type === "audio" || entry.codec_type === "video") &&
        entry.disposition?.attached_pic !== 1,
    )
    .map((entry) => Number.parseFloat(entry.start_time ?? ""))
    .filter(Number.isFinite);
  const first = times.length ? Math.min(...times) : 0;
  const latest = times.length ? Math.max(...times) - first : 0;
  const offset = /\b(mp4|webm)\b/.test(probe.format.format_name ?? "")
    ? Math.max(0, first)
    : 0;
  return async (outputPath: string, start: number, seconds: number) => {
    const seek = start - offset;
    const before = seek >= latest;
    const time = (value: number) => String(Number(value.toFixed(6)));
    const filters = [
      ...(!before
        ? [
            `atrim=start=${time(seek)}:end=${time(seek + seconds)}`,
            `asetpts=PTS-${time(seek)}/TB`,
            "aresample=async=1:first_pts=0",
          ]
        : []),
      "apad",
      ...(channels === 1 ? ["pan=stereo|FL=FL+FC|FR=FR+FC"] : []),
    ];
    const result = await runFfmpeg(
      [
        ...localMediaInputOptions,
        ...(before ? ["-ss", time(seek), "-t", time(seconds)] : []),
        "-i",
        source,
        "-map",
        `0:a:${stream}`,
        "-vn",
        "-af",
        filters.join(","),
        "-ac",
        "2",
        "-ar",
        "48000",
        "-c:a",
        "pcm_s16le",
        "-t",
        time(seconds),
        "-y",
        outputPath,
      ],
      { signal, timeout },
    );
    signal?.throwIfAborted();
    return { ...result, outputPath };
  };
}

/**
 * Prepare a ramp run from a local source, as the media service does for the viewer and export,
 * long enough to cover `frames`.
 */
export async function prepareLocalRun(
  source: string,
  output: string,
  run: RampRun,
  frames: number,
  signal?: AbortSignal,
  timeout?: number,
) {
  return prepareRampRun(
    output,
    run,
    frames,
    await localDecoder(source, signal, timeout),
    signal,
  );
}

/**
 * Stretch one element's own sound when the document gives it no run, such as a track a script
 * created: `duration` seconds from `start`, along `lane`.
 */
export async function prepareLocalRamp(
  source: string,
  output: string,
  start: number,
  duration: number,
  lane: Exclude<RateSpec, number>,
  signal?: AbortSignal,
  timeout?: number,
) {
  return prepareStretch(
    output,
    Math.round(duration * 48_000),
    (frame) => start + sourceTimeAt(lane, frame / 48_000),
    await localDecoder(source, signal, timeout),
    signal,
  );
}

/** Runs an export had to make itself, because the server did not hand them over. */
const madeRuns = new Map<string, Promise<string | null>>();

/**
 * The export mixer's input for a piece: its samples of the run. The server prepares runs before
 * the render and passes their files. A run it did not prepare is made once here, the same way.
 */
export async function sliceLocalRun(
  source: string,
  output: string,
  { run, from, to, frames, file }: RunSlice & { file?: string },
  signal?: AbortSignal,
  timeout?: number,
) {
  let path = file;
  if (!path) {
    const key = `${source}\0${JSON.stringify(run)}\0${frames}`;
    let made = madeRuns.get(key);
    if (!made) {
      console.warn(
        `Preparing ramp audio for ${basename(source)} during the export.`,
      );
      const directory = join(dirname(output), ".ramp-runs");
      const target = join(directory, `${madeRuns.size}.wav`);
      made = mkdir(directory, { recursive: true })
        .then(() =>
          prepareLocalRun(source, target, run, frames, signal, timeout),
        )
        .then((result) => (result?.success ? target : null));
      madeRuns.set(key, made);
    }
    path = (await made) ?? undefined;
    if (!path) return null;
  }
  await sliceRun(path, output, from, to);
  return { success: true, outputPath: output };
}
