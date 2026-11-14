import {
  audioDbToGain,
  audioGainToDb,
  audioGainToText,
  MAX_AUDIO_GAIN_DB,
} from "@hyperframes/core/audio-gain";
import type { Selection } from "../../timeline/selection";
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

export type FieldUnit = "timecode" | "percent" | "gain" | "pixels";

/** The gain floor shared with the timeline line: at or below it a clip is silent. */
const SILENCE_DB = -60;
export type TimingField = "start" | "duration" | "speed" | "sourceIn";

/** Typed gain as linear gain: dB with or without the unit, and -∞ or anything from -60 dB down as silence. */
export function parseGain(text: string) {
  const input = text.trim();
  if (/^-\s*(?:∞|inf(?:inity)?)(?:\s*dB)?$/i.test(input)) return 0;
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:dB)?$/i.test(input))
    throw new Error("Enter gain in dB, such as -6 dB, or -∞ for silence.");
  const db = Number.parseFloat(input);
  // The timeline line and stepping treat -60 dB as silence; typing below it means the same.
  if (db <= SILENCE_DB) return 0;
  const gain = audioDbToGain(db);
  if (!Number.isFinite(db) || !Number.isFinite(gain) || gain === 0)
    throw new Error("Gain is outside the supported range.");
  return gain;
}

export function parseField(text: string, unit: FieldUnit, fps: Fps): number {
  const input = text.trim();
  if (unit === "pixels") {
    if (
      !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:px)?$/.test(input) ||
      !Number.isFinite(Number.parseFloat(input))
    )
      throw new Error("Enter a position in pixels, such as -40 px.");
    return Number.parseFloat(input);
  }
  if (unit === "gain") return parseGain(input);
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
    : unit === "pixels"
      ? `${value} px`
      : unit === "gain"
        ? audioGainToText(value)
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

/** Gain gestures travel in dB, with the same silence floor and conversion as the timeline line. */
export function stepField(value: number, delta: number, unit: FieldUnit) {
  if (unit === "gain") {
    const db = Math.max(
      SILENCE_DB,
      Math.min(
        MAX_AUDIO_GAIN_DB,
        (value > 0 ? audioGainToDb(value) : SILENCE_DB) + delta,
      ),
    );
    return db <= SILENCE_DB ? 0 : audioDbToGain(Math.round(db * 10) / 10);
  }
  if (unit === "pixels") return Number((value + delta).toFixed(6));
  return unit === "timecode" ? Math.round(value + delta) : value + delta * 0.01;
}

/** A full linked group is one subject. Alt-selection can still inspect one partner alone. */
export function inspectorSubject(timeline: Timeline, selection: Selection) {
  const members = timeline.clips.filter((clip) => selection.ids.has(clip.id));
  const first = members[0];
  if (!first) return null;
  if (
    members.length > 1 &&
    (!first.link ||
      members.some((clip) => clip.link !== first.link) ||
      timeline.clips.some(
        (clip) => clip.link === first.link && !selection.ids.has(clip.id),
      ))
  )
    return null;
  const clip =
    members.find((clip) => clip.kind === "video") ??
    members.find((clip) => clip.id === selection.anchor) ??
    first;
  const partners = members.filter((clip) => clip.kind === "audio");
  const audio = partners.length
    ? partners
    : members.filter((clip) => clip.hasAudio);
  return { clip, members, audio };
}
