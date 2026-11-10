import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  EditorReviewDraft,
} from "../../shared/editor";
import { ReviewCanvas } from "../components/ReviewCanvas";
import { compositionFps, useWorkspace } from "../workspace";

const NativeStudio = memo(StudioApp);

export interface CutroomEditorProps {
  projectId: string;
  mode?: EditorMode;
  onContext?: (context: EditorContext) => void;
  onReview?: (draft: EditorReviewDraft) => void;
  onAskAgent?: (prompt: string) => void;
}

export function seekEditor(time: number, targetComposition?: string) {
  if (targetComposition) {
    window.dispatchEvent(
      new CustomEvent("cutroom:seek-review", {
        detail: { time, compositionPath: targetComposition },
      }),
    );
    return;
  }
  const state = usePlayerStore.getState();
  state.requestPlayback(false);
  state.requestSeek(Math.max(0, time));
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
  mode,
  onReview,
}: Pick<CutroomEditorProps, "mode" | "onReview">) {
  const host = useRef<HTMLDivElement>(null);
  const iframe = usePreviewIframeStore((state) => state.iframe);
  const rect = usePreviewCompositionRect(host, iframe);

  useEffect(() => {
    const doc = iframe?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll<HTMLMediaElement>("audio,video").forEach((element) => {
      element.muted = true;
    });
  }, [iframe]);

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
      {(mode === "draw" || mode === "comment") && rect.width > 0 && (
        <div
          style={{
            position: "absolute",
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }}
        >
          <ReviewCanvas
            mode={mode}
            begin={() => {
              usePlayerStore.getState().requestPlayback(false);
              const current = context();
              return {
                time: current.currentTime,
                compositionPath: current.compositionPath,
                elementIds: current.selectedElementIds,
              };
            }}
            onReview={onReview}
          />
        </div>
      )}
    </div>
  );
}

const filePanels = ["compositions", "assets", "code"] as const;

function shownPanels() {
  const { visiblePanels } = useDockLayoutStore.getState();
  return {
    files: filePanels.some((id) => visiblePanels.has(id)),
    exports: visiblePanels.has("renders"),
  };
}

/** Keeps the shell's panel flags and the embedded editor's dock in agreement. */
function mirrorWorkspacePanels() {
  let applying = false;
  const pull = () => {
    if (applying) return;
    const shown = shownPanels();
    const wanted = useWorkspace.getState();
    if (shown.files !== wanted.files || shown.exports !== wanted.exports)
      useWorkspace.setState(shown);
  };
  const push = ({ files, exports }: ReturnType<typeof shownPanels>) => {
    const shown = shownPanels();
    const dock = useDockLayoutStore.getState();
    applying = true;
    try {
      if (files !== shown.files) {
        if (files) {
          for (const id of filePanels) dock.controller?.open(id);
          dock.setZoneVisible("left", true);
          dock.activatePanel("compositions");
        } else dock.setZoneVisible("left", false);
      }
      if (exports && !shown.exports) {
        dock.controller?.open("renders");
        dock.setZoneVisible("right", true);
        dock.activatePanel("renders");
      }
    } finally {
      applying = false;
    }
    pull();
  };
  const stopPull = useDockLayoutStore.subscribe(pull);
  const stopPush = useWorkspace.subscribe(push);
  return () => {
    stopPull();
    stopPush();
  };
}

/** Publishes the open composition's frame rate and size for the status bar and timecode. */
function useCompositionFacts() {
  const iframe = usePreviewIframeStore((state) => state.iframe);
  useEffect(() => {
    if (!iframe) return;
    const read = () => {
      const root = iframe.contentDocument?.querySelector(
        "[data-composition-id]",
      );
      if (!root) return;
      const size = (name: string) => {
        const value = Number(root.getAttribute(name));
        return Number.isFinite(value) && value > 0 ? value : null;
      };
      useWorkspace.setState({
        composition: {
          fps: compositionFps(root.getAttribute("data-fps")),
          width: size("data-width"),
          height: size("data-height"),
        },
      });
    };
    read();
    iframe.addEventListener("load", read);
    return () => iframe.removeEventListener("load", read);
  }, [iframe]);
  useEffect(() => () => useWorkspace.setState({ composition: null }), []);
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
  useCompositionFacts();

  useEffect(() => {
    if (!controller) return;
    const dock = useDockLayoutStore.getState();
    dock.setZoneVisible("right", false);
    dock.setZoneVisible("left", false);
    useWorkspace.setState({ files: false, exports: false });
    return mirrorWorkspacePanels();
  }, [controller, projectId]);

  useLayoutEffect(() => {
    const projectHash = `#project/${encodeURIComponent(projectId)}`;
    if (
      window.location.hash !== projectHash &&
      !window.location.hash.startsWith(`${projectHash}?`)
    )
      return;
    const previous = new URLSearchParams(window.location.hash.split("?")[1]);
    previous.set("rc", "1");
    previous.set("tv", "1");
    window.history.replaceState(null, "", `${projectHash}?${previous}`);
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
          <NativeStudio key={projectId} />
          <ReviewOverlay mode={mode} onReview={onReview} />
        </>
      )}
    </div>
  );
}
