import { resolve } from "node:path";
import type { Project } from "../../shared/project";
import { HttpError } from "../../shared/errors";
import { isMissing, readSource } from "../projects/store";
import type { ProjectStore } from "../projects/store";
import {
  applyTrackMix,
  compositionScope,
  mediaSources,
  parseComposition,
} from "./composition";
import { mediaFacts } from "./media";

/** Mix state is projected on read, so outside writes need no follow-up command or history entry. */
export async function readTrackMix(store: ProjectStore, project: Project) {
  const document = await store.document(project);
  const sources = await Promise.all(
    Object.entries(document.timelines).map(async ([composition, settings]) => {
      const source = await readSource(project, composition).catch(
        (error: unknown) => {
          if (
            isMissing(error) ||
            (error instanceof HttpError && error.status === 404)
          )
            return null;
          throw error;
        },
      );
      if (!source) return null;
      if (
        !settings.tracks.some(
          (track) => !track.enabled || track.muted || track.solo,
        ) &&
        !/data-cutroom-(track-hidden|muted)/.test(source.content)
      )
        return null;
      const scope = compositionScope(composition);
      const { lengths } = await mediaFacts(
        project,
        composition,
        mediaSources(source.content, scope),
      );
      const parsed = parseComposition(source.content, settings, {
        scope,
        mediaLengths: lengths,
      });
      return {
        path: resolve(project.path, composition),
        settings,
        lengths,
        composition,
        html: applyTrackMix(parsed),
      };
    }),
  );
  return sources.filter((source) => source !== null);
}
