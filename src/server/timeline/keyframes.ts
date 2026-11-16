import { toFrames, toSeconds } from "../../shared/timeline/apply";
import {
  KEYFRAME_EASES,
  KEYFRAME_PROPERTIES,
  KeyframesSchema,
} from "../../shared/timeline/schema";
import type {
  Fps,
  KeyframeEase,
  KeyframeProperty,
  Keyframes,
} from "../../shared/timeline/schema";
import { tracksOf } from "../../shared/timeline/keyframes";
import type { KeyframeValues } from "../../shared/timeline/keyframes";
import { transformStyle } from "../../shared/timeline/transform";

/** A clip's keyframes, in element-local seconds. The stylesheet below draws them. */
export const KEYFRAMES_ATTRIBUTE = "data-cutroom-keyframes";
export const KEYFRAME_STYLE_ATTRIBUTE = "data-cutroom-keyframe-style";
const STYLE_VERSION = "1";

/** Each value's numbers in the attribute, in order, and back. */
const FORMATS: {
  [P in KeyframeProperty]: {
    numbers(value: KeyframeValues[P]): number[];
    value(numbers: number[]): unknown;
    css(value: KeyframeValues[P]): string;
  };
} = {
  position: {
    numbers: ({ x, y }) => [x, y],
    value: ([x, y]) => ({ x, y }),
    css: ({ x, y }) => `translate:${x}px ${y}px`,
  },
  scale: {
    numbers: ({ x, y }) => [x, y],
    value: ([x, y]) => ({ x, y }),
    css: ({ x, y }) =>
      `scale:${transformStyle({ scaleX: x, scaleY: y, rotation: null, crop: null }).scale}`,
  },
  rotation: {
    numbers: (degrees) => [degrees],
    value: ([degrees]) => degrees,
    css: (degrees) => `rotate:${degrees}deg`,
  },
  crop: {
    numbers: ({ top, right, bottom, left }) => [top, right, bottom, left],
    value: ([top, right, bottom, left]) => ({ top, right, bottom, left }),
    css: (crop) =>
      `clip-path:${transformStyle({ scaleX: null, scaleY: null, rotation: null, crop })["clip-path"]}`,
  },
  opacity: {
    numbers: (opacity) => [opacity],
    value: ([opacity]) => opacity,
    css: (opacity) => `opacity:${opacity}`,
  },
};
const ARITY: Record<KeyframeProperty, number> = {
  position: 2,
  scale: 2,
  rotation: 1,
  crop: 4,
  opacity: 1,
};

