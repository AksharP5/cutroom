import type { TimelineView } from "../../../shared/timeline/schema";

type ClipEdits = NonNullable<TimelineView["clipEdits"]>;
export const pendingEdit = (edit: ClipEdits[number]) =>
  edit.by === "agent" && !edit.accepted && !edit.resolution;

/** Linked partners share a history entry, but keep their own review records. */
export function groupedChanges(edits: ClipEdits, name: string) {
  const groups = new Map<string, ClipEdits>();
  for (const edit of edits) {
    const key = edit.historyId ?? edit.id;
    const group = groups.get(key);
    if (group) group.push(edit);
    else groups.set(key, [edit]);
  }
  return [...groups.values()].map((members) => {
    // Keep partially accepted or superseded groups actionable until all pending work is reviewed.
    const edit =
      members.find(pendingEdit) ??
      members.find((edit) => edit.resolution) ??
      members[0]!;
    const label = [...new Set(members.map((edit) => edit.label))].join("; ");
    return {
      ...edit,
      id: members[0]!.id,
      label:
        new Set(members.map((edit) => edit.clipId)).size > 1
          ? `${name} · ${label}`
          : label,
      members,
    };
  });
}

/** Five recent rows, making room for every pending agent edit even when it is older. */
export function shownChanges<T extends ClipEdits[number]>(
  edits: T[],
  expanded: boolean,
): T[] {
  const recent = edits.toReversed();
  if (expanded) return recent;
  let slots = Math.max(0, 5 - edits.filter(pendingEdit).length);
  return recent.filter((edit) => pendingEdit(edit) || slots-- > 0);
}
