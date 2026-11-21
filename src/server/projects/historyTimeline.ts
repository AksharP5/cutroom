import { clipEnd, TimelineError } from "../../shared/timeline/apply";
import type {
  Clip,
  Timeline,
  TimelineSettings,
} from "../../shared/timeline/schema";
import { groupClips, tailShift } from "../../shared/timeline/tailShift";
import {
  compositionScope,
  parseComposition,
  reverseComposition,
} from "../timeline/composition";

function timingChanged(before: Clip, after: Clip) {
  return (
    before.start !== after.start ||
    before.duration !== after.duration ||
    before.track !== after.track
  );
}

function timingConflict(before: Timeline, after: Timeline, current: Timeline) {
  const b = new Map(before.clips.map((clip) => [clip.id, clip]));
  const a = new Map(after.clips.map((clip) => [clip.id, clip]));
  const c = new Map(current.clips.map((clip) => [clip.id, clip]));
  const boundary = tailShift(before.clips, after.clips);
  if (boundary !== Infinity) {
    for (const clip of current.clips) {
      const previous = a.get(clip.id);
      if (
        (!previous || timingChanged(previous, clip)) &&
        Math.max(clip.start, previous?.start ?? 0) >= boundary
      )
        return true;
    }
    if (after.clips.some((clip) => clip.start >= boundary && !c.has(clip.id)))
      return true;
    const markers = new Map(after.markers.map(({ id, frame }) => [id, frame]));
    if (
      current.markers.some(
        ({ id, frame }) => frame >= boundary && markers.get(id) !== frame,
      )
    )
      return true;
  }
  const laterShift = tailShift(after.clips, current.clips);
  return (
    laterShift !== Infinity &&
    [...b.values()].some((clip) => {
      const edited = a.get(clip.id);
      return (
        clip.start >= laterShift &&
        (!edited || clip.start !== edited.start || clip.track !== edited.track)
      );
    })
  );
}

/** Only violations newly introduced by the inverse are unsafe. */
function timingProblems(timeline: Timeline) {
  const problems = new Set<string>();
  for (const track of groupClips(
    timeline.clips,
    (clip) => clip.track,
  ).values()) {
    const active: Clip[] = [];
    const ordered = track.toSorted((a, b) => a.start - b.start);
    const outgoing = new Set(
      track.filter((clip) => clip.transitionOut).map(clipEnd),
    );
    const incoming = new Set(
      track.filter((clip) => clip.transitionIn).map((clip) => clip.start),
    );
    for (const clip of ordered) {
      for (let i = active.length - 1; i >= 0; i--) {
        const other = active[i]!;
        if (clipEnd(other) <= clip.start) active.splice(i, 1);
        else problems.add(JSON.stringify([clip.id, other.id].sort()));
      }
      active.push(clip);
      if (clip.transitionIn && !outgoing.has(clip.start))
        problems.add(`in:${clip.id}`);
      if (clip.transitionOut && !incoming.has(clipEnd(clip)))
        problems.add(`out:${clip.id}`);
    }
  }
  for (const group of groupClips(
    timeline.clips,
    (clip) => clip.link,
  ).values()) {
    if (!group[0]?.link) continue;
    for (const [index, clip] of group.entries())
      for (const other of group.slice(index + 1))
        if (clip.start !== other.start || clipEnd(clip) !== clipEnd(other))
          problems.add(`link:${JSON.stringify([clip.id, other.id].sort())}`);
  }
  return problems;
}

export function reverseTimeline(
  path: string,
  sources: { before: string; after: string; current: string },
  settings: {
    before: TimelineSettings;
    after: TimelineSettings;
    current: TimelineSettings;
    restored: TimelineSettings;
  },
) {
  const scope = compositionScope(path);
  try {
    const before = parseComposition(sources.before, settings.before, { scope });
    const after = parseComposition(sources.after, settings.after, { scope });
    const current = parseComposition(sources.current, settings.current, {
      scope,
    });
    if (timingConflict(before.timeline, after.timeline, current.timeline))
      return null;
    if (
      sources.after === sources.current &&
      Bun.deepEquals(settings.after, settings.current)
    )
      return sources.before;
    const result =
      sources.after === sources.current
        ? sources.before
        : reverseComposition(before, after, current, settings.restored);
    if (result === null) return null;
    const restored = parseComposition(result, settings.restored, { scope });
    const existing = timingProblems(current.timeline);
    for (const problem of timingProblems(restored.timeline))
      if (!existing.has(problem)) return null;
    // The old source can reference media that someone moved outside Cutroom. The
    // caller checks any references absent from the standing composition.
    return result;
  } catch (error) {
    if (error instanceof TimelineError) return null;
    throw error;
  }
}
