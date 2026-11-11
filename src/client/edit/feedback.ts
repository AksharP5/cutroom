import type {
  Clip,
  Command,
  Timeline,
  TimelineView,
} from "../../shared/timeline/schema";
import { formatTimecode } from "../../shared/timeline/timecode";

/** Report actual ripple consequences. Same-track followers alone are an obvious, silent edit. */
export function rippleFeedback(
  before: Timeline,
  after: Timeline,
  commands: readonly Command[],
  clipboards: ReadonlyMap<string, readonly Clip[]>,
) {
  const targetTracks = new Set<number>();
  let frames = 0;
  let ripple = false;
  for (const command of commands) {
    if (command.type === "trim" && command.ripple) {
      ripple = true;
      const clip = before.clips.find((clip) => clip.id === command.clipId)!;
      targetTracks.add(clip.track);
      frames +=
        command.edge === "start"
          ? clip.start - command.to
          : command.to - clip.start - clip.duration;
    }
    if (command.type === "remove" && command.ripple) {
      ripple = true;
      const targets = before.clips.filter((clip) =>
        command.clipIds.includes(clip.id),
      );
      const links = new Set(
        targets.flatMap((clip) => (clip.link ? [clip.link] : [])),
      );
      const clips = before.clips.filter(
        (clip) => targets.includes(clip) || (clip.link && links.has(clip.link)),
      );
      for (const clip of before.clips)
        if (command.clipIds.includes(clip.id)) targetTracks.add(clip.track);
      let end = 0;
      for (const clip of clips.toSorted((a, b) => a.start - b.start)) {
        frames -= Math.max(
          0,
          clip.start + clip.duration - Math.max(end, clip.start),
        );
        end = Math.max(end, clip.start + clip.duration);
      }
    }
    if (command.type === "insert" && command.mode === "insert") {
      ripple = true;
      targetTracks.add(command.track);
      frames += command.clip.duration;
    }
    if (command.type === "paste" && command.mode === "insert") {
      ripple = true;
      const clips = clipboards.get(command.clipboardId) ?? [];
      for (const clip of clips) targetTracks.add(clip.track);
      if (clips.length)
        frames +=
          Math.max(...clips.map((clip) => clip.start + clip.duration)) -
          Math.min(...clips.map((clip) => clip.start));
    }
  }
  if (!ripple) return "";
  const next = new Map(after.clips.map((clip) => [clip.id, clip]));
  const tracks = new Set<number>();
  let deleted = 0;
  for (const clip of before.clips) {
    const to = next.get(clip.id);
    if (!to) deleted++;
    if (
      !to ||
      to.start !== clip.start ||
      to.duration !== clip.duration ||
      to.track !== clip.track
    ) {
      tracks.add(clip.track);
      if (to) tracks.add(to.track);
    }
  }
  if (!deleted && ![...tracks].some((track) => !targetTracks.has(track)))
    return "";
  // An insert can open time on followers while adding its target on a previously empty track.
  const previousIds = new Set(before.clips.map((clip) => clip.id));
  for (const clip of after.clips)
    if (!previousIds.has(clip.id)) tracks.add(clip.track);
  const time = formatTimecode(Math.abs(frames), before.fps).replace(
    /^00:(?:00:)?/,
    "",
  );
  const detail = deleted
    ? `${deleted} clip${deleted === 1 ? "" : "s"} deleted.`
    : "";
  return [
    frames
      ? `${frames < 0 ? "Removed" : "Inserted"} ${time} ${frames < 0 ? "from" : "on"} ${tracks.size} track${tracks.size === 1 ? "" : "s"}.`
      : "Ripple edited timeline.",
    detail,
  ]
    .filter(Boolean)
    .join(" ");
}

function clipContent({ sourceRestrictions, ...clip }: Clip) {
  return JSON.stringify(clip);
}

/** Compare confirmed projections, never the optimistic preview or the playback clock. */
export function outsideChanges(before: TimelineView, after: TimelineView) {
  const previous = new Map(
    before.timeline.clips.map((clip) => [clip.id, clip]),
  );
  const next = new Map(after.timeline.clips.map((clip) => [clip.id, clip]));
  const changes = new Map<string, "moved" | "added" | "deleted" | "updated">();
  for (const [id, clip] of previous) {
    const to = next.get(id);
    if (!to) changes.set(id, "deleted");
    else if (clipContent(clip) !== clipContent(to))
      changes.set(
        id,
        to.start !== clip.start || to.track !== clip.track
          ? "moved"
          : "updated",
      );
  }
  for (const id of next.keys()) if (!previous.has(id)) changes.set(id, "added");
  const timelineChanged =
    changes.size > 0 ||
    JSON.stringify({ ...before.timeline, clips: [] }) !==
      JSON.stringify({ ...after.timeline, clips: [] });
  const known = new Set(before.clipEdits?.map((edit) => edit.id));
  const edits = after.clipEdits?.filter((edit) => !known.has(edit.id)) ?? [];
  const actor =
    edits.length && edits.every((edit) => edit.by === "agent")
      ? "Agent"
      : "Outside edit";
  return { changes, timelineChanged, actor };
}

export function outsideMessage(
  changes: ReadonlyMap<string, string>,
  actors: ReadonlySet<string>,
) {
  const actor = actors.size === 1 ? [...actors][0] : "Outside edit";
  const kinds = new Set(changes.values());
  const verb = kinds.size === 1 ? [...kinds][0] : "updated";
  return changes.size
    ? `${actor} ${verb} ${changes.size} clip${changes.size === 1 ? "" : "s"}.`
    : `${actor} updated timeline.`;
}
