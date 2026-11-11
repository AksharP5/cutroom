import { create } from "zustand";

const NEW_EDITOR_KEY = "cutroom.newEditor";

/**
 * The composition's frame rate from its root `data-fps`, read as HyperFrames reads it:
 * an integer or `num/den`, and 30 when absent. Core's parser is not browser-safe to import.
 */
export function compositionFps(value: string | null | undefined) {
  const match = /^\s*(\d+)\s*(?:\/\s*(\d+)\s*)?$/.exec(value ?? "");
  const rate = Number(match?.[1]) / Number(match?.[2] ?? 1);
  return Number.isFinite(rate) && rate > 0 ? rate : 30;
}

/**
 * Shell-owned editor state. The shell reads and writes only this store;
 * `CutroomEditor` mirrors the panel flags onto whichever editor is embedded.
 */
export const useWorkspace = create(() => ({
  /** Compositions, assets, and source files beside the preview. */
  files: false,
  /** Starts closed where it would be a drawer over the stage (tokens.css --breakpoint-drawer). */
  inspector:
    localStorage.getItem("cutroom.inspector") === null
      ? !matchMedia("(max-width: 1303px)").matches
      : localStorage.getItem("cutroom.inspector") !== "false",
  /** Export progress and finished renders. */
  exports: false,
  exporting: false,
  /** Bumped when files other than compositions or `cutroom.json` change on disk. */
  mediaRevision: 0,
  /** The stat version of each project file, so a replaced file loads afresh. */
  fileChanges: {} as Record<string, string | null>,
  /** Read from the open composition's root once its preview loads. */
  composition: null as {
    fps: number;
    width: number | null;
    height: number | null;
  } | null,
  /** The chat panel's selected native agent, once its configuration is read. */
  agent: null as { name: string; available: boolean } | null,
  /** Cutroom's own editor, unless Settings switched back to the embedded one. */
  newEditor: localStorage.getItem(NEW_EDITOR_KEY) !== "false",
  /** A press is under way in the timeline. Esc cancels it and does nothing else. */
  gesture: false,
  /** The open editor can refuse navigation while it holds an unsaved take. */
  beforeProjectChange: null as (() => boolean) | null,
  /**
   * The new editor's failures, shown in the status bar. Each side sets and clears only its own,
   * so a preview that loads fine never hides a timeline the engine refused.
   */
  editorErrors: { viewer: null, timeline: null } as Record<
    EditorErrorSide,
    string | null
  >,
  /** The header toast's message, empty when none shows. */
  toast: "",
  toastAction: null as { label: string; run(): void } | null,
}));

let toastVersion = 0;

/** The returned dismiss function clears only this toast, leaving later messages alone. */
export const showToast = (
  message: string,
  action: { label: string; run(): void } | null = null,
) => {
  const version = ++toastVersion;
  useWorkspace.setState({ toast: message, toastAction: action });
  return () => {
    if (version !== toastVersion) return;
    ++toastVersion;
    useWorkspace.setState({ toast: "", toastAction: null });
  };
};

type EditorErrorSide = "viewer" | "timeline";

/** Shows a failure from one side of the new editor, or clears that side with null. */
export const reportEditorError = (side: EditorErrorSide, error: unknown) =>
  useWorkspace.setState((state) => ({
    editorErrors: {
      ...state.editorErrors,
      [side]:
        error === null
          ? null
          : error instanceof Error
            ? error.message
            : String(error),
    },
  }));

useWorkspace.subscribe(({ newEditor, inspector }, previous) => {
  if (inspector !== previous.inspector)
    localStorage.setItem("cutroom.inspector", String(inspector));
  if (newEditor !== previous.newEditor)
    localStorage.setItem(NEW_EDITOR_KEY, String(newEditor));
});

/** Frame rate for timecode: the open composition's, or the default before it loads. */
export function useFps() {
  return (
    useWorkspace((state) => state.composition?.fps) ?? compositionFps(null)
  );
}
