import { audioGainToDb } from "@hyperframes/core/audio-gain";
import { gainFromDrag, laneFromLevel } from "./mix";
import type { GainDrag } from "./mix";
import { isAudioKind } from "../../shared/timeline/schema";
import { z } from "zod";
import {
  TimelineError,
  applyAll,
  clipEnd,
  normalizeTimeline,
  slideRange,
  slipRange,
} from "../../shared/timeline/apply";
import { CommandSchema } from "../../shared/timeline/schema";
import { clipFades, volumePoints } from "../../shared/timeline/mix";
import {
  limitSpeedPoint,
  speedLevel,
  speedPoints,
  speedProjection,
} from "../../shared/timeline/speed";
import { formatTimecode } from "../../shared/timeline/timecode";
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import type { MediaDrag } from "./mediaDrag";
import { sourceUrl } from "../../shared/media";
import type {
  Clip,
  CommandInput,
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
/** Speeds a held speed point jumps to within `SPEED_SNAP_PX` pixels, as a gain line finds 0 dB. */
const SNAP_SPEEDS = [0.25, 0.5, 1, 2, 4];
const SPEED_SNAP_PX = 3;

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
  /** A volume point, by its index on the clip's volume lane. */
  | { kind: "point"; clipId: string; index: number }
  /** A speed point, by its index on the clip's ramp. */
  | { kind: "speed"; clipId: string; index: number }
  /** A clip's speed line: its constant speed, or the points either side of the press. */
  | { kind: "speedLine"; clipId: string }
  | { kind: "move"; clipId: string; alone: boolean }
  | { kind: "trim"; clipId: string; edge: "start" | "end"; ripple: boolean }
  /** `left` ends where `right` starts; the cut between them moves. */
  | { kind: "roll"; left: string; right: string }
  /** The clip shows another part of its source in the same place. */
  | { kind: "slip"; clipId: string }
  /** The clip moves between its neighbours, which trim to follow. */
  | { kind: "slide"; clipId: string }
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
              (intent.kind === "gain" || intent.kind === "speedLine") &&
              across > down
                ? {
                    kind: "move",
                    clipId: intent.clipId,
                    alone: "alone" in intent && intent.alone,
                  }
                : intent,
            point,
            loose: false,
          },
          outcome: null,
        };
      const loose =
        gesture.phase === "dragging" ||
        ((intent.kind === "gain" || intent.kind === "speedLine") &&
          down >= 1 &&
          down > across);
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
  /** The press is on the clip's name strip, along its top. */
  strip?: boolean;
  mix?: "gain" | "fadeIn" | "fadeOut" | { point: number };
  /** The press is on a speed line, or on one of its points. */
  speed?: "line" | { point: number };
}

