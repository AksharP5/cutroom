import { sourceTimeAt } from "@hyperframes/core/speed-ramp";
import {
  AudioAutomationError,
  RATE_TARGET,
} from "@hyperframes/core/audio-automation";
import { readAutomation } from "./automation.ts";
import type { RateSpec } from "@hyperframes/core/speed-ramp";
import type { Clip, Fps } from "./schema.ts";

/** Exact time of a frame, for seeking. */
export const frameTime = (frames: number, fps: Fps) =>
  (frames * fps.den) / fps.num;
/**
 * A source in-point on the edit's frame grid. The microsecond allows for stored decimal
 * seconds, including old transition handles rounded both before and after the shift.
 */
export function sourceGridFrame(seconds: number, fps: Fps, rate: number) {
  const frame = Math.round((seconds * fps.num) / (fps.den * rate));
  return Math.abs(seconds - frameTime(frame, fps) * rate) < 1e-6 ? frame : null;
}

export function clipRate({
  automation,
  playbackRate,
}: Pick<Clip, "automation" | "playbackRate">): RateSpec {
  if (!automation) return playbackRate;
  try {
    return (
      readAutomation(automation).lanes.find(
        ({ target }) => target === RATE_TARGET,
      ) ?? playbackRate
    );
  } catch (error) {
    if (error instanceof AudioAutomationError) return playbackRate;
    throw error;
  }
}

/** Move a source in-point by whole timeline frames, keeping its phase if it is off-grid. */
export function offsetSourceTime(
  seconds: number,
  frames: number,
  fps: Fps,
  rate: RateSpec = 1,
): number {
  if (typeof rate !== "number")
    return seconds + sourceTimeAt(rate, frameTime(frames, fps));
  const frame = sourceGridFrame(seconds, fps, rate);
  return frame === null
    ? seconds + frameTime(frames, fps) * rate
    : frameTime(frame + frames, fps) * rate;
}
