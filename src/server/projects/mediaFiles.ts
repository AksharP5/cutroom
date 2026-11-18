import { lstat, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { dirname, extname, join, posix } from "node:path";
import { fileContentVersion } from "@hyperframes/studio-server";
import type { FileMutationInput, HistoryWho } from "@hyperframes/studio-server";
import type { z } from "zod";
import { HttpError } from "../../shared/errors";
import {
  MEDIA_TRASH,
  inMediaTrash,
  localMediaPath,
  mediaKind,
} from "../../shared/media";
import type { MediaRemoveSchema, MediaRenameSchema } from "../../shared/media";
import type { Project } from "../../shared/project";
import { TimelineError } from "../../shared/timeline/errors";
import {
  parseSceneVariableValues,
  sceneImageUrl,
} from "../../shared/variables";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import {
  compositionScope,
  parseComposition,
  sourceVariables,
} from "../timeline/composition";
import { compositionFiles } from "./media";
import { isMissing, projectWritePath } from "./path";
import { readSource } from "./store";
import type { ProjectStore } from "./store";
import { compositionVersions } from "./changes";
import { sceneSourceBase, sceneSourcePath } from "./sceneSources";
import { renameReferences } from "./mediaReferences";
import { moveSourceMarks } from "./view";

const SOURCE_BYTES = 10 * 1024 * 1024;

/** A media file the panel lists: a regular file of a known kind, outside the trash. */
async function mediaFile(project: Project, raw: string) {
  const path = posix.normalize(raw.replaceAll("\\", "/"));
  if (!mediaKind(path) || inMediaTrash(path))
    throw new HttpError(400, "Choose a video, audio, or image file.");
  const absolute = await projectWritePath(project, path, { sourceOnly: false });
  // The file itself moves, never the target of a link.
  if (!(await lstat(join(project.path, path))).isFile())
    throw new HttpError(400, "Choose a video, audio, or image file.");
  return { path, absolute, name: posix.basename(path) };
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );

function sceneImageIndex(load: (path: string) => Promise<string | undefined>) {
  const cache = new Map<string, ReadonlySet<string>>();
  return async (composition: string, html: string) => {
    const from = html.includes("data-variable-values")
      ? await sceneSourceBase(
          composition,
          html,
          async () => (await load("index.html")) ?? "",
        )
      : null;
    return async (src: string) => {
      const path = from && sceneSourcePath(from, src);
      if (!path) return;
      const cached = cache.get(path);
      if (cached) return cached;
      const source = await load(path);
      const ids = new Set(
        source
          ? sourceVariables(source, "sub-composition").declarations.flatMap(
              ({ id, type }) => (type === "image" ? [id] : []),
            )
          : [],
      );
      cache.set(path, ids);
      return ids;
    };
  };
}

/** Count linked clips once, and retain a conservative use for shared CSS/script references. */
export async function mediaUses(project: Project, raw: string) {
  const { path } = await mediaFile(project, raw);
  let uses = 0;
  const imageIdsAt = sceneImageIndex(async (file) => {
    try {
      return (await readSource(project, file)).content;
    } catch (error) {
      if (error instanceof HttpError || isMissing(error)) return;
      throw error;
    }
  });
  for (const composition of await compositionFiles(project)) {
    const { references } = await compositionVersions(project, composition);
    const { content: source } = await readSource(project, composition);
    const sceneImageIds = await imageIdsAt(composition, source);
    const owners = new Set<string>();
    try {
      const { timeline, elements } = parseComposition(
        source,
        emptyTimelineSettings(),
        { scope: compositionScope(composition) },
      );
      for (const clip of timeline.clips) {
        if (references.get(clip.id)?.has(path)) {
          owners.add(clip.link ?? clip.id);
          continue;
        }
        if (clip.kind !== "composition" || !clip.src) continue;
        const raw = elements.get(clip.id)?.attrs["data-variable-values"];
        if (raw === undefined) continue;
        const ids = await sceneImageIds(clip.src);
        if (!ids?.size) continue;
        const values = parseSceneVariableValues(raw);
        if (
          values &&
          [...ids].some((id) => {
            const url = sceneImageUrl(values[id]);
            return url && localMediaPath("index.html", url) === path;
          })
        )
          owners.add(clip.link ?? clip.id);
      }
    } catch (error) {
      if (!(error instanceof TimelineError)) throw error;
    }
    uses += Math.max(owners.size, references.get(null)?.has(path) ? 1 : 0);
  }
  return uses;
}

/** Read only editable sources, resolving references against each source's directory. */
async function referenceEdits(project: Project, from: string, to: string) {
  const sources: { path: string; absolute: string; before: string }[] = [];
  const files = new Set<string>();
  const directories = [""];
  for (const directory of directories) {
    for (const entry of await readdir(join(project.path, directory), {
      withFileTypes: true,
    })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = posix.join(directory, entry.name);
      if (inMediaTrash(path)) continue;
      if (entry.isDirectory()) directories.push(path);
      if (!entry.isFile()) continue;
      files.add(path);
      const absolute = await projectWritePath(project, path).catch(
        (error: unknown) => {
          if (error instanceof HttpError && error.status === 403) return null;
          throw error;
        },
      );
      if (absolute !== null && (await lstat(absolute)).size <= SOURCE_BYTES) {
        sources.push({
          path,
          absolute,
          before: await readFile(absolute, "utf8"),
        });
      }
    }
  }
  const edits: FileMutationInput[] = [];
  const sourceByPath = new Map(
    sources.map(({ path, before }) => [path, before]),
  );
  const imageIdsAt = sceneImageIndex(async (file) => sourceByPath.get(file));
  for (const { path, absolute, before } of sources) {
    const after = await renameReferences(
      before,
      path,
      from,
      to,
      files,
      await imageIdsAt(path, before),
    );
    if (after === before) continue;
    const sourceFile = path === from ? to : path;
    edits.push({
      sourceFile,
      absPath:
        path === from
          ? await projectWritePath(project, to, { allowMissing: true })
          : absolute,
      before,
      after,
      expectedVersion: fileContentVersion(before),
    });
  }
  return edits;
}

/** Renames a media file in its folder and points every source reference at the new name. */
export async function renameMedia(
  store: ProjectStore,
  project: Project,
  input: z.output<typeof MediaRenameSchema>,
  who?: HistoryWho,
) {
  const file = await mediaFile(project, input.path);
  if (extname(input.name).toLowerCase() !== extname(file.name).toLowerCase())
    throw new HttpError(
      400,
      `Keep the ${extname(file.name)} extension. Renaming does not convert the file.`,
    );
  const path = posix.join(posix.dirname(file.path), input.name);
  if (path === file.path) return { path, sources: [] };
  const absolute = await projectWritePath(project, path, {
    allowMissing: true,
    sourceOnly: false,
  });
  if (await exists(absolute))
    throw new HttpError(
      409,
      `${input.name} already exists in this folder. Choose another name.`,
    );
  return store.mutate(
    project,
    `Rename ${file.name} to ${input.name}`,
    async () => {
      const edits = await referenceEdits(project, file.path, path);
      await rename(file.absolute, absolute);
      try {
        store.writeFiles(project, edits);
      } catch (error) {
        // A source changed under the rewrite: leave the project as it was.
        await rename(absolute, file.absolute);
        throw error;
      }
      await moveSourceMarks(project, file.path, path);
      return { path, sources: edits.map((edit) => edit.sourceFile) };
    },
    who,
  );
}

/**
 * Moves a media file into the project's trash folder. History sees one move between two tracked
 * paths, so undo moves the file back, including video and audio it never keeps a copy of.
 */
export async function removeMedia(
  store: ProjectStore,
  project: Project,
  input: z.output<typeof MediaRemoveSchema>,
  who?: HistoryWho,
) {
  const file = await mediaFile(project, input.path);
  return store.mutate(
    project,
    `Remove ${file.name}`,
    async () => {
      const extension = extname(file.name);
      const stem = file.name.slice(0, file.name.length - extension.length);
      for (let copy = 1; ; copy++) {
        const trash = `${MEDIA_TRASH}/${stem}${copy === 1 ? "" : ` ${copy}`}${extension}`;
        const absolute = await projectWritePath(project, trash, {
          allowMissing: true,
          sourceOnly: false,
        });
        if (await exists(absolute)) continue;
        await mkdir(dirname(absolute), { recursive: true });
        await rename(file.absolute, absolute);
        return { path: file.path, trash };
      }
    },
    who,
  );
}
