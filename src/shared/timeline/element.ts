import {
  HF_AUDIO_AUTOMATION_VERSION,
  VOLUME_TARGET,
  normalizeAutomation,
  serializeAutomation,
} from "@hyperframes/core/audio-automation";
import { frameTime, toSeconds } from "./apply";
import { elementBounds, sourceAtEdge } from "./clipTiming";
import { shiftKeyframes } from "./keyframes";
import { offsetAutomation } from "./mix";
import { frames } from "./piece";
import type { Clip, Fps } from "./schema";
import { framesAfter, framesBefore, takesTransition } from "./transition";

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

/**
 * The element a clip is written as. Its media runs on under each transition, and a clip with sound
 * plays the crossfade envelope across them. A clip with its own volume automation keeps it and
 * crossfades with straight fades instead.
 */
export function elementClip(clip: Clip, fps: Fps): Clip {
  const { transitionIn, transitionOut } = clip;
  if (!takesTransition(clip) || (!transitionIn && !transitionOut)) return clip;
  const { start, end } = elementBounds(clip);
  const before = clip.start - start;
  const straight = clip.hasAudio && clip.automation !== null;
  const source = sourceAtEdge(
    clip,
    frames(clip.start, fps),
    frames(start, fps),
    fps,
  );
  return {
    ...clip,
    start,
    duration: end - start,
    mediaStart: source.mediaStart,
    fadeIn: transitionIn && straight ? transitionIn.duration : clip.fadeIn,
    fadeOut: transitionOut && straight ? transitionOut.duration : clip.fadeOut,
    // Mix lanes run from the element start. The rate lane already carries its encoded offset.
    automation: source.automation
      ? offsetAutomation(source.automation, frameTime(before, fps))
      : crossfadeAutomation(clip, fps),
    keyframes: shiftKeyframes(clip.keyframes, -before),
  };
}
