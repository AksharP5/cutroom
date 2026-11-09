import type { MouseEvent } from "react";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  Camera,
  Export,
  FolderOpen,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import { useDockLayoutStore } from "@hyperframes/studio";

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
}

export function EditorHeader(props: EditorHeaderProps) {
  const filesVisible = useDockLayoutStore(
    (state) =>
      state.visiblePanels.has("compositions") ||
      state.visiblePanels.has("assets") ||
      state.visiblePanels.has("code"),
  );
  const toggleFiles = () => {
    const state = useDockLayoutStore.getState();
    if (filesVisible) {
      state.setZoneVisible("left", false);
      return;
    }
    for (const id of ["compositions", "assets", "code"] as const)
      state.controller?.open(id);
    state.setZoneVisible("left", true);
    state.activatePanel("compositions");
  };
  return (
    <div className="editor-header" aria-label="Composition controls">
      <span className="editor-header-label">Canvas & timeline</span>
      <div className="editor-header-actions">
        <button
          type="button"
          className="editor-files-button"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
          }}
          onClick={toggleFiles}
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
            const state = useDockLayoutStore.getState();
            state.controller?.open("renders");
            state.setZoneVisible("right", true);
            state.activatePanel("renders");
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
