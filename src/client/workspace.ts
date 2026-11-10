import { create } from "zustand";

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
  /** Export progress and finished renders. */
  exports: false,
  exporting: false,
  /** Bumped when files other than compositions or `cutroom.json` change on disk. */
  mediaRevision: 0,
  /** When each project file last changed on disk, so a replaced file loads afresh. */
  fileChanges: {} as Record<string, number>,
  /** Read from the open composition's root once its preview loads. */
  composition: null as {
    fps: number;
    width: number | null;
    height: number | null;
  } | null,
  /** The chat panel's selected native agent, once its configuration is read. */
  agent: null as { name: string; available: boolean } | null,
}));

/** Frame rate for timecode: the open composition's, or the default before it loads. */
export function useFps() {
  return (
    useWorkspace((state) => state.composition?.fps) ?? compositionFps(null)
  );
}
