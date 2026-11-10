import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { z } from "zod";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  Camera,
  Export,
  FolderOpen,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import { usePreviewIframeStore } from "@hyperframes/studio";
import { seekEditor } from "./CutroomEditor";
import { EditorTools } from "./EditorTools";
import { useWorkspace } from "../workspace";

const reviewSeekSchema = z.object({
  time: z.number().finite().nonnegative(),
  compositionPath: z.string().min(1),
});

interface EditorHeaderProps {
  captureFrameHref: string;
  captureFrameFilename: string;
  handleCaptureFrameClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  refreshCaptureFrameTime: () => void;
  capturing?: boolean;
  inspectorButtonActive: boolean;
  onInspector: () => void;
  onExport?: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  isRendering: boolean;
  ffmpegMissing: boolean;
  onSelectComposition: (path: string) => void;
  activeCompPath: string | null;
  compositionLoading: boolean;
}

export function EditorHeader(props: EditorHeaderProps) {
  const [reviewSeek, setReviewSeek] = useState<z.infer<
    typeof reviewSeekSchema
  > | null>(null);
  const iframe = usePreviewIframeStore((state) => state.iframe);
  useEffect(() => {
    const navigate = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const parsed = reviewSeekSchema.safeParse(event.detail);
      if (!parsed.success) return;
      setReviewSeek(parsed.data);
      if (
        parsed.data.compositionPath !== (props.activeCompPath ?? "index.html")
      )
        props.onSelectComposition(parsed.data.compositionPath);
    };
    window.addEventListener("cutroom:seek-review", navigate);
    return () => window.removeEventListener("cutroom:seek-review", navigate);
  }, [props.activeCompPath, props.onSelectComposition]);
  useEffect(() => {
    if (
      !reviewSeek ||
      !iframe ||
      props.compositionLoading ||
      (props.activeCompPath ?? "index.html") !== reviewSeek.compositionPath
    )
      return;
    const path = decodeURIComponent(new URL(iframe.src).pathname);
    if (
      !path.endsWith(`/preview/comp/${reviewSeek.compositionPath}`) &&
      !(
        reviewSeek.compositionPath === "index.html" && path.endsWith("/preview")
      )
    )
      return;
    if (iframe.contentDocument?.readyState !== "complete") return;
    seekEditor(reviewSeek.time);
    setReviewSeek(null);
  }, [iframe, props.activeCompPath, props.compositionLoading, reviewSeek]);
  const filesVisible = useWorkspace((state) => state.files);
  useEffect(() => {
    useWorkspace.setState({ exporting: props.isRendering });
    return () => useWorkspace.setState({ exporting: false });
  }, [props.isRendering]);
  return (
    <div className="editor-header" aria-label="Composition controls">
      <EditorTools />
      <div className="editor-header-actions">
        <button
          type="button"
          className="editor-files-button"
          onClick={() => useWorkspace.setState({ files: !filesVisible })}
          aria-pressed={filesVisible}
          aria-label="Toggle project files"
          title="Compositions, assets, and source"
        >
          <FolderOpen size={16} />
          <span>Files</span>
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={props.onUndo}
          disabled={!props.canUndo}
          title={props.undoLabel ? `Undo ${props.undoLabel}` : "Undo"}
          aria-label="Undo edit"
        >
          <ArrowCounterClockwise size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={props.onRedo}
          disabled={!props.canRedo}
          title={props.redoLabel ? `Redo ${props.redoLabel}` : "Redo"}
          aria-label="Redo edit"
        >
          <ArrowClockwise size={16} />
        </button>
        <span className="editor-toolbar-separator" />
        <a
          className="icon-button"
          href={props.captureFrameHref}
          download={props.captureFrameFilename}
          onClick={props.handleCaptureFrameClick}
          onFocus={props.refreshCaptureFrameTime}
          onPointerDown={props.refreshCaptureFrameTime}
          aria-disabled={props.capturing || undefined}
          aria-label="Capture frame"
          title="Capture frame"
        >
          <Camera size={16} />
        </a>
        <button
          type="button"
          className="icon-button"
          onClick={props.onInspector}
          aria-pressed={props.inspectorButtonActive}
          aria-label="Toggle inspector"
          title="Inspector"
        >
          <SlidersHorizontal size={16} />
        </button>
        <button
          type="button"
          className="editor-export-button"
          onClick={() => {
            useWorkspace.setState({ exports: true });
            if (!props.ffmpegMissing) props.onExport?.();
          }}
          disabled={props.isRendering}
        >
          <Export size={15} />
          {props.isRendering ? "Exporting" : "Export"}
        </button>
      </div>
    </div>
  );
}
