import { clipEnd, gapAt } from "../../shared/timeline/apply";
import type { Clip, Timeline } from "../../shared/timeline/schema";
import { destinationTracks } from "../../shared/timeline/tracks";
import type { TimelineViewSettings } from "../../shared/timeline/view";
import type { FrameRange } from "./math";

export interface Selection {
  ids: ReadonlySet<string>;
  /** The clip a Shift-click range starts from: the last clip clicked without Shift. */
  anchor: string | null;
  /** A selected transition, named by the clip it leads into. It is selected alone. */
  transition?: string;
  /** A selected gap between clips on a track, which Delete closes. It is selected alone. */
  gap?: Gap;
  /** A selected cut, gap edge or end of a track. */
  editPoint?: EditPoint;
}

export interface EditPoint {
  from?: string;
  to?: string;
  mode: "start" | "end" | "roll";
}

export function clipsAtEditPoint(timeline: Timeline, point: EditPoint) {
  const from =
    point.from && timeline.clips.find((clip) => clip.id === point.from);
  const to = point.to && timeline.clips.find((clip) => clip.id === point.to);
  if (from && to && clipEnd(from) === to.start && from.track === to.track)
    return { from, to };
  // A one-sided trim can leave a gap. Keep the chosen side selected for the next press.
  if (point.mode === "end" && from) return { from, to: undefined };
  if (point.mode === "start" && to) return { from: undefined, to };
  return null;
}

/** Find the nearest edge on the enabled picture destination, or on the sound destination. */
export function nearestEditPoint(
  timeline: Timeline,
  frame: number,
  chosen: TimelineViewSettings["destinations"],
): EditPoint | null {
  const { video, audio, videoEnabled, audioEnabled } = destinationTracks(
    timeline.tracks,
    chosen,
  );
  const track = [
    ...(videoEnabled ? [video] : []),
    ...(audioEnabled ? [audio] : []),
  ].find(
    ({ locked, index }) =>
      !locked && timeline.clips.some((clip) => clip.track === index),
  );
  if (!track) return null;
  let nearest: {
    distance: number;
    clip: Clip;
    edge: "start" | "end";
  } | null = null;
  for (const clip of timeline.clips) {
    if (clip.track !== track.index) continue;
    for (const edge of ["start", "end"] as const) {
      const distance = Math.abs(
        frame - (edge === "start" ? clip.start : clipEnd(clip)),
      );
      if (!nearest || distance < nearest.distance)
        nearest = { distance, clip, edge };
    }
  }
  if (!nearest) return null;
  const { clip, edge } = nearest;
  const other = timeline.clips.find(
    (item) =>
      item.track === clip.track &&
      item.id !== clip.id &&
      (edge === "start"
        ? clipEnd(item) === clip.start
        : item.start === clipEnd(clip)),
  );
  return {
    from: edge === "end" ? clip.id : other?.id,
    to: edge === "start" ? clip.id : other?.id,
    mode: other ? "roll" : edge,
  };
}

export function selectedEditEdges(
  timeline: Timeline,
  point: EditPoint,
  linked: boolean,
) {
  const sides = clipsAtEditPoint(timeline, point);
  if (!sides) return [];
  return (["end", "start"] as const).flatMap((edge) => {
    if (point.mode !== "roll" && point.mode !== edge) return [];
    const clip = edge === "end" ? sides.from : sides.to;
    if (!clip) return [];
    const clips =
      linked && clip.link
        ? timeline.clips.filter((item) => item.link === clip.link)
        : [clip];
    return clips.map((item) => ({
      id: item.id,
      track: item.track,
      edge,
      frame: edge === "start" ? item.start : clipEnd(item),
    }));
  });
}

export interface Gap {
  track: number;
  from: number;
  to: number;
}

/**
 * The gap a click on an empty lane selects, as in Resolve: the empty time between two clips, or
 * before a track's first clip. Null after the last clip and on a locked track.
 */
export function gapSelection(
  timeline: Timeline,
  track: number,
  frame: number,
): Selection | null {
  if (lockedTracks(timeline).has(track)) return null;
  const gap = gapAt(timeline, track, frame);
  return gap ? { ids: new Set(), anchor: null, gap: { track, ...gap } } : null;
}
export const emptySelection: Selection = { ids: new Set(), anchor: null };

/**
 * Where each gap starts on unlocked tracks with auto-select on, in order: the empty time before a
 * track's first clip or between two clips, as a click on an empty lane selects it.
 */
export function gapStarts(timeline: Timeline) {
  const starts = new Set<number>();
  for (const track of timeline.tracks) {
    if (!track.autoSelect || track.locked) continue;
    let end = 0;
    for (const clip of timeline.clips
      .filter((clip) => clip.track === track.index)
      .toSorted((a, b) => a.start - b.start)) {
      if (clip.start > end) starts.add(end);
      end = Math.max(end, clipEnd(clip));
    }
  }
  return [...starts].toSorted((a, b) => a - b);
}

export interface ClickModifiers {
  /** Ctrl or Cmd: add or remove the clip. */
  toggle: boolean;
  /** Shift: select everything between the anchor and the clip. */
  range: boolean;
  /** Alt: leave linked clips out. */
  alone: boolean;
}

const lockedTracks = (timeline: Timeline) =>
  new Set(
    timeline.tracks.filter((track) => track.locked).map((track) => track.index),
  );

