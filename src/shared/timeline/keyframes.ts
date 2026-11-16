import type { z } from "zod";
import { KEYFRAME_PROPERTIES, KeyframeValueSchemas } from "./schema";
import type { Clip, KeyframeEase, KeyframeProperty, Keyframes } from "./schema";

export type KeyframeValues = {
  [P in KeyframeProperty]: z.output<(typeof KeyframeValueSchemas)[P]>;
};
export type Keyframe<P extends KeyframeProperty> = {
  frame: number;
  value: KeyframeValues[P];
  ease: KeyframeEase;
};
type Track<P extends KeyframeProperty> = Keyframe<P>[] | undefined;
type Tracks = { [P in KeyframeProperty]?: Track<P> };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
type Point = KeyframeValues["position"];
const lerpPoint = (a: Point, b: Point, t: number) => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});

interface Property<V> {
  /** The value a clip without keyframes shows. */
  read(clip: Clip): V;
  /** The static fields that show `value`, with the identity stored as null. */
  write(value: V): Partial<Clip>;
  mix(a: V, b: V, t: number): V;
}

const PROPERTIES: { [P in KeyframeProperty]: Property<KeyframeValues[P]> } = {
  position: {
    read: (clip) => ({ x: clip.x ?? 0, y: clip.y ?? 0 }),
    write: ({ x, y }) => ({ x: x || null, y: y || null }),
    mix: lerpPoint,
  },
  scale: {
    read: (clip) => ({ x: clip.scaleX ?? 1, y: clip.scaleY ?? 1 }),
    write: ({ x, y }) =>
      x === 1 && y === 1
        ? { scaleX: null, scaleY: null }
        : { scaleX: x, scaleY: y },
    mix: lerpPoint,
  },
  rotation: {
    read: (clip) => clip.rotation ?? 0,
    write: (rotation) => ({ rotation: rotation || null }),
    mix: lerp,
  },
  crop: {
    read: (clip) => clip.crop ?? { top: 0, right: 0, bottom: 0, left: 0 },
    write: (crop) => ({
      crop: Object.values(crop).some(Boolean) ? crop : null,
    }),
    mix: (a, b, t) => ({
      top: lerp(a.top, b.top, t),
      right: lerp(a.right, b.right, t),
      bottom: lerp(a.bottom, b.bottom, t),
      left: lerp(a.left, b.left, t),
    }),
  },
  opacity: {
    read: (clip) => clip.opacity ?? 1,
    write: (opacity) => ({ opacity }),
    mix: lerp,
  },
};

/** Parses one property's keyframe value, typed by the property. */
const PARSERS: {
  [P in KeyframeProperty]: (
    value: unknown,
  ) => z.ZodSafeParseResult<KeyframeValues[P]>;
} = {
  position: (value) => KeyframeValueSchemas.position.safeParse(value),
  scale: (value) => KeyframeValueSchemas.scale.safeParse(value),
  rotation: (value) => KeyframeValueSchemas.rotation.safeParse(value),
  crop: (value) => KeyframeValueSchemas.crop.safeParse(value),
  opacity: (value) => KeyframeValueSchemas.opacity.safeParse(value),
};
export const parseKeyframeValue = <P extends KeyframeProperty>(
  property: P,
  value: unknown,
) => PARSERS[property](value);

/** The static fields each property owns, all null while it has keyframes. */
const CLEARED = {
  position: { x: null, y: null },
  scale: { scaleX: null, scaleY: null },
  rotation: { rotation: null },
  crop: { crop: null },
  opacity: { opacity: null },
} satisfies Record<KeyframeProperty, Partial<Clip>>;

