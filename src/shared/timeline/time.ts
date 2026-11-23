import type { Fps } from "./schema.ts";

/** Exact time of a frame, for seeking. */
export const frameTime = (frames: number, fps: Fps) =>
  (frames * fps.den) / fps.num;
