import {
  VOLUME_TARGET,
  parseAutomation,
} from "@hyperframes/core/audio-automation";
import { volumePoints } from "../../shared/timeline/mix";
import { compactFxNode } from "../../shared/timeline/fx";
import type { Timeline, TimelineView } from "../../shared/timeline/schema";

/**
 * The timeline as agents read it: a clip's native automation becomes its volume points in
 * frames, as `setClip.automation` writes them, and the names of any other lanes, which can hold
 * hundreds of points. Effects leave out parameters at their defaults.
 */
export function agentTimeline(timeline: Timeline) {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => ({
      ...track,
      fx: track.fx.map(compactFxNode),
    })),
    clips: timeline.clips.map(({ automation, ...rest }) => {
      const clip = { ...rest, fx: rest.fx.map(compactFxNode) };
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

/**
 * What a timeline edit changed, so an agent can keep editing without reading the whole
 * timeline again. Added clips are complete, so new razor and insert ids are here.
 */
export function editReply(
  before: TimelineView,
  after: TimelineView,
  fullTimeline: boolean,
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
  const changes = {
    clips: diff(old.clips, timeline.clips, "id"),
    tracks,
    markers: diff(old.markers, timeline.markers, "id"),
    ...(JSON.stringify(old.range) !== JSON.stringify(timeline.range) && {
      range: timeline.range,
    }),
    ...(old.duration !== timeline.duration && { duration: timeline.duration }),
  };
  return {
    revision: after.revision,
    composition: after.composition,
    changes,
    ...(after.skippedClips?.length && { skippedClips: after.skippedClips }),
    ...(warnings.length && { warnings }),
    // With the timeline, the reply holds everything a read returns.
    ...(fullTimeline && { timeline, agentChanges: after.agentChanges }),
  };
}

/** Clips and markers overlapping the half-open frame range `[from, to)`, on the given tracks. */
export function filterTimeline(
  timeline: Timeline,
  {
    from = 0,
    to = Infinity,
    tracks,
  }: { from?: number; to?: number; tracks?: number[] },
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
