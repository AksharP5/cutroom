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
