import { isAudioKind } from "../../shared/timeline/schema";
import type { Clip, CommandInput, Title } from "../../shared/timeline/schema";
import {
  ElementStyleEditSchema,
  takesStyleField,
} from "../../shared/timeline/elementStyle";
import type { ElementStyle } from "../../shared/timeline/elementStyle";
import { isTitle } from "../../shared/timeline/title";
import { editTimeline } from "./timeline";

/**
 * The look last copied in each project, since fonts belong to a project: a title's settings, or
 * another visual clip's style. Each pastes onto clips of its own sort.
 */
type Copied = { title: Title } | { style: ElementStyle };
const copies = new Map<string, Copied>();

/** Which sort of clip a paste can restyle, or null when nothing was copied. */
export function copiedStyle(projectId: string) {
  const copied = copies.get(projectId);
  return copied ? ("title" in copied ? "title" : "style") : null;
}

export function copyStyle(projectId: string, clip: Clip) {
  if (clip.title) copies.set(projectId, { title: clip.title });
  else if (!isTitle(clip) && !isAudioKind(clip.kind))
    copies.set(projectId, { style: clip.style });
}

/**
 * Gives every clip in `clipIds` of the copied sort the copied look in one undo step; words and
 * timing stay. A style replaces the clip's own, leaving out fields its kind cannot take.
 */
export function pasteStyle(projectId: string, clipIds: Iterable<string>) {
  const copied = copies.get(projectId);
  if (!copied) return;
  const ids = new Set(clipIds);
  void editTimeline(projectId, "Paste style", (timeline) =>
    timeline.clips.flatMap((clip): CommandInput[] => {
      if (!ids.has(clip.id)) return [];
      if ("title" in copied)
        return clip.title
          ? [{ type: "setClip", clipId: clip.id, title: copied.title }]
          : [];
      if (isTitle(clip) || isAudioKind(clip.kind)) return [];
      const style = ElementStyleEditSchema.parse({
        ...Object.fromEntries(
          Object.keys(clip.style).map((key) => [key, null]),
        ),
        ...Object.fromEntries(
          Object.entries(copied.style).filter(([field]) =>
            takesStyleField(clip.kind, field),
          ),
        ),
      });
      return [{ type: "setClip", clipId: clip.id, style }];
    }),
  );
}
