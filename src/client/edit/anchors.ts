import type { Clip, Command, Timeline } from "../../shared/timeline/schema";

function sameClip(seen: Clip, clip: Clip | undefined) {
  if (!clip) return false;
  return (Object.keys(seen) as (keyof Clip)[]).every((key) => {
    if (key === "mediaStart") {
      // The server stores source offsets to the microsecond.
      return seen.mediaStart === null || clip.mediaStart === null
        ? seen.mediaStart === clip.mediaStart
        : Math.abs(seen.mediaStart - clip.mediaStart) <= 1e-6;
    }
    if (key === "startRef")
      return (
        seen.startRef?.clipId === clip.startRef?.clipId &&
        seen.startRef?.offset === clip.startRef?.offset
      );
    return seen[key] === clip[key];
  });
}

/** Every clip a positional edit changes, including linked partners and ripple followers. */
export function editAnchors(
  before: Timeline,
  after: Timeline,
  commands: readonly Pick<Command, "type">[],
) {
  if (
    !commands.some(
      ({ type }) => type === "trim" || type === "split" || type === "move",
    )
  )
    return [];
  const clips = new Map(after.clips.map((clip) => [clip.id, clip]));
  return before.clips.filter((clip) => !sameClip(clip, clips.get(clip.id)));
}

/** A frozen edit only means what the user saw while its affected clips are unchanged. */
export function anchorsChanged(anchors: readonly Clip[], timeline: Timeline) {
  const clips = new Map(timeline.clips.map((clip) => [clip.id, clip]));
  return anchors.some((seen) => !sameClip(seen, clips.get(seen.id)));
}
