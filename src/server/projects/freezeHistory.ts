import { START } from "../history/historyLog";
import type { HistoryEntry, HistoryFileChange } from "../history/historyLog";
import type { ProjectHistoryOptions } from "../history/projectHistory";
import { HttpError } from "../../shared/errors";
import {
  freezeExportPath,
  inMediaTrash,
  isFreezeExport,
} from "../../shared/media";
import type { Project } from "../../shared/project";
import { compositionVersions } from "./changes";
import { compositionSources } from "./media";
import { removedFreezeSource } from "./mediaTrash";

type ReplayContext = Parameters<
  NonNullable<ProjectHistoryOptions["beforeReplay"]>
>[2];

function exemptRecordedRemovals(
  deleted: Map<string, string | null>,
  changes: readonly HistoryFileChange[],
  context: ReplayContext,
) {
  const trashWrites = changes.flatMap(({ path, before, after }) =>
    before === null && after !== null && inMediaTrash(path)
      ? [{ path, hash: after }]
      : [],
  );
  if (!trashWrites.length) return;

  const { entries } = context;
  const offsets = new Map(entries.map(({ id }, index) => [id, index]));
  const targetOf = ({
    restoredTo,
    undoes,
  }: Pick<HistoryEntry, "undoes" | "restoredTo">) => {
    if (restoredTo !== undefined)
      return restoredTo === START ? -1 : offsets.get(restoredTo);
    const reversed = undoes === undefined ? undefined : offsets.get(undoes);
    return reversed === undefined ? undefined : reversed - 1;
  };
  const target = targetOf(context);
  if (target === undefined) return;

  // Replay entries repeat a past version. Follow the path back to its original write.
  const writtenAt = (path: string, point: number) => {
    while (point >= 0) {
      const entry = entries[point]!;
      const change = entry.files.find((change) => change.path === path);
      if (!change) {
        point--;
        continue;
      }
      if (change.after === null) return;
      if (!entry.undoes && !entry.restoredTo) return point;
      const target = targetOf(entry);
      if (target === undefined || target >= point) return;
      point = target;
    }
    return -1;
  };
  for (const { path, hash } of trashWrites) {
    const removedAt = writtenAt(path, target);
    if (removedAt === undefined || removedAt < 0) continue;
    const source = removedFreezeSource(entries[removedAt]!, path, hash);
    if (!source || deleted.get(source) !== hash) continue;
    const original = writtenAt(source, removedAt - 1);
    if (
      original !== undefined &&
      original === writtenAt(source, entries.length - 1)
    )
      deleted.delete(source);
  }
}

/** Check the composition sources that will survive replay while the old aliases still resolve. */
export async function guardFreezeHistory(
  project: Pick<Project, "path">,
  changes: readonly HistoryFileChange[],
  readBlob: (hash: string) => Promise<Buffer>,
  context: ReplayContext,
) {
  const deleted = new Map(
    changes
      .filter(
        ({ path, after }) =>
          after === null && (freezeExportPath(path) || isFreezeExport(path)),
      )
      .map(({ path, before }) => [path, before]),
  );
  if (!deleted.size) return;
  exemptRecordedRemovals(deleted, changes, context);
  if (!deleted.size) return;

  const next = new Map(changes.map(({ path, after }) => [path, after]));
  const readChanged = async (path: string) => {
    const hash = next.get(path);
    return hash ? (await readBlob(hash)).toString("utf8") : hash;
  };
  const changed = changes
    .filter(({ path, after }) => after !== null && /\.html?$/i.test(path))
    .map(({ path }) => path);
  for await (const { path, content, mounted } of compositionSources(project, {
    changed,
    readOverride: readChanged,
  })) {
    const { canonicalMedia } = await compositionVersions(project, path, {
      content,
      mounted,
      readChanged,
    });
    for (const asset of canonicalMedia.values()) {
      if (deleted.has(asset))
        throw new HttpError(
          409,
          `History would remove ${asset}, which is still used by ${path}. Undo or remove that use first.`,
        );
    }
  }
}
