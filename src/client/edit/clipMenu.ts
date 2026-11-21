import { clipEnd } from "../../shared/timeline/apply";
import type { Clip, Timeline } from "../../shared/timeline/schema";
import type { MenuItem } from "../components/menu";
import { isAudioKind } from "../../shared/timeline/schema";
import { isTitle } from "../../shared/timeline/title";
import { takesGrade } from "../../shared/timeline/grade";

/**
 * The clip menu, shared by the timeline, the picture and the menu key. Its edits are keymap
 * actions, so each acts on the selection exactly as its key does; a right-click selects first.
 */
export function clipMenuItems({
  timeline,
  selection,
  frame,
  clipboard,
  copiedStyle,
  inspector,
  onReveal,
  onInspector,
  onCopyStyle,
  onPasteStyle,
  copiedGrade,
  onCopyGrade,
  onPasteGrade,
  onDuck,
  onNormalize,
  onFreeze,
  clicked,
}: {
  timeline: Timeline;
  selection: ReadonlySet<string>;
  /** The frame under the playhead. */
  frame: number;
  /** Clips have been copied in this project. */
  clipboard: boolean;
  /** The sort of clip whose look was copied in this project: a title, or any other visual clip. */
  copiedStyle: "title" | "style" | null;
  inspector: boolean;
  /** Shows the clip's file in Media; null when the clip has no file listed there. */
  onReveal: (() => void) | null;
  onInspector(): void;
  onCopyStyle(clip: Clip): void;
  onPasteStyle(clips: Clip[]): void;
  /** A grade has been copied in this project. */
  copiedGrade: boolean;
  onCopyGrade(clip: Clip): void;
  onPasteGrade(clips: Clip[]): void;
  /** Ducks the clip under the voice: the other selected clips, or every voice over it. */
  onDuck(bed: Clip, voices: Clip[]): void;
  /** Sets each clip's gain so it measures -16 LUFS. */
  onNormalize(clips: Clip[]): void;
  onFreeze(clip: Clip, frame: number): void;
  /** The clip a right-click landed on, which Duck under voice lowers. */
  clicked?: Clip;
}): MenuItem[] {
  const clips = timeline.clips.filter((clip) => selection.has(clip.id));
  const none = clips.length === 0;
  // A title carries its title settings; any other picture its inline style.
  const styled = clips.filter(
    (clip) => !isAudioKind(clip.kind) && (clip.title || !isTitle(clip)),
  );
  const pastable = styled.filter(
    (clip) => (copiedStyle === "title") === !!clip.title,
  );
  const graded = clips.filter(takesGrade);
  const sound = clips.filter((clip) => clip.hasAudio);
  const pictures = clips.filter((clip) => clip.kind === "video");
  const freeze =
    clicked?.kind === "video"
      ? clicked
      : clicked
        ? undefined
        : pictures.length === 1
          ? pictures[0]
          : undefined;
  const bed = sound.find((clip) => clip.id === clicked?.id) ?? sound[0];
  const voices = sound.filter((clip) => clip !== bed);
  return [
    { action: "editCut", disabled: none },
    { action: "editCopy", disabled: none },
    { action: "editPaste", disabled: !clipboard },
    { action: "editPasteAttributes", disabled: !clipboard || none },
    { action: "editPasteInsert", disabled: !clipboard },
    "separator",
    {
      action: "editM2SplitClip",
      // With no selected clip under the playhead the key cuts other tracks' clips instead.
      disabled: !clips.some(
        (clip) => clip.start < frame && frame < clipEnd(clip),
      ),
    },
    ...(freeze
      ? [
          {
            label: "Freeze frame",
            disabled:
              !freeze.src || frame <= freeze.start || frame >= clipEnd(freeze),
            run: () => onFreeze(freeze, frame),
          },
        ]
      : []),
    { action: "editBackspace", disabled: none },
    { action: "editDelete", disabled: none },
    { action: "editClipEnabled", disabled: none },
    {
      action: "editLink",
      disabled: clips.length < 2 && !clips.some((clip) => clip.link),
      checked: clips.some((clip) => clip.link !== null),
    },
    "separator",
    { action: "editSelectClipsSelectTrackAfter" },
    "separator",
    { action: "cutroomAddTitle" },
    // Sound has no look, so style rows appear only for pictures.
    ...(styled.length
      ? [
          {
            label: "Copy style",
            run: () => onCopyStyle(styled[0]!),
            disabled: styled.length !== 1,
          },
          {
            label: "Paste style",
            run: () => onPasteStyle(pastable),
            disabled: !copiedStyle || !pastable.length,
          },
        ]
      : []),
    ...(graded.length
      ? [
          {
            label: "Copy grade",
            run: () => onCopyGrade(graded[0]!),
            disabled: graded.length !== 1,
          },
          {
            label: "Paste grade",
            run: () => onPasteGrade(graded),
            disabled: !copiedGrade,
          },
        ]
      : []),
    ...(bed
      ? [
          "separator" as const,
          {
            label: voices.length
              ? "Duck under the selected voice"
              : "Duck under voice",
            run: () => onDuck(bed, voices),
          },
          {
            label: "Normalize loudness to -16 LUFS",
            run: () => onNormalize(sound),
          },
        ]
      : []),
    "separator",
    {
      label: "Reveal media",
      run: () => onReveal?.(),
      disabled: !onReveal,
    },
    { label: "Inspector", run: onInspector, checked: inspector },
  ];
}
