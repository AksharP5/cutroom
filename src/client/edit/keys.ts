import { clipEnd } from "../../shared/timeline/apply";
import type {
  Clip,
  CommandInput,
  Timeline,
} from "../../shared/timeline/schema";
import type { Action } from "../keymap";

/** What an editing key acts on, read when the key is pressed. */
export interface EditTarget {
  /** Selected clip ids; clips on locked tracks are never selected. */
  selection: ReadonlySet<string>;
  /** The frame under the playhead. */
  frame: number;
}

interface EditKey {
  /** The undo step's name. */
  label: string;
  commands(timeline: Timeline, target: EditTarget): CommandInput[];
}

const spans = (clip: Clip, frame: number) =>
  clip.start < frame && frame < clipEnd(clip);

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
      (a, b) => Number(a.kind === "audio") - Number(b.kind === "audio"),
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
  const clips = underPlayhead(timeline, target);
  return [
    {
      type: "split",
      at: target.frame,
      ...(clips.length && { clipIds: clips.map((clip) => clip.id) }),
    },
  ];
};

const removeSelection =
  (ripple: boolean) =>
  (timeline: Timeline, target: EditTarget): CommandInput[] => {
    const clipIds = selectedIn(timeline, target).map((clip) => clip.id);
    return clipIds.length ? [{ type: "remove", clipIds, ripple }] : [];
  };

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
  markMarkerAdd: {
    label: "Add marker",
    commands: ({ markers }, { frame }) =>
      markers.some((marker) => marker.frame === frame)
        ? []
        : [{ type: "setMarker", frame, name: `Marker ${markers.length + 1}` }],
  },
} satisfies Partial<Record<Action, EditKey>>;
