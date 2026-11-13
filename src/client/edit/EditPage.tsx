import { useContext, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ChatCircle,
  Cursor,
  Folder,
  Knife,
  Magnet,
  PencilSimple,
  SplitHorizontal,
} from "@phosphor-icons/react";
import { z } from "zod";
import type { EditorContext } from "../../shared/editor";
import type { ReviewItem } from "../../shared/review";
import { clipEnd, frameTime } from "../../shared/timeline/apply";
import type { Timeline } from "../../shared/timeline/schema";
import { EditorToolsContext } from "../editor/EditorTools";
import {
  blurPointerButton,
  clearBrowserSelection,
  focusPanel,
  hint,
  isTyping,
  keymap,
  useKeymap,
} from "../keymap";
import type { Action } from "../keymap";
import { ProjectTimeline } from "../timeline/ProjectTimeline";
import { subscribeProjectEvents } from "../api";
import { reportEditorError, showToast, useWorkspace } from "../workspace";
import "./edit.css";
import { Inspector, InspectorToggle } from "./inspector/Inspector";
import { ExportControl } from "./ExportDialog";
import { SelectMenu } from "../components/SelectMenu";
import {
  receiveAnimationFeedback,
  editTimeline,
  loadTimeline,
  openTimeline,
  stepHistory,
  useTimeline,
} from "./timeline";
import { useVoiceover } from "../voiceover/Voiceover";
import {
  closeSource,
  markSource,
  placeSource,
  showSource,
  sourcePlayer,
  useSource,
} from "./source";
import { SourceViewer } from "./SourceViewer";
import { TransportBar } from "./TransportBar";
import { transport, useTransport } from "./transport";
import type { SaveNote } from "./NoteLayer";
import { Viewer } from "./Viewer";
import type { Zoom } from "./Viewer";

/** A file change from the preview server's watcher, which owns preview invalidation. */
const previewChangeSchema = z.object({
  projectId: z.string(),
  affectsPreview: z.boolean(),
  affectedCompositions: z.array(z.string()).nullable(),
});

const report = (error: unknown) => reportEditorError("timeline", error);

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

const tools = [
  { mode: "select", action: "editPointer", icon: Cursor },
  { mode: "trim", action: "editTrim", icon: SplitHorizontal },
  { mode: "blade", action: "editBlade", icon: Knife },
  { mode: "draw", action: "cutroomDraw", icon: PencilSimple },
  { mode: "comment", action: "cutroomComment", icon: ChatCircle },
] as const;

