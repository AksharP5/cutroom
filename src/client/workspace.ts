import { create } from "zustand";

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
}));
