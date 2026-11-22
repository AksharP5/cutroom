import {
  parseAutomation,
  serializeAutomation,
} from "@hyperframes/core/audio-automation";
import { toFrames, toSeconds } from "../../shared/timeline/apply";
import { crossfadeAutomation } from "../../shared/timeline/element";
import { TransitionSchema } from "../../shared/timeline/schema";
import { KEYFRAME_ANIMATION } from "./keyframes";
import { REGION_ANIMATION } from "../../shared/timeline/regionStyle";
import type { Clip, Fps, Transition } from "../../shared/timeline/schema";

const STYLE_VERSION = "1";
export const TRANSITION_STYLE_ATTRIBUTE = "data-cutroom-transitions";

type Edge = "in" | "out";
const name = (edge: Edge, part = "") => `data-transition-${edge}${part}`;

/**
 * The one stylesheet that draws every transition from its clips' attributes. Each clip's element
 * already runs across the whole transition, so this only ramps the picture in clip-local time:
 * the runtime's CSS adapter seeks these animations in preview and render alike, with no script.
 *
 * A cross dissolve fades only the clip drawn on top, which is the later one in the document, so
 * the earlier one is marked `-under` and holds. A dip takes the outgoing clip to black and hides it
 * halfway, then brings the incoming clip up from black, so their order does not matter. Typed
 * `attr()` needs Chromium 133 or newer. Keyframe names are part of saved projects: bump the
 * version to change them.
 */
const RULES = [
  "@keyframes cutroom-dissolve-in{from{opacity:0}}",
  "@keyframes cutroom-dissolve-out{to{opacity:0}}",
  "@keyframes cutroom-dip-in{0%{opacity:0;filter:brightness(0);animation-timing-function:steps(1,end)}50%{opacity:1;filter:brightness(0)}to{opacity:1;filter:brightness(1)}}",
  "@keyframes cutroom-dip-out{0%{filter:brightness(1)}50%{opacity:1;filter:brightness(0);animation-timing-function:steps(1,start)}to{opacity:0;filter:brightness(0)}}",
  "[data-transition-in],[data-transition-out]{" +
    "--cutroom-transition-length:attr(data-duration type(<number>),0);" +
    "--cutroom-transition-in:0;--cutroom-transition-out:0;" +
    "--cutroom-transition-in-name:none;--cutroom-transition-out-name:none;" +
    // A keyframed clip's own animation comes first, so the transition draws over it.
    `animation-name:${KEYFRAME_ANIMATION.name},var(--cutroom-transition-in-name),var(--cutroom-transition-out-name),${REGION_ANIMATION.name};` +
    `animation-duration:${KEYFRAME_ANIMATION.duration},calc(var(--cutroom-transition-in)*1s),calc(var(--cutroom-transition-out)*1s),${REGION_ANIMATION.duration};` +
    `animation-delay:${KEYFRAME_ANIMATION.delay},0s,calc((var(--cutroom-transition-length) - var(--cutroom-transition-out))*1s),${REGION_ANIMATION.delay};` +
    `animation-iteration-count:${KEYFRAME_ANIMATION.iterations},1,1,${REGION_ANIMATION.iterations};` +
    `animation-fill-mode:${KEYFRAME_ANIMATION.fill},none,forwards,${REGION_ANIMATION.fill};` +
    `animation-timing-function:${KEYFRAME_ANIMATION.timing},linear,linear,${REGION_ANIMATION.timing};` +
    `animation-composition:replace,replace,replace,${REGION_ANIMATION.composition}}`,
  ...(["dissolve", "dip"] as const).flatMap((kind) =>
    (["in", "out"] as const).map(
      (edge) =>
        `[${name(edge)}="${kind}"]${kind === "dissolve" ? `:not([${name(edge, "-under")}])` : ""}{--cutroom-transition-${edge}:attr(${name(edge, "-duration")} type(<number>),0);--cutroom-transition-${edge}-name:cutroom-${kind}-${edge}}`,
    ),
  ),
];

export const transitionStyle = () =>
  `<style ${TRANSITION_STYLE_ATTRIBUTE}="${STYLE_VERSION}">\n${RULES.join("\n")}\n</style>`;

type Attributes = Readonly<Record<string, string | undefined>>;

/**
 * A clip's transitions from its element. An edge whose attributes are not ones Cutroom writes is
 * no transition, so the element reads as the clip it is.
 */
export function readTransitions(
  attrs: Attributes,
  fps: Fps,
): Record<Edge, Transition | null> {
  const read = (edge: Edge) => {
    const kind = attrs[name(edge)];
    if (kind === undefined) return null;
    const seconds = attrs[name(edge, "-duration")];
    const parsed = TransitionSchema.safeParse({
      kind,
      duration:
        seconds !== undefined && /^\d+(?:\.\d+)?$/.test(seconds)
          ? toFrames(Number(seconds), fps)
          : Number.NaN,
      alignment: attrs[name(edge, "-align")],
    });
    return parsed.success ? parsed.data : null;
  };
  return { in: read("in"), out: read("out") };
}

/** Every transition attribute of one edge; null removes one. */
export function transitionAttributes(
  edge: Edge,
  transition: Transition | null,
  under: boolean,
  fps: Fps,
): [string, string | null][] {
  return [
    [name(edge), transition?.kind ?? null],
    [
      name(edge, "-duration"),
      transition ? String(toSeconds(transition.duration, fps)) : null,
    ],
    [name(edge, "-align"), transition?.alignment ?? null],
    [
      name(edge, "-under"),
      transition?.kind === "dissolve" && under ? "" : null,
    ],
  ];
}

/** Whether an element's automation is exactly the crossfade Cutroom writes for its transitions. */
export function isCrossfadeAutomation(
  attribute: string | undefined,
  clip: Clip,
  fps: Fps,
) {
  const generated = crossfadeAutomation(clip, fps);
  if (attribute === undefined || generated === null) return false;
  try {
    return serializeAutomation(parseAutomation(attribute)) === generated;
  } catch {
    return false;
  }
}
