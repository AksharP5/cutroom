import { resolve } from "node:path";
import type { Project, ProjectDocument } from "../../shared/project";
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
import type { Track } from "../../shared/timeline/schema";

const hasTrackMix = ({ enabled, muted, solo, volume, fx }: Track) =>
  !enabled || muted || solo || volume !== 1 || fx.length > 0;

/** Only settings the preview projects onto the composition. */
export function trackMixStamp(document: ProjectDocument) {
  const compositions = Object.entries(document.timelines).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify(
    compositions.flatMap(([composition, settings]) => {
      const tracks = settings.tracks
        .filter(hasTrackMix)
        .map(({ index, kind, enabled, muted, solo, volume, fx }) => [
          index,
          kind,
          enabled,
          muted,
          solo,
          volume,
          fx,
        ]);
      const { soloAudioGroups: solo } = settings;
      return tracks.length || solo.length
        ? [[composition, tracks, ...(solo.length ? [solo] : [])]]
        : [];
    }),
  );
}

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
        !settings.tracks.some(hasTrackMix) &&
        !settings.soloAudioGroups.length &&
        !/data-cutroom-(track(?:-hidden)?|muted)\b/.test(source.content)
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
