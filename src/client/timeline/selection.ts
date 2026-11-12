import { clipEnd } from "../../shared/timeline/apply";
import type { Clip, Timeline } from "../../shared/timeline/schema";
import type { FrameRange } from "./math";

export interface Selection {
  ids: ReadonlySet<string>;
  /** The clip a Shift-click range starts from: the last clip clicked without Shift. */
  anchor: string | null;
}
export const emptySelection: Selection = { ids: new Set(), anchor: null };

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
    return {
      ids: new Set(
        withLinked(
          clips,
          clips.filter((item) => tracks.has(item.track) && touches(item, span)),
        ),
      ),
      anchor: anchor.id,
    };
  }
  const group = alone ? [clip.id] : withLinked(clips, [clip]);
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
): Selection {
  const clips = selectable(timeline);
  const inside = clips.filter(
    (clip) => tracks.includes(clip.track) && touches(clip, range),
  );
  return {
    ids: new Set([...base.ids, ...withLinked(clips, inside)]),
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
