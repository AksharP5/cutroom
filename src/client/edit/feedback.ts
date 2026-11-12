import type {
  Clip,
  Command,
  Timeline,
  TimelineView,
} from "../../shared/timeline/schema";
import type { TweenWindows } from "../../shared/preview";
import type { EditorReviewDraft } from "../../shared/editor";
import { toFrames, toSeconds } from "../../shared/timeline/apply";
import { formatTimecode } from "../../shared/timeline/timecode";
import { clipName } from "../../shared/timeline/labels";

/** Partial overwrites retain the original id; only completely replaced clips need a warning. */
export function overwriteFeedback(
  before: Timeline,
  after: Timeline,
  commands: readonly Command[],
) {
  if (
    !commands.some(
      (command) =>
        (command.type === "insert" ||
          command.type === "paste" ||
          command.type === "move") &&
        command.mode === "overwrite",
    )
  )
    return "";
  const retained = new Set(after.clips.map((clip) => clip.id));
  const removed = before.clips.filter((clip) => !retained.has(clip.id));
  if (!removed.length) return "";
  const names = [...new Set(removed.map(clipName))];
  const detail =
    names.length < 3
      ? names.join(" and ")
      : `${names[0]} and ${names.length - 1} others`;
  return `Replaced ${detail}.`;
}

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
  const known = new Set(before.clipEdits?.map((edit) => edit.id));
  const edits = after.clipEdits?.filter((edit) => !known.has(edit.id)) ?? [];
  const authors = new Map(
    edits
      .filter((edit) => edit.composition === after.composition)
      .map((edit) => [edit.clipId, edit.by]),
  );
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
  // Watcher reads can observe an owner source save or import before its UI receipt arrives.
  // Keep those attributed edits silent without dropping unrelated agent or disk changes.
  for (const id of changes.keys())
    if (authors.get(id) === "human") changes.delete(id);
  const settingsChanged =
    authors.get(null) !== "human" &&
    JSON.stringify({ ...before.timeline, clips: [] }) !==
      JSON.stringify({ ...after.timeline, clips: [] });
  const timelineChanged = changes.size > 0 || settingsChanged;
  const changedAuthors = [
    ...[...changes.keys()].map((id) => authors.get(id)),
    ...(settingsChanged ? [authors.get(null)] : []),
  ];
  const actor =
    changedAuthors.length && changedAuthors.every((by) => by === "agent")
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

export function animationFeedback(
  before: Timeline,
  after: Timeline,
  previous: TweenWindows,
  next: TweenWindows,
) {
  const old = new Map(before.clips.map((clip) => [clip.id, clip]));
  if (
    !after.clips.some((clip) => {
      const from = old.get(clip.id);
      return (
        from && from.duration === clip.duration && from.start !== clip.start
      );
    })
  )
    return [];
  return after.clips.flatMap((clip) => {
    const from = old.get(clip.id);
    if (!from || from.duration !== clip.duration) return [];
    const a = previous[clip.id] ?? [];
    const b = next[clip.id] ?? [];
    if (!a.length && !b.length) return [];
    const delta = toSeconds(clip.start - from.start, after.fps);
    const follows =
      a.length === b.length &&
      a.every(
        (window, index) =>
          Math.abs(b[index]!.start - window.start - delta) <= 0.002 &&
          Math.abs(b[index]!.end - window.end - delta) <= 0.002,
      );
    return follows ? [] : [{ clip, time: b[0]?.start ?? a[0]!.start }];
  });
}

export function animationMessage(
  clips: ReturnType<typeof animationFeedback>,
  fps: Timeline["fps"],
) {
  const first = clips[0]!;
  return clips.length === 1
    ? `${clipName(first.clip)}'s animation stayed at ${formatTimecode(toFrames(first.time, fps), fps)}.`
    : `${clips.length} clips left their animation behind.`;
}

export function animationReview(
  clip: Clip,
  time: number,
  fps: Timeline["fps"],
) {
  const draft: EditorReviewDraft = {
    time: toSeconds(clip.start, fps),
    compositionPath: "index.html",
    strokes: [],
    elementIds: [clip.id],
  };
  const body = `Make this clip's animation follow the clip. Its tweens are at absolute timeline seconds (${time.toFixed(2)} s) and the clip now starts at ${draft.time.toFixed(2)} s. Move the title into its own sub-composition file with a timeline in clip-local seconds. Keep the look and the timing relative to the clip's start. Check the first second of the clip with timeline_view.`;
  return { draft, body };
}
