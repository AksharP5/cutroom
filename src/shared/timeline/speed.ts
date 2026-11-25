import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import {
  HF_AUDIO_AUTOMATION_VERSION,
  parseAutomation,
  RATE_TARGET,
  serializeAutomation,
} from "@hyperframes/core/audio-automation";
import type {
  HfAutomationEase,
  HfAutomationLane,
  HfAutomationPoint,
} from "@hyperframes/core/audio-automation";
import { framesAfterOut, readClipSource, resolveClip } from "./clipTiming";
import { TimelineError } from "./errors.ts";
import {
  attrMicros,
  curvePosition,
  encode,
  frames,
  secondsOf,
  sourceAt,
  sourceSeconds,
  speedsAt,
  subtract,
} from "./piece";
import type { Clip, Fps, KeyframeEase, SpeedPresetId } from "./schema";

/**
 * How the speed changes from a point to the next: the keyframe eases, or custom for a shape
 * authored elsewhere with `curve` or `via`, which is kept until its ease is changed.
 */
export type SpeedEase = KeyframeEase | "custom";
/** A ramp point at a clip-local frame, fractional when the lane was authored in seconds. */
export type SpeedPoint = { frame: number; speed: number; ease: SpeedEase };
/** A point as an edit gives it. No ease keeps a custom shape already on that frame, else linear. */
export type SpeedInput = { frame: number; speed: number; ease?: KeyframeEase };

/** The lane's spelling of each keyframe ease. Linear is a plain point. */
const LANE_EASES = {
  "ease-in": "in",
  "ease-out": "out",
  "ease-in-out": "in-out",
  hold: "hold",
} as const satisfies Record<Exclude<KeyframeEase, "linear">, HfAutomationEase>;

const easeOf = (point: HfAutomationPoint): SpeedEase =>
  point.ease
    ? (Object.keys(LANE_EASES) as (keyof typeof LANE_EASES)[]).find(
        (ease) => LANE_EASES[ease] === point.ease,
      )!
    : shaped(point)
      ? "custom"
      : "linear";

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
    ease: easeOf(point),
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
    if (point.ease === "linear" || point.ease === "hold" || !next) return;
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

const seconds = (frame: number, fps: Fps) =>
  round((frame * fps.den) / fps.num, 6);

/**
 * The clip's automation with its rate lane replaced by these points. Points before the clip's
 * first frame move the curve's zero earlier, as a head trim does. Other lanes stay.
 */
export function withSpeedPoints(
  clip: Clip,
  points: readonly SpeedInput[],
  fps: Fps,
) {
  const sorted = [...points].sort((a, b) => a.frame - b.frame);
  const twin = sorted.find(
    (point, index) => index && point.frame === sorted[index - 1]!.frame,
  );
  if (twin)
    throw new TimelineError(
      "unsupported",
      `Two speed points share frame ${twin.frame}. Use Hold to change speed on one frame.`,
    );
  const { lane } = readClipSource(clip);
  const current = lane ? speedPoints(clip, fps)! : [];
  const base = Math.min(0, sorted[0]!.frame);
  const rate = {
    target: RATE_TARGET,
    points: sorted.map(({ frame, speed, ease }) => {
      const index =
        ease === undefined
          ? current.findIndex((point) => point.frame === frame)
          : -1;
      const kept = index < 0 ? undefined : lane!.points[index]!;
      return {
        t: seconds(frame - base, fps),
        v: speed,
        ...(ease && ease !== "linear" && { ease: LANE_EASES[ease] }),
        ...(kept?.curve && { curve: kept.curve }),
        ...(kept?.viaX !== undefined &&
          kept.viaY !== undefined && { viaX: kept.viaX, viaY: kept.viaY }),
      };
    }),
    ...(base && { offset: seconds(-base, fps) }),
  };
  return withRateLane(clip.automation, rate)!;
}

function withRateLane(automation: string | null, rate?: HfAutomationLane) {
  const parsed = automation
    ? parseAutomation(automation)
    : { version: HF_AUDIO_AUTOMATION_VERSION, lanes: [] };
  const lanes = parsed.lanes.filter(({ target }) => target !== RATE_TARGET);
  if (rate) lanes.push(rate);
  return lanes.length ? serializeAutomation({ ...parsed, lanes }) : null;
}

/** Put one speed curve on the timeline clock, keeping each file's source time at the anchor. */
export function speedProjection(
  target: Clip,
  clips: readonly Clip[],
  fps: Fps,
  anchorFrame = Math.min(...clips.map(({ start }) => start)),
) {
  const anchor = frames(anchorFrame, fps);
  const previous = clips.map((clip) => ({
    clip,
    start: frames(clip.start, fps),
    source: Number(
      attrMicros(sourceSeconds(sourceAt(resolveClip(clip, fps), anchor))),
    ),
  }));
  return (edit: number | readonly SpeedInput[]) => {
    const playbackRate = typeof edit === "number" ? edit : 1;
    const draft = resolveClip(
      {
        ...target,
        playbackRate,
        mediaStart: 0,
        automation:
          typeof edit === "number" ? null : withSpeedPoints(target, edit, fps),
      },
      fps,
    );
    const { curve } = draft;
    const elapsed =
      Number(attrMicros(sourceSeconds(sourceAt(draft, anchor)))) - draft.zero;
    return previous.map(({ clip, start, source }) => {
      const { mediaStart, offset } = encode(
        { c: draft.c, tau: draft.tau, zero: source - elapsed },
        curve,
        start,
        fps,
      );
      return {
        ...clip,
        mediaStart: mediaStart / 1e6,
        playbackRate,
        speedSpan: undefined,
        automation: withRateLane(
          clip.automation,
          typeof curve === "object"
            ? {
                ...curve,
                ...(offset && { offset: offset / 1e6 }),
              }
            : undefined,
        ),
      };
    });
  };
}

