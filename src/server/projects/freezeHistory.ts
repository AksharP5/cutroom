import type { HistoryFileChange } from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import {
  freezeExportPath,
  inMediaTrash,
  isFreezeExport,
} from "../../shared/media";
import type { Project } from "../../shared/project";
import { compositionVersions } from "./changes";
import { compositionFiles } from "./media";

/** Check the composition sources that will survive replay while the old aliases still resolve. */
export async function guardFreezeHistory(
  project: Pick<Project, "path">,
  changes: readonly HistoryFileChange[],
  readBlob: (hash: string) => Promise<Buffer>,
) {
  // Media Remove intentionally leaves its uses offline and keeps the bytes in trash.
  const trashed = new Set(
    changes
      .filter(({ path, before }) => before === null && inMediaTrash(path))
      .map(({ after }) => after),
  );
  const deleted = new Set(
    changes
      .filter(
        ({ path, before, after }) =>
          after === null &&
          !trashed.has(before) &&
          (freezeExportPath(path) || isFreezeExport(path)),
      )
      .map(({ path }) => path),
  );
  if (!deleted.size) return;

  const next = new Map(changes.map(({ path, after }) => [path, after]));
  const readChanged = async (path: string) => {
    const hash = next.get(path);
    return hash ? (await readBlob(hash)).toString("utf8") : hash;
  };
  const compositions = new Set([
    ...(await compositionFiles(project)),
    ...changes
      .filter(({ path, after }) => after !== null && /\.html?$/i.test(path))
      .map(({ path }) => path),
  ]);
  for (const composition of compositions) {
    if (next.get(composition) === null || inMediaTrash(composition)) continue;
    const { canonicalMedia } = await compositionVersions(
      project,
      composition,
      readChanged,
    );
    for (const asset of canonicalMedia.values()) {
      if (deleted.has(asset))
        throw new HttpError(
          409,
          `History would remove ${asset}, which is still used by ${composition}. Undo or remove that use first.`,
        );
    }
  }
}
