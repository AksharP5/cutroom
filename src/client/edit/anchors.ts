import { clipEnd } from "../../shared/timeline/apply";
import type {
  Clip,
  CommandInput,
  Timeline,
} from "../../shared/timeline/schema";

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  return (
    Object.keys(a).every((key) =>
      sameValue(Reflect.get(a, key), Reflect.get(b, key)),
    ) &&
    Object.keys(b).every(
      (key) => Object.hasOwn(a, key) || Reflect.get(b, key) === undefined,
    )
  );
}

function sameClip(seen: Clip, clip: Clip | undefined) {
  if (seen === clip) return true;
  if (!clip) return false;
  // The server stores source offsets to the microsecond.
  const from = seen.mediaStart;
  const to = clip.mediaStart;
  if (
    from !== to &&
    (from === null || to === null || Math.abs(from - to) > 1e-6)
  )
    return false;
  return (
    Object.keys(seen).every(
      (key) =>
        key === "mediaStart" ||
        sameValue(Reflect.get(seen, key), Reflect.get(clip, key)),
    ) &&
    Object.keys(clip).every(
      (key) => Object.hasOwn(seen, key) || Reflect.get(clip, key) === undefined,
    )
  );
}

function occupants(timeline: Timeline, range: Clip) {
  return timeline.clips.filter(
    (clip) =>
      clip.track === range.track &&
      clip.start < clipEnd(range) &&
      clipEnd(clip) > range.start,
  );
}

/** Changed clips and the occupancy of overwrite destinations, including empty ranges. */
export function editAnchors(
  before: Timeline,
  after: Timeline,
  commands: readonly CommandInput[],
) {
  const destinations: { range: Clip; clips: Clip[] }[] = [];
  if (
    !commands.some(
      ({ type }) =>
        type === "setTransitions" ||
        type === "paste" ||
        type === "remove" ||
        type === "trim" ||
        type === "trimPlayhead" ||
        type === "roll" ||
        type === "slide" ||
        type === "slip" ||
        type === "swap" ||
        type === "setTiming" ||
        type === "insert" ||
        type === "split" ||
        type === "freeze" ||
        type === "move" ||
        type === "setClip",
    )
  )
    return { clips: [], destinations };
  const clips = new Map(after.clips.map((clip) => [clip.id, clip]));
  if (
    commands.some(
      (command) =>
        command.type === "paste" ||
        (command.type === "insert" && command.mode === "overwrite"),
    )
  ) {
    const previous = new Set(before.clips.map((clip) => clip.id));
    for (const clip of after.clips)
      if (!previous.has(clip.id))
        destinations.push({ range: clip, clips: occupants(before, clip) });
  }
  for (const command of commands) {
    if (command.type !== "move" || command.mode === "place") continue;
    const named = new Set(command.clipIds);
    const links = new Set(
      command.linked === false
        ? []
        : before.clips
            .filter((clip) => named.has(clip.id))
            .flatMap((clip) => clip.link ?? []),
    );
    for (const old of before.clips) {
      if (!named.has(old.id) && !(old.link && links.has(old.link))) continue;
      const moved = clips.get(old.id);
      if (!moved || (moved.start === old.start && moved.track === old.track))
        continue;
      destinations.push({ range: moved, clips: occupants(before, moved) });
    }
  }
  const targets = new Set(
    commands.flatMap((command) => {
      if (command.type === "split" || command.type === "trimPlayhead")
        return command.clipIds ?? [];
      if (command.type === "roll" || command.type === "swap")
        return [command.from, command.to];
      // A grade write can replace an existing wheel even if it looked unchanged
      // when the command was built. A retry must still check the intended clip.
      if (command.type === "setClip" && command.grade !== undefined)
        return [command.clipId];
      if (command.type === "setTransitions")
        return command.cuts.flatMap(({ from, to }) => [from, to]);
      return [];
    }),
  );
  return {
    clips: before.clips.filter(
      (clip) => targets.has(clip.id) || !sameClip(clip, clips.get(clip.id)),
    ),
    destinations,
  };
}

/** Refuse changed clips or destination occupancy before replaying a frozen edit. */
export function anchorsChanged(
  anchors: ReturnType<typeof editAnchors>,
  timeline: Timeline,
) {
  const clips = new Map(timeline.clips.map((clip) => [clip.id, clip]));
  if (anchors.clips.some((seen) => !sameClip(seen, clips.get(seen.id))))
    return true;
  return anchors.destinations.some(
    ({ range, clips: seen }) =>
      occupants(timeline, range).length !== seen.length ||
      seen.some((clip) => !sameClip(clip, clips.get(clip.id))),
  );
}

/**
 * What an Undo of the edit from `restored` to `edited` should show when other editors changed
 * the timeline to `current` since, or null when their changes meet the edit: the same clips,
 * markers or settings, or anything from where the edit moved clips onward, which covers a
 * restored clip's place. The engine decides; this paints its likely answer before it arrives.
 */
export function undoOver(
  edited: Timeline,
  restored: Timeline,
  current: Timeline,
): Timeline | null {
  const settings = ({ clips: _clips, markers: _markers, ...rest }: Timeline) =>
    rest;
  const [from, to, now] = [edited, restored, current].map(settings);
  const rest = sameValue(from, to) ? now : sameValue(from, now) ? to : null;
  if (!rest) return null;
  /** Every version of each item that differs between `a` and `b`, keyed by id. */
  const changes = <T extends { id: string }>(
    a: readonly T[],
    b: readonly T[],
    same: (x: T, y: T | undefined) => boolean,
  ) => {
    const earlier = new Map(a.map((item) => [item.id, item]));
    const later = new Map(b.map((item) => [item.id, item]));
    const changed = new Map<string, T[]>();
    for (const [id, item] of earlier)
      if (!same(item, later.get(id))) changed.set(id, [item]);
    for (const [id, item] of later) {
      const before = earlier.get(id);
      if (!before || !same(before, item))
        changed.set(id, [...(changed.get(id) ?? []), item]);
    }
    return changed;
  };
  const undoneClips = changes(edited.clips, restored.clips, sameClip);
  const otherClips = changes(edited.clips, current.clips, sameClip);
  const undoneMarkers = changes(edited.markers, restored.markers, sameValue);
  const otherMarkers = changes(edited.markers, current.markers, sameValue);
  if (
    [...undoneClips.keys()].some((id) => otherClips.has(id)) ||
    [...undoneMarkers.keys()].some((id) => otherMarkers.has(id))
  )
    return null;
  // A ripple shifts what follows it, so a later change there depends on the edit.
  const moved = [...undoneClips.values()].filter(
    (versions) =>
      versions.length < 2 ||
      versions[0]!.start !== versions[1]!.start ||
      versions[0]!.duration !== versions[1]!.duration ||
      versions[0]!.track !== versions[1]!.track,
  );
  const boundary = Math.min(...moved.flat().map((clip) => clip.start));
  const others = [...otherClips.values()].flat();
  if (
    others.some((clip) => clipEnd(clip) > boundary) ||
    [...otherMarkers.values()].flat().some(({ frame }) => frame >= boundary)
  )
    return null;
  return {
    ...rest,
    clips: [
      ...current.clips.filter(({ id }) => !undoneClips.has(id)),
      ...restored.clips.filter(({ id }) => undoneClips.has(id)),
    ],
    markers: [
      ...current.markers.filter(({ id }) => !undoneMarkers.has(id)),
      ...restored.markers.filter(({ id }) => undoneMarkers.has(id)),
    ],
  };
}
