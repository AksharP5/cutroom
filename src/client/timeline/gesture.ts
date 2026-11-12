import { audioGainToDb } from "@hyperframes/core/audio-gain";
import { gainFromDrag } from "./mix";
import type { GainDrag } from "./mix";
import { isAudioKind } from "../../shared/timeline/schema";
import { z } from "zod";
import {
  TimelineError,
  applyAll,
  clipEnd,
  normalizeTimeline,
} from "../../shared/timeline/apply";
import { CommandSchema } from "../../shared/timeline/schema";
import { clipFades } from "../../shared/timeline/mix";
import type { MediaDrag } from "./mediaDrag";
import type {
  Clip,
  CommandInput,
  InsertClip,
  Timeline,
  Track,
} from "../../shared/timeline/schema";

/** Pixels the pointer travels before a press becomes a drag. */
export const DRAG_THRESHOLD = 3;
/** Pixels inside a clip's edge that grab the edge instead of the clip. */
const EDGE_PX = 6;
/** Pixels either side of a cut that grab both of its clips, with the Trim tool. */
const ROLL_PX = 4;
/** Pixels within which a dragged edge jumps to a clip edge, the playhead, a marker, or in/out. */
export const SNAP_PX = 8;

/** The timeline's share of the tool state: Draw and Comment leave it on the pointer. */
export type Tool = "pointer" | "trim" | "blade";

export interface Point {
  x: number;
  y: number;
}

/** What a press on the lanes will do if it becomes a drag, decided at the press. */
export type Intent =
  | { kind: "gain"; clipId: string; alone: boolean }
  | { kind: "fade"; clipId: string; edge: "fadeIn" | "fadeOut" }
  | { kind: "move"; clipId: string; alone: boolean }
  | { kind: "trim"; clipId: string; edge: "start" | "end"; ripple: boolean }
  /** `left` ends where `right` starts; the cut between them moves. */
  | { kind: "roll"; left: string; right: string }
  | { kind: "blade"; clipId: string }
  | { kind: "marquee" };

/** What a press holds until it ends: where and when it began, and the furthest it has been on either axis. */
interface Press {
  intent: Intent;
  origin: Point;
  since: number;
  reach: number;
}

/** One pointer gesture: idle > armed > dragging > commit or cancel. */
export type Gesture =
  | { phase: "idle" }
  | ({ phase: "armed" } & Press)
  | ({
      phase: "dragging";
      point: Point;
      /**
       * A gain line shows its gain from the first vertical pixel, before the threshold settles
       * whether the press is a gain drag, a clip move or a click.
       */
      loose: boolean;
    } & Press);

/** `at` is the event's time in milliseconds. */
export type GestureEvent =
  | { type: "press"; intent: Intent; point: Point; at: number }
  | { type: "move"; point: Point }
  | { type: "release"; at: number }
  | { type: "cancel" };

/** A gain press released this soon, having stayed this close on both axes, is a click. */
const CLICK_MS = 250;
const CLICK_REACH = 1;

/**
 * How a gesture ended: `commit` after a drag, `click` when the press never travelled the
 * threshold or only wobbled on a gain line, `cancel` on Esc or a lost pointer. Null while it
 * goes on.
 */
export type Outcome = "commit" | "click" | "cancel" | null;

export const idle: Gesture = { phase: "idle" };

/** The gesture state machine. A second press while one is under way is ignored. */
export function step(
  gesture: Gesture,
  event: GestureEvent,
): { gesture: Gesture; outcome: Outcome } {
  if (gesture.phase === "idle")
    return event.type === "press"
      ? {
          gesture: {
            phase: "armed",
            intent: event.intent,
            origin: event.point,
            since: event.at,
            reach: 0,
          },
          outcome: null,
        }
      : { gesture, outcome: null };
  switch (event.type) {
    case "press":
      return { gesture, outcome: null };
    case "move": {
      const { point } = event;
      // Once the threshold has been passed, coming back inside it changes nothing.
      if (gesture.phase === "dragging" && !gesture.loose)
        return { gesture: { ...gesture, point }, outcome: null };
      const { intent, origin, since } = gesture;
      const across = Math.abs(point.x - origin.x);
      const down = Math.abs(point.y - origin.y);
      const held = {
        intent,
        origin,
        since,
        reach: Math.max(gesture.reach, across, down),
      };
      // At the threshold a gain press that went sideways becomes a move of its clip.
      if (Math.hypot(across, down) >= DRAG_THRESHOLD)
        return {
          gesture: {
            ...held,
            phase: "dragging",
            intent:
              intent.kind === "gain" && across > down
                ? { kind: "move", clipId: intent.clipId, alone: intent.alone }
                : intent,
            point,
            loose: false,
          },
          outcome: null,
        };
      const loose =
        gesture.phase === "dragging" ||
        (intent.kind === "gain" && down >= 1 && down > across);
      return {
        gesture: loose
          ? { ...held, phase: "dragging", point, loose }
          : { ...held, phase: "armed" },
        outcome: null,
      };
    }
    case "release": {
      if (gesture.phase === "armed") return { gesture: idle, outcome: "click" };
      // A wobble during a click is not a mix change, and neither is a line left where it was.
      const click =
        gesture.loose &&
        ((event.at - gesture.since <= CLICK_MS &&
          gesture.reach <= CLICK_REACH) ||
          gesture.point.y === gesture.origin.y);
      return { gesture: idle, outcome: click ? "click" : "commit" };
    }
    case "cancel":
      return { gesture: idle, outcome: "cancel" };
  }
}

