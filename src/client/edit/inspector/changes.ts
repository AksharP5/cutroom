import type { TimelineView } from "../../../shared/timeline/schema";

type ClipEdits = NonNullable<TimelineView["clipEdits"]>;
export const pendingEdit = (edit: ClipEdits[number]) =>
  edit.by === "agent" && !edit.accepted && !edit.resolution;

/** Five recent rows, making room for every pending agent edit even when it is older. */
export function shownChanges(edits: ClipEdits, expanded: boolean): ClipEdits {
  const recent = edits.toReversed();
  if (expanded) return recent;
  let slots = Math.max(0, 5 - edits.filter(pendingEdit).length);
  return recent.filter((edit) => pendingEdit(edit) || slots-- > 0);
}
