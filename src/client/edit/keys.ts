import { isAudioKind } from "../../shared/timeline/schema";
import {
  clipEnd,
  cutRoom,
  frameTime,
  toFrames,
} from "../../shared/timeline/apply";
import { takesTransition } from "../../shared/timeline/transition";
import { TimelineError } from "../../shared/timeline/errors";
import type {
  Clip,
  CommandInput,
  Timeline,
} from "../../shared/timeline/schema";
import type { Action } from "../keymap";
import type { MediaDrag } from "../timeline/mediaDrag";

/** What an editing key acts on, read when the key is pressed. */
export interface EditTarget {
  /** Selected clip ids; clips on locked tracks are never selected. */
  selection: ReadonlySet<string>;
  /** The frame under the playhead. */
  frame: number;
  /** A selected transition, named by the clip it leads into. */
  transition?: string;
}

interface EditKey {
  /** The undo step's name. */
  label: string;
  commands(timeline: Timeline, target: EditTarget): CommandInput[];
}

const spans = (clip: Clip, frame: number) =>
  clip.start <= frame && frame < clipEnd(clip);

/**
 * The selected clips in the timeline an edit is built from, which may be the server's, newer than
 * the view they were selected in. A clip id names one clip for good, so a selected clip is there
 * or gone, as after a quick second X or an agent's delete.
 */
const selectedIn = (timeline: Timeline, { selection }: EditTarget) =>
  timeline.clips.filter((clip) => selection.has(clip.id));

/**
 * The clips Q, W and E act on, as in Resolve: the selected clips under the playhead, or when none
 * is, the clips under it on unlocked tracks with auto-select on. Video first, from V1 up, then audio.
 */
function underPlayhead(timeline: Timeline, target: EditTarget) {
  const { frame } = target;
  const selected = selectedIn(timeline, target).filter((clip) =>
    spans(clip, frame),
  );
  if (selected.length) return selected;
  const editable = new Set(
    timeline.tracks
      .filter((track) => track.autoSelect && !track.locked)
      .map((track) => track.index),
  );
  return timeline.clips
    .filter((clip) => editable.has(clip.track) && spans(clip, frame))
    .toSorted(
      (a, b) =>
        Number(isAudioKind(a.kind)) - Number(isAudioKind(b.kind)) ||
        a.track - b.track,
    );
}

/**
 * A ripple trim moves one edit point and keeps every auto-select track in sync, so Q and W trim one
 * clip with its linked partners: the first clip under the playhead.
 */
const trimToPlayhead =
  (edge: "start" | "end") =>
  (timeline: Timeline, target: EditTarget): CommandInput[] => {
    const [clip] = underPlayhead(timeline, target);
    // At a cut the playhead is on the incoming clip's first frame, so W would leave none of it.
    if (clip && edge === "end" && target.frame === clip.start)
      throw new TimelineError(
        "out_of_bounds",
        `Nothing to trim: the playhead is at the start of ${clip.id}. Move into the clip to trim its end, or ripple delete the clip.`,
      );
    return clip
      ? [
          {
            type: "trim",
            clipId: clip.id,
            edge,
            to: target.frame,
            ripple: true,
          },
        ]
      : [];
  };

/** Q and W park on the new edit point, showing the first frame after the cut. */
export function trimmedPlayhead(
  timeline: Timeline,
  commands: readonly CommandInput[],
) {
  const [command] = commands;
  if (command?.type !== "trim" || !command.ripple) return null;
  const clip = timeline.clips.find((clip) => clip.id === command.clipId);
  if (!clip) return null;
  return command.edge === "start" ? clip.start : clipEnd(clip);
}

/**
 * Razors the clips under the playhead as shown when the key is pressed, named one by one, so a
 * later agent edit can never widen the cut. With none, the engine refuses the unscoped razor in
 * the browser with its own reason, and nothing is sent.
 */
const razor = (timeline: Timeline, target: EditTarget): CommandInput[] => {
  const targets = underPlayhead(timeline, target);
  const clips = targets.filter((clip) => clip.start < target.frame);
  if (targets.length && !clips.length) return [];
  return [
    {
      type: "split",
      at: target.frame,
      ...(!clips.some((clip) => target.selection.has(clip.id)) && {
        autoSelect: true,
      }),
      ...(clips.length && { clipIds: clips.map((clip) => clip.id) }),
    },
  ];
};