/** The attribute for keyframes at element-local frames; null for none. */
export function keyframesAttribute(
  keyframes: Keyframes | null,
  fps: Fps,
): string | null {
  if (!keyframes) return null;
  const tracks = tracksOf({ keyframes });
  const track = <P extends KeyframeProperty>(property: P) =>
    tracks[property]?.map(({ frame, value, ease }) =>
      [
        toSeconds(frame, fps),
        ...FORMATS[property].numbers(value),
        ...(ease === "linear" ? [] : [ease]),
      ].join(" "),
    );
  return (
    KEYFRAME_PROPERTIES.flatMap((property) => {
      const keyframes = track(property);
      return keyframes ? [`${property} ${keyframes.join(", ")}`] : [];
    }).join("; ") || null
  );
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Keyframes at element-local frames from the attribute, or null when it is absent or is not one
 * Cutroom writes. Every value passes the schema, so only numbers and named eases reach CSS.
 */
export function readKeyframes(
  attribute: string | undefined,
  fps: Fps,
): Keyframes | null {
  if (attribute === undefined) return null;
  const tracks: Record<string, unknown[]> = {};
  for (const part of attribute.split("; ")) {
    const [, name, list] = /^([a-z]+) (.+)$/.exec(part) ?? [];
    const property = KEYFRAME_PROPERTIES.find((known) => known === name);
    if (!property || !list || tracks[property]) return null;
    tracks[property] = list.split(", ").map((keyframe) => {
      const tokens = keyframe.split(" ");
      const ease = KEYFRAME_EASES.find((known) => known === tokens.at(-1));
      if (ease) tokens.pop();
      const [seconds, ...numbers] = tokens.map((token) =>
        NUMBER.test(token) ? Number(token) : Number.NaN,
      );
      return {
        frame: seconds === undefined ? Number.NaN : toFrames(seconds, fps),
        value:
          numbers.length === ARITY[property]
            ? FORMATS[property].value(numbers)
            : null,
        ease: ease ?? "linear",
      };
    });
  }
  const parsed = KeyframesSchema.safeParse(tracks);
  return parsed.success && Object.keys(parsed.data).length ? parsed.data : null;
}

const TIMING = {
  linear: "linear",
  "ease-in": "ease-in",
  "ease-out": "ease-out",
  "ease-in-out": "ease-in-out",
  hold: "steps(1,end)",
} satisfies Record<KeyframeEase, string>;

/**
 * The animation a keyframed clip runs, as one entry of an `animation-*` list. Titles and transitions
 * put it first in theirs, so their fades draw over the keyframed opacity as they do over a static
 * one. It runs from the first keyframe to the last and holds outside them; its iterations are cut
 * at the element's end, so a keyframe a trim left outside the clip never lengthens a composition
 * whose length the runtime infers from its animations.
 */
export const KEYFRAME_ANIMATION = {
  name: "var(--cutroom-keyframes,none)",
  duration: "calc(var(--cutroom-keyframes-span,1)*1s)",
  delay:
    "calc(min(var(--cutroom-keyframes-at,0),attr(data-duration type(<number>),0))*1s)",
  iterations:
    "clamp(0,(attr(data-duration type(<number>),0) - var(--cutroom-keyframes-at,0))/var(--cutroom-keyframes-span,1),1)",
  fill: "both",
  timing: "linear",
};

const BASE_RULE =
  `:where([${KEYFRAMES_ATTRIBUTE}]){` +
  `animation-name:${KEYFRAME_ANIMATION.name};` +
  `animation-duration:${KEYFRAME_ANIMATION.duration};` +
  `animation-delay:${KEYFRAME_ANIMATION.delay};` +
  `animation-iteration-count:${KEYFRAME_ANIMATION.iterations};` +
  `animation-fill-mode:${KEYFRAME_ANIMATION.fill};` +
  `animation-timing-function:${KEYFRAME_ANIMATION.timing}}`;

const number = (value: number) => String(Number(value.toFixed(6)) + 0);

/** One attribute value's rules: its custom properties and its `@keyframes`. */
function keyframeRules(attribute: string, fps: Fps): string | null {
  const keyframes = readKeyframes(attribute, fps);
  if (!keyframes) return null;
  const tracks = tracksOf({ keyframes });
  const frames = KEYFRAME_PROPERTIES.flatMap(
    (property) => tracks[property]?.map((keyframe) => keyframe.frame) ?? [],
  );
  const at = toSeconds(Math.min(...frames), fps);
  const span = toSeconds(Math.max(...frames), fps) - at || 1;
  const offset = (frame: number) =>
    `${number(((toSeconds(frame, fps) - at) / span) * 100)}%`;
  const blocks = <P extends KeyframeProperty>(property: P) => {
    const track = tracks[property];
    if (!track) return [];
    const css = (value: KeyframeValues[P]) => FORMATS[property].css(value);
    const [first, last] = [track[0]!, track.at(-1)!];
    // Each property holds its first and last value over the whole animation.
    return [
      ...(toSeconds(first.frame, fps) > at ? [`0%{${css(first.value)}}`] : []),
      ...track.map(
        (keyframe) =>
          `${offset(keyframe.frame)}{${css(keyframe.value)};animation-timing-function:${TIMING[keyframe.ease]}}`,
      ),
      ...(toSeconds(last.frame, fps) < at + span
        ? [`100%{${css(last.value)}}`]
        : []),
    ];
  };
  const name = `cutroom-keyframes-${Bun.hash(attribute).toString(36)}`;
  // The attribute holds only numbers, property and ease names, spaces and separators.
  return (
    `[${KEYFRAMES_ATTRIBUTE}="${attribute}"]{--cutroom-keyframes:${name};--cutroom-keyframes-at:${number(at)};--cutroom-keyframes-span:${number(span)}}\n` +
    `@keyframes ${name}{${KEYFRAME_PROPERTIES.flatMap(blocks).join("")}}`
  );
}

/** The stylesheet block that draws these attribute values, or null when no clip has keyframes. */
export function keyframeStyle(
  attributes: Iterable<string>,
  fps: Fps,
): string | null {
  const rules = [...new Set(attributes)]
    .sort()
    .flatMap((attribute) => keyframeRules(attribute, fps) ?? []);
  if (!rules.length) return null;
  return `<style ${KEYFRAME_STYLE_ATTRIBUTE}="${STYLE_VERSION}">\n${[BASE_RULE, ...rules].join("\n")}\n</style>`;
}
