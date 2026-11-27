import { offerMediaFormat } from "../edit/projectFormat";
import { trackDensities } from "../../shared/timeline/view";
import type { TimelineViewSettings } from "../../shared/timeline/view";
import { openContextMenu } from "../components/ContextMenu";
import type { MenuItem } from "../components/menu";
import { openClipMenu } from "../edit/openClipMenu";
import { useStore } from "zustand";
import { audioGainToText } from "@hyperframes/core/audio-gain";
import { useEffect, useMemo, useState } from "react";
import type { ReviewItem, ReviewStatus } from "../../shared/review";
import { toFrames } from "../../shared/timeline/apply";
import {
  destinationTracks,
  nextTrackIndex,
  shownTracks,
} from "../../shared/timeline/tracks";
import { addTitleCommands } from "../edit/addTitle";
import { addLayerCommands } from "../edit/regionCommands";
import { addTransition, editKeys, editedPlayhead } from "../edit/keys";
import { useTextEdit } from "../edit/preview";
import { showSource, useSource } from "../edit/source";
import {
  clipboardEdit,
  editTimeline,
  finishHeldEdit,
  useTimeline,
} from "../edit/timeline";
import { transport, useTransport, velocity } from "../edit/transport";
import { isTyping, keymap, useKeymap } from "../keymap";
import type { HeldKey } from "../keymap";
import { leaveComposition, openHost } from "../edit/compositions";
import { noteNumbers } from "../review";
import type { Action } from "../keymap";
import { showToast, useWorkspace } from "../workspace";
import type { Tool } from "./gesture";
import type { Row } from "./math";
import { Timeline } from "./Timeline";
import {
  openViewSettings,
  saveViewSettings,
  useViewSettings,
} from "./viewSettings";
import { TrackGainDialog } from "./TrackGain";
import { Mixer } from "./Mixer";
import { trackRows } from "./math";
import { FxRack } from "../edit/inspector/FxRack";
import { Modal } from "../components/Modal";
import { clipName } from "../../shared/timeline/labels";
import { MarkerEditor } from "./MarkerEditor";
import type { Marker, Track } from "../../shared/timeline/schema";
import type { TimelineClock, TimelinePin, TimelineProps } from "./Timeline";
import {
  clickSelection,
  emptySelection,
  clipsAtEditPoint,
  nearestEditPoint,
  pruneSelection,
  selectAll,
  selectionAtPlayhead,
  selectionFromPlayhead,
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

/** Reveal the picture a timeline editing action is about to change. */
function revealTimeline() {
  if (useSource.getState().shown) showSource(false);
}

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
  const [gainTrack, setGainTrack] = useState<Track | null>(null);
  /** The track whose effects are open, by index, so the dialog shows each edit as it lands. */
  const [fxTrack, setFxTrack] = useState<number | null>(null);
  const openFx = view?.timeline.tracks.find((track) => track.index === fxTrack);
  const [editingMarker, setEditingMarker] = useState<{
    marker: Marker;
    anchor: { x: number; y: number };
  } | null>(null);
  const viewSettings = useViewSettings();
  const composition = view?.composition;
  useEffect(() => {
    if (composition) return openViewSettings(projectId, composition);
  }, [projectId, composition]);
  // Open or closed per window, as the left column's width is.
  const [mixerOpen, setMixerOpen] = useState(
    () => sessionStorage.getItem("cutroom.mixer") === "true",
  );
  const showMixer = (open: boolean) => {
    sessionStorage.setItem("cutroom.mixer", String(open));
    setMixerOpen(open);
  };
  const selection = useTimeline((state) => state.selection);
  const snapping = useTimeline((state) => state.snapping);
  const linkedSelection = useTimeline((state) => state.linkedSelection);
  const setSelection = (next: Selection) =>
    useTimeline.setState({ selection: next });
  const timeline = view?.timeline;
  useEffect(() => {
    if (timeline)
      useTimeline.setState(({ selection: current }) => ({
        selection: pruneSelection(timeline, current),
      }));
  }, [timeline]);
  useEffect(() => {
    const release = (event: KeyboardEvent) => finishHeldEdit(event);
    const blur = () => finishHeldEdit();
    window.addEventListener("keyup", release, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keyup", release, true);
      window.removeEventListener("blur", blur);
      finishHeldEdit();
    };
  }, [projectId, composition]);

  // The selection, playhead and timeline are read at the press, and the commands built from them.
  const edits = Object.entries(editKeys).map(
    ([action, { label, commands }]) => [
      action,
      (_binding: number, heldKey?: HeldKey) => {
        revealTimeline();
        // The store's selection, not this render's: a click just before the key has not rendered.
        const {
          selection: { ids, transition, gap, editPoint },
          linkedSelection: linked,
          trimKeys,
        } = useTimeline.getState();
        const target = {
          selection: ids,
          transition,
          gap,
          editPoint,
          linked,
          ...(tool === "trim" && { trim: trimKeys }),
          frame: clock.frame(),
        };
        let parked: number | null = null;
        let saved = () => {};
        void editTimeline(
          projectId,
          label,
          (current) => commands(current, target),
          undefined,
          (next, built) => {
            const frame = editedPlayhead(next, built);
            if (frame === null) return;
            saved = transport.follow(frame);
            // A trim at the end shortens the timeline, and the transport parks on its last frame.
            parked = Math.min(frame, next.duration - 1);
          },
          undefined,
          heldKey,
        ).then((accepted) => {
          saved();
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
  /** Adds a title at the playhead and hands its placeholder words to the inspector's Text field. */
  const addTitle = () => {
    revealTimeline();
    const at = clock.frame();
    void editTimeline(
      projectId,
      "Add title",
      (current) =>
        addTitleCommands(
          current,
          destinationTracks(
            current.tracks,
            useViewSettings.getState().destinations,
          ).video,
          at,
        ),
      undefined,
      (_, commands) => {
        const id = commands.find((command) => command.type === "insert")?.clip
          .id;
        if (id === undefined) return;
        useTimeline.setState({ selection: { ids: new Set([id]), anchor: id } });
        useWorkspace.setState({ inspector: true });
        useTextEdit.setState({ clipId: id });
      },
    );
  };
  const addAdjustment = (track?: Track) => {
    const at = clock.frame();
    void editTimeline(
      projectId,
      "Add adjustment layer",
      (current) =>
        addLayerCommands(
          current,
          track?.kind === "video"
            ? track
            : destinationTracks(
                current.tracks,
                useViewSettings.getState().destinations,
              ).video,
          at,
        ),
      undefined,
      (_, commands) => {
        const id = commands.find((command) => command.type === "insert")?.clip
          .id;
        if (id === undefined) return;
        useTimeline.setState({ selection: { ids: new Set([id]), anchor: id } });
        useWorkspace.setState({ inspector: true });
      },
    );
  };
  /** Adds transitions and reports any cuts that kept their old transition or ran out of media. */
  const transitionKey = (scope: Parameters<typeof addTransition>[2]) => () => {
    revealTimeline();
    const target = {
      selection: useTimeline.getState().selection.ids,
      frame: clock.frame(),
    };
    let note: string | null = null;
    let noChanges = false;
    void editTimeline(projectId, "Add transition", (current) => {
      const added = addTransition(current, target, scope);
      note = added.note;
      noChanges = added.commands.length === 0;
      return added.commands;
    }).then((accepted) => {
      if ((accepted || noChanges) && note)
        showToast(note, null, { tone: "info", transient: true });
    });
  };
  const clipboard = (action: Parameters<typeof clipboardEdit>[1]) => {
    if (action !== "copy") revealTimeline();
    clipboardEdit(projectId, action, clock.frame());
  };
  const chooseDestination = ({
    kind,
    index,
  }: Pick<Track, "kind" | "index">) => {
    const settings = useViewSettings.getState();
    const tracks = useTimeline.getState().view?.timeline.tracks;
    if (!tracks) return;
    const current = destinationTracks(tracks, settings.destinations);
    const enabled = kind === "video" ? "videoEnabled" : "audioEnabled";
    saveViewSettings({
      ...settings,
      destinations: {
        ...settings.destinations,
        [kind]: index,
        [enabled]: current[kind].index !== index || !current[enabled],
      },
    });
  };
  const toggleDestinations = (kinds: readonly Track["kind"][]) => {
    const settings = useViewSettings.getState();
    const destinations = { ...settings.destinations };
    const enabled = !kinds.some(
      (kind) => destinations[`${kind}Enabled`] !== false,
    );
    for (const kind of kinds) destinations[`${kind}Enabled`] = enabled;
    saveViewSettings({ ...settings, destinations });
  };
  /** Picks a destination by its place among the tracks of its kind, counted from V1 or A1. */
  const destinationKey = (
    kind: Track["kind"],
    place: (current: number) => number,
  ) => {
    const tracks = useTimeline.getState().view?.timeline.tracks;
    if (!tracks) return;
    const current = destinationTracks(
      tracks,
      useViewSettings.getState().destinations,
    )[kind];
    const ofKind = shownTracks(tracks).filter((track) => track.kind === kind);
    const ordinal = place(
      ofKind.findIndex(({ index }) => index === current.index),
    );
    const track = ofKind[ordinal];
    if (track) chooseDestination(track);
    else if (ordinal >= 0)
      showToast(`No ${kind === "video" ? "V" : "A"}${ordinal + 1} yet`, null, {
        tone: "info",
        transient: true,
      });
  };
  useKeymap({
    editTrackDestinationSelectionTargetV: (key) =>
      destinationKey("video", () => key),
    editTrackDestinationSelectionTargetA: (key) =>
      destinationKey("audio", () => key),
    editTrackDestinationSelectionTargetVideoAll: () =>
      toggleDestinations(["video"]),
    editTrackDestinationSelectionTargetAudioAll: () =>
      toggleDestinations(["audio"]),
    timelineTrackDestinationSelectionTargetAudioVideoAll: () =>
      toggleDestinations(["video", "audio"]),
    // Up is the header above: a higher video track, a lower audio track.
    editVideoMoveTrackDestinationUp: () =>
      destinationKey("video", (current) => current + 1),
    editVideoMoveTrackDestinationDown: () =>
      destinationKey("video", (current) => current - 1),
    editAudioMoveTrackDestinationUp: () =>
      destinationKey("audio", (current) => current - 1),
    editAudioMoveTrackDestinationDown: () =>
      destinationKey("audio", (current) => current + 1),
    cutroomAddTitle: addTitle,
    editAddTransition: transitionKey("both"),
    editAddVideoTransition: transitionKey("video"),
    editAddAudioTransition: transitionKey("audio"),
    editCopy: () => clipboard("copy"),
    editPasteAttributes: () => clipboard("attributes"),
    editCut: () => clipboard("cut"),
    editPaste: () => clipboard("overwrite"),
    editPasteInsert: () => clipboard("insert"),
    ...(Object.fromEntries(edits) as Partial<Record<Action, () => void>>),
    editSelectEditPoint: () => {
      const current = useTimeline.getState().view?.timeline;
      const editPoint =
        current &&
        nearestEditPoint(
          current,
          clock.frame(),
          useViewSettings.getState().destinations,
        );
      if (editPoint) {
        revealTimeline();
        setSelection({ ...emptySelection, editPoint });
      } else
        showToast("No edit point on an unlocked destination track.", null, {
          tone: "info",
          transient: true,
        });
    },
    editToggleEditPointType: () => {
      const { selection, view } = useTimeline.getState();
      const { editPoint } = selection;
      if (!editPoint)
        return void showToast("Press V to select an edit point.", null, {
          tone: "info",
          transient: true,
        });
      const cut = view && clipsAtEditPoint(view.timeline, editPoint);
      if (!cut?.from || !cut.to) return;
      const mode =
        editPoint.mode === "roll"
          ? "end"
          : editPoint.mode === "end"
            ? "start"
            : "roll";
      setSelection({ ...selection, editPoint: { ...editPoint, mode } });
    },
    editLinkedSelection: () => {
      const linkedSelection = !useTimeline.getState().linkedSelection;
      useTimeline.setState({ linkedSelection });
      showToast(`Linked selection ${linkedSelection ? "on" : "off"}.`, null, {
        tone: "info",
        transient: true,
      });
    },
    editSelectAll: () => {
      if (timeline) setSelection(selectAll(timeline));
    },
    editSelectItemAtPlayhead: () => {
      if (timeline) setSelection(selectionAtPlayhead(timeline, clock.frame()));
    },
    editSelectClipsSelectTrackAfter: () => {
      if (timeline)
        setSelection(selectionFromPlayhead(timeline, clock.frame(), "forward"));
    },
    editSelectClipsSelectAllAfter: () => {
      if (timeline)
        setSelection(
          selectionFromPlayhead(timeline, clock.frame(), "forward", true),
        );
    },
    editSelectClipsSelectTrackBefore: () => {
      if (timeline)
        setSelection(
          selectionFromPlayhead(timeline, clock.frame(), "backward"),
        );
    },
    editSelectClipsSelectAllBefore: () => {
      if (timeline)
        setSelection(
          selectionFromPlayhead(timeline, clock.frame(), "backward", true),
        );
    },
    editDeselectAll: (key) => {
      // Esc with nothing selected steps out of a sub-composition, as in Studio.
      const { ids, transition, gap, editPoint } =
        useTimeline.getState().selection;
      if (
        keymap.editDeselectAll.keys[key] === "Esc" &&
        !ids.size &&
        !transition &&
        !gap &&
        !editPoint &&
        leaveComposition(projectId)
      )
        return;
      setSelection(emptySelection);
    },
    cutroomOpenComposition: () => {
      const { selection, view } = useTimeline.getState();
      const [id, ...others] = selection.ids;
      const clip = view?.timeline.clips.find((item) => item.id === id);
      if (!clip || others.length || !openHost(projectId, clip))
        showToast("Select one composition clip to open it.", null, {
          tone: "info",
          transient: true,
        });
    },
    trimToggleSlideMode: () => {
      const trimKeys =
        useTimeline.getState().trimKeys === "slip" ? "slide" : "slip";
      useTimeline.setState({ trimKeys });
      showToast(`Comma and period now ${trimKeys} clips with Trim.`, null, {
        tone: "info",
        transient: true,
      });
    },
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

  // The menu key and Shift+F10 open the clip menu for the selection, by its first clip. A focused
  // control with a menu of its own, such as a track header, has taken the event already.
  useEffect(() => {
    const menuKey = (event: MouseEvent) => {
      // With nothing focused the browser aims the event at the window's corner, so focus decides.
      const focused = document.activeElement;
      if (
        event.button >= 0 ||
        event.defaultPrevented ||
        isTyping(focused) ||
        (focused && focused !== document.body && !focused.closest(".edit-page"))
      )
        return;
      const [id] = useTimeline.getState().selection.ids;
      if (id === undefined) return;
      // A selected clip scrolled out of the mounted range leaves the lanes to hang the menu from.
      const anchor =
        document.querySelector(`.tl-lanes [data-clip="${CSS.escape(id)}"]`) ??
        document.querySelector(".tl-lanes");
      if (anchor) openClipMenu(event, projectId, anchor);
    };
    window.addEventListener("contextmenu", menuKey);
    return () => window.removeEventListener("contextmenu", menuKey);
  }, [projectId]);

  if (!view) return null;
  const destinations = destinationTracks(
    view.timeline.tracks,
    viewSettings.destinations,
  );
  const addTrack = (kind: Track["kind"]) =>
    void editTimeline(projectId, `Add ${kind} track`, (timeline) => [
      { type: "setTrack", index: nextTrackIndex(timeline.tracks), kind },
    ]);
  const setTrackGain: TimelineProps["onTrackGain"] = (track, volume) => {
    const excluded = view.timeline.clips.filter(
      (clip) => clip.track === track.index && clip.trackGainWarning,
    );
    if (excluded.length)
      showToast(
        `Track gain does not apply to ${excluded.map(clipName).join(", ")}: authored audio group membership is preserved.`,
      );
    void editTimeline(projectId, "Track gain", () => [
      { type: "setTrack", index: track.index, kind: track.kind, volume },
    ]);
  };
  /** A header's switches, the track density, and adding or removing a track. */
  const trackMenu = (row: Row | null): MenuItem[] => {
    const track = row?.track;
    const toggle = (
      label: string,
      setting: Parameters<typeof toggleTrack>[1],
    ): MenuItem[] =>
      track
        ? [
            {
              label,
              checked: track[setting],
              run: () => toggleTrack(track, setting),
            },
          ]
        : [];
    const { state } = voiceover.store.getState();
    const armed = state.kind !== "idle" && state.track.index === track?.index;
    return [
      ...toggle("Lock", "locked"),
      ...toggle("Auto-select", "autoSelect"),
      ...(track?.kind === "video" ? toggle("Enable", "enabled") : []),
      ...(track?.kind === "audio"
        ? [
            ...toggle("Mute", "muted"),
            ...toggle("Solo", "solo"),
            {
              label: "Arm",
              checked: armed,
              // As the header's R button: a take in progress holds the microphone where it is.
              disabled:
                (!armed && track.locked) ||
                (state.kind !== "idle" && state.kind !== "armed"),
              run: () => voiceover.toggleArm(track),
            },
            { label: "Set gain...", run: () => setGainTrack(track) },
            { label: "Effects...", run: () => setFxTrack(track.index) },
            {
              // A compact header has no room for the level, so the menu names it.
              label:
                track.volume === 1
                  ? "Reset gain"
                  : `Reset gain (${audioGainToText(track.volume)})`,
              disabled: track.volume === 1,
              run: () => setTrackGain(track, 1),
            },
          ]
        : []),
      ...(track ? ["separator" as const] : []),
      ...trackDensities.map((density): MenuItem => ({
        label: density[0]!.toUpperCase() + density.slice(1),
        radio: true,
        checked:
          viewSettings.density === density &&
          !Object.keys(viewSettings.heights).length,
        run: () => saveViewSettings({ ...viewSettings, density, heights: {} }),
      })),
      "separator",
      { action: "cutroomAddTitle" },
      { label: "Add adjustment layer", run: () => addAdjustment(track) },
      { label: "Add video track", run: () => addTrack("video") },
      { label: "Add audio track", run: () => addTrack("audio") },
      // A row the timeline does not hold yet has nothing to remove.
      ...(track &&
      view.timeline.tracks.some((item) => item.index === track.index)
        ? [
            {
              label: "Remove empty track",
              disabled:
                track.locked ||
                view.timeline.clips.some(
                  (clip) => clip.track === track.index,
                ) ||
                recording?.track.index === track.index,
              run: () =>
                void editTimeline(projectId, "Remove empty track", () => [
                  { type: "removeTrack", index: track.index },
                ]),
            },
          ]
        : []),
    ];
  };
  return (
    <>
      {gainTrack && (
        <TrackGainDialog
          track={gainTrack}
          onCommit={(volume) => setTrackGain(gainTrack, volume)}
          onClose={() => setGainTrack(null)}
        />
      )}
      {openFx && (
        <Modal
          title={`${openFx.name ?? "Track"} effects`}
          onClose={() => setFxTrack(null)}
        >
          <div className="clip-inspector">
            <FxRack
              fx={openFx.fx}
              onChange={(label, fx) =>
                void editTimeline(projectId, label, () => [
                  {
                    type: "setTrack",
                    index: openFx.index,
                    kind: openFx.kind,
                    fx,
                  },
                ])
              }
            />
          </div>
        </Modal>
      )}
      <Timeline
        onMixer={() => showMixer(true)}
        mixer={
          mixerOpen ? (
            <Mixer
              key={`${projectId}:${view.composition}`}
              projectId={projectId}
              composition={view.composition}
              timeline={view.timeline}
              rows={
                trackRows(view.timeline.tracks, {
                  video: 0,
                  audio: 0,
                  seam: 0,
                  divider: 0,
                }).rows
              }
              onTrackMenu={(event, anchor, row) =>
                openContextMenu(
                  event,
                  `Track ${row.id}`,
                  trackMenu(row),
                  anchor,
                )
              }
              onToggleTrack={toggleTrack}
              onTrackGain={setTrackGain}
              onClose={() => showMixer(false)}
            />
          ) : undefined
        }
        onTrackFx={(track) => setFxTrack(track.index)}
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
        viewSettings={viewSettings}
        onViewSettings={saveViewSettings}
        destinations={{
          video: destinations.videoEnabled ? destinations.video.index : null,
          audio: destinations.audioEnabled ? destinations.audio.index : null,
        }}
        onDestination={chooseDestination}
        timeline={view.timeline}
        source={{ projectId, composition: view.composition }}
        clock={clock}
        pins={pins}
        agentChanges={new Set(view.agentChanges)}
        selection={selection}
        onSelect={setSelection}
        tool={tool}
        snapping={snapping}
        linkedSelection={linkedSelection}
        onEdit={(label, commands, basis, match) => {
          // The editor shows an edit it takes before this returns.
          const before = useTimeline.getState().view;
          const offer =
            match &&
            before?.composition === "index.html" &&
            before.timeline.clips.length === 0;
          void editTimeline(
            projectId,
            label,
            () => commands,
            basis,
            undefined,
            offer
              ? (saved) => offerMediaFormat(projectId, saved, match)
              : undefined,
          );
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
        onTrackGain={setTrackGain}
        onTrackMenu={(event, anchor, row) =>
          openContextMenu(
            event,
            row ? `Track ${row.id}` : "Tracks",
            trackMenu(row),
            anchor,
          )
        }
        onClipMenu={(event, anchor, clip) => {
          // A drag under way keeps the pointer; a second button does not interrupt it.
          if (useWorkspace.getState().gesture) {
            event.preventDefault();
            return;
          }
          // A right-click selects as a click does, and the menu acts on the selection.
          const current = useTimeline.getState().selection;
          if (!clip) setSelection(emptySelection);
          else if (!current.ids.has(clip.id))
            setSelection(
              clickSelection(
                view.timeline,
                [],
                current,
                clip.id,
                {
                  toggle: false,
                  range: false,
                  alone: false,
                },
                linkedSelection,
              ),
            );
          openClipMenu(event, projectId, anchor, clip ?? undefined);
        }}
        onOpenPin={onOpenNote}
        onOpenMarker={(marker, anchor) => setEditingMarker({ marker, anchor })}
        onOpenClip={(clip) => openHost(projectId, clip)}
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
