import { offsetSourceTime } from "../../shared/timeline/time";
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
 * HyperFrames draws the plan's other videos above them. Null when a video the plan never
 * classified shows there, or an edit has put one of HyperFrames' videos beneath one of the
 * pipeline's, so the frame needs HyperFrames.
 *
 * A clip's element runs across its transitions: it starts `framesBefore` its first frame and ends
 * `framesAfter` its last. Cutroom's transitions sheet animates it in element-local seconds. A cross
 * dissolve fades only the clip later in the document; a dip takes the picture to black and back.
 */
function layerQuery(timeline: Timeline, plan: Plan, from: number, to: number) {
  const { fps } = timeline;
  const order = new Map(plan.order.map((id, index) => [id, index]));
  const off = new Set(
    timeline.tracks.filter((track) => !track.enabled).map(({ index }) => index),
  );
  type Owner = Fit | "hyperframes";
  const named = (id: string): Owner | undefined =>
    plan.drawable[id] ?? (plan.hyperframes[id] ? "hyperframes" : undefined);
  const ownerOf = (clip: Clip): Owner | null => {
    const owner = named(clip.id);
    if (owner) return owner;
    if (order.has(clip.id)) return null;
    // A piece an edit just made, such as the razor's, draws as the clip it came from until the
    // next plan names it: its neighbour on the track, or else any clip of the file, if they agree.
    const known = timeline.clips.filter(
      (other) => other.src === clip.src && named(other.id),
    );
    const neighbour = known.find(
      (other) =>
        other.track === clip.track &&
        (other.start + other.duration === clip.start ||
          clip.start + clip.duration === other.start),
    );
    if (neighbour) return named(neighbour.id)!;
    const owners = new Set(known.map((other) => named(other.id)!));
    return owners.size === 1 ? [...owners][0]! : null;
  };
  // The lookahead visits every frame in the window. Prepare its metadata and candidate
  // intervals once; ownership still sees the whole timeline, including clips outside it.
  const candidates: { clip: Clip; first: number; end: number }[] = [];
  for (const clip of timeline.clips) {
    if (clip.kind !== "video" || !clip.enabled || off.has(clip.track)) continue;
    const first =
      clip.start - (clip.transitionIn ? framesBefore(clip.transitionIn) : 0);
    const end =
      clip.start +
      clip.duration +
      (clip.transitionOut ? framesAfter(clip.transitionOut) : 0);
    if (end <= from || first > to) continue;
    candidates.push({ clip, first, end });
  }
  return (frame: number): Shown[] | null => {
    const shown: (Shown & { level: number; index: number })[] = [];
    const hyperframes: { level: number; index: number }[] = [];
    for (const { clip, first, end } of candidates) {
      if (frame < first || frame >= end) continue;
      const fit = ownerOf(clip);
      if (!fit) return null;
      const level = plan.trackZ[String(clip.track)] ?? 0;
      const index = order.get(clip.id) ?? Infinity;
      if (fit === "hyperframes") {
        hyperframes.push({ level, index });
        continue;
      }
      if (clip.mediaStart === null) return null;
      const partner = (edge: "in" | "out") =>
        timeline.clips.find(
          (other) =>
            other.track === clip.track &&
            other.kind === "video" &&
            (edge === "in"
              ? other.start + other.duration === clip.start &&
                other.transitionOut
              : other.start === clip.start + clip.duration &&
                other.transitionIn),
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
          offsetSourceTime(
            clip.mediaStart,
            frame - clip.start,
            fps,
            clip.playbackRate,
          ) +
          // The runtime seeks just past the frame's start, as HyperFrames does.
          1e-5,
        opacity,
        brightness,
        level,
        index,
      });
    }
    const below = (
      a: { level: number; index: number },
      b: { level: number; index: number },
    ) => a.level < b.level || (a.level === b.level && a.index < b.index);
    if (
      shown.some((layer) => hyperframes.some((other) => !below(layer, other)))
    )
      return null;
    return shown
      .sort((a, b) => a.level - b.level || a.index - b.index)
      .map(({ level: _level, index: _index, ...rest }) => rest);
  };
}

export function shownAt(timeline: Timeline, plan: Plan, frame: number) {
  return layerQuery(timeline, plan, frame, frame)(frame);
}

/**
 * The layers a frame draws: nothing shows beneath an opaque clip that fills the frame untouched.
 * Null when the frame needs HyperFrames.
 */
function visible(all: Shown[] | null) {
  if (!all) return null;
  const covering = all.findLastIndex(
    ({ clip, fit, opacity, brightness }) =>
      opacity === 1 &&
      brightness === 1 &&
      fit !== "contain" &&
      !clip.x &&
      !clip.y &&
      (clip.scaleX ?? 1) >= 1 &&
      (clip.scaleY ?? 1) >= 1 &&
      !clip.rotation &&
      !Object.values(clip.crop ?? {}).some(Boolean),
  );
  return all.slice(Math.max(0, covering));
}

export function visibleAt(timeline: Timeline, plan: Plan, frame: number) {
  return visible(shownAt(timeline, plan, frame));
}

/** A clip that comes into view at `frame`: it starts there, or what covered it ends. */
export interface Appearance {
  frame: number;
  layer: Shown;
}

/**
 * Every clip that comes into view after `from` and up to `to`, in time order, whether it starts
 * there or a clip above it stops covering it. Each needs its opening decoded before the clock
 * gets there. Stops at a frame that needs HyperFrames.
 */
export function appearances(
  timeline: Timeline,
  plan: Plan,
  from: number,
  to: number,
): Appearance[] {
  const at = layerQuery(timeline, plan, from, to);
  const found: Appearance[] = [];
  let before = new Set(visible(at(from))?.map(({ clip }) => clip.id));
  for (let frame = from + 1; frame <= to; frame++) {
    const layers = visible(at(frame));
    if (!layers) break;
    for (const layer of layers)
      if (!before.has(layer.clip.id)) found.push({ frame, layer });
    before = new Set(layers.map(({ clip }) => clip.id));
  }
  return found;
}
