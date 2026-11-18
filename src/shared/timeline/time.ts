import type { Fps } from "./schema.ts";

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

/** Move a source in-point by whole timeline frames, keeping its phase if it is off-grid. */
export function offsetSourceTime(
  seconds: number,
  frames: number,
  fps: Fps,
  rate = 1,
): number {
  const frame = sourceGridFrame(seconds, fps, rate);
  return frame === null
    ? seconds + frameTime(frames, fps) * rate
    : frameTime(frame + frames, fps) * rate;
}
