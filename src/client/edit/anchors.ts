import { clipEnd } from "../../shared/timeline/apply";
import { sameTitle } from "../../shared/timeline/title";
import type {
  Clip,
  CommandInput,
  Timeline,
} from "../../shared/timeline/schema";

function sameClip(seen: Clip, clip: Clip | undefined) {
  if (!clip) return false;
  return (Object.keys(seen) as (keyof Clip)[]).every((key) => {
    if (key === "mediaStart") {
      // The server stores source offsets to the microsecond.
      return seen.mediaStart === null || clip.mediaStart === null
        ? seen.mediaStart === clip.mediaStart
        : Math.abs(seen.mediaStart - clip.mediaStart) <= 1e-6;
    }
    if (key === "sourceRestrictions")
      return (
        seen.sourceRestrictions?.copy === clip.sourceRestrictions?.copy &&
        seen.sourceRestrictions?.remove === clip.sourceRestrictions?.remove
      );
    if (key === "startRef")
      return (
        seen.startRef?.clipId === clip.startRef?.clipId &&
        seen.startRef?.offset === clip.startRef?.offset
      );
    // Every server answer parses a new title object, so a title is the same by its values.
    if (key === "title") return sameTitle(seen.title, clip.title);
    return seen[key] === clip[key];
  });
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
        type === "paste" ||
        type === "remove" ||
        type === "trim" ||
        type === "split" ||
        type === "move" ||
        type === "setClip",
    )
  )
    return { clips: [], destinations };
  const clips = new Map(after.clips.map((clip) => [clip.id, clip]));
  if (commands.some((command) => command.type === "paste")) {
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
    commands.flatMap((command) =>
      command.type === "split" ? (command.clipIds ?? []) : [],
    ),
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
