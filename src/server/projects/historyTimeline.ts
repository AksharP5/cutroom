import { clipEnd, TimelineError } from "../../shared/timeline/apply";
import type {
  Clip,
  Timeline,
  TimelineSettings,
} from "../../shared/timeline/schema";
import {
  groupClips,
  tailShift,
  tailShifts,
} from "../../shared/timeline/tailShift";
import {
  compositionMarkup,
  compositionScope,
  historyComposition,
  projectTimeline,
  patchComposition,
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

export function timelineReplayCache() {
  const trees = new Map<string, ReturnType<typeof compositionMarkup>>();
  const markup = (path: string, source: string) => {
    const key = `${path}\0${source}`;
    let tree = trees.get(key);
    if (!tree) {
      tree = compositionMarkup(source, compositionScope(path));
      trees.set(key, tree);
    }
    return tree;
  };
  const structures = new Map<string, ReturnType<typeof historyComposition>>();
  const projections = new Map<string, ReturnType<typeof projectTimeline>>();
  const structure = (path: string, source: string) => {
    const key = `${path}\0${source}`;
    if (!structures.has(key))
      structures.set(key, historyComposition(markup(path, source)));
    return structures.get(key) ?? null;
  };
  const project = (
    path: string,
    source: string,
    settings: TimelineSettings,
  ) => {
    const key = `${path}\0${JSON.stringify(settings)}\0${source}`;
    let projection = projections.get(key);
    if (!projection) {
      projection = projectTimeline(markup(path, source), settings);
      projections.set(key, projection);
    }
    return projection;
  };
  return {
    structure,
    project,
    media: (path: string, source: string) =>
      markup(path, source).sources({ images: true, versions: true }),
  };
}

export function reverseTimeline(
  cache: ReturnType<typeof timelineReplayCache>,
  path: string,
  sources: { before: string; after: string; current: string },
  settings: {
    before: TimelineSettings;
    after: TimelineSettings;
    current: TimelineSettings;
    restored: TimelineSettings;
  },
) {
  try {
    const project = (state: "before" | "after" | "current") =>
      cache.project(path, sources[state], settings[state]);
    let moved: Set<string> | undefined;
    const slid = (id: string) => {
      if (!moved) {
        const after = project("after").timeline.clips;
        const current = project("current").timeline.clips;
        const later = new Map(current.map((clip) => [clip.id, clip]));
        const shifts = tailShifts(after, current);
        moved = new Set(
          after
            .filter((clip) => {
              const shift = shifts.get(clip.track);
              const next = later.get(clip.id);
              return (
                shift &&
                next &&
                clip.start >= shift.from &&
                next.track === clip.track &&
                next.start - clip.start === shift.delta
              );
            })
            .map((clip) => clip.id),
        );
      }
      return moved.has(id);
    };
    if (
      sources.after === sources.current &&
      Bun.deepEquals(settings.after, settings.current)
    )
      return { source: sources.before, structural: true };
    const before = cache.structure(path, sources.before);
    const after = cache.structure(path, sources.after);
    const current = cache.structure(path, sources.current);
    if (!before || !after || !current) return null;
    const merged =
      sources.after === sources.current
        ? { source: sources.before, structural: true }
        : reverseComposition(before, after, current, slid);
    if (!merged || !merged.structural) return merged;
    const standing = project("current").timeline;
    if (
      timingConflict(
        project("before").timeline,
        project("after").timeline,
        standing,
      )
    )
      return null;
    const restored = cache.project(path, merged.source, settings.restored);
    const existing = timingProblems(standing);
    for (const problem of timingProblems(restored.timeline))
      if (!existing.has(problem)) return null;
    return {
      source: patchComposition(restored, restored.timeline, new Map()),
      structural: true,
    };
  } catch (error) {
    if (error instanceof TimelineError) return null;
    throw error;
  }
}
