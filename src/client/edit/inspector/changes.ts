import { EDIT_LABEL_LIMIT } from "../../../shared/timeline/labels";
import type { TimelineView } from "../../../shared/timeline/schema";

type ClipEdits = NonNullable<TimelineView["clipEdits"]>;
export const pendingEdit = (edit: ClipEdits[number]) =>
  edit.by === "agent" && !edit.accepted && !edit.resolution;

/** A row spans one batch. Each affected clip keeps its own review record. */
export function ledgerChanges(edits: ClipEdits, clipIds?: ReadonlySet<string>) {
  const groups = new Map<string, ClipEdits>();
  const batchLabels = new Map<string, string[]>();

  for (const edit of edits) {
    const key = edit.historyId ?? edit.id;
    if (edit.batchLabels) batchLabels.set(key, edit.batchLabels);
    if (clipIds && (edit.clipId === null || !clipIds.has(edit.clipId)))
      continue;
    const group = groups.get(key);
    if (group) group.push(edit);
    else groups.set(key, [edit]);
  }
  return [...groups].map(([key, members]) => {
    // Keep partially accepted or superseded groups actionable until all pending work is reviewed.
    const edit =
      members.find(pendingEdit) ??
      members.find((edit) => edit.resolution) ??
      members[0]!;
    const raw = clipIds
      ? [...new Set(members.map((member) => member.label))].join("; ")
      : (members.find((member) => member.clipId === null) ?? members[0]!).label;
    const saved = batchLabels.get(key);
    const annotation = raw.match(/; (Agent label: [\s\S]+)$/);
    const summary = annotation ? raw.slice(0, annotation.index) : raw;
    // Older rows only have the bounded history label, which may end mid-batch.
    const labels = saved ?? summary.split("; ");
    const more =
      labels.length < 2
        ? null
        : !saved && Array.from(summary).length === EDIT_LABEL_LIMIT
          ? "and more"
          : `and ${labels.length - 1} more`;
    return {
      ...edit,
      id: members[0]!.id,
      label: labels[0] ?? raw,
      more,
      details: saved
        ? [...saved, annotation?.[1]].filter(Boolean).join("\n")
        : raw,
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

export type ChangeRow = ReturnType<typeof ledgerChanges>[number];

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
