import { toggleSpeedLines } from "../timeline/ClipSpeed";
import { isAudioKind } from "../../shared/timeline/schema";
import { watchMattes } from "./mattes";
import { useContext, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  Code,
  FrameCorners,
  GridNine,
  Magnet,
  LinkSimple,
  Waveform,
} from "@phosphor-icons/react";
import { z } from "zod";
import type { EditorContext } from "../../shared/editor";
import type { ReviewItem } from "../../shared/review";
import { clipEnd, frameTime, toFrames } from "../../shared/timeline/apply";
import type { Timeline } from "../../shared/timeline/schema";
import { EditorToolsContext } from "./editorTools";
import {
  actionFor,
  blurPointerButton,
  clearBrowserSelection,
  focusPanel,
  hint,
  isTyping,
  missingNotice,
  runAction,
  useKeymap,
} from "../keymap";
import type { Action } from "../keymap";
import { ProjectTimeline } from "../timeline/ProjectTimeline";
import { selectedSpan } from "../timeline/selection";
import { subscribeProjectEvents } from "../api";
import {
  NO_COMPOSITION_ROOT,
  reportEditorError,
  showToast,
  useWorkspace,
} from "../workspace";
import { useGradeBypass } from "./preview";
import "./edit.css";
import {
  Inspector,
  InspectorToggle,
  useTimingEdit,
} from "./inspector/Inspector";
import { matchFrame } from "./keys";
import { keyAt, keyframeFrames, removeAt } from "./keyframeKeys";
import { inspectorSubject } from "./inspector/fields";
import { editorContext, publishSelection } from "./agentContext";
import { ExportControl } from "./ExportDialog";
import { SelectMenu } from "../components/SelectMenu";
import {
  receiveAnimationFeedback,
  editTimeline,
  clearRefusal,
  finishHeldEdit,
  hasPendingTimelineSaves,
  loadTimeline,
  openTimeline,
  refreshTimeline,
  stepHistory,
  useTimeline,
} from "./timeline";
import { DiscardRecording, useVoiceover } from "../voiceover/Voiceover";
import {
  closeSource,
  markSource,
  openSource,
  placeSource,
  showSource,
  sourcePlayer,
  useSource,
} from "./source";
import { SourceViewer } from "./SourceViewer";
import { CompositionPath } from "./CompositionPath";
import { lastTimeline, newTimeline } from "./compositions";
import { ToolButtons } from "./ToolButtons";
import { createJog, jogKeyOf } from "./jog";
import { CodePanel } from "./code/CodePanel";
import { codeCanLeave, openFile, useCode } from "./code/code";
import { TransportBar } from "./TransportBar";
import { transport, useTransport } from "./transport";
import { startScrubAudio } from "../scrubAudio/engine";
import type { SaveNote } from "./NoteLayer";
import { Viewer } from "./Viewer";
import { useFollowVariables } from "./variables";
import type { Zoom } from "./Viewer";

/** A file change from the preview server's watcher, which owns preview invalidation. */
const previewChangeSchema = z.object({
  projectId: z.string(),
  path: z.string(),
  affectsPreview: z.boolean(),
  affectedCompositions: z.array(z.string()).nullable(),
});
const projectFileEventSchema = z.object({
  timelineSaveEcho: z.literal(true).optional(),
});

const report = (error: unknown) => reportEditorError("timeline", error);
const notice = (text: string) =>
  showToast(text, null, { tone: "info", transient: true });

/** Clip boundaries on tracks that take part in edits, for Up and Down. */
function edits({ clips, tracks }: Timeline) {
  const skipped = new Set(
    tracks.filter((track) => !track.autoSelect).map((track) => track.index),
  );
  return [
    ...new Set(
      clips
        .filter((clip) => !skipped.has(clip.track))
        .flatMap((clip) => [clip.start, clipEnd(clip)]),
    ),
  ].sort((a, b) => a - b);
}

