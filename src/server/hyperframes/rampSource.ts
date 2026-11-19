import { runFfmpeg, runFfprobe } from "@hyperframes/engine";
import { decodableAudioStream } from "@hyperframes/parsers/media-streams";
import type { RateSpec } from "@hyperframes/core";
import { z } from "zod";
import { localMediaInputOptions } from "../media/input.ts";
import { prepareRampAudio } from "./rampAudio.ts";

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

/** A supported local source uses the same dry WAV before the preview and export mixers. */
export async function prepareLocalRamp(
  source: string,
  output: string,
  start: number,
  duration: number,
  lane: Exclude<RateSpec, number>,
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
  const seek = start - offset;
  return prepareRampAudio(
    output,
    duration,
    lane,
    async (outputPath, seconds) => {
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
    },
    signal,
  );
}