/** A clip under the pointer: `x` pixels from its left edge, in a box `width` pixels wide. */
export interface Hit {
  clip: Clip;
  x: number;
  width: number;
  mix?: "gain" | "fadeIn" | "fadeOut";
}

/**
 * What a press means, as on Resolve's Edit page. The pointer moves a clip by its body and
 * resizes it by an edge. The Trim tool ripples an edge and rolls a cut between two clips; its
 * press on a body only selects. The blade cuts the clip it is on. A press on an empty lane draws
 * a marquee. Null when the press starts nothing, as on a locked track.
 */
export function intentAt(
  tool: Tool,
  timeline: Timeline,
  hit: Hit | null,
  alone = false,
): Intent | null {
  if (!hit) return tool === "blade" ? null : { kind: "marquee" };
  const { clip, x, width } = hit;
  if (timeline.tracks.find((track) => track.index === clip.track)?.locked)
    return null;
  if (tool === "blade") return { kind: "blade", clipId: clip.id };
  const reach = Math.min(EDGE_PX, width / 3);
  const edge = x < reach ? "start" : x >= width - reach ? "end" : null;
  if (tool === "pointer" && edge)
    return { kind: "trim", clipId: clip.id, edge, ripple: false };
  if (tool === "pointer" && hit.mix && clip.hasAudio)
    return hit.mix === "gain"
      ? { kind: "gain", clipId: clip.id, alone }
      : { kind: "fade", clipId: clip.id, edge: hit.mix };
  if (!edge)
    return tool === "pointer" ? { kind: "move", clipId: clip.id, alone } : null;
  const cut = edge === "start" ? clip.start : clipEnd(clip);
  const neighbour = timeline.clips.find(
    (other) =>
      other.track === clip.track &&
      (edge === "start" ? clipEnd(other) : other.start) === cut &&
      other.id !== clip.id,
  );
  if (neighbour && (edge === "start" ? x : width - x) <= ROLL_PX)
    return edge === "start"
      ? { kind: "roll", left: neighbour.id, right: clip.id }
      : { kind: "roll", left: clip.id, right: neighbour.id };
  return { kind: "trim", clipId: clip.id, edge, ripple: true };
}

/**
 * Frames a dragged edge snaps to: the playhead, markers, in and out, and the edges of clips
 * that stay put. `moving` clips are left out, and with `until`, so is every edge after that
 * frame, which a ripple is about to move.
 */
export function snapTargets(
  timeline: Timeline,
  playhead: number,
  moving: ReadonlySet<string> = new Set(),
  until = Infinity,
): number[] {
  const { range } = timeline;
  const frames = new Set([
    playhead,
    ...timeline.markers.map((marker) => marker.frame),
    ...(range.in === null ? [] : [range.in]),
    ...(range.out === null ? [] : [range.out]),
  ]);
  for (const clip of timeline.clips) {
    if (moving.has(clip.id)) continue;
    for (const frame of [clip.start, clipEnd(clip)])
      if (frame <= until) frames.add(frame);
  }
  return [...frames].sort((a, b) => a - b);
}

/**
 * The smallest shift that puts one of `edges` on a target no more than `reach` frames away,
 * and the target it lands on. `targets` are sorted. Null when nothing is in reach.
 */
export function snap(
  edges: readonly number[],
  targets: readonly number[],
  reach: number,
): { by: number; at: number } | null {
  let best: { by: number; at: number } | null = null;
  for (const edge of edges) {
    let low = 0;
    let high = targets.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (targets[middle]! < edge) low = middle + 1;
      else high = middle;
    }
    for (const at of [targets[low - 1], targets[low]]) {
      if (at === undefined) continue;
      const by = at - edge;
      if (Math.abs(by) <= reach && (!best || Math.abs(by) < Math.abs(best.by)))
        best = { by, at };
    }
  }
  return best;
}

