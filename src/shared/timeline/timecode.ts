import type { Fps } from "./schema";

/**
 * Timecode counts whole frames at the nominal rate (24 for 23.976, 30 for 29.97), as Resolve's
 * non-drop-frame timecode does, so every frame has exactly one label.
 */
export const nominal = (fps: Fps) => Math.round(fps.num / fps.den);
const pad = (value: number) => String(value).padStart(2, "0");

/** `HH:MM:SS:FF` for a frame number. */
export function formatTimecode(frame: number, fps: Fps): string {
  const rate = nominal(fps);
  const seconds = Math.floor(frame / rate);
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}:${pad(frame % rate)}`;
}

/**
 * A timecode cut where its zeros carry nothing: the leading groups that are all zero, and with
 * `trailing`, a frames group of `00` after a value (the ruler, whose labels fall on whole
 * seconds). The value is never empty: the frames group always stays in it or in `tail`.
 * The three parts joined are the timecode unchanged.
 */
export function quietTimecode(
  timecode: string,
  { trailing = false }: { trailing?: boolean } = {},
): { lead: string; value: string; tail: string } {
  const lead = /^(?:00:){0,3}/.exec(timecode)![0];
  const rest = timecode.slice(lead.length);
  const tail = trailing && rest.length > 2 && rest.endsWith(":00") ? ":00" : "";
  return { lead, value: rest.slice(0, rest.length - tail.length), tail };
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