/** Cutroom's own editor: tool row, viewer, transport, and the timeline below a split. */
export function EditPage({
  projectId,
  projectName,
  notes,
  onContext,
  onSaveNote,
  onOpenNote,
  projectPath,
}: {
  projectId: string;
  projectName: string;
  /** Review notes, shown as pins on the picture and the timeline ruler. */
  notes: readonly ReviewItem[];
  onContext?: (context: EditorContext) => void;
  onSaveNote: SaveNote;
  onOpenNote(id: string): void;
  /** The project folder, for copying a file's full path. */
  projectPath: string;
}) {
  const voiceover = useVoiceover(projectId);
  const codeOpen = useWorkspace((state) => state.code);
  const safeZones = useWorkspace((state) => state.safeZones);
  const audioScrubbing = useWorkspace((state) => state.audioScrubbing);
  const grid = useWorkspace((state) => state.grid);
  // Leaving the project keeps neither a voiceover take nor code edits unsaved.
  useEffect(() => {
    useWorkspace.setState({
      beforeProjectChange: () => voiceover.canLeave() && codeCanLeave(),
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      finishHeldEdit();
      if (!useCode.getState().edited && !hasPendingTimelineSaves()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const hide = () => finishHeldEdit();
    const visibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visibility);
      useWorkspace.setState({ beforeProjectChange: null });
    };
  }, [voiceover]);
  const editorTools = useContext(EditorToolsContext);
  const mode = editorTools?.mode ?? "select";
  const setMode = (next: typeof mode) => {
    // Notes go on the timeline's picture.
    if (next === "draw" || next === "comment" || next === "region")
      showSource(false);
    editorTools?.setMode(next);
  };
  const page = useRef<HTMLDivElement>(null);
  const viewer = useRef<HTMLElement>(null);
  const timelinePanel = useRef<HTMLElement>(null);
  const [previewChange, setPreviewChange] = useState({
    revision: 0,
    path: "",
  });
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [fullscreen, setFullscreen] = useState(false);
  const history = useTimeline((state) => state.history);
  const composition = useTimeline((state) => state.composition);
  /** The timeline to open is known, so the viewer loads only that one. */
  const opened = useTimeline((state) => state.projectId === projectId);
  const missingRoot = useWorkspace(
    (state) => state.editorErrors.timeline === NO_COMPOSITION_ROOT,
  );
  useFollowVariables(projectId, opened ? composition : null);
  const snapping = useTimeline((state) => state.snapping);
  const linkedSelection = useTimeline((state) => state.linkedSelection);
  const source = useSource((state) => state.file !== null);
  const sourceShown = useSource((state) => state.shown);
  /** The transport keys and bar drive what the viewer shows. */
  const player = sourceShown ? sourcePlayer : transport;
  const shownPlayer = useRef(player);
  shownPlayer.current = player;
  const [jog] = useState(() => createJog(() => shownPlayer.current));
  useEffect(() => {
    // J, K and L drive playback while held, so their releases count wherever focus is.
    const press = (event: KeyboardEvent) => {
      const key = jogKeyOf(event);
      if (key) jog.keyDown(key);
    };
    const release = (event: KeyboardEvent) => {
      const key = jogKeyOf(event);
      if (key) jog.release(key);
    };
    const reset = () => jog.reset();
    window.addEventListener("keydown", press, true);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", press, true);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", reset);
      jog.reset();
    };
  }, [jog]);

  useEffect(() => {
    const closing = new AbortController();
    transport.seek(0);
    const unsubscribe = useTimeline.subscribe(({ view }) => {
      if (view) transport.setTimeline(view.timeline);
    });
    const fail = (error: unknown) => {
      if (!closing.signal.aborted) report(error);
    };
    // The project opens on the timeline last shown, and reads only that one.
    void lastTimeline(projectId, closing.signal).then((composition) => {
      if (closing.signal.aborted) return;
      openTimeline(projectId, closing.signal, composition);
      return loadTimeline(projectId, closing.signal);
    });
    watchMattes(projectId, closing.signal);
    // Any project change can move the timeline or the undo history.
    const stopProject = subscribeProjectEvents(
      projectId,
      "message",
      (event) => {
        const changed = projectFileEventSchema.safeParse(
          JSON.parse(event.data),
        );
        if (!changed.success || !changed.data.timelineSaveEcho)
          void refreshTimeline(projectId, closing.signal);
      },
    );
    // The preview server's own invalidation decides what reloads the picture: HTML, CSS, scripts, media.
    const stopAnimationFeedback = subscribeProjectEvents(
      projectId,
      "animation-left-behind",
      (event) => {
        try {
          receiveAnimationFeedback(
            projectId,
            JSON.parse(event.data),
            closing.signal,
          );
        } catch (error) {
          fail(error);
        }
      },
    );
    const stopPreview = subscribeProjectEvents(
      projectId,
      "file-change",
      (event) => {
        const change = previewChangeSchema.safeParse(
          JSON.parse(String(event.data)),
        );
        if (
          change.success &&
          change.data.projectId === projectId &&
          change.data.affectsPreview &&
          (change.data.affectedCompositions?.includes(
            useTimeline.getState().composition,
          ) ??
            true)
        )
          setPreviewChange((value) => ({
            revision: value.revision + 1,
            path: change.data.path,
          }));
      },
    );
    return () => {
      closing.abort();
      closeSource();
      reportEditorError("timeline", null);
      stopProject();
      stopPreview();
      stopAnimationFeedback();
      unsubscribe();
    };
  }, [projectId]);

  const contextReport = useRef(onContext);
  contextReport.current = onContext;
  useEffect(() => {
    const send = () => contextReport.current?.(editorContext());
    send();
    const transportChanged = useTransport.subscribe(send);
    const timelineChanged = useTimeline.subscribe(send);
    return () => {
      transportChanged();
      timelineChanged();
    };
  }, []);
  useEffect(() => publishSelection(projectId), [projectId]);
  useEffect(() => startScrubAudio(), []);

  useEffect(() => {
    const change = () =>
      setFullscreen(document.fullscreenElement === viewer.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  useEffect(() => {
    const closeDrawer = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        isTyping(event.target) ||
        !useWorkspace.getState().inspector
      )
        return;
      const width = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--breakpoint-drawer",
        ),
      );
      if (!matchMedia(`(width < ${width}px)`).matches) return;
      event.preventDefault();
      useWorkspace.setState({ inspector: false });
      page.current
        ?.querySelector<HTMLButtonElement>(
          '.edit-tools [aria-label="Inspector"]',
        )
        ?.focus();
    };
    // Fields cancel first; consume Escape before the window's selection shortcuts.
    document.addEventListener("keydown", closeDrawer);
    return () => document.removeEventListener("keydown", closeDrawer);
  }, []);
  useEffect(() => {
    // Before the action runs, so a press that is refused again shows its own reason.
    const press = (event: KeyboardEvent) => {
      if (actionFor(event)) clearRefusal(event);
    };
    const node = page.current;
    window.addEventListener("keydown", press, true);
    node?.addEventListener("pointerdown", clearRefusal, true);
    return () => {
      window.removeEventListener("keydown", press, true);
      node?.removeEventListener("pointerdown", clearRefusal, true);
    };
  }, []);
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      const text = missingNotice(event);
      if (!text) return;
      event.preventDefault();
      notice(text);
    };
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void viewer.current
        ?.requestFullscreen()
        .catch((error: unknown) => reportEditorError("viewer", error));
  };

  const step = (direction: "undo" | "redo") => {
    void stepHistory(projectId, direction).catch((error: unknown) =>
      showToast(error instanceof Error ? error.message : String(error)),
    );
  };
  const playing = player.use.getState;
  /** A source keeps its own marks; the timeline's are an edit, so undo takes them back. */
  const mark = (
    label: string,
    range: (frame: number, current: Timeline["range"]) => Timeline["range"],
  ) => {
    const { frame, range: marks } = playing();
    if (sourceShown) return markSource(range(frame, marks));
    void editTimeline(projectId, label, (timeline) => [
      { type: "setRange", ...range(frame, timeline.range) },
    ]);
  };
  /** Where Up and Down stop: the timeline's clip boundaries, or a source's marks. */
  const jump = (to: (stops: number[], frame: number) => number) => {
    const { frame, range } = playing();
    const view = useTimeline.getState().view;
    if (sourceShown)
      player.seek(
        to(
          [range.in, range.out === null ? null : range.out - 1].filter(
            (stop) => stop !== null,
          ),
          frame,
        ),
      );
    else if (view) player.seek(to(edits(view.timeline), frame));
  };
  const second = () => {
    const { fps } = playing();
    return Math.round(fps.num / fps.den);
  };
  const last = () => playing().duration - 1;
  /** Markers belong to the timeline, so their keys show it even while a source is up. */
  const marker = (
    to: (frames: number[], frame: number) => number | undefined,
    none: string,
  ) => {
    const view = useTimeline.getState().view;
    if (!view) return;
    const frames = view.timeline.markers
      .map((marker) => marker.frame)
      .toSorted((a, b) => a - b);
    const frame = to(frames, transport.use.getState().frame);
    if (frame === undefined)
      return void notice(frames.length ? none : "No markers yet.");
    showSource(false);
    transport.seek(frame);
  };
  /** [ and ] step through the selected clips' keyframes, or every clip's when none is selected. */
  const keyframe = (
    to: (frames: number[], frame: number) => number | undefined,
    none: string,
  ) => {
    const { view, selection } = useTimeline.getState();
    if (!view) return;
    const selected = view.timeline.clips.filter((clip) =>
      selection.ids.has(clip.id),
    );
    const frames = keyframeFrames(
      selected.length ? selected : view.timeline.clips,
    );
    const frame = to(frames, transport.use.getState().frame);
    if (frame === undefined)
      return void notice(frames.length ? none : "No keyframes yet.");
    showSource(false);
    transport.seek(frame);
  };
  /** The selected clip and the frame of it under the playhead, for the keys that key it. */
  const keyedClip = () => {
    const { view, selection } = useTimeline.getState();
    const clip = view && inspectorSubject(view.timeline, selection)?.clip;
    if (!clip) return void notice("Select a clip to keyframe it.");
    const frame = transport.use.getState().frame - clip.start;
    if (frame < 0 || frame >= clip.duration)
      return void notice("Move the playhead over the clip to keyframe it.");
    return { clip, frame };
  };
  const addKeyframe = (ease: "linear" | "hold") => {
    const at = keyedClip();
    if (!at) return;
    const commands = keyAt(at.clip, at.frame, ease);
    if (!commands.length) return void notice("Sound has nothing to keyframe.");
    void editTimeline(
      projectId,
      ease === "hold" ? "Add held keyframe" : "Add keyframe",
      () => commands,
    );
  };
  /** Opens the inspector on the selected clip with one of its Timing fields ready to type in. */
  const timingField = (field: "Duration" | "Speed") => {
    useWorkspace.setState({ inspector: true });
    useTimingEdit.setState({ field });
  };

  const handlers: Partial<Record<Action, () => void>> = {
    editPointer: () => setMode("select"),
    editTrim: () => setMode("trim"),
    editBlade: () => setMode("blade"),
    cutroomRegion: () => setMode("region"),
    cutroomDraw: () => setMode("draw"),
    cutroomComment: () => setMode("comment"),
    controlPlayToggle: () => player.dispatch({ type: "toggle" }),
    controlPlayForward: () => jog.press("forward"),
    controlPlayReverse: () => jog.press("reverse"),
    controlFastForward: () =>
      player.dispatch({ type: "shuttle", dir: "forward", fast: true }),
    controlFastReverse: () =>
      player.dispatch({ type: "shuttle", dir: "reverse", fast: true }),
    controlStop: () => jog.press("stop"),
    controlPlayAroundToPlayAroundCurrentSelection: () => {
      const { frame, fps } = playing();
      const view = useTimeline.getState().view;
      const span = (!sourceShown &&
        view &&
        selectedSpan(view.timeline, useTimeline.getState().selection)) || {
        from: frame,
        to: frame,
      };
      // Resolve's default pre-roll and post-roll.
      const roll = toFrames(2, fps);
      player.playAround(span.from - roll, span.to + roll);
    },
    controlStepReverse: () => player.step(-1),
    controlStepForward: () => player.step(1),
    controlLargeStepReverse: () => player.step(-second()),
    controlLargeStepForward: () => player.step(second()),
    controlClipPrev: () =>
      jump((stops, frame) => stops.findLast((stop) => stop < frame) ?? 0),
    controlClipNext: () =>
      jump((stops, frame) => stops.find((stop) => stop > frame) ?? last()),
    controlKeyframePrev: () =>
      keyframe(
        (frames, frame) => frames.findLast((at) => at < frame),
        "No keyframe before the playhead.",
      ),
    controlKeyframeNext: () =>
      keyframe(
        (frames, frame) => frames.find((at) => at > frame),
        "No keyframe after the playhead.",
      ),
    markKeyframeMakeDynamic: () => addKeyframe("linear"),
    markKeyframeMakeStatic: () => addKeyframe("hold"),
    markKeyframeDelete: () => {
      const at = keyedClip();
      if (!at) return;
      const commands = removeAt(at.clip, at.frame);
      if (!commands.length)
        return void notice("No keyframe at the playhead on this clip.");
      void editTimeline(projectId, "Delete keyframe", () => commands);
    },
    controlMarkersPrev: () =>
      marker(
        (frames, frame) => frames.findLast((at) => at < frame),
        "No marker before the playhead.",
      ),
    controlMarkersNext: () =>
      marker(
        (frames, frame) => frames.find((at) => at > frame),
        "No marker after the playhead.",
      ),
    controlTimelineStart: () => player.seek(0),
    controlTimelineEnd: () => player.seek(last()),
    controlFirstFrame: () => player.seek(0),
    controlLastFrame: () => player.seek(last()),
    // Out is exclusive, so O keeps the frame under the playhead. A mark past the other one clears it.
    markIn: () =>
      mark("Mark in", (frame, { out }) => ({
        in: frame,
        out: out !== null && out <= frame ? null : out,
      })),
    markOut: () =>
      mark("Mark out", (frame, range) => ({
        in: range.in !== null && range.in > frame ? null : range.in,
        out: frame + 1,
      })),
    markResetIn: () => mark("Clear in", (_, { out }) => ({ in: null, out })),
    markResetOut: () =>
      mark("Clear out", (_, range) => ({ in: range.in, out: null })),
    markResetInOut: () =>
      mark("Clear in and out", () => ({ in: null, out: null })),
    controlGotoIn: () => {
      const { range } = playing();
      if (range.in !== null) player.seek(range.in);
    },
    controlGotoOut: () => {
      const { range } = playing();
      if (range.out !== null) player.seek(range.out - 1);
    },
    controlLoop: () => player.toggleLoop(),
    editInsertOverwriteActionInsert: () => placeSource(projectId, "insert"),
    editInsertOverwriteActionOverwrite: () =>
      placeSource(projectId, "overwrite"),
    editInsertOverwriteActionReplace: () => placeSource(projectId, "replace"),
    editInsertOverwriteActionPlaceOnTop: () => placeSource(projectId, "top"),
    // The one viewer is either panel: its key shows that side and takes the keyboard there.
    viewActiveWindowSelectionSourceViewer: () => {
      if (!source)
        return void showToast(
          "Open a file from Media to see its source.",
          null,
          {
            tone: "info",
            transient: true,
          },
        );
      showSource(true);
      focusPanel(viewer.current);
    },
    viewActiveWindowSelectionTimelineViewer: () => {
      showSource(false);
      focusPanel(viewer.current);
    },
    viewActiveWindowSelectionTimeline: () => {
      showSource(false);
      focusPanel(timelinePanel.current);
    },
    viewToggleSourceTimeline: () => showSource(!sourceShown),
    editMatchFrame: () => {
      const view = useTimeline.getState().view;
      if (!view) return;
      const match = matchFrame(view.timeline, {
        selection: useTimeline.getState().selection.ids,
        frame: transport.use.getState().frame,
      });
      if (!match)
        return void notice(
          "Match frame needs a video or audio clip under the playhead.",
        );
      openSource(match.file, match.frame);
    },
    clipChangeClipDuration: () => timingField("Duration"),
    clipChangeClipSpeed: () => timingField("Speed"),
    clipRetimeControls: () => {
      const { view, selection } = useTimeline.getState();
      if (!view) return;
      toggleSpeedLines(
        view.timeline.clips
          .filter(
            (clip) =>
              selection.ids.has(clip.id) &&
              clip.mediaStart !== null &&
              !isAudioKind(clip.kind),
          )
          .map((clip) => clip.id),
      );
    },
    fileNewTimeline: () => newTimeline(projectId),
    editUndo: () => step("undo"),
    editRedo: () => step("redo"),
    workspaceViewerModeCinemaViewer: toggleFullscreen,
    cutroomToggleCode: () => useWorkspace.setState({ code: !codeOpen }),
    viewSafeAreaToggle: () => useWorkspace.setState({ safeZones: !safeZones }),
    editScrubAudio: () =>
      useWorkspace.setState({ audioScrubbing: !audioScrubbing }),
    cutroomToggleGrid: () => useWorkspace.setState({ grid: !grid }),
    viewBypassColorGrades: () => {
      const bypass = !useGradeBypass.getState().bypass;
      useGradeBypass.setState({ bypass });
      notice(bypass ? "Grades bypassed" : "Grades on");
    },
  };
  useKeymap(handlers);

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    const element = page.current;
    if (!element || !event.currentTarget.hasPointerCapture(event.pointerId))
      return;
    const bounds = element.getBoundingClientRect();
    const height = Math.max(
      0,
      Math.min(bounds.bottom - event.clientY - 2, bounds.height - 200),
    );
    element.style.setProperty("--edit-timeline-height", `${height}px`);
  };

  return (
    <div ref={page} className="edit-page">
      <div
        className="edit-tools"
        role="toolbar"
        aria-label="Tools"
        onClick={blurPointerButton}
      >
        <ToolButtons mode={mode} onMode={setMode} />
        {source && (
          <>
            <span className="edit-separator" />
            <div className="edit-views" role="group" aria-label="Viewer">
              {(["Source", "Timeline"] as const).map((view) => (
                <button
                  key={view}
                  className="edit-tool"
                  aria-pressed={sourceShown === (view === "Source")}
                  title={hint("viewToggleSourceTimeline")}
                  onClick={() => showSource(view === "Source")}
                >
                  {view}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="edit-grow" />
        <button
          className="edit-icon"
          aria-label="Snapping"
          aria-pressed={snapping}
          title={hint("editSnapping")}
          onClick={() => useTimeline.setState({ snapping: !snapping })}
        >
          <Magnet size={16} weight={snapping ? "fill" : "regular"} />
        </button>
        <button
          className="edit-icon"
          aria-label="Linked selection"
          aria-pressed={linkedSelection}
          title={hint("editLinkedSelection")}
          onClick={() => runAction("editLinkedSelection")}
        >
          <LinkSimple size={16} weight={linkedSelection ? "fill" : "regular"} />
        </button>
        <button
          className="edit-icon"
          aria-label="Audio scrubbing"
          aria-pressed={audioScrubbing}
          title={hint("editScrubAudio")}
          onClick={() =>
            useWorkspace.setState({ audioScrubbing: !audioScrubbing })
          }
        >
          <Waveform size={16} weight={audioScrubbing ? "fill" : "regular"} />
        </button>
        <button
          className="edit-icon"
          aria-label="Safe zones"
          aria-pressed={safeZones}
          title={hint("viewSafeAreaToggle")}
          onClick={() => useWorkspace.setState({ safeZones: !safeZones })}
        >
          <FrameCorners size={16} weight={safeZones ? "fill" : "regular"} />
        </button>
        <button
          className="edit-icon"
          aria-label="Grid"
          aria-pressed={grid}
          title={hint("cutroomToggleGrid")}
          onClick={() => useWorkspace.setState({ grid: !grid })}
        >
          <GridNine size={16} weight={grid ? "fill" : "regular"} />
        </button>
        <SelectMenu<Zoom>
          className="edit-zoom"
          label="Viewer zoom"
          title="Viewer zoom"
          value={zoom}
          options={[
            { value: "fit", label: "Fit" },
            { value: "actual", label: "100%" },
          ]}
          onChange={setZoom}
        />
        <button
          className="edit-icon"
          aria-label="Code"
          aria-controls="code-panel"
          aria-pressed={codeOpen}
          title={hint("cutroomToggleCode")}
          onClick={() => useWorkspace.setState({ code: !codeOpen })}
        >
          <Code size={16} />
        </button>
        <span className="edit-separator" />
        <button
          className="edit-icon"
          aria-label="Undo"
          aria-description={history.nextUndo?.label}
          title={hint(
            "editUndo",
            history.nextUndo ? `Undo ${history.nextUndo.label}` : undefined,
          )}
          disabled={!history.canUndo}
          onClick={() => step("undo")}
        >
          <ArrowCounterClockwise size={16} />
        </button>
        <button
          className="edit-icon"
          aria-label="Redo"
          aria-description={history.nextRedo?.label}
          title={hint(
            "editRedo",
            history.nextRedo ? `Redo ${history.nextRedo.label}` : undefined,
          )}
          disabled={!history.canRedo}
          onClick={() => step("redo")}
        >
          <ArrowClockwise size={16} />
        </button>
        {history.historyUnavailable && (
          <span
            className="edit-history-unavailable"
            role="status"
            title={history.historyUnavailable}
          >
            Undo is unavailable
          </span>
        )}
        <span className="edit-separator" />
        <InspectorToggle />
        <ExportControl projectId={projectId} projectName={projectName} />
      </div>
      <CodePanel projectId={projectId} projectPath={projectPath} />
      <section
        ref={viewer}
        className="edit-viewer"
        aria-label="Viewer"
        onPointerDownCapture={clearBrowserSelection}
      >
        {opened && (
          <Viewer
            key={projectId}
            projectId={projectId}
            composition={composition}
            change={previewChange}
            zoom={zoom}
            mode={mode}
            notes={notes}
            onOpenNote={onOpenNote}
            onSaveNote={onSaveNote}
          />
        )}
        <SourceViewer projectId={projectId} />
        <TransportBar
          key={sourceShown ? "source" : "timeline"}
          player={player}
          fullscreen={fullscreen}
          onFullscreen={toggleFullscreen}
          voiceover={sourceShown ? undefined : voiceover}
        />
      </section>
      <Inspector projectId={projectId} projectName={projectName} />
      <div
        className="edit-split"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline"
        title="Resize timeline"
        onPointerDown={(event) =>
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        onPointerMove={resize}
      />
      <section
        ref={timelinePanel}
        className="edit-timeline"
        aria-label="Timeline"
        onPointerDownCapture={clearBrowserSelection}
      >
        <CompositionPath projectId={projectId} projectName={projectName} />
        {missingRoot ? (
          <div className="edit-timeline-problem">
            <p role="alert">
              {composition} has no composition to edit. Add{" "}
              <code>data-composition-id</code> to its root element
              {history.canUndo ? ", or undo the last change." : "."}
            </p>
            <div>
              {history.canUndo && (
                <button
                  className="secondary-button"
                  onClick={() => step("undo")}
                >
                  Undo
                </button>
              )}
              <button
                className="secondary-button"
                onClick={() => {
                  useWorkspace.setState({ code: true });
                  void openFile(composition);
                }}
              >
                Open source
              </button>
            </div>
          </div>
        ) : (
          <ProjectTimeline
            voiceover={voiceover}
            projectId={projectId}
            tool={mode === "trim" || mode === "blade" ? mode : "pointer"}
            notes={notes}
            onOpenNote={onOpenNote}
          />
        )}
      </section>
      <DiscardRecording session={voiceover} />
    </div>
  );
}