/** What a drag would do if it were released now. */
export interface Preview {
  /** The undo step's name. */
  label: string;
  /** The edit, empty when the drag is back where it started. */
  commands: CommandInput[];
  /** The timeline to draw while dragging. For a refused move, the clips where they are held. */
  shown: Timeline;
  /** False when the engine refuses the commands; releasing then changes nothing. */
  valid: boolean;
  /** The frame the drag snapped to, for the snap line. */
  snap: number | null;
  /** Frames the dragged edge or clips travelled, for the readout. */
  delta: number;
  /** The frame a razor cuts at or a dropped clip starts on. */
  at?: number;
  /**
   * Clips in `shown` that the edit cuts off others, as when a ripple passes through a music
   * bed, each by the id of the clip it was cut from.
   */
  pieces?: ReadonlyMap<string, string>;
}

/** The timeline the commands make and the pieces they cut, or null when the engine refuses. */
export function previewCommands(timeline: Timeline, commands: CommandInput[]) {
  const pieces = new Map<string, string>();
  try {
    return {
      timeline: applyAll(timeline, z.array(CommandSchema).parse(commands), {
        onCreate: (id, origin) => {
          if ("copyOf" in origin) pieces.set(id, origin.copyOf);
        },
      }),
      pieces,
    };
  } catch (error) {
    if (error instanceof TimelineError) return null;
    throw error;
  }
}

/**
 * The frame nearest `to` that `allows` the edit, searching back towards `from`, where nothing
 * changes. A trim past its neighbour or its source stops at the last frame the engine takes,
 * so the edge meets a wall instead of the edit being refused.
 */
function furthest(
  from: number,
  to: number,
  allows: (frame: number) => boolean,
) {
  if (to === from || allows(to)) return to;
  let near = from;
  let far = to;
  while (Math.abs(far - near) > 1) {
    const middle = Math.trunc((near + far) / 2);
    if (allows(middle)) near = middle;
    else far = middle;
  }
  return near;
}

const isAudio = (clip: Pick<Clip, "kind">) => isAudioKind(clip.kind);

/** A drag under way: the timeline it started from and what it carries, fixed at the press. */
export interface Drag {
  intent: Exclude<Intent, { kind: "marquee" }>;
  timeline: Timeline;
  /** The frame under the pointer at the press. */
  origin: number;
  /** Clips a move carries: the selection, with linked partners unless Alt was held. */
  carried: readonly Clip[];
  /** The selected clips a move names. */
  named: readonly Clip[];
  targets: readonly number[];
}

/** Starts a drag from a press at frame `origin` with `selection` as it stands after the press. */
export function beginDrag(
  timeline: Timeline,
  intent: Drag["intent"],
  selection: ReadonlySet<string>,
  origin: number,
  playhead: number,
): Drag {
  const named = timeline.clips.filter((clip) => selection.has(clip.id));
  const links = new Set(named.flatMap((clip) => clip.link ?? []));
  const carried =
    intent.kind !== "move"
      ? []
      : intent.alone
        ? named
        : timeline.clips.filter(
            (clip) =>
              selection.has(clip.id) || (clip.link && links.has(clip.link)),
          );
  // A ripple moves everything after its edit point, so nothing there is a place to snap to.
  let until: number | undefined;
  if (intent.kind === "trim" && intent.ripple) {
    const clip = timeline.clips.find((item) => item.id === intent.clipId);
    if (clip) until = intent.edge === "start" ? clip.start : clipEnd(clip);
  }
  return {
    intent,
    timeline,
    origin,
    carried,
    named,
    targets: snapTargets(
      timeline,
      playhead,
      new Set(carried.map((clip) => clip.id)),
      until,
    ),
  };
}

export interface DragInput {
  /** Tracks created with this move, in the same undo step. */
  create?: readonly Track[];
  /** How far the pointer has taken a gain line. */
  gain?: GainDrag;
  /** The frame under the pointer. */
  frame: number;
  /** The track of the row under the pointer, or null between rows. */
  track: number | null;
  /** Frames within which edges snap; 0 with snapping off. */
  reach: number;
}