/** CSS easing for each ease, applied from a keyframe to the next. */
const EASE_CURVES = {
  linear: [0, 0, 1, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
} as const satisfies Record<
  Exclude<KeyframeEase, "hold">,
  readonly [number, number, number, number]
>;

/** Progress along a CSS `cubic-bezier`, as browsers solve it: Newton steps, then bisection. */
function cubicBezier(
  [x1, y1, x2, y2]: readonly [number, number, number, number],
  progress: number,
) {
  const at = (a: number, b: number, s: number) =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3;
  const slope = (a: number, b: number, s: number) =>
    3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s ** 2;
  let s = progress;
  for (let step = 0; step < 8; step++) {
    const error = at(x1, x2, s) - progress;
    if (Math.abs(error) < 1e-7) return at(y1, y2, s);
    const d = slope(x1, x2, s);
    if (Math.abs(d) < 1e-6) break;
    s -= error / d;
  }
  let [low, high] = [0, 1];
  s = progress;
  while (high - low > 1e-7) {
    if (at(x1, x2, s) < progress) low = s;
    else high = s;
    s = (low + high) / 2;
  }
  return at(y1, y2, s);
}

const easeProgress = (ease: KeyframeEase, progress: number) =>
  ease === "hold" ? 0 : cubicBezier(EASE_CURVES[ease], progress);

export const tracksOf = (clip: Pick<Clip, "keyframes">): Tracks =>
  clip.keyframes ?? {};

/** The value a property shows at a clip-local frame: its keyframes interpolated, or its static value. */
export function valueAt<P extends KeyframeProperty>(
  clip: Clip,
  property: P,
  frame: number,
): KeyframeValues[P] {
  const spec = PROPERTIES[property];
  const track = tracksOf(clip)[property];
  if (!track) return spec.read(clip);
  const next = track.findIndex((keyframe) => keyframe.frame > frame);
  if (next === 0) return track[0]!.value;
  if (next === -1) return track.at(-1)!.value;
  const from = track[next - 1]!;
  const to = track[next]!;
  return spec.mix(
    from.value,
    to.value,
    easeProgress(from.ease, (frame - from.frame) / (to.frame - from.frame)),
  );
}

const withTrack = <P extends KeyframeProperty>(
  clip: Clip,
  property: P,
  track: Track<P>,
): Clip => {
  const tracks: Tracks = { ...tracksOf(clip), [property]: track };
  if (!track) delete tracks[property];
  const keyframes: Keyframes | null = Object.keys(tracks).length
    ? tracks
    : null;
  return { ...clip, ...(track && CLEARED[property]), keyframes };
};

/**
 * The runtime draws a static position through GSAP, which folds the clip's `scale` and `rotate`
 * into its own transform once, at whatever value an animation shows then. So a clip with scale or
 * rotation keyframes keeps its position in keyframes too.
 */
function settle(clip: Clip, frame: number): Clip {
  const tracks = tracksOf(clip);
  if (
    tracks.position ||
    (!tracks.scale && !tracks.rotation) ||
    (clip.x === null && clip.y === null)
  )
    return clip;
  return withTrack(clip, "position", [
    { frame, value: PROPERTIES.position.read(clip), ease: "linear" },
  ]);
}

/** Adds the keyframe at `frame`, or replaces the one there. */
export function setKeyframe<P extends KeyframeProperty>(
  clip: Clip,
  property: P,
  frame: number,
  value: KeyframeValues[P],
  ease?: KeyframeEase,
): Clip {
  const track = tracksOf(clip)[property] ?? [];
  const existing = track.find((keyframe) => keyframe.frame === frame);
  const keyframe: Keyframe<P> = {
    frame,
    value,
    ease: ease ?? existing?.ease ?? "linear",
  };
  return settle(
    withTrack(
      clip,
      property,
      [...track.filter((item) => item.frame !== frame), keyframe].sort(
        (a, b) => a.frame - b.frame,
      ),
    ),
    frame,
  );
}

/** Removes the keyframe at `frame`; the last one leaves its value as the static value. */
export function removeKeyframe<P extends KeyframeProperty>(
  clip: Clip,
  property: P,
  frame: number,
): Clip {
  const track = tracksOf(clip)[property] ?? [];
  const removed = track.find((keyframe) => keyframe.frame === frame);
  if (!removed) return clip;
  const rest = track.filter((keyframe) => keyframe !== removed);
  if (rest.length) return withTrack(clip, property, rest);
  return {
    ...withTrack(clip, property, undefined),
    ...PROPERTIES[property].write(removed.value),
  };
}

/** Moves a keyframe to another frame, keeping its value and ease. */
export function moveKeyframe<P extends KeyframeProperty>(
  clip: Clip,
  property: P,
  frame: number,
  to: number,
): Clip {
  const track = tracksOf(clip)[property] ?? [];
  return withTrack(
    clip,
    property,
    track
      .map((keyframe) =>
        keyframe.frame === frame ? { ...keyframe, frame: to } : keyframe,
      )
      .sort((a, b) => a.frame - b.frame),
  );
}

/** Keyframes on a clip whose first frame moves `by` frames later in its content. */
export function shiftKeyframes(
  keyframes: Keyframes | null,
  by: number,
): Keyframes | null {
  if (!keyframes || by === 0) return keyframes;
  const tracks: Tracks = keyframes;
  const shift = <P extends KeyframeProperty>(property: P): Tracks =>
    tracks[property]
      ? {
          [property]: tracks[property].map((keyframe) => ({
            ...keyframe,
            frame: keyframe.frame - by,
          })),
        }
      : {};
  return KEYFRAME_PROPERTIES.reduce<Tracks>(
    (shifted, property) => ({ ...shifted, ...shift(property) }),
    {},
  );
}
