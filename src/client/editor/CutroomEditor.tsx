import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PointerEvent } from "react";
import {
  StudioApp,
  liveTime,
  useDockLayoutStore,
  usePlayerStore,
  usePreviewCompositionRect,
  usePreviewIframeStore,
} from "@hyperframes/studio";
import type {
  EditorContext,
  EditorMode,
  EditorPoint,
  EditorReviewDraft,
} from "../../shared/editor";

export interface CutroomEditorProps {
  projectId: string;
  mode?: EditorMode;
  onContext?: (context: EditorContext) => void;
  onReview?: (draft: EditorReviewDraft) => void;
  onAskAgent?: (prompt: string) => void;
}

export function seekEditor(time: number) {
  const state = usePlayerStore.getState();
  state.requestPlayback(false);
  state.requestSeek(Math.max(0, Math.min(time, state.duration || time)));
}

export function refreshEditor() {
  window.dispatchEvent(new CustomEvent("cutroom:refresh-editor"));
}

function compositionPath() {
  const query = window.location.hash.split("?")[1];
  return new URLSearchParams(query).get("comp") || "index.html";
}

function context(): EditorContext {
  const state = usePlayerStore.getState();
  return {
    currentTime: state.isPlaying ? liveTime.latest() : state.currentTime,
    duration: state.duration,
    isPlaying: state.isPlaying,
    compositionPath: compositionPath(),
    selectedElementIds: [...state.selectedElementIds],
  };
}

function ReviewOverlay({
  projectId,
  mode,
  onReview,
}: Pick<CutroomEditorProps, "projectId" | "mode" | "onReview">) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const points = useRef<EditorPoint[]>([]);
  const pointer = useRef<number | null>(null);
  const reviewTime = useRef(0);
  const iframe = usePreviewIframeStore((state) => state.iframe);
  const rect = usePreviewCompositionRect(host, iframe);
  const enabled = mode === "draw" || mode === "comment";

  useEffect(() => {
    const doc = iframe?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll("audio,video").forEach((element) => {
      if (element instanceof HTMLMediaElement) element.muted = true;
    });
  }, [iframe]);

  const draw = useCallback(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    const width = element.clientWidth;
    const height = element.clientHeight;
    element.width = Math.round(width * devicePixelRatio);
    element.height = Math.round(height * devicePixelRatio);
    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fa9a87";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    points.current.forEach((point, index) => {
      const x = point.x * width;
      const y = point.y * height;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, []);

  const pointFor = (event: PointerEvent<HTMLCanvasElement>): EditorPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  const finish = (event: PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const current = context();
    if (points.current.length > 0) {
      const params = new URLSearchParams({
        t: reviewTime.current.toFixed(3),
        format: "png",
        output: "source",
      });
      onReview?.({
        kind: mode === "draw" ? "draw" : "comment",
        time: reviewTime.current,
        compositionPath: current.compositionPath,
        points: [...points.current],
        elementIds: current.selectedElementIds,
        frameUrl: `/api/projects/${encodeURIComponent(projectId)}/thumbnail/${encodeURIComponent(current.compositionPath)}?${params}`,
      });
    }
    points.current = [];
    draw();
  };

  return (
    <div
      ref={host}
      className="editor-review-overlay"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 60,
      }}
    >
      {enabled && rect.width > 0 && (
        <canvas
          ref={canvas}
          className="editor-review-canvas"
          aria-label={
            mode === "draw"
              ? "Draw on the composition"
              : "Pin a comment on the composition"
          }
          style={{
            position: "absolute",
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            pointerEvents: "auto",
            touchAction: "none",
            cursor: mode === "draw" ? "crosshair" : "cell",
          }}
          onPointerDown={(event) => {
            reviewTime.current = context().currentTime;
            usePlayerStore.getState().requestPlayback(false);
            pointer.current = event.pointerId;
            points.current = [pointFor(event)];
            event.currentTarget.setPointerCapture(event.pointerId);
            draw();
          }}
          onPointerMove={(event) => {
            if (pointer.current !== event.pointerId || mode !== "draw") return;
            points.current.push(pointFor(event));
            draw();
          }}
          onPointerUp={finish}
          onPointerCancel={() => {
            pointer.current = null;
            points.current = [];
            draw();
          }}
        />
      )}
    </div>
  );
}

export function CutroomEditor({
  projectId,
  mode = "select",
  onContext,
  onReview,
  onAskAgent,
}: CutroomEditorProps) {
  const callbacks = useRef({ onContext, onAskAgent });
  callbacks.current = { onContext, onAskAgent };
  const [mountedProjectId, setMountedProjectId] = useState<string | null>(null);
  const controller = useDockLayoutStore((state) => state.controller);

  useEffect(() => {
    if (!controller) return;
    const layout = useDockLayoutStore.getState();
    layout.setZoneVisible("right", false);
    layout.setZoneVisible("left", false);
  }, [controller, projectId]);

  useLayoutEffect(() => {
    const sameProject = window.location.hash.startsWith(
      `#project/${encodeURIComponent(projectId)}?`,
    );
    const previous = new URLSearchParams(
      sameProject ? window.location.hash.split("?")[1] : undefined,
    );
    previous.set("rc", "1");
    previous.set("tv", "1");
    window.location.hash = `project/${encodeURIComponent(projectId)}?${previous}`;
    usePlayerStore.getState().setAudioMuted(true);
    setMountedProjectId(projectId);
  }, [projectId]);

  useEffect(() => {
    const report = () => callbacks.current.onContext?.(context());
    report();
    const unsubscribe = usePlayerStore.subscribe(report);
    const unsubscribeTime = liveTime.subscribe(report);
    window.addEventListener("hashchange", report);
    const ask = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (
        detail &&
        typeof detail === "object" &&
        "prompt" in detail &&
        typeof detail.prompt === "string"
      )
        callbacks.current.onAskAgent?.(detail.prompt);
    };
    window.addEventListener("cutroom:ask-agent", ask);
    return () => {
      unsubscribe();
      unsubscribeTime();
      window.removeEventListener("hashchange", report);
      window.removeEventListener("cutroom:ask-agent", ask);
    };
  }, [projectId]);

  return (
    <div
      className="cutroom-editor"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {mountedProjectId === projectId && (
        <>
          <StudioApp key={projectId} />
          <ReviewOverlay
            projectId={projectId}
            mode={mode}
            onReview={onReview}
          />
        </>
      )}
    </div>
  );
}
