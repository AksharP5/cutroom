import { shiftRateLane } from "@hyperframes/core/speed-ramp";
import type { HfAutomationLane } from "@hyperframes/core/audio-automation";
import type { Clip, Fps } from "./schema.ts";
import { framesAfter, framesBefore, takesTransition } from "./transition.ts";

/** The original media element's exact timing, before it is projected onto editor frames. */
export const authoredRampAudioWindow = Symbol("authored ramp audio window");
/** The element's subframe start and end relative to the timeline's whole-frame edges. */
export const authoredRampEdges = Symbol("authored ramp edges");
export type RampEdges = { start: number; end: number };
export const frameAlignedRampEdges: RampEdges = { start: 0, end: 0 };
export type ObservedRampClip = Clip & {
  [authoredRampAudioWindow]?: NonNullable<HfAutomationLane["audioWindow"]>;
  [authoredRampEdges]?: RampEdges;
};

/** The element window includes the footage under transitions and both authored outer edges. */
export function elementBounds(clip: ObservedRampClip, fps: Fps) {
  const transition = takesTransition(clip);
  const before =
    transition && clip.transitionIn ? framesBefore(clip.transitionIn) : 0;
  const after =
    transition && clip.transitionOut ? framesAfter(clip.transitionOut) : 0;
  const edges = clip[authoredRampEdges] ?? frameAlignedRampEdges;
  const seconds = (frames: number) => (frames * fps.den) / fps.num;
  return {
    before,
    after,
    start: seconds(clip.start - before) + edges.start,
    end: seconds(clip.start + clip.duration + after) + edges.end,
  };
}

/** Shift a lane from the timeline's displayed cut to the element's physical start. */
export function elementRate(
  clip: ObservedRampClip,
  fps: Fps,
  lane: HfAutomationLane,
) {
  const window = elementBounds(clip, fps);
  return shiftRateLane(lane, window.start - (clip.start * fps.den) / fps.num);
}
