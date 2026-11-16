import { frameTime, toSeconds } from "../../shared/timeline/apply";
import { framesAfter, framesBefore } from "../../shared/timeline/transition";
import type { Clip, Timeline } from "../../shared/timeline/schema";
import type { PipelinePlan } from "../../shared/pipeline";

type Plan = Exclude<PipelinePlan, { reason: string }>;
type Fit = Plan["drawable"][string];

export interface Shown {
  clip: Clip;
  fit: Fit;
  /** Source seconds the runtime seeks this clip's media to at the frame. */
  time: number;
  /** The clip's own opacity as its transitions animate it. */
  opacity: number;
  brightness: number;
}

/**
 * Which drawable video clips show at a frame, bottom first, and how their transitions draw them.
 * Null when a video the plan never classified shows there, so the frame needs HyperFrames.
 *
 * A clip's element runs across its transitions: it starts `framesBefore` its first frame and ends
 * `framesAfter` its last. Cutroom's transitions sheet animates it in element-local seconds. A cross
 * dissolve fades only the clip later in the document; a dip takes the picture to black and back.
 */
export function shownAt(
  timeline: Timeline,
  plan: Plan,
  frame: number,
): Shown[] | null {
  const { fps } = timeline;
  const seconds = (frames: number) => (frames * fps.den) / fps.num;
  const order = new Map(plan.order.map((id, index) => [id, index]));
  const off = new Set(
    timeline.tracks.filter((track) => !track.enabled).map(({ index }) => index),
  );
  const fitOf = (clip: Clip): Fit | null => {
    const named = plan.drawable[clip.id];
    if (named) return named;
    if (order.has(clip.id)) return null;
    // A piece an edit just made, such as the razor's, draws as the clip it came from until the
    // next plan names it: its neighbour on the track, or else any clip of the file, if they agree.
    const known = timeline.clips.filter(
      (other) => other.src === clip.src && plan.drawable[other.id],
    );
    const neighbour = known.find(
      (other) =>
        other.track === clip.track &&
        (other.start + other.duration === clip.start ||
          clip.start + clip.duration === other.start),
    );
    if (neighbour) return plan.drawable[neighbour.id]!;
    const fits = new Set(known.map((other) => plan.drawable[other.id]!));
    return fits.size === 1 ? [...fits][0]! : null;
  };
  const shown: (Shown & { level: number; index: number })[] = [];
  for (const clip of timeline.clips) {
    if (clip.kind !== "video" || !clip.enabled || off.has(clip.track)) continue;
    const before = clip.transitionIn ? framesBefore(clip.transitionIn) : 0;
    const after = clip.transitionOut ? framesAfter(clip.transitionOut) : 0;
    const first = clip.start - before;
    const end = clip.start + clip.duration + after;
    if (frame < first || frame >= end) continue;
    const fit = fitOf(clip);
    if (!fit || clip.mediaStart === null) return null;
    const partner = (edge: "in" | "out") =>
      timeline.clips.find(
        (other) =>
          other.track === clip.track &&
          other.kind === "video" &&
          (edge === "in"
            ? other.start + other.duration === clip.start && other.transitionOut
            : other.start === clip.start + clip.duration && other.transitionIn),
      );
    // The earlier of a dissolving pair in the document holds; the later one fades.
    const under = (edge: "in" | "out") => {
      const other = partner(edge);
      return (
        !!other &&
        (order.get(clip.id) ?? Infinity) < (order.get(other.id) ?? Infinity)
      );
    };
    // Animations run on the attributes as written, in seconds rounded to six decimals, so a
    // frame exactly halfway through a dip falls on the same side of it as in HyperFrames.
    const local = frameTime(frame, fps) - toSeconds(first, fps);
    const length = toSeconds(end - first, fps);
    const still = clip.opacity ?? 1;
    let opacity = still;
    let brightness = 1;
    const transitionIn = clip.transitionIn;
    if (transitionIn) {
      const duration = toSeconds(transitionIn.duration, fps);
      const progress = local / duration;
      if (progress < 1)
        if (transitionIn.kind === "dip") {
          opacity = progress < 0.5 ? 0 : 1;
          brightness = progress < 0.5 ? 0 : (progress - 0.5) * 2;
        } else if (!under("in")) opacity = still * progress;
    }
    const transitionOut = clip.transitionOut;
    if (transitionOut) {
      const duration = toSeconds(transitionOut.duration, fps);
      const progress = Math.min(1, (local - (length - duration)) / duration);
      if (progress >= 0)
        if (transitionOut.kind === "dip") {
          opacity = progress < 0.5 ? still + (1 - still) * progress * 2 : 0;
          brightness = progress < 0.5 ? 1 - progress * 2 : 0;
        } else if (!under("out")) opacity = still * (1 - progress);
    }
    shown.push({
      clip,
      fit,
      time:
        clip.mediaStart +
        seconds(frame - clip.start) * clip.playbackRate +
        // The runtime seeks just past the frame's start, as HyperFrames does.
        1e-5,
      opacity,
      brightness,
      level: plan.trackZ[String(clip.track)] ?? 0,
      index: order.get(clip.id) ?? Infinity,
    });
  }
  return shown
    .sort((a, b) => a.level - b.level || a.index - b.index)
    .map(({ level: _level, index: _index, ...rest }) => rest);
}