/** Cutroom's own editor: tool row, viewer, transport, and the timeline below a split. */
export function EditPage({
  projectId,
  projectName,
  notes,
  onContext,
  onSaveNote,
  onOpenNote,
  onFiles,
}: {
  projectId: string;
  projectName: string;
  /** Review notes, shown as pins on the picture and the timeline ruler. */
  notes: readonly ReviewItem[];
  onContext?: (context: EditorContext) => void;
  onSaveNote: SaveNote;
  onOpenNote(id: string): void;
  /** Opens the project's folder in the file dialog. */
  onFiles(): void;
}) {
  const voiceover = useVoiceover(projectId);
  const editorTools = useContext(EditorToolsContext);
  const mode = editorTools?.mode ?? "select";
  const setMode = (next: typeof mode) => {
    // Notes go on the timeline's picture.
    if (next === "draw" || next === "comment") showSource(false);
    editorTools?.setMode(next);
  };
  const page = useRef<HTMLDivElement>(null);
  const viewer = useRef<HTMLElement>(null);
  const timelinePanel = useRef<HTMLElement>(null);
  const [revision, setRevision] = useState(0);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [fullscreen, setFullscreen] = useState(false);
  const history = useTimeline((state) => state.history);
  const snapping = useTimeline((state) => state.snapping);
  const source = useSource((state) => state.file !== null);
  const sourceShown = useSource((state) => state.shown);
  /** The transport keys and bar drive what the viewer shows. */
  const player = sourceShown ? sourcePlayer : transport;

  useEffect(() => {
    const closing = new AbortController();
    openTimeline(projectId, closing.signal);
    transport.seek(0);
    const unsubscribe = useTimeline.subscribe(({ view }) => {
      if (view) transport.setTimeline(view.timeline);
    });
    const fail = (error: unknown) => {
      if (!closing.signal.aborted) report(error);
    };
    void loadTimeline(projectId, closing.signal).catch(fail);
    // Any project change can move the timeline or the undo history.
    const stopProject = subscribeProjectEvents(
      projectId,
      "message",
      () => void loadTimeline(projectId, closing.signal).catch(fail),
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
          (change.data.affectedCompositions?.includes("index.html") ?? true)
        )
          setRevision((value) => value + 1);
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
    const send = ({
      frame,
      fps,
      duration,
      state,
    }: ReturnType<typeof useTransport.getState>) =>
      contextReport.current?.({
        currentTime: frameTime(frame, fps),
        duration: frameTime(duration, fps),
        isPlaying: state.kind !== "stopped",
        compositionPath: "index.html",
        selectedElementIds: [],
      });
    send(useTransport.getState());
    return useTransport.subscribe(send);
  }, []);

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
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void viewer.current
        ?.requestFullscreen()
        .catch((error: unknown) => reportEditorError("viewer", error));
  };

  const step = (direction: "undo" | "redo") => {
    void stepHistory(projectId, direction).catch(report);
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

  const handlers: Partial<Record<Action, () => void>> = {
    editPointer: () => setMode("select"),
    editTrim: () => setMode("trim"),
    editBlade: () => setMode("blade"),
    cutroomDraw: () => setMode("draw"),
    cutroomComment: () => setMode("comment"),
    controlPlayToggle: () => player.dispatch({ type: "toggle" }),
    controlPlayForward: () =>
      player.dispatch({ type: "shuttle", dir: "forward", fast: false }),
    controlPlayReverse: () =>
      player.dispatch({ type: "shuttle", dir: "reverse", fast: false }),
    controlFastForward: () =>
      player.dispatch({ type: "shuttle", dir: "forward", fast: true }),
    controlFastReverse: () =>
      player.dispatch({ type: "shuttle", dir: "reverse", fast: true }),
    controlStop: () => player.dispatch({ type: "stop" }),
    controlStepReverse: () => player.step(-1),
    controlStepForward: () => player.step(1),
    controlLargeStepReverse: () => player.step(-second()),
    controlLargeStepForward: () => player.step(second()),
    controlClipPrev: () =>
      jump((stops, frame) => stops.findLast((stop) => stop < frame) ?? 0),
    controlClipNext: () =>
      jump((stops, frame) => stops.find((stop) => stop > frame) ?? last()),
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
    editUndo: () => step("undo"),
    editRedo: () => step("redo"),
    workspaceViewerModeCinemaViewer: toggleFullscreen,
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
        {tools.map((tool) => (
          <button
            key={tool.mode}
            className="edit-tool"
            aria-pressed={mode === tool.mode}
            title={hint(tool.action)}
            onClick={() => setMode(tool.mode)}
          >
            <tool.icon
              size={14}
              weight={mode === tool.mode ? "fill" : "regular"}
            />
            <span>{keymap[tool.action].label}</span>
            <kbd>{keymap[tool.action].keys[0]}</kbd>
          </button>
        ))}
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
        <SelectMenu<Zoom>
          className="edit-zoom"
          label="Viewer zoom"
          value={zoom}
          options={[
            { value: "fit", label: "Fit" },
            { value: "actual", label: "100%" },
          ]}
          onChange={setZoom}
        />
        <button
          className="edit-icon"
          aria-label="Project files"
          aria-haspopup="dialog"
          title="Project files"
          onClick={onFiles}
        >
          <Folder size={16} />
        </button>
        <span className="edit-separator" />
        <button
          className="edit-icon"
          aria-label="Undo"
          title={hint("editUndo")}
          disabled={!history.canUndo}
          onClick={() => step("undo")}
        >
          <ArrowCounterClockwise size={16} />
        </button>
        <button
          className="edit-icon"
          aria-label="Redo"
          title={hint("editRedo")}
          disabled={!history.canRedo}
          onClick={() => step("redo")}
        >
          <ArrowClockwise size={16} />
        </button>
        <span className="edit-separator" />
        <InspectorToggle />
        <ExportControl projectId={projectId} projectName={projectName} />
      </div>
      <section
        ref={viewer}
        className="edit-viewer"
        aria-label="Viewer"
        onPointerDownCapture={clearBrowserSelection}
      >
        <Viewer
          key={projectId}
          projectId={projectId}
          revision={revision}
          zoom={zoom}
          mode={mode}
          notes={notes}
          onOpenNote={onOpenNote}
          onSaveNote={onSaveNote}
        />
        <SourceViewer projectId={projectId} />
        <TransportBar
          key={sourceShown ? "source" : "timeline"}
          player={player}
          fullscreen={fullscreen}
          onFullscreen={toggleFullscreen}
          voiceover={sourceShown ? undefined : voiceover}
        />
      </section>
      <Inspector projectId={projectId} />
      <div
        className="edit-split"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline"
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
        <ProjectTimeline
          voiceover={voiceover}
          projectId={projectId}
          tool={mode === "trim" || mode === "blade" ? mode : "pointer"}
          notes={notes}
          onOpenNote={onOpenNote}
        />
      </section>
    </div>
  );
}
