import { isAudioKind } from "./schema";
import type { Clip, Transition } from "./schema";

/** Frames of a transition before its cut; the rest come after it. */
export const framesBefore = ({ duration, alignment }: Transition) =>
  alignment === "start"
    ? 0
    : alignment === "end"
      ? duration
      : Math.floor(duration / 2);

export const framesAfter = (transition: Transition) =>
  transition.duration - framesBefore(transition);

/** Titles, scenes and authored elements own their animation, so only media takes a transition. */
export const takesTransition = (clip: Pick<Clip, "kind">) =>
  clip.kind === "video" || clip.kind === "image" || isAudioKind(clip.kind);

export const sameTransition = (a: Transition | null, b: Transition | null) =>
  a !== null &&
  b !== null &&
  a.kind === b.kind &&
  a.duration === b.duration &&
  a.alignment === b.alignment;

/** What the editor calls each kind. */
export const TRANSITION_NAMES: Record<Transition["kind"], string> = {
  dissolve: "Cross dissolve",
  dip: "Dip to black",
};
