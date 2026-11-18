import { takesGrade } from "../../shared/timeline/grade";
import type { Grade } from "../../shared/timeline/grade";
import type { Clip, CommandInput } from "../../shared/timeline/schema";
import { editTimeline } from "./timeline";

/** The grade last copied in each project; null is a copied ungraded clip, which pastes as none. */
const copies = new Map<string, Grade | null>();

export const hasCopiedGrade = (projectId: string) => copies.has(projectId);

export function copyGrade(projectId: string, clip: Clip) {
  copies.set(projectId, clip.grade);
}

/** Gives every graded kind of clip in `clipIds` the copied grade, replacing its own, in one undo step. */
export function pasteGrade(projectId: string, clipIds: Iterable<string>) {
  if (!copies.has(projectId)) return;
  const grade = copies.get(projectId)!;
  const ids = new Set(clipIds);
  void editTimeline(projectId, "Paste grade", (timeline) =>
    timeline.clips.flatMap((clip): CommandInput[] =>
      ids.has(clip.id) && takesGrade(clip)
        ? [
            { type: "setClip", clipId: clip.id, grade: null },
            ...(grade
              ? [{ type: "setClip" as const, clipId: clip.id, grade }]
              : []),
          ]
        : [],
    ),
  );
}