/** The clip that ends where `to` starts on its track: the other side of its cut. */
const outgoing = (timeline: Timeline, to: Clip) =>
  timeline.clips.find(
    (clip) =>
      clip.track === to.track &&
      clipEnd(clip) === to.start &&
      clip.id !== to.id &&
      takesTransition(clip),
  );

const removeSelection =
  (ripple: boolean) =>
  (timeline: Timeline, target: EditTarget): CommandInput[] => {
    // A selected transition is what Delete and Backspace remove.
    if (target.transition !== undefined) {
      const to = timeline.clips.find((clip) => clip.id === target.transition);
      const from = to?.transitionIn && outgoing(timeline, to);
      return to && from
        ? [
            {
              type: "setTransition",
              from: from.id,
              to: to.id,
              transition: null,
            },
          ]
        : [];
    }
    const clipIds = selectedIn(timeline, target).map((clip) => clip.id);
    return clipIds.length ? [{ type: "remove", clipIds, ripple }] : [];
  };

/** Nudge moves the selected clips and their linked partners, overwriting what they land on. */
const nudge =
  (by: number) =>
  (timeline: Timeline, target: EditTarget): CommandInput[] => {
    const clipIds = selectedIn(timeline, target).map((clip) => clip.id);
    return clipIds.length ? [{ type: "move", clipIds, by }] : [];
  };

/**
 * Moves the selected clips to the next track of their kind as the headers stack them: up is a
 * higher video track or a lower audio track. Clips with no track there stay, and a move never
 * covers another clip. The track furthest along moves first, so selected neighbours make way.
 */
const moveTrack =
  (up: boolean) =>
  (timeline: Timeline, target: EditTarget): CommandInput[] => {
    const groups = new Map<number, string[]>();
    for (const clip of selectedIn(timeline, target))
      groups.set(clip.track, [...(groups.get(clip.track) ?? []), clip.id]);
    if (!groups.size) return [];
    const moves = [...groups].flatMap(([index, clipIds]) => {
      const track = timeline.tracks.find((track) => track.index === index);
      if (!track) return [];
      const ofKind = timeline.tracks
        .filter(({ kind }) => kind === track.kind)
        .toSorted((a, b) => a.index - b.index);
      const step = (track.kind === "video") === up ? 1 : -1;
      const place = ofKind.indexOf(track) + step;
      const to = ofKind[place];
      return to
        ? [{ order: place * step, clipIds, trackBy: to.index - index }]
        : [];
    });
    if (!moves.length)
      throw new TimelineError(
        "out_of_bounds",
        `No track ${up ? "above" : "below"} the selected clips.`,
      );
    return moves
      .toSorted((a, b) => b.order - a.order)
      .map(({ clipIds, trackBy }) => ({
        type: "move",
        clipIds,
        trackBy,
        mode: "place",
      }));
  };

/**
 * Ctrl+T, Alt+T and Shift+T: a one-second cross dissolve, centred on the cut nearest the playhead
 * between two clips on unlocked auto-select tracks, or touching the selected clips when there are
 * some. Ctrl+T takes a picture cut first and its linked sound with it; Alt+T only picture, Shift+T
 * only sound. Where the media runs short it takes the longest that fits and says so.
 */
