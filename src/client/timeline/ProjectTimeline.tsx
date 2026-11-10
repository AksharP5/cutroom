import { useEffect, useMemo } from "react";
import type { ReviewItem, ReviewStatus } from "../../shared/review";
import { toFrames } from "../../shared/timeline/apply";
import { editKeys } from "../edit/keys";
import { editTimeline, useTimeline } from "../edit/timeline";
import { transport, useTransport, velocity } from "../edit/transport";
import { useKeymap } from "../keymap";
import type { Action } from "../keymap";
import { Timeline } from "./Timeline";
import type { TimelineClock, TimelinePin, TimelineProps } from "./Timeline";
import {
  emptySelection,
  pruneSelection,
  selectionAtPlayhead,
} from "./selection";
import type { Selection } from "./selection";

/** Notes the agent still owes work on are the owner's mark; withdrawn notes leave the ruler. */
const pinStates = {
  open: "queued",
  queued: "queued",
  blocked: "queued",
  working: "working",
  done: "review",
  accepted: "accepted",
  withdrawn: null,
} as const satisfies Record<ReviewStatus, TimelinePin["state"] | null>;

/**
 * The transport's playhead, read without rendering. The store also changes for mute, loop and
 * every timeline edit; only a frame change may move the view, or an agent's edit would pull it
 * back to the playhead.
 */
const clock: TimelineClock = {
  frame: () => useTransport.getState().frame,
  direction: () => {
    const speed = velocity(useTransport.getState().state);
    return speed > 0 ? 1 : speed < 0 ? -1 : 0;
  },
  subscribe: (listener) =>
    useTransport.subscribe((state, previous) => {
      if (state.frame !== previous.frame) listener();
    }),
};

/**
 * The open project's timeline: the engine's projection from the editor's store, the transport's
 * playhead, review notes as ruler pins, and track changes and editing keys sent back as commands.
 */
export function ProjectTimeline({
  projectId,
  notes,
  onOpenNote,
}: {
  projectId: string;
  notes: readonly ReviewItem[];
  onOpenNote(id: string): void;
}) {
  const view = useTimeline((state) => state.view);
  const selection = useTimeline((state) => state.selection);
  const setSelection = (next: Selection) =>
    useTimeline.setState({ selection: next });
  const timeline = view?.timeline;

  useEffect(() => {
    if (timeline)
      useTimeline.setState(({ selection: current }) => ({
        selection: pruneSelection(timeline, current),
      }));
  }, [timeline]);

  // The selection, playhead and timeline are read at the press, and the commands built from them.
  const edits = Object.entries(editKeys).map(
    ([action, { label, commands }]) => [
      action,
      () => {
        // The store's selection, not this render's: a click just before the key has not rendered.
        const target = {
          selection: useTimeline.getState().selection.ids,
          frame: clock.frame(),
        };
        void editTimeline(projectId, label, (current) =>
          commands(current, target),
        );
      },
    ],
  );
  useKeymap({
    ...(Object.fromEntries(edits) as Partial<Record<Action, () => void>>),
    editSelectItemAtPlayhead: () => {
      if (timeline) setSelection(selectionAtPlayhead(timeline, clock.frame()));
    },
    editDeselectAll: () => setSelection(emptySelection),
  });

  const pins = useMemo(
    () =>
      view
        ? notes.flatMap((note): TimelinePin[] => {
            const state = pinStates[note.review.status];
            return state && note.compositionPath === view.composition
              ? [
                  {
                    id: note.id,
                    frame: toFrames(note.time, view.timeline.fps),
                    state,
                  },
                ]
              : [];
          })
        : [],
    [notes, view],
  );

  // The toggle is worked out from the timeline as shown, with earlier edits already on it,
  // so two quick clicks flip twice. A track the timeline does not hold yet
  // is created as the kind its row shows.
  const toggleTrack: TimelineProps["onToggleTrack"] = (shown, setting) =>
    void editTimeline(
      projectId,
      setting === "locked" ? "Lock or unlock track" : "Toggle auto-select",
      ({ tracks }) => {
        const track = tracks.find((item) => item.index === shown.index);
        return [
          {
            type: "setTrack",
            index: shown.index,
            ...(!track && { kind: shown.kind }),
            [setting]: !(track ?? shown)[setting],
          },
        ];
      },
    );

  if (!view) return null;
  return (
    <Timeline
      timeline={view.timeline}
      source={{ projectId, composition: view.composition }}
      clock={clock}
      pins={pins}
      selection={selection}
      onSelect={setSelection}
      onSeek={transport.seek}
      onScrub={transport.scrub}
      onScrubEnd={transport.release}
      onToggleTrack={toggleTrack}
      onOpenPin={onOpenNote}
    />
  );
}
