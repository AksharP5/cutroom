import { resolvePreviewCompositionSrc } from "@hyperframes/core/compiler";
import { collectSubCompositionSrcs } from "@hyperframes/parsers/asset-resolution";
import type { HistoryFileChange } from "../history/historyLog";
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { HttpError } from "../../shared/errors";
import type { Project } from "../../shared/project";
import { compositionSources } from "./media";

export async function guardSceneRemoval(
  project: Pick<Project, "path">,
  changes: readonly HistoryFileChange[],
  readBlob: (hash: string) => Promise<Buffer>,
) {
  const sources = new Map(
    changes
      .filter(({ path }) => /\.html?$/i.test(path))
      .map(({ path, after }) => [path, after]),
  );
  if (![...sources.values()].includes(null)) return;
  const root = await realpath(project.path);
  for await (const { path, content } of compositionSources(project, {
    changed: sources.keys(),
    readOverride: async (path) => {
      const hash = sources.get(path);
      return hash ? (await readBlob(hash)).toString("utf8") : hash;
    },
  })) {
    for (const src of collectSubCompositionSrcs(content)) {
      const scene = resolvePreviewCompositionSrc(project.path, path, src);
      if (!scene) continue;
      const canonical = relative(root, await realpath(scene.file))
        .split(sep)
        .join("/");
      if (sources.get(canonical) === null)
        throw new HttpError(
          409,
          `History would remove ${canonical}, which is still mounted by ${path}.`,
        );
    }
  }
}
