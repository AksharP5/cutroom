import type { Clip, Title } from "../../shared/timeline/schema";
import { editTimeline } from "./timeline";

/** The look and motion last copied from a title, per project, since fonts belong to a project. */
const styles = new Map<string, Title>();

export const hasTitleStyle = (projectId: string) => styles.has(projectId);

export function copyTitleStyle(projectId: string, clip: Clip) {
  if (clip.title) styles.set(projectId, clip.title);
}

/** Gives every title in `clipIds` the copied style in one undo step; words and timing stay. */
export function pasteTitleStyle(projectId: string, clipIds: Iterable<string>) {
  const style = styles.get(projectId);
  if (!style) return;
  const ids = new Set(clipIds);
  void editTimeline(projectId, "Paste style", (timeline) =>
    timeline.clips
      .filter((clip) => clip.title && ids.has(clip.id))
      .map((clip) => ({ type: "setClip", clipId: clip.id, title: style })),
  );
}
