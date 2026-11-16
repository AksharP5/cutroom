import { isAudioKind, KEYFRAME_PROPERTIES } from "../../shared/timeline/schema";
import type {
  Clip,
  CommandInput,
  KeyframeEase,
} from "../../shared/timeline/schema";
import { tracksOf } from "../../shared/timeline/keyframes";
import { keyframeStops } from "../timeline/KeyframeMarks";

/** Timeline frames that hold a keyframe inside one of these clips, in order, each once. */
export const keyframeFrames = (clips: readonly Clip[]) =>
  [
    ...new Set(
      clips.flatMap((clip) =>
        keyframeStops(clip).map(([frame]) => clip.start + frame),
      ),
    ),
  ].sort((a, b) => a - b);

/**
 * The keyframe Ctrl+[ or Ctrl+] sets at a clip-local frame, as Resolve's Add Keyframe and Add Static
 * Keyframe do: on every property the clip already animates, or for its first on all of them but an
 * opacity the composition's styles control. Each takes the value the clip shows there; one already
 * there keeps its value and takes the ease.
 */
export function keyAt(
  clip: Clip,
  frame: number,
  ease: KeyframeEase,
): CommandInput[] {
  if (isAudioKind(clip.kind)) return [];
  const tracks = tracksOf(clip);
  const keyed = KEYFRAME_PROPERTIES.filter((property) => tracks[property]);
  // Opacity left to the composition's styles stays theirs: keying it would set it to 100%.
  const first = KEYFRAME_PROPERTIES.filter(
    (property) => property !== "opacity" || clip.opacity !== null,
  );
  return (keyed.length ? keyed : first).map((property) => ({
    type: "setKeyframe",
    clipId: clip.id,
    property,
    frame,
    ease,
  }));
}

/** Removes every keyframe at a clip-local frame, whatever property it keys. */
export const removeAt = (clip: Clip, frame: number): CommandInput[] =>
  (keyframeStops(clip).find(([at]) => at === frame)?.[1] ?? []).map(
    (property) => ({
      type: "removeKeyframe",
      clipId: clip.id,
      property,
      frame,
    }),
  );
