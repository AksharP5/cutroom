import {
  VOLUME_TARGET,
  parseAutomation,
} from "@hyperframes/core/audio-automation";
import { z } from "zod";
import { volumePoints } from "../../shared/timeline/mix";
import { compactFxNode } from "../../shared/timeline/fx";
import { syncOffsets } from "../../shared/timeline/sync";
import type { Timeline, TimelineView } from "../../shared/timeline/schema";

export const TimelineReplyFormatSchema = z.enum(["auto", "compact", "legacy"]);
type ReplyFormat = z.infer<typeof TimelineReplyFormatSchema>;
type TimelineFilters = { from?: number; to?: number; tracks?: number[] };

// MCP sends both text and structured content, roughly doubling the clip JSON.
const CLIP_DETAIL_BUDGET = 16 * 1024;
const fitsClipBudget = (detail: unknown) =>
  Buffer.byteLength(JSON.stringify(detail)) <= CLIP_DETAIL_BUDGET;

/**
 * The timeline as agents read it: a clip's native automation becomes its volume points in
 * frames, as `setClip.automation` writes them, and the names of any other lanes, which can hold
 * hundreds of points. Effects leave out parameters at their defaults. Linked picture and sound
 * that have drifted apart carry their offset, as the timeline's out-of-sync badge shows it.
 */
export function agentTimeline(timeline: Timeline, whole = timeline) {
  const offsets = syncOffsets(whole);
  const members = new Map<string, number>();
  for (const { authoredAudioGroupId: group } of whole.clips)
    if (group) members.set(group, (members.get(group) ?? 0) + 1);
  return {
    ...timeline,
    authoredAudioGroups: timeline.authoredAudioGroups?.map((group) => ({
      ...group,
      members: members.get(group.id) ?? 0,
      fx: group.fx.map(compactFxNode),
    })),
    ...(timeline.main && {
      main: { ...timeline.main, fx: timeline.main.fx.map(compactFxNode) },
    }),
    tracks: timeline.tracks.map((track) => ({
      ...track,
      fx: track.fx.map(compactFxNode),
    })),
    clips: timeline.clips.map(({ automation, ...rest }) => {
      const offset = offsets.get(rest.id);
      const clip = {
        ...rest,
        fx: rest.fx.map(compactFxNode),
        ...(offset && { syncOffset: offset }),
      };
      if (!automation) return { ...clip, automation: null };
      const volume = volumePoints(automation, timeline.fps);
      const lanes = parseAutomation(automation)
        .lanes.map((lane) => lane.target)
        .filter((target) => target !== VOLUME_TARGET);
      return {
        ...clip,
        automation: {
          ...(volume && { volume }),
          ...(lanes.length && { lanes }),
        },
      };
    }),
  };
}

type AgentClip = ReturnType<typeof agentTimeline>["clips"][number];

/** A complete clip in the compact format. Omit its defaults only in snapshots. */
function compactClip(clip: AgentClip) {
  const {
    playbackRate,
    hasAudio,
    enabled,
    adjustment,
    fadeIn,
    fadeOut,
    style,
    fx,
    ...fields
  } = clip;
  return {
    ...Object.fromEntries(
      Object.entries<unknown>(fields).filter(([, value]) => value != null),
    ),
    ...(playbackRate !== 1 && { playbackRate }),
    ...(hasAudio && { hasAudio }),
    ...(!enabled && { enabled }),
    ...(adjustment && { adjustment }),
    ...(fadeIn !== 0 && { fadeIn }),
    ...(fadeOut !== 0 && { fadeOut }),
    ...(Object.keys(style).length > 0 && { style }),
    ...(fx.length > 0 && { fx }),
  };
}

export function readTimelineReply(
  whole: Timeline,
  filters: TimelineFilters,
  format: ReplyFormat,
) {
  const timeline = agentTimeline(filterTimeline(whole, filters), whole);
  if (
    format === "legacy" ||
    (format === "auto" && fitsClipBudget(timeline.clips))
  )
    return timeline;

  const { clips, ...details } = timeline;
  const compact = clips.map(compactClip);
  const { from, to, tracks } = filters;
  if (
    from !== undefined ||
    to !== undefined ||
    tracks !== undefined ||
    fitsClipBudget(compact)
  )
    return { ...details, clips: compact };

  const counts = new Map<
    number,
    { clipCount: number; from: number; to: number }
  >();
  for (const { track, start, duration } of clips) {
    const range = counts.get(track);
    if (range) {
      range.clipCount++;
      range.from = Math.min(range.from, start);
      range.to = Math.max(range.to, start + duration);
    } else {
      counts.set(track, { clipCount: 1, from: start, to: start + duration });
    }
  }
  return {
    ...details,
    clipSummary: {
      clipCount: clips.length,
      tracks: timeline.tracks.map(({ index }) => ({
        index,
        ...(counts.get(index) ?? { clipCount: 0, from: null, to: null }),
      })),
      guidance:
        'Clip details are omitted. Call timeline_read with a smaller frame window (from, to) or selected track indexes (tracks), or both. Use replyFormat: "compact" for exact IDs and details with clip defaults omitted.',
    },
  };
}