/** The edit a drag makes with the pointer where `input` says, and the timeline to draw for it. */
export function dragPreview(drag: Drag, input: DragInput): Preview {
  const { intent, timeline, targets } = drag;
  const travel = input.frame - drag.origin;
  const find = (id: string) => {
    const clip = timeline.clips.find((item) => item.id === id);
    if (!clip) throw new Error(`The dragged clip ${id} is gone.`);
    return clip;
  };
  const still = (label: string): Preview => ({
    label,
    commands: [],
    shown: timeline,
    valid: true,
    snap: null,
    delta: 0,
  });
  const edit = (
    label: string,
    commands: CommandInput[],
    delta: number,
    snapped: number | null,
  ): Preview => {
    if (!commands.length) return still(label);
    const result = previewCommands(timeline, commands);
    return {
      label,
      commands,
      shown: result?.timeline ?? timeline,
      valid: result !== null,
      snap: snapped,
      delta,
      pieces: result?.pieces,
    };
  };

  switch (intent.kind) {
    case "gain": {
      const clip = find(intent.clipId);
      const volume = input.gain ? gainFromDrag(input.gain) : (clip.volume ?? 1);
      return edit(
        "Clip gain",
        volume === (clip.volume ?? 1)
          ? []
          : [{ type: "setClip", clipId: clip.id, volume }],
        volume > 0 ? audioGainToDb(volume) : -60,
        null,
      );
    }
    case "fade": {
      const clip = find(intent.clipId);
      const effective = clipFades(clip);
      const other = intent.edge === "fadeIn" ? "fadeOut" : "fadeIn";
      const kept = Math.round(effective[other]);
      const start = Math.round(effective[intent.edge]);
      // The handles meet but never cross, so the runtime never rescales them mid-drag.
      const length = Math.max(
        0,
        Math.min(
          clip.duration - kept,
          start + (intent.edge === "fadeIn" ? travel : -travel),
        ),
      );
      // Fades longer than the clip are scaled by the runtime. Committing the other edge's
      // drawn length keeps that handle in place; an unchanged handle keeps authored lengths.
      const overlong = clip.fadeIn + clip.fadeOut > clip.duration;
      return edit(
        intent.edge === "fadeIn" ? "Fade in" : "Fade out",
        length === start
          ? []
          : [
              {
                type: "setClip",
                clipId: clip.id,
                [intent.edge]: length,
                ...(overlong && { [other]: kept }),
              },
            ],
        length,
        null,
      );
    }
    case "move": {
      const grabbed = find(intent.clipId);
      const { carried, named } = drag;
      // The drag is held at the timeline's start; nothing is pushed off it.
      const floor = -Math.min(...carried.map((clip) => clip.start));
      const hit = snap(
        carried.flatMap((clip) => [
          clip.start + travel,
          clipEnd(clip) + travel,
        ]),
        targets,
        input.reach,
      );
      const by = Math.max(floor, travel + (hit?.by ?? 0));
      const trackBy = input.track === null ? 0 : input.track - grabbed.track;
      // Only clips of the grabbed clip's kind change track: picture never lands on an audio track.
      const lifted = trackBy
        ? named.filter((clip) => isAudio(clip) === isAudio(grabbed))
        : named;
      const liftedIds = new Set(lifted.map((clip) => clip.id));
      if (!by && !trackBy) return still("Move");
      // One command carries the whole selection before clearing any destination frames.
      const commands: CommandInput[] = [
        ...(input.create ?? []).map((track): CommandInput => ({
          type: "setTrack",
          index: track.index,
          kind: track.kind,
        })),
        {
          type: "move",
          clipIds: named.map((clip) => clip.id),
          by,
          trackBy,
          ...(lifted.length !== named.length && {
            trackClipIds: lifted.map((clip) => clip.id),
          }),
          mode: "overwrite",
          ...(intent.alone && { linked: false }),
        },
      ];
      const moving = new Set(carried.map((clip) => clip.id));
      const result = previewCommands(timeline, commands);
      return {
        label: "Move",
        commands,
        // Drawn where the pointer holds the clips, whether or not the engine takes them there.
        shown:
          result?.timeline ??
          normalizeTimeline({
            ...timeline,
            clips: timeline.clips.map((clip) =>
              moving.has(clip.id)
                ? {
                    ...clip,
                    start: clip.start + by,
                    track: clip.track + (liftedIds.has(clip.id) ? trackBy : 0),
                  }
                : clip,
            ),
          }),
        valid: result !== null,
        pieces: result?.pieces,
        snap: hit && by === travel + hit.by ? hit.at : null,
        delta: by,
      };
    }
    case "trim": {
      const clip = find(intent.clipId);
      const from = intent.edge === "start" ? clip.start : clipEnd(clip);
      const hit = snap([from + travel], targets, input.reach);
      const command = (to: number): CommandInput => ({
        type: "trim",
        clipId: clip.id,
        edge: intent.edge,
        to,
        ripple: intent.ripple,
      });
      const to = furthest(
        from,
        Math.max(0, from + travel + (hit?.by ?? 0)),
        (frame) => previewCommands(timeline, [command(frame)]) !== null,
      );
      return edit(
        intent.ripple ? "Ripple trim" : "Resize",
        to === from ? [] : [command(to)],
        to - from,
        hit?.at === to ? to : null,
      );
    }
    case "roll": {
      const left = find(intent.left);
      const from = clipEnd(left);
      const hit = snap([from + travel], targets, input.reach);
      // The clip that gives way is trimmed first, so the cut never overlaps on the way.
      const commands = (to: number): CommandInput[] => {
        const out: CommandInput = {
          type: "trim",
          clipId: intent.left,
          edge: "end",
          to,
        };
        const into: CommandInput = {
          type: "trim",
          clipId: intent.right,
          edge: "start",
          to,
        };
        return to > from ? [into, out] : [out, into];
      };
      const to = furthest(
        from,
        Math.max(0, from + travel + (hit?.by ?? 0)),
        (frame) => previewCommands(timeline, commands(frame)) !== null,
      );
      return edit(
        "Roll",
        to === from ? [] : commands(to),
        to - from,
        hit?.at === to ? to : null,
      );
    }
    case "blade":
      return bladePreview(
        timeline,
        find(intent.clipId),
        input.frame,
        targets,
        input.reach,
      );
  }
}