export function addTransition(
  timeline: Timeline,
  target: EditTarget,
  scope: "both" | "video" | "audio",
): { commands: CommandInput[]; note: string | null } {
  const tracks = new Map(
    timeline.tracks
      .filter((track) => track.autoSelect && !track.locked)
      .map((track) => [track.index, track]),
  );
  const cuts = timeline.clips.flatMap((to) => {
    const track = tracks.get(to.track);
    const from = track && takesTransition(to) && outgoing(timeline, to);
    if (!track || !from) return [];
    if (scope !== "both" && track.kind !== scope) return [];
    if (
      target.selection.size &&
      !target.selection.has(from.id) &&
      !target.selection.has(to.id)
    )
      return [];
    return [{ from, to, video: track.kind === "video" }];
  });
  const [cut] = cuts.toSorted(
    (a, b) =>
      Math.abs(a.to.start - target.frame) -
        Math.abs(b.to.start - target.frame) ||
      Number(b.video) - Number(a.video) ||
      a.to.track - b.to.track,
  );
  if (!cut)
    throw new TimelineError(
      "not_found",
      `No cut between two ${scope === "audio" ? "sound clips" : scope === "video" ? "picture clips" : "clips"} to put a transition on${target.selection.size ? " at the selected clips" : ""}.`,
    );
  const linked = scope === "both";
  const room = cutRoom(timeline, cut.from, cut.to, "center", linked);
  if (room.frames < 1)
    throw new TimelineError(
      "out_of_bounds",
      `No transition fits at this cut: ${room.reason}.`,
    );
  const second = toFrames(1, timeline.fps);
  const duration = Math.min(second, room.frames);
  return {
    commands: [
      {
        type: "setTransition",
        from: cut.from.id,
        to: cut.to.id,
        linked,
        transition: {
          kind: cut.to.transitionIn?.kind ?? "dissolve",
          duration,
          alignment: "center",
        },
      },
    ],
    note:
      duration < second
        ? `Shortened to ${duration} ${duration === 1 ? "frame" : "frames"}: ${room.reason}.`
        : null,
  };
}

/**
 * The source file and frame under the playhead, for match frame: from the selected clip under it,
 * or else the top picture, then the first sound, on unlocked auto-select tracks.
 */
export function matchFrame(
  timeline: Timeline,
  target: EditTarget,
): { file: MediaDrag; frame: number } | null {
  const media = underPlayhead(timeline, target).flatMap((clip) => {
    const { kind, src, mediaStart, sourceDuration } = clip;
    if (
      (kind !== "video" && kind !== "audio" && kind !== "voiceover") ||
      src === null ||
      mediaStart === null ||
      sourceDuration === null
    )
      return [];
    const seconds =
      mediaStart +
      frameTime(target.frame - clip.start, timeline.fps) * clip.playbackRate;
    return [
      {
        id: clip.id,
        file: {
          kind,
          path: src,
          seconds: sourceDuration,
          hasAudio: clip.hasAudio,
        },
        frame: toFrames(seconds, timeline.fps),
      },
    ];
  });
  return (
    media.find(({ id }) => target.selection.has(id)) ??
    media.findLast(({ file }) => file.kind === "video") ??
    media[0] ??
    null
  );
}

/** The timeline edits bound to keys. Each press is one batch, so one undo step. */
export const editKeys = {
  trimRippleStartToPlayhead: {
    label: "Ripple trim start",
    commands: trimToPlayhead("start"),
  },
  trimRippleEndToPlayhead: {
    label: "Ripple trim end",
    commands: trimToPlayhead("end"),
  },
  editBladeRazor: { label: "Razor", commands: razor },
  editM2SplitClip: { label: "Split", commands: razor },
  editBackspace: { label: "Lift", commands: removeSelection(false) },
  editDelete: { label: "Ripple delete", commands: removeSelection(true) },
  editClipEnabled: {
    label: "Turn clips on or off",
    commands: (timeline, target) =>
      selectedIn(timeline, target).map((clip): CommandInput => ({
        type: "setClip",
        clipId: clip.id,
        enabled: !clip.enabled,
      })),
  },
  editNudgeTrimStepNudgeReverse: { label: "Nudge", commands: nudge(-1) },
  editNudgeTrimStepNudgeForward: { label: "Nudge", commands: nudge(1) },
  editNudgeTrimStepTrimMultiFrameLeft: { label: "Nudge", commands: nudge(-5) },
  editNudgeTrimStepTrimMultiFrameRight: { label: "Nudge", commands: nudge(5) },
  editMoveClipsUp: { label: "Move clips up", commands: moveTrack(true) },
  editMoveClipsDown: { label: "Move clips down", commands: moveTrack(false) },
  markMarkerAdd: {
    label: "Add marker",
    commands: ({ markers }, { frame }) =>
      markers.some((marker) => marker.frame === frame)
        ? []
        : [{ type: "setMarker", frame, name: `Marker ${markers.length + 1}` }],
  },
} satisfies Partial<Record<Action, EditKey>>;