export function speedSourceLimit(clip: Clip, fps: Fps) {
  if (clip.mediaStart !== null && clip.mediaStart < 0) return "before";
  if (framesAfterOut(clip, fps) < 0) return "after";
  return null;
}

/** Keep the hit pinned and lower the surrounding speeds until every linked source fits. */
export function fitSlowMoHit(
  project: ReturnType<typeof speedProjection>,
  points: readonly SpeedInput[],
  at: number,
  fps: Fps,
) {
  const def = project(points);
  const limited = def.find((clip) => speedSourceLimit(clip, fps));
  if (!limited) return { clips: def };
  const side = speedSourceLimit(limited, fps);
  const cap = (percent: number) =>
    project(
      points.map((point) => ({
        ...point,
        speed: Math.min(point.speed, percent / 100),
      })),
    );
  let low = Math.round(MIN_PLAYBACK_RATE * 100);
  let high = 100;
  let clips = cap(low);
  if (clips.some((clip) => speedSourceLimit(clip, fps)))
    throw new TimelineError(
      "out_of_bounds",
      `Not enough source ${side} the hit on clip ${limited.id}, even at ${low}%.`,
    );
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const trial = cap(middle);
    if (trial.some((clip) => speedSourceLimit(clip, fps))) high = middle;
    else {
      low = middle;
      clips = trial;
    }
  }
  const speed = points.find(({ frame }) => frame === at)!.speed;
  return {
    clips,
    notice: `Not enough source ${side} the hit. Slowed to ${Math.min(Math.round(speed * 100), low)}%.`,
  };
}

type PresetShape = (duration: number, at: number, fps: Fps) => SpeedInput[];
const third = (duration: number) => Math.round(duration / 3);

/** One list, read by the Presets menu and by `setSpeed.preset`. Frames are clip-local. */
export const SPEED_PRESETS = [
  {
    id: "speed-into-cut",
    label: "Speed into cut",
    shape: (d) => [
      { frame: d - third(d), speed: 1, ease: "ease-in" },
      { frame: d, speed: 4 },
    ],
  },
  {
    id: "speed-out-of-cut",
    label: "Speed out of cut",
    shape: (d) => [
      { frame: 0, speed: 4, ease: "ease-out" },
      { frame: third(d), speed: 1 },
    ],
  },
  {
    id: "slow-mo-hit",
    label: "Slow-mo hit",
    // Down to 25% by the hit, held for a second, back to 100% over 8 frames.
    shape: (_, at, fps) => {
      const second = Math.round(fps.num / fps.den);
      return [
        { frame: at - 8, speed: 1, ease: "ease-in-out" },
        { frame: at, speed: 0.25 },
        { frame: at + second, speed: 0.25, ease: "ease-in-out" },
        { frame: at + second + 8, speed: 1 },
      ];
    },
  },
  {
    id: "speed-through",
    label: "Speed through",
    shape: (d) => [
      { frame: third(d), speed: 1, ease: "ease-in-out" },
      { frame: Math.round(d / 2), speed: 3, ease: "ease-in-out" },
      { frame: d - third(d), speed: 1 },
    ],
  },
  {
    id: "ease-in-out",
    label: "Ease in and out",
    shape: (d) => [
      { frame: 0, speed: 0.5, ease: "ease-in-out" },
      { frame: Math.round(d * 0.3), speed: 1 },
      { frame: d - Math.round(d * 0.3), speed: 1, ease: "ease-in-out" },
      { frame: d, speed: 0.5 },
    ],
  },
] as const satisfies readonly {
  id: SpeedPresetId;
  label: string;
  shape: PresetShape;
}[];

/** The most a ramp's point can speed up before the clip runs past its source, to a hundredth. */
export function mostSpeed(
  clip: Clip,
  points: readonly SpeedInput[],
  index: number,
  fps: Fps,
) {
  const fits = (speed: number) =>
    framesAfterOut(
      {
        ...clip,
        automation: withSpeedPoints(
          clip,
          points.map((point, at) =>
            at === index ? { ...point, speed } : point,
          ),
          fps,
        ),
      },
      fps,
    ) >= 0;
  let low = MIN_PLAYBACK_RATE;
  let high = MAX_PLAYBACK_RATE;
  if (fits(high)) return high;
  if (!fits(low)) return null;
  while (high - low > 0.005) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return Math.floor(low * 100) / 100;
}
