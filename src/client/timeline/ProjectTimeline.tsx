import { useStore } from "zustand";
import { useEffect, useMemo, useState } from "react";
import type { ReviewItem, ReviewStatus } from "../../shared/review";
import { toFrames } from "../../shared/timeline/apply";
import { nextTrackIndex } from "../../shared/timeline/tracks";
import { editKeys, trimmedPlayhead } from "../edit/keys";
import { editTimeline, loadTimeline, useTimeline } from "../edit/timeline";
import { transport, useTransport, velocity } from "../edit/transport";
import { useKeymap } from "../keymap";
import { noteNumbers } from "../review";
import type { Action } from "../keymap";
import { reportEditorError, useWorkspace } from "../workspace";
import type { Tool } from "./gesture";
import { Timeline } from "./Timeline";
import { MarkerEditor } from "./MarkerEditor";
import type { Marker } from "../../shared/timeline/schema";
import type { TimelineClock, TimelinePin, TimelineProps } from "./Timeline";
import {
  emptySelection,
  pruneSelection,
  selectionAtPlayhead,
} from "./selection";
import type { Selection } from "./selection";
import type { VoiceoverSession } from "../voiceover/session";
import { VoiceoverHeader } from "../voiceover/Voiceover";

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
  voiceover,
  projectId,
  tool,
  notes,
  onOpenNote,
}: {
  voiceover: VoiceoverSession;
  projectId: string;
  tool: Tool;
  notes: readonly ReviewItem[];
  onOpenNote(id: string): void;
}) {
  const recording = useStore(voiceover.store, ({ state }) =>
    state.kind === "recording" ? state : null,
  );
  const view = useTimeline((state) => state.view);
  const [editingMarker, setEditingMarker] = useState<{
    marker: Marker;
    anchor: { x: number; y: number };
  } | null>(null);
  const selection = useTimeline((state) => state.selection);
  const snapping = useTimeline((state) => state.snapping);
  const setSelection = (next: Selection) =>
    useTimeline.setState({ selection: next });
  const timeline = view?.timeline;
  useEffect(() => {
    const closing = new AbortController();
    void loadTimeline(projectId, closing.signal).catch((error: unknown) => {
      if (!closing.signal.aborted) reportEditorError("timeline", error);
    });
    return () => closing.abort();
  }, [projectId, notes]);

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
        let parked: number | null = null;
        void editTimeline(
          projectId,
          label,
          (current) => commands(current, target),
          undefined,
          (next, built) => {
            const frame = trimmedPlayhead(next, built);
            if (frame === null) return;
            transport.seek(frame);
            // A trim at the end shortens the timeline, and the transport parks on its last frame.
            parked = Math.min(frame, next.duration - 1);
          },
        ).then((accepted) => {
          if (
            !accepted &&
            parked !== null &&
            useTimeline.getState().projectId === projectId &&
            clock.frame() === parked
          )
            transport.seek(target.frame);
        });
      },
    ],
  );
  useKeymap({
    ...(Object.fromEntries(edits) as Partial<Record<Action, () => void>>),
    editSelectItemAtPlayhead: () => {
      if (timeline) setSelection(selectionAtPlayhead(timeline, clock.frame()));
    },
    editDeselectAll: () => setSelection(emptySelection),
    // Pressed during a drag, it turns snapping off or on for the rest of it, as in Resolve.
    editSnapping: () =>
      useTimeline.setState((state) => ({ snapping: !state.snapping })),
  });

  const pins = useMemo(() => {
    const numbers = noteNumbers(notes);
    return view
      ? notes.flatMap((note): TimelinePin[] => {
          const state = pinStates[note.review.status];
          return state && note.compositionPath === view.composition
            ? [
                {
                  id: note.id,
                  number: numbers.get(note.id) ?? 0,
                  frame: toFrames(note.time, view.timeline.fps),
                  state,
                },
              ]
            : [];
        })
      : [];
  }, [notes, view]);

  // The toggle is worked out from the timeline as shown, with earlier edits already on it,
  // so two quick clicks flip twice. A track the timeline does not hold yet
  // is created as the kind its row shows.
  const toggleTrack: TimelineProps["onToggleTrack"] = (shown, setting) =>
    void editTimeline(
      projectId,
      {
        locked: "Lock or unlock track",
        autoSelect: "Toggle auto-select",
        enabled: "Enable or disable track",
        muted: "Mute or unmute track",
        solo: "Solo or unsolo track",
      }[setting],
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
    <>
      <Timeline
        recording={
          recording ? { track: recording.track, start: recording.start } : null
        }
        audioControls={(track, id, part) => (
          <VoiceoverHeader
            session={voiceover}
            track={track}
            id={id}
            part={part}
          />
        )}
        timeline={view.timeline}
        source={{ projectId, composition: view.composition }}
        clock={clock}
        pins={pins}
        agentChanges={new Set(view.agentChanges)}
        selection={selection}
        onSelect={setSelection}
        tool={tool}
        snapping={snapping}
        onEdit={(label, commands, basis) => {
          // The editor shows an edit it takes before this returns.
          const before = useTimeline.getState().view;
          void editTimeline(projectId, label, () => commands, basis);
          return useTimeline.getState().view !== before;
        }}
        onGesture={(gesture) => useWorkspace.setState({ gesture })}
        onSeek={transport.seek}
        onScrub={transport.scrub}
        onScrubEnd={transport.release}
        onToggleTrack={toggleTrack}
        onRenameTrack={(track, name) =>
          void editTimeline(projectId, "Rename track", () => [
            {
              type: "setTrack",
              index: track.index,
              kind: track.kind,
              name: name || null,
            },
          ])
        }
        onAddTrack={(kind) =>
          void editTimeline(projectId, `Add ${kind} track`, (timeline) => [
            { type: "setTrack", index: nextTrackIndex(timeline.tracks), kind },
          ])
        }
        onOpenPin={onOpenNote}
        onOpenMarker={(marker, anchor) => setEditingMarker({ marker, anchor })}
      />
      {editingMarker &&
        view.timeline.markers.some(
          ({ id }) => id === editingMarker.marker.id,
        ) && (
          <MarkerEditor
            key={editingMarker.marker.id}
            {...editingMarker}
            onClose={() => setEditingMarker(null)}
            onSave={(changes) =>
              // Only the changed fields are sent, so an agent's newer edit to the others stays,
              // even when it lands after this edit was made.
              editTimeline(projectId, "Edit marker", (timeline) => {
                if (
                  !timeline.markers.some(
                    ({ id }) => id === editingMarker.marker.id,
                  )
                )
                  throw new Error("This marker was removed.");
                return [
                  {
                    type: "setMarker",
                    id: editingMarker.marker.id,
                    ...changes,
                  },
                ];
              })
            }
            onDelete={() =>
              editTimeline(projectId, "Remove marker", () => [
                { type: "removeMarker", id: editingMarker.marker.id },
              ])
            }
          />
        )}
    </>
  );
}
