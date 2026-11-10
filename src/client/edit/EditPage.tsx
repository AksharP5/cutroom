import { useContext, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CaretDown,
  ChatCircle,
  Cursor,
  PencilSimple,
} from "@phosphor-icons/react";
import { z } from "zod";
import type { EditorContext, EditorReviewDraft } from "../../shared/editor";
import { clipEnd, frameTime } from "../../shared/timeline/apply";
import type { Timeline } from "../../shared/timeline/schema";
import { EditorToolsContext } from "../editor/EditorTools";
import { hint, keymap, useKeymap } from "../keymap";
import type { Action } from "../keymap";
import { useWorkspace } from "../workspace";
import "./edit.css";
import {
  editTimeline,
  loadTimeline,
  stepHistory,
  useTimeline,
} from "./timeline";
import { TransportBar } from "./TransportBar";
import { transport, useTransport } from "./transport";
import { Viewer } from "./Viewer";
import type { Zoom } from "./Viewer";

/** A file change from the preview server's watcher, which owns preview invalidation. */
const previewChangeSchema = z.object({
  projectId: z.string(),
  affectsPreview: z.boolean(),
  affectedCompositions: z.array(z.string()).nullable(),
});

const report = (error: unknown) =>
  useWorkspace.setState({
    editorError: error instanceof Error ? error.message : String(error),
  });

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
  { mode: "draw", action: "cutroomDraw", icon: PencilSimple },
  { mode: "comment", action: "cutroomComment", icon: ChatCircle },
] as const;

/** Cutroom's own editor: tool row, viewer, transport, and the timeline below a split. */
export function EditPage({
  projectId,
  onContext,
  onReview,
}: {
  projectId: string;
  onContext?: (context: EditorContext) => void;
  onReview?: (draft: EditorReviewDraft) => void;
}) {
  const editorTools = useContext(EditorToolsContext);
  const mode = editorTools?.mode ?? "select";
  const setMode = (next: typeof mode) => editorTools?.setMode(next);
  const page = useRef<HTMLDivElement>(null);
  const viewer = useRef<HTMLElement>(null);
  const [revision, setRevision] = useState(0);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [fullscreen, setFullscreen] = useState(false);
  const history = useTimeline((state) => state.history);
  const base = `/projects/${encodeURIComponent(projectId)}`;

  useEffect(() => {
    useTimeline.setState({ view: null });
    transport.seek(0);
    const unsubscribe = useTimeline.subscribe(({ view }) => {
      if (view) transport.setTimeline(view.timeline);
    });
    void loadTimeline(projectId).catch(report);
    // Any project change can move the timeline or the undo history.
    const projectEvents = new EventSource(`/api/cutroom${base}/events`);
    projectEvents.onmessage = () => void loadTimeline(projectId).catch(report);
    // The preview server's own invalidation decides what reloads the picture: HTML, CSS, scripts, media.
    const previewEvents = new EventSource("/api/events");
    previewEvents.addEventListener("file-change", (event) => {
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
    });
    return () => {
      projectEvents.close();
      previewEvents.close();
      unsubscribe();
    };
  }, [base, projectId]);

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
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void viewer.current?.requestFullscreen().catch(report);
  };

  const step = (direction: "undo" | "redo") =>
    void stepHistory(projectId, direction).catch(report);
  const mark = (
    label: string,
    range: (frame: number, current: Timeline["range"]) => Timeline["range"],
  ) => {
    const { frame } = useTransport.getState();
    void editTimeline(projectId, label, (timeline) => [
      { type: "setRange", ...range(frame, timeline.range) },
    ]).catch(report);
  };
  const jump = (to: (timeline: Timeline, frame: number) => number | null) => {
    const view = useTimeline.getState().view;
    if (!view) return;
    const frame = to(view.timeline, useTransport.getState().frame);
    if (frame !== null) transport.seek(frame);
  };
  const second = () => {
    const { fps } = useTransport.getState();
    return Math.round(fps.num / fps.den);
  };
  const last = () => useTransport.getState().duration - 1;

  const handlers: Partial<Record<Action, () => void>> = {
    editPointer: () => setMode("select"),
    cutroomDraw: () => setMode("draw"),
    cutroomComment: () => setMode("comment"),
    controlPlayToggle: () => transport.dispatch({ type: "toggle" }),
    controlPlayForward: () =>
      transport.dispatch({ type: "shuttle", dir: "forward", fast: false }),
    controlPlayReverse: () =>
      transport.dispatch({ type: "shuttle", dir: "reverse", fast: false }),
    controlFastForward: () =>
      transport.dispatch({ type: "shuttle", dir: "forward", fast: true }),
    controlFastReverse: () =>
      transport.dispatch({ type: "shuttle", dir: "reverse", fast: true }),
    controlStop: () => transport.dispatch({ type: "stop" }),
    controlStepReverse: () => transport.step(-1),
    controlStepForward: () => transport.step(1),
    controlLargeStepReverse: () => transport.step(-second()),
    controlLargeStepForward: () => transport.step(second()),
    controlClipPrev: () =>
      jump(
        (timeline, frame) =>
          edits(timeline).findLast((edit) => edit < frame) ?? 0,
      ),
    controlClipNext: () =>
      jump(
        (timeline, frame) =>
          edits(timeline).find((edit) => edit > frame) ?? last(),
      ),
    controlTimelineStart: () => transport.seek(0),
    controlTimelineEnd: () => transport.seek(last()),
    controlFirstFrame: () => transport.seek(0),
    controlLastFrame: () => transport.seek(last()),
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
    controlGotoIn: () => jump(({ range }) => range.in),
    controlGotoOut: () =>
      jump(({ range }) => (range.out === null ? null : range.out - 1)),
    controlLoop: () => transport.toggleLoop(),
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
      <div className="edit-tools" role="toolbar" aria-label="Tools">
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
            {keymap[tool.action].label}
            <kbd>{keymap[tool.action].keys[0]}</kbd>
          </button>
        ))}
        <span className="edit-grow" />
        <button
          className="edit-zoom"
          popoverTarget="edit-zoom-menu"
          aria-label="Viewer zoom"
        >
          {zoom === "fit" ? "Fit" : "100%"}
          <CaretDown size={10} />
        </button>
        <div id="edit-zoom-menu" className="edit-menu" popover="auto">
          {(["fit", "actual"] as const).map((option) => (
            <button
              key={option}
              role="menuitemradio"
              aria-checked={zoom === option}
              popoverTarget="edit-zoom-menu"
              popoverTargetAction="hide"
              onClick={() => setZoom(option)}
            >
              {option === "fit" ? "Fit" : "100%"}
            </button>
          ))}
        </div>
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
      </div>
      <section ref={viewer} className="edit-viewer" aria-label="Viewer">
        <Viewer
          projectId={projectId}
          revision={revision}
          zoom={zoom}
          mode={mode}
          onReview={onReview}
        />
        <TransportBar fullscreen={fullscreen} onFullscreen={toggleFullscreen} />
      </section>
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
      {/* The timeline (src/client/timeline/) mounts here. */}
      <section className="edit-timeline" aria-label="Timeline" />
    </div>
  );
}
