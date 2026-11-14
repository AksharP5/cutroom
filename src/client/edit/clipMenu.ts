import { clipEnd } from "../../shared/timeline/apply";
import type { Timeline } from "../../shared/timeline/schema";
import type { MenuItem } from "../components/menu";

/**
 * The clip menu, shared by the timeline, the picture and the menu key. Its edits are keymap
 * actions, so each acts on the selection exactly as its key does; a right-click selects first.
 */
export function clipMenuItems({
  timeline,
  selection,
  frame,
  clipboard,
  inspector,
  onReveal,
  onInspector,
}: {
  timeline: Timeline;
  selection: ReadonlySet<string>;
  /** The frame under the playhead. */
  frame: number;
  /** Clips have been copied in this project. */
  clipboard: boolean;
  inspector: boolean;
  /** Shows the clip's file in Media; null when the clip has no file listed there. */
  onReveal: (() => void) | null;
  onInspector(): void;
}): MenuItem[] {
  const clips = timeline.clips.filter((clip) => selection.has(clip.id));
  const none = clips.length === 0;
  return [
    { action: "editCut", disabled: none },
    { action: "editCopy", disabled: none },
    { action: "editPaste", disabled: !clipboard },
    { action: "editPasteInsert", disabled: !clipboard },
    "separator",
    {
      action: "editM2SplitClip",
      // With no selected clip under the playhead the key cuts other tracks' clips instead.
      disabled: !clips.some(
        (clip) => clip.start < frame && frame < clipEnd(clip),
      ),
    },
    { action: "editBackspace", disabled: none },
    { action: "editDelete", disabled: none },
    { action: "editClipEnabled", disabled: none },
    "separator",
    { action: "editSelectClipsSelectTrackAfter" },
    "separator",
    { action: "cutroomAddTitle" },
    "separator",
    {
      label: "Reveal media",
      run: () => onReveal?.(),
      disabled: !onReveal,
    },
    { label: "Inspector", run: onInspector, checked: inspector },
  ];
}
