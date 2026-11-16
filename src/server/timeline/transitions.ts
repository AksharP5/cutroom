import {
  HF_AUDIO_AUTOMATION_VERSION,
  VOLUME_TARGET,
  normalizeAutomation,
  parseAutomation,
  serializeAutomation,
} from "@hyperframes/core/audio-automation";
import { frameTime, toFrames, toSeconds } from "../../shared/timeline/apply";
import { TransitionSchema } from "../../shared/timeline/schema";
import { shiftKeyframes } from "../../shared/timeline/keyframes";
import { KEYFRAME_ANIMATION } from "./keyframes";
import type { Clip, Fps, Transition } from "../../shared/timeline/schema";
import {
  framesAfter,
  framesBefore,
  takesTransition,
} from "../../shared/timeline/transition";

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
    `animation-name:${KEYFRAME_ANIMATION.name},var(--cutroom-transition-in-name),var(--cutroom-transition-out-name);` +
    `animation-duration:${KEYFRAME_ANIMATION.duration},calc(var(--cutroom-transition-in)*1s),calc(var(--cutroom-transition-out)*1s);` +
    `animation-delay:${KEYFRAME_ANIMATION.delay},0s,calc((var(--cutroom-transition-length) - var(--cutroom-transition-out))*1s);` +
    `animation-iteration-count:${KEYFRAME_ANIMATION.iterations},1,1;` +
    `animation-fill-mode:${KEYFRAME_ANIMATION.fill},none,forwards;` +
    `animation-timing-function:${KEYFRAME_ANIMATION.timing},linear,linear}`,
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

/** Breakpoints per crossfade side; straight pieces of a sine stay within 0.05 dB of equal power. */
const CROSSFADE_STEPS = 8;

/**
 * The volume envelope a clip with sound plays across its transitions, in element-local seconds:
 * up on a quarter sine and down on a quarter cosine, so the two sides keep a steady power whether
 * or not their sound is related. Null for a clip without sound or without transitions.
 */
export function crossfadeAutomation(clip: Clip, fps: Fps): string | null {
  const { transitionIn, transitionOut } = clip;
  if (!clip.hasAudio || (!transitionIn && !transitionOut)) return null;
  const length =
    clip.duration +
    (transitionIn ? framesBefore(transitionIn) : 0) +
    (transitionOut ? framesAfter(transitionOut) : 0);
  const at = (frames: number) => toSeconds(frames, fps);
  const ramp = (from: number, frames: number, rising: boolean) =>
    Array.from({ length: CROSSFADE_STEPS + 1 }, (_, step) => {
      const progress = step / CROSSFADE_STEPS;
      const angle = ((rising ? progress : 1 - progress) * Math.PI) / 2;
      return {
        t: Number(
          (at(from) + (at(frames) * step) / CROSSFADE_STEPS).toFixed(6),
        ),
        v: Number(Math.sin(angle).toFixed(6)),
      };
    });
  const points = [
    ...(transitionIn ? ramp(0, transitionIn.duration, true) : [{ t: 0, v: 1 }]),
    ...(transitionOut
      ? ramp(length - transitionOut.duration, transitionOut.duration, false)
      : [{ t: at(length), v: 1 }]),
  ];
  // Normalised as the reader does, so ramps that meet share one breakpoint.
  return serializeAutomation(
    normalizeAutomation({
      version: HF_AUDIO_AUTOMATION_VERSION,
      lanes: [{ target: VOLUME_TARGET, points }],
    }),
  );
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

/**
 * The element a clip is written as. Its media runs on under each transition, and a clip with sound
 * plays the crossfade envelope across them. A clip with its own volume automation keeps it and
 * crossfades with straight fades instead.
 */
export function elementClip(clip: Clip, fps: Fps): Clip {
  const { transitionIn, transitionOut } = clip;
  if (!takesTransition(clip) || (!transitionIn && !transitionOut)) return clip;
  const before = transitionIn ? framesBefore(transitionIn) : 0;
  const after = transitionOut ? framesAfter(transitionOut) : 0;
  const straight = clip.hasAudio && clip.automation !== null;
  return {
    ...clip,
    start: clip.start - before,
    duration: clip.duration + before + after,
    mediaStart:
      clip.mediaStart === null
        ? null
        : clip.mediaStart - frameTime(before, fps) * clip.playbackRate,
    fadeIn: transitionIn && straight ? transitionIn.duration : clip.fadeIn,
    fadeOut: transitionOut && straight ? transitionOut.duration : clip.fadeOut,
    automation: clip.automation ?? crossfadeAutomation(clip, fps),
    keyframes: shiftKeyframes(clip.keyframes, -before),
  };
}
