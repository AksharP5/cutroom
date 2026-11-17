import { z } from "zod";

/** Seconds of floating-point slack when comparing a seek to a presentation timestamp. */
export const presentationTimeTolerance = 1e-6;

/**
 * Where export puts a video's frames: each frame's time is snapped to `start + k / rate`, which
 * undoes a container's rounding (Matroska and OBS's MP4s keep whole milliseconds, so a 60 fps
 * frame can start up to half a millisecond after its slot). Null where export reads the file's
 * own times: variable frame rate, or no video stream.
 */
export const FrameGridSchema = z
  .object({ start: z.number().finite(), rate: z.number().finite().positive() })
  .nullable();
export type FrameGrid = z.infer<typeof FrameGridSchema>;

/**
 * The time to seek a video to so it shows the frame export writes at media time `time`: a
 * quarter of a frame into the last grid frame starting at or before it. That is past the
 * container's rounding and the millisecond Chromium can show a Matroska frame late, so players
 * that show the frame at or before a seek show this one. It is also short of the frame's
 * middle, past which Chromium's HLS player, which shows the nearest frame in an editing proxy's
 * later pieces, shows the next. The `1e-6` of a frame absorbs floating-point error at a frame's
 * exact start, as export's half microsecond does. Before the first frame, export shows the first.
 *
 * Self-contained: the preview bridge runs it from its source text.
 */
export function frameSeek(grid: { start: number; rate: number }, time: number) {
  const frame = Math.floor((time - grid.start) * grid.rate + 1e-6);
  return grid.start + (Math.max(0, frame) + 0.25) / grid.rate;
}
