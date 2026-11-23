import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import type { HfAutomationPoint } from "@hyperframes/core/audio-automation";
import { readClipSource, resolveClip } from "./clipTiming";
import {
  curvePosition,
  frames,
  secondsOf,
  sourceAt,
  speedsAt,
  subtract,
} from "./piece";
import type { Clip, Fps } from "./schema";

/** How the speed changes from a point to the next. Custom is a shape authored with `curve` or `via`. */
export type SpeedEase = "linear" | "custom";
/** A ramp point at a clip-local frame, fractional when the lane was authored in seconds. */
export type SpeedPoint = { frame: number; speed: number; ease: SpeedEase };

const round = (value: number, places: number) =>
  Math.round(value * 10 ** places) / 10 ** places;

const shaped = (point: HfAutomationPoint) =>
  !!point.curve || (point.viaX !== undefined && point.viaY !== undefined);

/** True when the clip's speed is a ramp: a rate lane in its automation. */
export const hasRamp = (
  clip: Pick<Clip, "automation" | "mediaStart" | "playbackRate">,
) => !!clip.automation?.includes('"rate"') && !!readClipSource(clip).lane;

/** The clip's ramp points, or null when it plays at a constant speed. */
export function speedPoints(clip: Clip, fps: Fps): SpeedPoint[] | null {
  const { lane } = readClipSource(clip);
  if (!lane) return null;
  const piece = resolveClip(clip, fps);
  const start = frames(clip.start, fps);
  return lane.points.map((point) => ({
    frame: round(
      (secondsOf(subtract(curvePosition(piece, point.t), start)) * fps.num) /
        fps.den,
      3,
    ),
    speed: round(point.v, 6),
    ease: shaped(point) ? "custom" : "linear",
  }));
}

/** The clip's speed at a clip-local frame. */
export const speedAtFrame = (clip: Clip, fps: Fps, frame: number) =>
  speedsAt(resolveClip(clip, fps), frames(clip.start, fps), [
    (frame * fps.den) / fps.num,
  ])[0]!;

/** The source frame the clip shows on its last frame, on the timeline's frame grid. */
export function sourceOutFrame(clip: Clip, fps: Fps) {
  if (clip.mediaStart === null) return null;
  const time = sourceAt(
    resolveClip(clip, fps),
    frames(clip.start + clip.duration - 1, fps),
  );
  const seconds = typeof time === "number" ? time : secondsOf(time);
  return Math.floor((seconds * fps.num) / fps.den + 1e-6);
}

/** Samples across a shaped segment. Straight segments are straight on the log scale and need none. */
const SHAPED_SAMPLES = 24;
const curves = new WeakMap<Clip, { fps: Fps; curve: readonly CurveSample[] }>();
type CurveSample = { frame: number; speed: number };

/**
 * The clip's speed from its first frame to its end, for drawing on the log scale: the clip's
 * edges, every point inside it, and samples through segments with a shape. Log interpolation
 * draws a plain segment as a straight line, so its two ends describe it exactly.
 */
export function speedCurve(clip: Clip, fps: Fps): readonly CurveSample[] {
  const cached = curves.get(clip);
  if (cached?.fps === fps) return cached.curve;
  const points = speedPoints(clip, fps) ?? [];
  const at = new Set([0, clip.duration]);
  points.forEach((point, index) => {
    if (point.frame > 0 && point.frame < clip.duration) at.add(point.frame);
    const next = points[index + 1];
    if (point.ease !== "custom" || !next) return;
    for (let step = 1; step < SHAPED_SAMPLES; step++) {
      const frame =
        point.frame + ((next.frame - point.frame) * step) / SHAPED_SAMPLES;
      if (frame > 0 && frame < clip.duration) at.add(frame);
    }
  });
  const sorted = [...at].sort((a, b) => a - b);
  const speeds = speedsAt(
    resolveClip(clip, fps),
    frames(clip.start, fps),
    sorted.map((frame) => (frame * fps.den) / fps.num),
  );
  const curve = sorted.map((frame, index) => ({
    frame,
    speed: speeds[index]!,
  }));
  curves.set(clip, { fps, curve });
  return curve;
}

const LOG_MIN = Math.log10(MIN_PLAYBACK_RATE);
const LOG_MAX = Math.log10(MAX_PLAYBACK_RATE);

/** How far down the speed scale a speed sits, 0 at 1000% to 1 at 10%, on a log scale. */
export const speedLevel = (speed: number) =>
  (LOG_MAX -
    Math.log10(
      Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, speed)),
    )) /
  (LOG_MAX - LOG_MIN);
