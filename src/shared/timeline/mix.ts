import {
  HF_AUDIO_AUTOMATION_VERSION,
  MAX_AUTOMATION_POINTS,
  VOLUME_TARGET,
  gainedVolume,
  isBentSegment,
  parseAutomation,
  sampleAutomationLane,
  serializeAutomation,
} from "@hyperframes/core/audio-automation";
import type { HfAutomationLane } from "@hyperframes/core/audio-automation";
import { clampFadesToDuration } from "@hyperframes/core/audio-fade";
import type { Clip, Fps } from "./schema";

/** Native fades on the frame grid, including externally authored fades that overlap. */
export function clipFades(clip: Pick<Clip, "fadeIn" | "fadeOut" | "duration">) {
  const fades = clampFadesToDuration(clip, clip.duration);
  const fadeIn = Math.round(fades.fadeIn);
  return {
    fadeIn,
    fadeOut: Math.min(Math.round(fades.fadeOut), clip.duration - fadeIn),
  };
}

/** Trims keep edge fades; cuts preserve the source envelope across their internal edge. */
export function windowMix(
  clip: Clip,
  from: number,
  duration: number,
  fps: Fps,
  mode: "trim" | "cut",
) {
  const { fadeIn, fadeOut } = clipFades(clip);
  const to = from + duration;
  const edges = mode === "trim" ? clipFades({ ...clip, duration }) : null;
  const nextIn =
    edges?.fadeIn ?? (from <= 0 && fadeIn <= duration ? fadeIn : 0);
  const nextOut =
    edges?.fadeOut ??
    (to >= clip.duration && fadeOut <= duration - nextIn ? fadeOut : 0);
  const seconds = (frames: number) =>
    Math.round(((frames * fps.den) / fps.num) * 1e6) / 1e6;
  const offset = seconds(from);
  const automation = clip.automation
    ? parseAutomation(clip.automation)
    : { version: HF_AUDIO_AUTOMATION_VERSION, lanes: [] };
  const volume = automation.lanes.find((lane) => lane.target === VOLUME_TARGET);
  // Retain the source ramp beyond a cut so extension cannot hold a partial level.
  const length = Math.max(
    seconds(Math.max(duration, clip.duration - from)),
    (volume?.points.at(-1)?.t ?? 0) - offset,
  );
  const partialIn =
    mode === "cut" && fadeIn > 0 && nextIn === 0 && from < fadeIn;
  const partialOut =
    mode === "cut" &&
    fadeOut > 0 &&
    nextOut === 0 &&
    to > clip.duration - fadeOut;
  const residual = (time: number) => {
    const frame = (time * fps.num) / fps.den;
    const head = partialIn
      ? Math.max(0, Math.min(1, (from + frame) / fadeIn))
      : 1;
    const tail = partialOut
      ? Math.max(0, Math.min(1, (clip.duration - from - frame) / fadeOut))
      : 1;
    return head * tail;
  };
  const lanes = automation.lanes.map((lane) => {
    if (from === 0) return lane;
    // Keeping the point beyond the end retains the exact outgoing segment on a tail trim.
    const points = lane.points
      .filter((point) => point.t > offset)
      .map((point) => ({ ...point, t: Math.max(0, point.t - offset) }));
    return {
      ...lane,
      points: [{ t: 0, v: sampleAutomationLane(lane, offset) }, ...points],
    };
  });
  const crossing = volume?.points.findLast((point) => point.t <= offset);
  if (
    partialIn ||
    partialOut ||
    (from > 0 && crossing && isBentSegment(crossing))
  ) {
    const times = [
      ...new Set([
        0,
        length,
        seconds(fadeIn - from),
        seconds(clip.duration - fadeOut - from),
        ...(volume?.points.map((point) => point.t - offset) ?? []),
      ]),
    ]
      .filter((time) => time >= 0 && time <= length)
      .sort((a, b) => a - b);
    const value = (time: number) => {
      const lane = volume ? sampleAutomationLane(volume, time + offset) : 1;
      const gain = clip.volume ?? 1;
      return (
        (gain > 0 ? gainedVolume(lane, gain) / gain : lane) * residual(time)
      );
    };
    const points: HfAutomationLane["points"] = [{ t: 0, v: value(0) }];
    const append = (start: number, end: number, depth = 0) => {
      const middle = (start + end) / 2;
      // Native fades alone are linear. Existing volume curves may need extra breakpoints after multiplication.
      if (
        depth < 12 &&
        [0.25, 0.5, 0.75].some(
          (fraction) =>
            Math.abs(
              value(start + (end - start) * fraction) -
                (value(start) + (value(end) - value(start)) * fraction),
            ) > 0.0001,
        )
      ) {
        append(start, middle, depth + 1);
        append(middle, end, depth + 1);
        return;
      }
      points.push({ t: end, v: value(end) });
    };
    for (let index = 1; index < times.length; index++)
      append(times[index - 1]!, times[index]!);
    if (points.length > MAX_AUTOMATION_POINTS)
      throw new Error(
        "The cut would exceed HyperFrames' volume automation limit.",
      );
    const lane = { target: VOLUME_TARGET, points };
    const index = lanes.findIndex((entry) => entry.target === VOLUME_TARGET);
    if (index < 0) lanes.push(lane);
    else lanes[index] = lane;
  }
  return {
    fadeIn: nextIn,
    fadeOut: nextOut,
    automation: lanes.length
      ? serializeAutomation({ ...automation, lanes })
      : null,
  };
}
