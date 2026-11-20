import { sourceTimeAt } from "@hyperframes/core/speed-ramp";
import type { HfAutomationLane } from "@hyperframes/core/audio-automation";

type RampAudioWindow = NonNullable<HfAutomationLane["audioWindow"]>;

export const AUDIO_SAMPLE_RATE = 48_000;

export function audioSampleAt(seconds: number) {
  const sample = seconds * AUDIO_SAMPLE_RATE;
  const half = Math.floor(sample) + 0.5;
  // Reading seconds from HTML and translating a host can land a tie a few ULPs off.
  const tolerance = Math.max(1e-7, Math.abs(sample) * Number.EPSILON * 2);
  return Math.round(Math.abs(sample - half) <= tolerance ? half : sample);
}

export function rampAudioWindowAt(
  lane: HfAutomationLane,
  mediaStart: number,
  duration: number,
  start?: number,
): RampAudioWindow {
  return {
    offset: lane.offset ?? 0,
    mediaStart,
    duration,
    ...(start !== undefined && { timelineStart: start, elementStart: start }),
  };
}

export function rampAudioSourceAt(
  lane: HfAutomationLane,
  original: RampAudioWindow,
): number {
  return (
    original.mediaStart -
    sourceTimeAt(lane, original.offset - (lane.offset ?? 0))
  );
}

/** Drop stale preparation after a source edit or an extension beyond the original run. */
export function matchingRampAudioWindow(
  lane: HfAutomationLane,
  mediaStart: number,
  duration: number,
): RampAudioWindow | undefined {
  const original = lane.audioWindow;
  if (!original) return;
  const from = (lane.offset ?? 0) - original.offset;
  // HTML stores the edited start, duration and media in-point at whole microseconds.
  const epsilon = 1e-6;
  if (
    from >= -epsilon &&
    from + duration <= original.duration + epsilon &&
    Math.abs(mediaStart - rampAudioSourceAt(lane, original)) <= epsilon
  )
    return original;
}

export type MediaWindow = { start: number; end: number; mediaStart: number };

export type RampPlayback = ReturnType<typeof resolveRampPlayback>;

/** Resolve a physical element at its composition placement, before any range is rebased. */
export function resolveRampPlayback(
  element: MediaWindow,
  rate: HfAutomationLane,
  played = { start: element.start, end: element.end },
) {
  const duration = element.end - element.start;
  const original =
    matchingRampAudioWindow(rate, element.mediaStart, duration) ??
    rampAudioWindowAt(rate, element.mediaStart, duration, element.start);
  const originalStart =
    original.timelineStart !== undefined && original.elementStart !== undefined
      ? original.timelineStart + (element.start - original.elementStart)
      : element.start - ((rate.offset ?? 0) - original.offset);
  const originSample = audioSampleAt(originalStart);
  const runRate: HfAutomationLane = {
    ...rate,
    offset: original.offset,
    audioWindow: undefined,
  };
  return {
    ...element,
    rate,
    original,
    originalStart,
    run: {
      rate: runRate,
      mediaStart: original.mediaStart,
      frames: audioSampleAt(originalStart + original.duration) - originSample,
      phase: Number(
        (originalStart * AUDIO_SAMPLE_RATE - originSample).toFixed(6),
      ),
    },
    pcm: {
      origin: originSample,
      start: audioSampleAt(played.start),
      end: audioSampleAt(played.end),
    },
  };
}

export function rampMediaTimeAt(
  timing: Pick<RampPlayback, "start" | "end" | "mediaStart" | "rate">,
  at: number,
  integrate = sourceTimeAt,
) {
  return (
    timing.mediaStart +
    integrate(timing.rate, Math.max(0, Math.min(at, timing.end) - timing.start))
  );
}
