import type { Clip } from "./schema";

export function groupClips<Key>(
  clips: readonly Clip[],
  keyOf: (clip: Clip) => Key,
) {
  const groups = new Map<Key, Clip[]>();
  for (const clip of clips) {
    const key = keyOf(clip);
    const group = groups.get(key);
    if (group) group.push(clip);
    else groups.set(key, [clip]);
  }
  return groups;
}

/** The first position affected by a uniform shift of the surviving tail of a track. */
export function tailShift(before: readonly Clip[], after: readonly Clip[]) {
  const byId = new Map(after.map((clip) => [clip.id, clip]));
  const tracks = groupClips(before, (clip) => clip.track);
  const known = new Set(before.map(({ id }) => id));
  const additions = groupClips(
    after.filter(({ id }) => !known.has(id)),
    (clip) => clip.track,
  );
  let boundary = Infinity;
  for (const [track, clips] of tracks) {
    const ordered = clips.toSorted((a, b) => a.start - b.start);
    let delta: number | undefined;
    let first: Clip | undefined;
    let count = 0;
    for (const clip of ordered.toReversed()) {
      const next = byId.get(clip.id);
      if (!next) continue;
      const shift = next.start - clip.start;
      if (
        !shift ||
        next.track !== track ||
        (delta !== undefined && shift !== delta)
      )
        break;
      delta = shift;
      first = clip;
      count++;
    }
    if (!first) continue;
    const start = first.start;
    const removed = ordered.filter(
      (clip) => clip.start <= start && !byId.has(clip.id),
    );
    const added = (additions.get(track) ?? []).filter(
      (clip) => clip.start <= start,
    );
    const trimmed = ordered.findLast((clip) => {
      if (clip.start >= start) return false;
      const next = byId.get(clip.id);
      return (
        next &&
        next.track === track &&
        next.start === clip.start &&
        next.duration - clip.duration === delta
      );
    });
    if (count < 2 && !removed.length && !added.length && !trimmed) continue;
    boundary = Math.min(
      boundary,
      first.start,
      ...removed.map(({ start }) => start),
      ...added.map(({ start }) => start),
      trimmed
        ? trimmed.start +
            Math.min(trimmed.duration, byId.get(trimmed.id)!.duration)
        : Infinity,
    );
  }
  return boundary;
}
