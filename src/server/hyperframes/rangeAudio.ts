import { copyFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runFfmpeg } from "@hyperframes/engine";
import type { AudioElement } from "@hyperframes/engine";
import type { ExportOptions } from "../../shared/export.ts";
import type { Fps } from "../../shared/timeline/schema.ts";

type Frames = NonNullable<ExportOptions["range"]>;

/** Every prepared track and mix the HyperFrames mixer writes is 48 kHz. */
const SAMPLE_RATE = 48000;
/** Mixed on each side of the range, so the delivery true-peak limiter (3 ms
 * look-ahead, 80 ms release) sees the same neighbourhood as in the full mix. */
const CONTEXT_SECONDS = 1;

type RangeMix = {
  /** Composition time the mix starts at. */
  startSeconds: number;
  durationSeconds: number;
  audios: AudioElement[];
};

/**
 * The part of the composition's mix that a range export plays.
 *
 * Clips heard within a second of the range are kept whole and moved earlier by
 * the same whole number of seconds. The mixer prepares each clip from its own
 * start (source offset, loop, rate, fades, gain automation and FX all read clip
 * time), places it at its start in whole milliseconds, and sums tracks in
 * authored order. Every other clip is silence at these samples, so the window
 * holds the full mix's samples. A master or group bus effect and group
 * automation run on the whole composition's clock; those mix in full.
 */
export function rangeMix(input: {
  audios: AudioElement[];
  masterFxChain?: string;
  durationSeconds: number;
  startSeconds: number;
  endSeconds: number;
}): RangeMix {
  const full = {
    startSeconds: 0,
    durationSeconds: input.durationSeconds,
    audios: input.audios,
  };
  if (
    input.masterFxChain ||
    input.audios.some((audio) => audio.groupFxChain || audio.groupAutomation)
  )
    return full;
  const from = input.startSeconds - CONTEXT_SECONDS;
  const to = Math.min(
    input.durationSeconds,
    input.endSeconds + CONTEXT_SECONDS,
  );
  // An FX tail can outlast its clip, and an unknown end is read from the file
  // during the mix, so those clips count from their start.
  const heard = input.audios.filter(
    (audio) =>
      audio.start < to &&
      (audio.fxChain || audio.end <= audio.start || audio.end > from),
  );
  // Whole seconds subtract exactly from every later time. The mixer rounds a
  // clip's start to milliseconds, and float error can round a half
  // millisecond (an NTSC frame boundary) differently after the shift.
  const placed = (seconds: number) => Math.round(seconds * 1000);
  let shift = Math.max(
    0,
    Math.floor(Math.min(from, ...heard.map((audio) => audio.start))),
  );
  while (
    shift > 0 &&
    heard.some(
      (audio) =>
        placed(audio.start - shift) !== placed(audio.start) - shift * 1000,
    )
  )
    shift -= 1;
  return {
    startSeconds: shift,
    durationSeconds: to - shift,
    audios: heard.map((audio) => ({
      ...audio,
      start: audio.start - shift,
      end: audio.end - shift,
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
  { startSeconds: number; pcmPath?: string; silent: boolean } | undefined;

/** Runs the planner's audio stage over the range's mix and keeps its PCM for
 * `alignRangeAudio`. */
export async function mixRangeAudio<
  Result extends { deliverySourcePath?: string },
>(
  plan: {
    composition: { audios: AudioElement[]; masterFxChain?: string };
    totalFrames: number;
    workDir: string;
  },
  range: { fps: Fps; frames: Frames },
  run: (stage: {
    totalFrames: number;
    fps: Fps;
    audios: AudioElement[];
    keepDeliverySource: true;
  }) => Promise<Result>,
) {
  const { num, den } = range.fps;
  const mix = rangeMix({
    audios: plan.composition.audios,
    masterFxChain: plan.composition.masterFxChain,
    durationSeconds: (plan.totalFrames * den) / num,
    startSeconds: (range.frames.start * den) / num,
    endSeconds: (range.frames.end * den) / num,
  });
  // The audio stage reads fps only to turn totalFrames into seconds.
  const result = await run({
    totalFrames: mix.durationSeconds,
    fps: { num: 1, den: 1 },
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
    startSeconds: mix.startSeconds,
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
  const { num, den } = input.fps;
  const sample = (frame: number) =>
    Math.round((frame * den * SAMPLE_RATE) / num) -
    (planned?.startSeconds ?? 0) * SAMPLE_RATE;
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
        : ["-f", "lavfi", "-i", `anullsrc=r=${SAMPLE_RATE}:cl=stereo`]),
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
      "-af",
      `atrim=start_sample=${first}:end_sample=${end},asetpts=PTS-STARTPTS,apad=whole_len=${end - first}`,
      "-t",
      String(((input.frames.end - input.frames.start) * den) / num),
      "-y",
      input.outputPath,
    ],
    { signal: input.signal },
  );
  if (!result.success)
    throw new Error(`Range audio alignment failed: ${result.stderr}`);
}
