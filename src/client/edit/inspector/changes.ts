import type { TimelineView } from "../../../shared/timeline/schema";

type ClipEdits = NonNullable<TimelineView["clipEdits"]>;
export const pendingEdit = (edit: ClipEdits[number]) =>
  edit.by === "agent" && !edit.accepted && !edit.resolution;

/** Linked partners share a history entry, but keep their own review records. */
export function groupedChanges(edits: ClipEdits) {
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
    return {
      ...edit,
      id: members[0]!.id,
      label: [...new Set(members.map((edit) => edit.label))].join("; "),
      members,
    };
  });
}

/**
 * The review list's rows: one per distinct change, counted when it repeats. Edits with no
 * sentence of their own share their file's label, so a file edited five times is one row.
 */
export function reviewRows(edits: ClipEdits) {
  const rows = new Map<string, { id: string; label: string; count: number }>();
  for (const edit of edits) {
    const row = rows.get(edit.label);
    if (row) row.count++;
    else rows.set(edit.label, { id: edit.id, label: edit.label, count: 1 });
  }
  return [...rows.values()];
}

export type ChangeRow = ReturnType<typeof groupedChanges>[number];

/**
 * The timeline's own ledger: one row per history step, worded as the step's factual summary
 * when it has one, rather than as the part one clip played in it.
 */
export function ledgerChanges(edits: ClipEdits): ChangeRow[] {
  return groupedChanges(edits).map((edit) => ({
    ...edit,
    label: (
      edit.members.find((member) => member.clipId === null) ?? edit.members[0]!
    ).label,
  }));
}

/** `limit` recent rows, making room for every pending agent edit even when it is older. */
export function shownChanges<T extends ClipEdits[number]>(
  edits: T[],
  expanded: boolean,
  limit: number,
): T[] {
  const recent = edits.toReversed();
  if (expanded) return recent;
  let slots = Math.max(0, limit - edits.filter(pendingEdit).length);
  return recent.filter((edit) => pendingEdit(edit) || slots-- > 0);
}