/**
 * What a press means, as on Resolve's Edit page. The pointer moves a clip by its body and
 * resizes it by an edge. The Trim tool ripples an edge and rolls a cut between two clips; on a
 * body it slips the clip's source, and on the name strip it slides the clip between its
 * neighbours. A clip with no source to slip only selects there. The blade cuts the clip it is on.
 * A press on an empty lane draws a marquee. Null when the press starts nothing, as on a locked
 * track.
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
  // A point on the clip's first or last frame sits on its edge, where it is still the point.
  if (tool === "pointer" && typeof hit.mix === "object" && clip.hasAudio)
    return { kind: "point", clipId: clip.id, index: hit.mix.point };
  if (tool === "pointer" && typeof hit.speed === "object")
    return { kind: "speed", clipId: clip.id, index: hit.speed.point };
  const reach = Math.min(EDGE_PX, width / 3);
  const edge = x < reach ? "start" : x >= width - reach ? "end" : null;
  if (tool === "pointer" && edge)
    return { kind: "trim", clipId: clip.id, edge, ripple: false };
  if (tool === "pointer" && hit.speed === "line")
    return { kind: "speedLine", clipId: clip.id };
  if (tool === "pointer" && typeof hit.mix === "string" && clip.hasAudio)
    return hit.mix === "gain"
      ? { kind: "gain", clipId: clip.id, alone }
      : { kind: "fade", clipId: clip.id, edge: hit.mix };
  if (!edge)
    return tool === "pointer"
      ? { kind: "move", clipId: clip.id, alone }
      : hit.strip
        ? { kind: "slide", clipId: clip.id }
        : clip.mediaStart === null
          ? null
          : { kind: "slip", clipId: clip.id };
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
  /** What a held speed point reads: its speed and frame, or the limit that stopped it. */
  readout?: string;
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
  /**
   * Clips a move carries: the selection, with linked partners unless Alt was held. A slide
   * carries the clip and its partners.
   */
  carried: readonly Clip[];
  /** The selected clips a move names. */
  named: readonly Clip[];
  /** How far a slip or slide can go each way, in frames. */
  range?: { min: number; max: number };
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
  const edited =
    (intent.kind === "slide" || intent.kind === "slip") &&
    timeline.clips.find((clip) => clip.id === intent.clipId);
  const slid = intent.kind === "slide" && edited;
  const carried = slid
    ? timeline.clips.filter(
        (clip) =>
          clip.id === slid.id ||
          (slid.link !== null && clip.link === slid.link),
      )
    : intent.kind !== "move"
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
    // Found once, by trying the edit, so each pointer move only clamps.
    ...(edited && {
      range:
        intent.kind === "slip"
          ? (slipRange(timeline, edited) ?? undefined)
          : slideRange(timeline, [edited]),
    }),
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
  /** Where a held volume point is, in percent down its clip's body, and the body's height. */
  level?: { at: number; body: number };
  /**
   * How far up a held speed point or line has travelled, in percent of its clip's body, with
   * Shift's steps already ten times finer, the body's height in pixels, and whether Shift is
   * held now, which leaves the speed off the snap list as Shift leaves a gain line off 0 dB.
   */
  speed?: { travel: number; body: number; fine: boolean };
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
    case "point": {
      const clip = find(intent.clipId);
      const points = volumePoints(clip.automation, timeline.fps) ?? [];
      const point = points[intent.index];
      if (!point || !input.level) return still("Move volume point");
      // A point stays between its neighbours, a frame from each, and on the clip.
      const before = points[intent.index - 1];
      const after = points[intent.index + 1];
      const low = before ? Math.floor(before.frame) + 1 : 0;
      const high = after ? Math.ceil(after.frame) - 1 : clip.duration;
      const frame =
        travel === 0 || low > high
          ? point.frame
          : Math.max(low, Math.min(high, Math.round(point.frame + travel)));
      const gain = laneFromLevel(
        clip,
        timeline.fps,
        frame,
        input.level.at,
        input.level.body,
      );
      const moved = points.map((each, index) =>
        index === intent.index ? { frame, gain } : each,
      );
      return edit(
        "Move volume point",
        frame === point.frame && gain === point.gain
          ? []
          : [
              {
                type: "setClip",
                clipId: clip.id,
                automation: { volume: moved },
              },
            ],
        frame - point.frame,
        null,
      );
    }
    case "speed":
    case "speedLine": {
      const clip = find(intent.clipId);
      const { fps } = timeline;
      const points = speedPoints(clip, fps);
      const held = input.speed;
      // Two decades of speed fill the body.
      const factor = held ? 10 ** ((held.travel / 100) * 2) : 1;
      const snapSpeed = (speed: number) => {
        const free = Math.min(
          MAX_PLAYBACK_RATE,
          Math.max(MIN_PLAYBACK_RATE, speed),
        );
        if (!input.reach || !held || held.fine) return free;
        const near = SNAP_SPEEDS.find(
          (target) =>
            Math.abs(speedLevel(target) - speedLevel(free)) * held.body <=
            SPEED_SNAP_PX,
        );
        return near ?? Math.round(free * 1e4) / 1e4;
      };
      const read = (speed: number, frame: number) =>
        `${Math.round(speed * 100)}% at ${formatTimecode(clip.start + Math.round(frame), fps)}`;
      if (!points) {
        const speed = snapSpeed(clip.playbackRate * factor);
        return {
          ...edit(
            "Change speed",
            speed === clip.playbackRate
              ? []
              : [{ type: "setSpeed", clipId: clip.id, speed }],
            0,
            null,
          ),
          readout: `${Math.round(speed * 100)}%`,
        };
      }
      const inputs = points.map(({ frame, speed, ease }) =>
        ease === "custom" ? { frame, speed } : { frame, speed, ease },
      );
      if (intent.kind === "speedLine") {
        // The segment under the press moves as one, or the end point beyond the last.
        const local = drag.origin - clip.start;
        const after = points.findIndex((point) => point.frame > local);
        const moved =
          after < 0
            ? [points.length - 1]
            : after === 0
              ? [0]
              : [after - 1, after];
        const next = inputs.map((point, index) =>
          moved.includes(index)
            ? {
                ...point,
                speed:
                  Math.round(
                    Math.min(
                      MAX_PLAYBACK_RATE,
                      Math.max(MIN_PLAYBACK_RATE, point.speed * factor),
                    ) * 1e4,
                  ) / 1e4,
              }
            : point,
        );
        const first = next[moved[0]!]!;
        return {
          ...edit(
            "Move speed line",
            factor === 1
              ? []
              : [{ type: "setSpeed", clipId: clip.id, points: next }],
            0,
            null,
          ),
          readout: read(first.speed, first.frame),
        };
      }
      const point = points[intent.index];
      if (!point) return still("Move speed point");
      // A point stays between its neighbours, a frame from each.
      const before = points[intent.index - 1];
      const after = points[intent.index + 1];
      const low = before
        ? Math.floor(before.frame) + 1
        : Math.min(0, point.frame);
      const high = after
        ? Math.ceil(after.frame) - 1
        : Math.max(clip.duration, point.frame);
      const free = Math.round(point.frame + travel);
      const snapped =
        travel === 0 ? null : snap([clip.start + free], targets, input.reach);
      const frame =
        travel === 0 || low > high
          ? point.frame
          : Math.max(low, Math.min(high, free + (snapped?.by ?? 0)));
      const speed =
        factor === 1 ? point.speed : snapSpeed(point.speed * factor);
      const pointsAt = inputs.map((each, index) =>
        index === intent.index ? { ...each, frame, speed } : each,
      );
      const move = (next: typeof pointsAt, snap: number | null) => {
        const chosen = next[intent.index]!;
        return edit(
          "Move speed point",
          chosen.frame === point.frame && chosen.speed === point.speed
            ? []
            : [{ type: "setSpeed", clipId: clip.id, points: next }],
          chosen.frame - point.frame,
          snap,
        );
      };
      const result = move(
        pointsAt,
        snapped && frame === free + snapped.by ? snapped.at : null,
      );
      if (!result.valid) {
        const limited = limitSpeedPoint(
          speedProjection(clip, timeline.clips, fps),
          pointsAt,
          intent.index,
          point,
          fps,
        );
        if (limited)
          return { ...move(limited.points, null), readout: limited.hint };
      }
      return { ...result, readout: read(speed, frame) };
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
      const commands = (to: number): CommandInput[] => [
        {
          type: "roll",
          from: intent.left,
          to: intent.right,
          by: to - from,
        },
      ];
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
    case "slip": {
      const clip = find(intent.clipId);
      const { range } = drag;
      if (!range) return still("Slip");
      // The source follows the pointer, as in Resolve: dragging right shows earlier frames. It
      // stops at either end of the source.
      const by = Math.max(range.min, Math.min(range.max, -travel));
      return edit(
        "Slip",
        by ? [{ type: "slip", clipId: clip.id, by }] : [],
        -by,
        null,
      );
    }
    case "slide": {
      const clip = find(intent.clipId);
      const range = drag.range ?? { min: 0, max: 0 };
      const hit = snap(
        [clip.start + travel, clipEnd(clip) + travel],
        targets,
        input.reach,
      );
      // A neighbour that runs out of source or length holds the clip, as in Resolve.
      const by = Math.max(
        range.min,
        Math.min(range.max, travel + (hit?.by ?? 0)),
      );
      return edit(
        "Slide",
        by ? [{ type: "slide", clipIds: [clip.id], by }] : [],
        by,
        hit && by === travel + hit.by ? hit.at : null,
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

/** Media dragged onto the timeline: a project file and the part of it that plays there. */
export interface DraggedMedia {
  kind: MediaDrag["kind"];
  /** The file as the composition it lands in writes it, from that composition's folder. */
  src: string;
  frames: number;
  /** Seconds into the file where the clip begins. */
  mediaStart?: number;
  hasAudio?: boolean;
}

/**
 * Dragged media as the timeline places it: its length in whole frames at the timeline's rate.
 * A marked range is a whole number of frames turned into seconds, which must not round down.
 */
export const placedMedia = (
  media: MediaDrag,
  { num, den }: Timeline["fps"],
  composition: string,
): DraggedMedia => ({
  kind: media.kind,
  src: sourceUrl(composition, media.path),
  frames: Math.max(1, Math.floor((media.seconds * num) / den + 1e-6)),
  mediaStart: media.start,
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
      clip:
        media.kind === "composition"
          ? { kind: "composition", src: media.src, duration: media.frames }
          : {
              kind: media.kind,
              src: media.src,
              duration: media.frames,
              mediaStart: media.mediaStart,
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
