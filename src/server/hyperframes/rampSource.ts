import { runFfmpeg, runFfprobe } from "@hyperframes/engine";
import { decodableAudioStream } from "@hyperframes/parsers/media-streams";
import { z } from "zod";
import { localMediaInputOptions } from "../media/input.ts";
import { prepareRampRun, writeRampSlice } from "./rampAudio.ts";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileFingerprint } from "../../shared/media.ts";
import type { RampPlayback } from "../../shared/timeline/rampWindow.ts";
import { AUDIO_SAMPLE_RATE } from "../../shared/timeline/rampWindow.ts";

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
export async function prepareLocalRampRun(
  source: string,
  output: string,
  run: RampPlayback["run"],
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
  return prepareRampRun(
    output,
    run,
    async (outputPath, sourceStart, seconds) => {
      const seek = sourceStart - offset;
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
          String(AUDIO_SAMPLE_RATE),
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

const preparing = new Map<string, ReturnType<typeof prepareLocalRampRun>>();

export async function prepareLocalRamp(
  source: string,
  output: string,
  timing: Pick<RampPlayback, "run" | "pcm">,
  cacheDir: string,
  signal?: AbortSignal,
  timeout?: number,
) {
  const { run, pcm } = timing;
  const from = Math.max(0, pcm.start - pcm.origin);
  const to = Math.min(run.frames, pcm.end - pcm.origin);
  if (to <= from) return;
  await mkdir(cacheDir, { recursive: true });
  const revision = fileFingerprint(source, await stat(source));
  const key = createHash("sha256")
    .update(JSON.stringify([revision, run]))
    .digest("hex");
  const original = join(cacheDir, key + ".wav");
  const existing = await stat(original).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  if (!existing) {
    let task = preparing.get(original);
    if (!task) {
      task = (async () => {
        const temp = await mkdtemp(join(cacheDir, ".run-"));
        try {
          const path = join(temp, "ramp.wav");
          const result = await prepareLocalRampRun(
            source,
            path,
            run,
            signal,
            timeout,
          );
          if (result?.success) await rename(path, original);
          return result;
        } finally {
          preparing.delete(original);
          await rm(temp, { recursive: true, force: true });
        }
      })();
      preparing.set(original, task);
    }
    const result = await task;
    if (!result?.success) return result;
  }
  await writeRampSlice(original, output, from, to, signal);
  return { success: true, outputPath: output };
}
