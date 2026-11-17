import type { HistoryFileChange } from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import { freezeExportPath, isFreezeExport } from "../../shared/media";
import type { Project } from "../../shared/project";
import { compositionVersions } from "./changes";
import { compositionSources } from "./media";
import { freezeTrashSources } from "./mediaTrash";

/** Check the composition sources that will survive replay while the old aliases still resolve. */
export async function guardFreezeHistory(
  project: Pick<Project, "path">,
  changes: readonly HistoryFileChange[],
  readBlob: (hash: string) => Promise<Buffer>,
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
  // Exempt the intended Media Remove. Equal bytes at another path are a different still.
  const trashed = new Set<string>();
  for (const { path, before, after } of changes) {
    if (before !== null || after === null) continue;
    const sources = freezeTrashSources(path).filter(
      (source) => deleted.get(source) === after,
    );
    if (sources.length === 1) trashed.add(sources[0]!);
  }
  for (const path of trashed) deleted.delete(path);
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
