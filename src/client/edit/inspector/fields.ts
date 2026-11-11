import { frameTime, toFrames } from "../../../shared/timeline/apply";
import type {
  CommandInput,
  Fps,
  Timeline,
} from "../../../shared/timeline/schema";
import { formatPercent } from "../../../shared/timeline/labels";
import {
  formatTimecode,
  parseTimecode,
} from "../../../shared/timeline/timecode";

export type FieldUnit = "timecode" | "percent";
export type TimingField = "start" | "duration" | "speed" | "sourceIn";

export function parseField(text: string, unit: FieldUnit, fps: Fps): number {
  const input = text.trim();
  if (unit === "timecode") {
    if (/^\d+(?:\.\d+)?\s*s$/.test(input))
      return toFrames(Number.parseFloat(input), fps);
    if (/^\d+\s*f$/.test(input)) return Number.parseInt(input, 10);
    if (/^\d{1,2}:\d{2}:\d{2}:\d{2}$/.test(input) || /^\d{1,8}$/.test(input)) {
      const frame = parseTimecode(input.replaceAll(":", ""), fps);
      if (frame !== null) return frame;
    }
    throw new Error("Use HH:MM:SS:FF, seconds with s, or frames with f.");
  }
  if (!/^\d+(?:\.\d+)?\s*%?$/.test(input))
    throw new Error("Enter a percentage, such as 75%.");
  return Number.parseFloat(input) / 100;
}

export const formatField = (value: number | null, unit: FieldUnit, fps: Fps) =>
  value === null
    ? "Auto"
    : unit === "timecode"
      ? formatTimecode(value, fps)
      : formatPercent(value);

/** Uses the same move and trim commands as the timeline, with source timing shared by linked media. */
export function timingCommands(
  timeline: Timeline,
  clipId: string,
  field: TimingField,
  value: number,
): CommandInput[] {
  const clip = timeline.clips.find((item) => item.id === clipId);
  if (!clip) throw new Error("This clip was removed.");
  if (field === "start")
    return value === clip.start
      ? []
      : [
          {
            type: "move",
            clipIds: [clipId],
            by: value - clip.start,
            mode: "place",
          },
        ];
  if (field === "duration")
    return value === clip.duration
      ? []
      : [{ type: "trim", clipId, edge: "end", to: clip.start + value }];
  if (field === "speed")
    return value === clip.playbackRate
      ? []
      : [{ type: "setTiming", clipId, playbackRate: value }];
  const mediaStart = frameTime(value, timeline.fps);
  return mediaStart === clip.mediaStart
    ? []
    : [{ type: "setTiming", clipId, mediaStart }];
}
