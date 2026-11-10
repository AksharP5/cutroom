import type { Fps } from "../../shared/timeline/schema";

/**
 * Timecode counts whole frames at the nominal rate (24 for 23.976, 30 for 29.97), as Resolve's
 * non-drop-frame timecode does, so every frame has exactly one label.
 */
const nominal = (fps: Fps) => Math.round(fps.num / fps.den);
const pad = (value: number) => String(value).padStart(2, "0");

/** `HH:MM:SS:FF` for a frame number. */
export function formatTimecode(frame: number, fps: Fps): string {
  const rate = nominal(fps);
  const seconds = Math.floor(frame / rate);
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}:${pad(frame % rate)}`;
}

/** Up to eight typed digits, filled from the right: `1204` is `00:00:12:04`. */
export const timecodeDigits = (digits: string) =>
  digits.slice(-8).padStart(8, "0");

/** The frame that typed digits name. Frames past the rate carry into the next second. */
export function parseTimecode(digits: string, fps: Fps): number | null {
  if (!/^\d{1,8}$/.test(digits)) return null;
  const [hours = 0, minutes = 0, seconds = 0, frames = 0] = (
    timecodeDigits(digits).match(/\d\d/g) ?? []
  ).map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * nominal(fps) + frames;
}