/** A razor through `clip` at the frame under the pointer, or no edit when that is not inside it. */
export function bladePreview(
  timeline: Timeline,
  clip: Clip,
  frame: number,
  targets: readonly number[],
  reach: number,
): Preview {
  const hit = snap([frame], targets, reach);
  const snapped = hit && hit.at > clip.start && hit.at < clipEnd(clip);
  const at = snapped ? hit.at : frame;
  const inside = at > clip.start && at < clipEnd(clip);
  return {
    label: "Razor",
    commands: inside ? [{ type: "split", at, clipIds: [clip.id] }] : [],
    shown: timeline,
    valid: inside,
    snap: snapped ? at : null,
    delta: 0,
    at,
  };
}

/** Media dragged from the Media panel: a project file and how long it runs on the timeline. */
export interface DraggedMedia {
  kind: InsertClip["kind"];
  /** The project-relative path, which is also its `src` in the root composition. */
  src: string;
  frames: number;
  hasAudio?: boolean;
}

/** A Media row as the timeline places it: its length in whole frames at the timeline's rate. */
export const placedMedia = (
  media: MediaDrag,
  { num, den }: Timeline["fps"],
): DraggedMedia => ({
  kind: media.kind,
  src: media.path,
  frames: Math.max(1, Math.floor((media.seconds * num) / den)),
  hasAudio: media.hasAudio,
});

/**
 * Dropping media overwrites its destination. Explicit insert opens auto-select tracks instead.
 * Audio on a video track or picture on an audio track is refused, as the engine refuses it.
 */
export function dropPreview(
  timeline: Timeline,
  media: DraggedMedia,
  track: Pick<Track, "index" | "kind">,
  frame: number,
  playhead: number,
  reach: number,
  create: readonly Track[] = [],
  mode: "overwrite" | "insert" = "overwrite",
): Preview {
  const hit = snap(
    [frame, frame + media.frames],
    snapTargets(timeline, playhead),
    reach,
  );
  const at = Math.max(0, frame + (hit?.by ?? 0));
  const commands: CommandInput[] = [
    ...create.map((track): CommandInput => ({
      type: "setTrack",
      index: track.index,
      kind: track.kind,
    })),
    ...(!timeline.tracks.some((item) => item.index === track.index) &&
    !create.some((item) => item.index === track.index)
      ? [{ type: "setTrack" as const, index: track.index, kind: track.kind }]
      : []),
    {
      type: "insert",
      mode,
      track: track.index,
      at,
      clip: {
        kind: media.kind,
        src: media.src,
        duration: media.frames,
        muted: media.kind === "video" && !media.hasAudio,
      },
    },
  ];
  const fits = (track.kind === "audio") === isAudioKind(media.kind);
  const result = fits ? previewCommands(timeline, commands) : null;
  return {
    label: "Add media",
    commands,
    shown: result?.timeline ?? timeline,
    valid: result !== null,
    snap: hit && at === frame + hit.by ? hit.at : null,
    delta: 0,
    at,
    pieces: result?.pieces,
  };
}
