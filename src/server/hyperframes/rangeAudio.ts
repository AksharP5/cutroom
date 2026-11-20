import { copyFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runFfmpeg } from "@hyperframes/engine";
import type { ExportOptions } from "../../shared/export.ts";
import type { Fps } from "../../shared/timeline/schema.ts";
import { AUDIO_SAMPLE_RATE, audioFrameSample } from "./audioClock.ts";
import type { AudioMixElement } from "./audioClock.ts";

type Frames = NonNullable<ExportOptions["range"]>;

/** Mixed on each side of the range, so the delivery true-peak limiter (3 ms
 * look-ahead, 80 ms release) sees the same neighbourhood as in the full mix. */
const CONTEXT_SAMPLES = AUDIO_SAMPLE_RATE;

type RangeMix = {
  startSample: number;
  sampleCount: number;
  audios: AudioMixElement[];
};

/**
 * The part of the composition's mix that a range export plays.
 *
 * Clips heard within a second of the range are kept whole and moved earlier by
 * the same whole number of seconds. The mixer prepares each clip from its own
 * start (source offset, loop, rate, fades, gain automation and FX all read clip
 * time), places it at its start sample, and sums tracks in
 * authored order. Every other clip is silence at these samples, so the window
 * holds the full mix's samples. A master or group bus effect and group
 * automation run on the whole composition's clock; those mix in full.
 */
export function rangeMix(input: {
  audios: AudioMixElement[];
  masterFxChain?: string;
  durationSamples: number;
  startSample: number;
  endSample: number;
}): RangeMix {
  const full = {
    startSample: 0,
    sampleCount: input.durationSamples,
    audios: input.audios,
  };
  if (
    input.masterFxChain ||
    input.audios.some((audio) => audio.groupFxChain || audio.groupAutomation)
  )
    return full;
  const from = input.startSample - CONTEXT_SAMPLES;
  const to = Math.min(input.durationSamples, input.endSample + CONTEXT_SAMPLES);
  // An FX tail can outlast its clip, and an unknown end is read from the file
  // during the mix, so those clips count from their start.
  const startOf = (audio: AudioMixElement) =>
    audio.samples?.start ?? audio.start * AUDIO_SAMPLE_RATE;
  const heard = input.audios.filter((audio) => {
    const start = startOf(audio);
    const end = audio.samples?.end ?? audio.end * AUDIO_SAMPLE_RATE;
    return start < to && (audio.fxChain || end <= start || end > from);
  });
  // Browser-only or unbounded tracks still use the producer's millisecond
  // placement. Keep its rounding stable when shifting by whole seconds.
  const placed = (seconds: number) => Math.round(seconds * 1000);
  let shift = Math.max(
    0,
    Math.floor(Math.min(from, ...heard.map(startOf)) / AUDIO_SAMPLE_RATE),
  );
  while (
    shift > 0 &&
    heard.some(
      (audio) =>
        !audio.samples &&
        placed(audio.start - shift) !== placed(audio.start) - shift * 1000,
    )
  )
    shift -= 1;
  const startSample = shift * AUDIO_SAMPLE_RATE;
  return {
    startSample,
    sampleCount: to - startSample,
    audios: heard.map((audio) => ({
      ...audio,
      start: audio.start - shift,
      end: audio.end - shift,
      ...(audio.samples && {
        samples: {
          start: audio.samples.start - startSample,
          end: audio.samples.end - startSample,
        },
      }),
      ...(audio.volumeKeyframes && {
        volumeKeyframes: audio.volumeKeyframes.map((keyframe) => ({
          ...keyframe,
          time: keyframe.time - shift,
        })),
      }),
    })),
  };
}

let planned:
  { startSample: number; pcmPath?: string; silent: boolean } | undefined;

/** Runs the planner's audio stage over the range's mix and keeps its PCM for
 * `alignRangeAudio`. */
export async function mixRangeAudio<
  Result extends { deliverySourcePath?: string },
>(
  plan: {
    composition: { audios: AudioMixElement[]; masterFxChain?: string };
    totalFrames: number;
    workDir: string;
  },
  range: { fps: Fps; frames: Frames },
  run: (stage: {
    totalFrames: number;
    fps: Fps;
    audios: AudioMixElement[];
    keepDeliverySource: true;
  }) => Promise<Result>,
) {
  const mix = rangeMix({
    audios: plan.composition.audios,
    masterFxChain: plan.composition.masterFxChain,
    durationSamples: audioFrameSample(plan.totalFrames, range.fps),
    startSample: audioFrameSample(range.frames.start, range.fps),
    endSample: audioFrameSample(range.frames.end, range.fps),
  });
  // The audio stage reads fps only to turn totalFrames into seconds.
  const result = await run({
    totalFrames: mix.sampleCount,
    fps: { num: AUDIO_SAMPLE_RATE, den: 1 },
    audios: mix.audios,
    keepDeliverySource: true,
  });
  // The planner removes its work folder before the stitch. renderSpan's own
  // work folder, two levels up, lasts until the export is written.
  let pcmPath: string | undefined;
  if (result.deliverySourcePath) {
    pcmPath = join(dirname(dirname(plan.workDir)), "cutroom-range-audio.wav");
    await rename(result.deliverySourcePath, pcmPath);
  }
  planned = {
    startSample: mix.startSample,
    pcmPath,
    silent: mix.audios.length === 0 && plan.composition.audios.length > 0,
  };
  return result;
}

/** AAC packet ownership can omit part of either boundary. Trim the range from
 * the mix's PCM at sample precision, encode it once, and copy the already
 * encoded video. */
export async function alignRangeAudio(input: {
  videoPath: string;
  /** The plan's AAC mix, read only when its PCM source went stale. */
  audioPath: string | null;
  outputPath: string;
  fps: Fps;
  frames: Frames;
  signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const source = planned?.pcmPath ?? input.audioPath;
  if (!source && !planned?.silent) {
    await copyFile(input.videoPath, input.outputPath);
    return;
  }
  const sample = (frame: number) =>
    audioFrameSample(frame, input.fps) - (planned?.startSample ?? 0);
  const webm = input.outputPath.toLowerCase().endsWith(".webm");
  const first = sample(input.frames.start);
  const end = sample(input.frames.end);
  const result = await runFfmpeg(
    [
      "-i",
      input.videoPath,
      // No clip is heard in the range, though the full mix has audio there.
      ...(source
        ? ["-i", source]
        : ["-f", "lavfi", "-i", `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`]),
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      // WebM carries Opus, as HyperFrames' own WebM exports do; MP4 and MOV carry AAC.
      ...(webm
        ? ["-c:a", "libopus", "-b:a", "128k"]
        : ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]),
      // The video already contains the selected frames. A shared time limit
      // can cut a sample when the two absolute edges round in opposite directions.
      "-af",
      `atrim=start_sample=${first}:end_sample=${end},asetpts=PTS-STARTPTS,apad=whole_len=${end - first}`,
      "-y",
      input.outputPath,
    ],
    { signal: input.signal },
  );
  if (!result.success)
    throw new Error(`Range audio alignment failed: ${result.stderr}`);
}
