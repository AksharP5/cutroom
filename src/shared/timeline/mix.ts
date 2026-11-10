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

/** Preserve the audible window. A fade cut away from its zero edge becomes native volume automation. */
export function windowMix(
  clip: Clip,
  from: number,
  duration: number,
  fps: Fps,
) {
  const { fadeIn, fadeOut } = clipFades(clip);
  const to = from + duration;
  const nextIn = from <= 0 ? Math.min(fadeIn, duration) : 0;
  const nextOut =
    to >= clip.duration ? Math.min(fadeOut, duration - nextIn) : 0;
  const seconds = (frames: number) =>
    Math.round(((frames * fps.den) / fps.num) * 1e6) / 1e6;
  const offset = seconds(from);
  const length = seconds(duration);
  const automation = clip.automation
    ? parseAutomation(clip.automation)
    : { version: HF_AUDIO_AUTOMATION_VERSION, lanes: [] };
  const volume = automation.lanes.find((lane) => lane.target === VOLUME_TARGET);
  const partialIn =
    fadeIn > 0 &&
    ((from > 0 && from < fadeIn) || (nextIn > 0 && nextIn < fadeIn));
  const partialOut =
    fadeOut > 0 &&
    ((to < clip.duration && to > clip.duration - fadeOut) ||
      (nextOut > 0 && nextOut < fadeOut));
  const residual = (time: number) => {
    const frame = (time * fps.num) / fps.den;
    const head = !partialIn
      ? 1
      : from <= 0
        ? nextIn / fadeIn
        : Math.min(1, (from + frame) / fadeIn);
    const tail = !partialOut
      ? 1
      : to >= clip.duration
        ? nextOut / fadeOut
        : Math.min(1, (clip.duration - from - frame) / fadeOut);
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
