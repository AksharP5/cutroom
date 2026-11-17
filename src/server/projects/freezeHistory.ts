import type { HistoryFileChange } from "@hyperframes/studio-server";
import { collectSubCompositionSrcs } from "@hyperframes/parsers/asset-resolution";
import { HttpError } from "../../shared/errors";
import {
  freezeExportPath,
  inMediaTrash,
  isFreezeExport,
  localMediaPath,
} from "../../shared/media";
import type { Project } from "../../shared/project";
import { compositionVersions } from "./changes";
import { compositionFiles } from "./media";
import { resolveProjectPath, unavailableProjectFile } from "./path";
import { readSource } from "./store";

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
  const discovered = new Set(await compositionFiles(project));
  const compositions = new Set([
    ...discovered,
    ...changes
      .filter(({ path, after }) => after !== null && /\.html?$/i.test(path))
      .map(({ path }) => path),
  ]);
  for (const composition of compositions) {
    if (inMediaTrash(composition)) continue;
    let content = await readChanged(composition);
    if (content === undefined && !discovered.has(composition)) {
      // A mounted alias can refer to a source changed or removed by replay.
      const resolved = await resolveProjectPath(project, composition).catch(
        (error: unknown) => {
          if (unavailableProjectFile(error)) return null;
          throw error;
        },
      );
      if (!resolved) continue;
      if (resolved.path !== composition)
        content = await readChanged(resolved.path);
    }
    if (content === null) continue;
    content ??= (await readSource(project, composition)).content;
    // Use the pinned compiler's project-root mount paths, including nested mounts.
    if (/data-composition-src/i.test(content))
      for (const src of collectSubCompositionSrcs(content)) {
        const path = localMediaPath("index.html", src);
        if (path && path !== "." && !path.includes("\0"))
          compositions.add(path);
      }
    const { canonicalMedia } = await compositionVersions(project, composition, {
      content,
      readChanged,
    });
    for (const asset of canonicalMedia.values()) {
      if (deleted.has(asset))
        throw new HttpError(
          409,
          `History would remove ${asset}, which is still used by ${composition}. Undo or remove that use first.`,
        );
    }
  }
}
