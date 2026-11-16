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
import { TimelineError } from "./errors";
import type { Clip, Fps } from "./schema";

const microseconds = (seconds: number) => Math.round(seconds * 1e6) / 1e6;
const frameSeconds = (frames: number, fps: Fps) =>
  microseconds((frames * fps.den) / fps.num);

/**
 * A lane on a clip that starts `offset` seconds later in its source: its points move earlier, and
 * one at the new start holds the level it had there. A negative offset only moves them later.
 */
function startLaneAt(lane: HfAutomationLane, offset: number): HfAutomationLane {
  const moved = lane.points.map((point) => ({
    ...point,
    t: microseconds(point.t - offset),
  }));
  if (offset <= 0) return { ...lane, points: moved };
  return {
    ...lane,
    points: [
      { t: 0, v: sampleAutomationLane(lane, offset) },
      ...moved.filter((point) => point.t > 0),
    ],
  };
}

/**
 * Clip-local automation re-timed for an element that starts `seconds` earlier than the clip, as
 * one does under a transition. A negative value reads such an element's automation back.
 */
export function offsetAutomation(automation: string, seconds: number) {
  if (!seconds) return automation;
  const parsed = parseAutomation(automation);
  return serializeAutomation({
    ...parsed,
    lanes: parsed.lanes.map((lane) => startLaneAt(lane, -seconds)),
  });
}

/** A point on a clip's volume lane: clip-local frames, and linear gain on top of the clip's gain. */
export interface VolumePoint {
  frame: number;
  gain: number;
}

/** The clip's volume lane as points, or null when it has none. */
export function volumePoints(
  automation: string | null,
  fps: Fps,
): VolumePoint[] | null {
  if (!automation) return null;
  const lane = parseAutomation(automation).lanes.find(
    (entry) => entry.target === VOLUME_TARGET,
  );
  return (
    lane?.points.map((point) => ({
      frame: Math.round(((point.t * fps.num) / fps.den) * 1e3) / 1e3,
      gain: Math.round(point.v * 1e6) / 1e6,
    })) ?? null
  );
}

/**
 * Automation with its volume lane replaced by straight runs between these points. Effect lanes
 * stay; no points removes the volume lane, and with it automation that holds nothing else.
 */
export function withVolumePoints(
  automation: string | null,
  points: readonly VolumePoint[],
  fps: Fps,
) {
  const parsed = automation
    ? parseAutomation(automation)
    : { version: HF_AUDIO_AUTOMATION_VERSION, lanes: [] };
  const timed = points
    .map((point) => ({ t: frameSeconds(point.frame, fps), v: point.gain }))
    .sort((a, b) => a.t - b.t);
  if (timed.some((point, index) => index && point.t === timed[index - 1]!.t))
    throw new TimelineError(
      "unsupported",
      "Two volume points share a frame. Give each its own frame.",
    );
  const lanes = [
    ...parsed.lanes.filter((lane) => lane.target !== VOLUME_TARGET),
    ...(timed.length ? [{ target: VOLUME_TARGET, points: timed }] : []),
  ];
  return lanes.length ? serializeAutomation({ ...parsed, lanes }) : null;
}

/** Effective fades, in frames, using the same proportional clamp as preview and render. */
export function clipFades(clip: Pick<Clip, "fadeIn" | "fadeOut" | "duration">) {
  return clampFadesToDuration(clip, clip.duration);
}

/** Trims keep edge fades; cuts preserve the source envelope across their internal edge. */
export function windowMix(
  clip: Clip,
  from: number,
  duration: number,
  fps: Fps,
  mode: "trim" | "cut",
) {
  if (mode === "trim" && (from === 0 || !clip.automation)) return {};
  const { fadeIn, fadeOut } =
    mode === "cut" ? clipFades(clip) : { fadeIn: 0, fadeOut: 0 };
  const to = from + duration;
  // A scaled fade must be baked: retaining its authored length would rescale it to the cut piece.
  const nextIn =
    from <= 0 && fadeIn === clip.fadeIn && fadeIn <= duration ? fadeIn : 0;
  const nextOut =
    to >= clip.duration &&
    fadeOut === clip.fadeOut &&
    fadeOut <= duration - nextIn
      ? fadeOut
      : 0;
  const seconds = (frames: number) => frameSeconds(frames, fps);
  const offset = seconds(from);
  const automation = clip.automation
    ? parseAutomation(clip.automation)
    : { version: HF_AUDIO_AUTOMATION_VERSION, lanes: [] };
  const volume = automation.lanes.find((lane) => lane.target === VOLUME_TARGET);
  // Retain the source ramp beyond a cut so extension cannot hold a partial level.
  const length = Math.max(
    seconds(clip.duration - from),
    (volume?.points.at(-1)?.t ?? 0) - offset,
  );
  const partialIn = fadeIn > 0 && nextIn === 0 && from < fadeIn;
  const partialOut =
    fadeOut > 0 && nextOut === 0 && to > clip.duration - fadeOut;
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
  // Known limit: a head trim loses earlier clip-local points; restoring them needs source-anchored keyframes.
  const lanes = automation.lanes.map((lane) =>
    from === 0 ? lane : startLaneAt(lane, offset),
  );
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
      throw new TimelineError(
        "unsupported",
        "The cut would exceed HyperFrames' volume automation limit.",
      );
    const lane = { target: VOLUME_TARGET, points };
    const index = lanes.findIndex((entry) => entry.target === VOLUME_TARGET);
    if (index < 0) lanes.push(lane);
    else lanes[index] = lane;
  }
  return {
    ...(mode === "cut" && { fadeIn: nextIn, fadeOut: nextOut }),
    automation: lanes.length
      ? serializeAutomation({ ...automation, lanes })
      : null,
  };
}
