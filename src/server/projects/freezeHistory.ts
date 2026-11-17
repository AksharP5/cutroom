import type { HistoryFileChange } from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import {
  freezeExportPath,
  inMediaTrash,
  isFreezeExport,
} from "../../shared/media";
import type { Project } from "../../shared/project";
import { compositionVersions } from "./changes";
import { compositionSources } from "./media";

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
  const changed = changes
    .filter(({ path, after }) => after !== null && /\.html?$/i.test(path))
    .map(({ path }) => path);
  for await (const { path, content } of compositionSources(project, {
    changed,
    readOverride: readChanged,
  })) {
    const { canonicalMedia } = await compositionVersions(project, path, {
      content,
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