/** Clips on locked tracks cannot be selected, as in Resolve. */
const selectable = (timeline: Timeline) => {
  const locked = lockedTracks(timeline);
  return timeline.clips.filter((clip) => !locked.has(clip.track));
};

const withLinked = (clips: readonly Clip[], picked: readonly Clip[]) => {
  const links = new Set(picked.flatMap((clip) => clip.link ?? []));
  const ids = new Set(picked.map((clip) => clip.id));
  return clips
    .filter((clip) => ids.has(clip.id) || (clip.link && links.has(clip.link)))
    .map((clip) => clip.id);
};

const touches = (clip: Clip, { from, to }: FrameRange) =>
  clip.start < to && clipEnd(clip) > from;

/**
 * A click on a clip. `order` lists track indexes top to bottom as displayed, so a Shift-click
 * covers the tracks between the anchor and the clip.
 */
export function clickSelection(
  timeline: Timeline,
  order: readonly number[],
  current: Selection,
  id: string,
  { toggle, range, alone }: ClickModifiers,
  linked = true,
): Selection {
  const clips = selectable(timeline);
  const clip = clips.find((item) => item.id === id);
  if (!clip) return current;
  const anchor = clips.find((item) => item.id === current.anchor);
  if (range && anchor) {
    const rows = [order.indexOf(anchor.track), order.indexOf(clip.track)];
    const tracks = new Set(
      order.slice(Math.min(...rows), Math.max(...rows) + 1),
    );
    const span = {
      from: Math.min(anchor.start, clip.start),
      to: Math.max(clipEnd(anchor), clipEnd(clip)),
    };
    const picked = clips.filter(
      (item) => tracks.has(item.track) && touches(item, span),
    );
    return {
      ids: new Set(
        linked && !alone
          ? withLinked(clips, picked)
          : picked.map(({ id }) => id),
      ),
      anchor: anchor.id,
    };
  }
  const group = alone || !linked ? [clip.id] : withLinked(clips, [clip]);
  if (!toggle) return { ids: new Set(group), anchor: clip.id };
  const ids = new Set(current.ids);
  for (const member of group)
    if (current.ids.has(clip.id)) ids.delete(member);
    else ids.add(member);
  return { ids, anchor: clip.id };
}

/** Clips a marquee touches on the given tracks, added to `base` when a modifier is held. */
export function marqueeSelection(
  timeline: Timeline,
  tracks: readonly number[],
  range: FrameRange,
  base: Selection = emptySelection,
  linked = true,
): Selection {
  const clips = selectable(timeline);
  const inside = clips.filter(
    (clip) => tracks.includes(clip.track) && touches(clip, range),
  );
  return {
    ids: new Set([
      ...base.ids,
      ...(linked ? withLinked(clips, inside) : inside.map(({ id }) => id)),
    ]),
    anchor: base.anchor,
  };
}

/** Select All includes every unlocked track, regardless of auto-select or linked partners. */
export function selectAll(timeline: Timeline): Selection {
  return {
    ids: new Set(selectable(timeline).map((clip) => clip.id)),
    anchor: null,
  };
}

/** Shift+V: the clips under the playhead on unlocked tracks with auto-select on. */
export function selectionAtPlayhead(
  timeline: Timeline,
  frame: number,
): Selection {
  const tracks = new Set(
    timeline.tracks
      .filter((track) => track.autoSelect && !track.locked)
      .map((track) => track.index),
  );
  return {
    ids: new Set(
      timeline.clips
        .filter(
          (clip) =>
            tracks.has(clip.track) &&
            touches(clip, { from: frame, to: frame + 1 }),
        )
        .map((clip) => clip.id),
    ),
    anchor: null,
  };
}

/** Start-based selection includes the playhead boundary in either direction, without linked expansion. */
export function selectionFromPlayhead(
  timeline: Timeline,
  frame: number,
  direction: "forward" | "backward",
  allTracks = false,
): Selection {
  const tracks = new Set(
    timeline.tracks
      .filter((track) => !track.locked && (allTracks || track.autoSelect))
      .map((track) => track.index),
  );
  return {
    ids: new Set(
      timeline.clips
        .filter(
          (clip) =>
            tracks.has(clip.track) &&
            (direction === "forward"
              ? clip.start >= frame
              : clip.start <= frame),
        )
        .map((clip) => clip.id),
    ),
    anchor: null,
  };
}

/** Drops ids of clips that no longer exist or sit on a track that was locked since. */
export function pruneSelection(
  timeline: Timeline,
  current: Selection,
): Selection {
  const { gap, editPoint } = current;
  if (editPoint) {
    const sides = clipsAtEditPoint(timeline, editPoint);
    const track = sides?.from?.track ?? sides?.to?.track;
    return sides &&
      !timeline.tracks.some((item) => item.index === track && item.locked)
      ? current
      : emptySelection;
  }
  if (gap) {
    const now = gapSelection(timeline, gap.track, gap.from)?.gap;
    return now?.from === gap.from && now.to === gap.to
      ? current
      : emptySelection;
  }
  if (current.transition !== undefined)
    return selectable(timeline).some(
      (clip) => clip.id === current.transition && clip.transitionIn,
    )
      ? current
      : emptySelection;
  const ids = new Set(
    selectable(timeline)
      .filter((clip) => current.ids.has(clip.id))
      .map((clip) => clip.id),
  );
  if (ids.size === current.ids.size) return current;
  return {
    ids,
    anchor: current.anchor && ids.has(current.anchor) ? current.anchor : null,
  };
}