function diff<T extends object, K extends keyof T>(
  before: readonly T[],
  after: readonly T[],
  key: K,
) {
  const previous = new Map(before.map((item) => [item[key], item]));
  const next = new Set(after.map((item) => item[key]));
  const added: T[] = [];
  /** Only the fields that changed, with their new values; a field that went away is null. */
  const changed: Record<string, unknown>[] = [];
  for (const item of after) {
    const old = previous.get(item[key]);
    if (!old) {
      added.push(item);
      continue;
    }
    const was = new Map<string, unknown>(Object.entries(old));
    const now = new Map<string, unknown>(Object.entries(item));
    const fields = Object.fromEntries(
      [...new Set([...was.keys(), ...now.keys()])].flatMap((field) =>
        JSON.stringify(was.get(field)) === JSON.stringify(now.get(field))
          ? []
          : [[field, now.get(field) ?? null]],
      ),
    );
    if (Object.keys(fields).length)
      changed.push({ [key]: item[key], ...fields });
  }
  const removed = before.flatMap((item) =>
    next.has(item[key]) ? [] : [item[key]],
  );
  if (!added.length && !changed.length && !removed.length) return undefined;
  return {
    ...(added.length && { added }),
    ...(changed.length && { changed }),
    ...(removed.length && { removed }),
  };
}

function compactClipChanges(
  changes: NonNullable<ReturnType<typeof diff<AgentClip, "id">>>,
  before: AgentClip[],
) {
  const starts = new Map(before.map(({ id, start }) => [id, start]));
  const shifts = new Map<number, string[]>();
  for (const change of changes.changed ?? []) {
    const { id, start, ...other } = change;
    if (
      typeof id !== "string" ||
      typeof start !== "number" ||
      Object.keys(other).length
    )
      continue;
    const previous = starts.get(id);
    if (previous === undefined) continue;
    const by = start - previous;
    const ids = shifts.get(by);
    if (ids) ids.push(id);
    else shifts.set(by, [id]);
  }
  // A handful of moves is easier to consume as absolute starts.
  const shifted = [...shifts].flatMap(([by, ids]) =>
    ids.length >= 16 ? [{ by, ids }] : [],
  );
  const grouped = new Set(shifted.flatMap(({ ids }) => ids));
  const changed = changes.changed?.filter(
    ({ id }) => typeof id !== "string" || !grouped.has(id),
  );
  return {
    ...(changes.added && { added: changes.added.map(compactClip) }),
    ...(changes.removed && { removed: changes.removed }),
    ...(changed?.length && { changed }),
    ...(shifted.length && { shifted }),
  };
}

/**
 * What a timeline edit changed, so an agent can keep editing without reading the whole
 * timeline again. Added clips are complete, so new razor and insert ids are here.
 */
export function editReply(
  before: TimelineView,
  after: TimelineView,
  fullTimeline: boolean,
  format: ReplyFormat = "legacy",
) {
  const timeline = agentTimeline(after.timeline);
  const old = agentTimeline(before.timeline);
  const tracks = diff(old.tracks, timeline.tracks, "index");
  const changedTracks = new Set([
    ...(tracks?.added ?? []).map((track) => track.index),
    ...(tracks?.changed ?? []).map((track) => track.index),
  ]);
  // Track gain skips these clips; their fields do not change when the track's gain does.
  const warnings = timeline.clips.flatMap(({ id, track, trackGainWarning }) =>
    trackGainWarning && changedTracks.has(track)
      ? [{ clipId: id, warning: trackGainWarning }]
      : [],
  );
  const clips = diff(old.clips, timeline.clips, "id");
  const changes = {
    clips:
      clips &&
      (format === "compact" ||
      (format === "auto" && !fullTimeline && !fitsClipBudget(clips))
        ? compactClipChanges(clips, old.clips)
        : clips),
    tracks,
    markers: diff(old.markers, timeline.markers, "id"),
    authoredAudioGroups: diff(
      old.authoredAudioGroups ?? [],
      timeline.authoredAudioGroups ?? [],
      "id",
    ),
    ...(JSON.stringify(old.range) !== JSON.stringify(timeline.range) && {
      range: timeline.range,
    }),
    ...(JSON.stringify(old.main) !== JSON.stringify(timeline.main) && {
      main: timeline.main ?? null,
    }),
    ...(old.duration !== timeline.duration && { duration: timeline.duration }),
  };
  return {
    revision: after.revision,
    composition: after.composition,
    changes,
    ...(after.skippedClips?.length && { skippedClips: after.skippedClips }),
    ...(warnings.length && { warnings }),
    ...(fullTimeline && {
      timeline:
        format === "compact"
          ? { ...timeline, clips: timeline.clips.map(compactClip) }
          : timeline,
      agentChanges: after.agentChanges,
    }),
  };
}

/** Clips and markers overlapping the half-open frame range `[from, to)`, on the given tracks. */
function filterTimeline(
  timeline: Timeline,
  { from = 0, to = Infinity, tracks }: TimelineFilters,
): Timeline {
  const overlaps = (start: number, length: number) =>
    start < to && (start + length > from || (length === 0 && start >= from));
  return {
    ...timeline,
    clips: timeline.clips.filter(
      (clip) =>
        (!tracks || tracks.includes(clip.track)) &&
        overlaps(clip.start, clip.duration),
    ),
    markers: timeline.markers.filter((marker) =>
      overlaps(marker.frame, marker.duration),
    ),
  };
}
