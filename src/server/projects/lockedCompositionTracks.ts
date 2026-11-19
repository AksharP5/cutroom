import type { Project, ProjectDocument } from "../../shared/project";
import { resolveProjectPath, unavailableProjectFile } from "./path";

/** Track locks follow the source file, including settings saved under its project-local aliases. */
export async function lockedCompositionTracks(
  project: Pick<Project, "path">,
  composition: string,
  timelines: ProjectDocument["timelines"],
): Promise<ReadonlySet<number>> {
  const indices = await Promise.all(
    Object.entries(timelines).map(async ([path, { tracks }]) => {
      const locked = tracks.filter((track) => track.locked);
      if (!locked.length) return [];
      if (path !== composition) {
        const alias = await resolveProjectPath(project, path).catch(
          (error: unknown) => {
            if (unavailableProjectFile(error)) return null;
            throw error;
          },
        );
        if (alias?.path !== composition) return [];
      }
      return locked.map(({ index }) => index);
    }),
  );
  return new Set(indices.flat());
}
