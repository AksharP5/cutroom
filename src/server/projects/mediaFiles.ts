import { renameSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, join, posix, relative } from "node:path";
import { isProjectIgnoredDir } from "@hyperframes/core/project-folders";
import {
  affectsProjectSignature,
  fileContentVersion,
} from "@hyperframes/studio-server";
import type { FileMutationInput, HistoryWho } from "@hyperframes/studio-server";
import type { z } from "zod";
import { HttpError } from "../../shared/errors";
import {
  FREEZE_DIR,
  FREEZE_EXPORT_DIR,
  freezeExportPath,
  inFreezeAssets,
  inMediaTrash,
  isFreezeExport,
  isMediaItem,
} from "../../shared/media";
import type { MediaRemoveSchema, MediaRenameSchema } from "../../shared/media";
import type { Project } from "../../shared/project";
import { TimelineError } from "../../shared/timeline/errors";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import { compositionScope, parseComposition } from "../timeline/composition";
import { compositionSources } from "./media";
import { mediaRemoveLabel, mediaTrashPath } from "./mediaTrash";
import { isMissing, projectStatePath, projectWritePath } from "./path";
import type { ProjectStore } from "./store";
import { compositionVersions } from "./changes";
import { mediaReferenceRenamer } from "./mediaReferences";
import type { ProjectEntry } from "./mediaReferences";
import { sceneSources } from "./sceneSources";
import { moveSourceMarks } from "./view";
import { freezeCompanion } from "./freezeAssets";

const SOURCE_BYTES = 10 * 1024 * 1024;

/** Resolve a still's export path to the same Media item as its preview path. */
async function mediaFile(project: Project, raw: string) {
  const requested = posix.normalize(raw.replaceAll("\\", "/"));
  const path = isFreezeExport(requested)
    ? `${FREEZE_DIR}/${requested.slice(FREEZE_EXPORT_DIR.length + 1)}`
    : requested;
  const companion = await freezeCompanion(project, path);
  if (requested !== path && companion?.path !== requested)
    throw new HttpError(404, "Freeze frame not found.");
  if (!isMediaItem(path))
    throw new HttpError(400, "Choose a video, audio, or image file.");
  const absolute = await projectWritePath(project, path, { sourceOnly: false });
  const canonical = relative(await realpath(project.path), absolute).replaceAll(
    "\\",
    "/",
  );
  if (canonical !== path && (inFreezeAssets(path) || inFreezeAssets(canonical)))
    throw new HttpError(403, "Use the freeze frame's Media path.");
  // The file itself moves, never the target of a link.
  if (!(await lstat(join(project.path, path))).isFile())
    throw new HttpError(400, "Choose a video, audio, or image file.");
  return { path, absolute, canonical, name: posix.basename(path), companion };
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );

/** Count linked clips once, and retain a conservative use for shared CSS/script references. */
export async function mediaUses(project: Project, raw: string) {
  const { canonical, companion } = await mediaFile(project, raw);
  const counts = new Map<string, number>();
  const resolveScene = sceneSources(project.path);
  for await (const {
    path: composition,
    canonical: sourceFile,
    content,
    mounted,
  } of compositionSources(project)) {
    const { references, canonicalMedia, sceneImages } =
      await compositionVersions(project, composition, {
        content,
        mounted,
        resolveScene,
      });
    const usesFile = (paths: Set<string> | undefined) =>
      paths &&
      [...paths].some((reference) => {
        const resolved = canonicalMedia.get(reference);
        return (
          resolved === canonical ||
          (companion !== undefined && resolved === companion.path)
        );
      });
    const owners = new Set<string | number>();
    const links = new Map<string, string>();
    try {
      const { timeline } = parseComposition(content, emptyTimelineSettings(), {
        scope: compositionScope(composition),
      });
      for (const clip of timeline.clips) {
        if (clip.link) links.set(clip.id, clip.link);
        if (usesFile(references.get(clip.id))) owners.add(clip.link ?? clip.id);
      }
    } catch (error) {
      if (!(error instanceof TimelineError)) throw error;
    }
    for (const [owner, paths] of sceneImages)
      if (usesFile(paths))
        owners.add(
          typeof owner === "string" ? (links.get(owner) ?? owner) : owner,
        );
    counts.set(
      sourceFile,
      Math.max(
        counts.get(sourceFile) ?? 0,
        owners.size,
        usesFile(references.get(null)) ? 1 : 0,
      ),
    );
  }
  return [...counts.values()].reduce((total, count) => total + count, 0);
}

/** Read only editable sources, resolving references against each source's directory. */
async function referenceEdits(
  project: Project,
  names: Map<string, string>,
  freeze: boolean,
) {
  const sources: { path: string; absolute: string; before: string }[] = [];
  const entries = new Map<string, ProjectEntry>([[".", "directory"]]);
  const directories = [""];
  for (const directory of directories) {
    for (const entry of await readdir(join(project.path, directory), {
      withFileTypes: true,
    })) {
      const path = posix.join(directory, entry.name);
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.isSymbolicLink() ||
        inMediaTrash(path)
      ) {
        entries.set(path, "unscanned");
        continue;
      }
      if (entry.isDirectory()) {
        entries.set(path, "directory");
        directories.push(path);
      }
      if (!entry.isFile()) continue;
      entries.set(path, "file");
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
  const renameReferences = mediaReferenceRenamer(project, names, entries);
  const edits: FileMutationInput[] = [];
  for (const { path, absolute, before } of sources) {
    const after = await renameReferences(before, path);
    if (after === before) continue;
    if (freeze && !affectsProjectSignature(project.path, absolute))
      throw new HttpError(
        409,
        `Renaming this freeze frame would change ${path} outside project history.`,
      );
    const sourceFile = names.get(path) ?? path;
    edits.push({
      sourceFile,
      absPath:
        sourceFile !== path
          ? await projectWritePath(project, sourceFile, { allowMissing: true })
          : absolute,
      before,
      after,
      expectedVersion: fileContentVersion(before),
    });
  }
  if (freeze) {
    const html = new Map(
      sources
        .filter(({ path }) => /\.html?$/i.test(path))
        .map(({ path, before }) => [path, before]),
    );
    const drafted = new Map(
      edits.map(({ sourceFile, after }) => [sourceFile, after]),
    );
    const readChanged = async (path: string) => drafted.get(path);
    for await (const {
      path,
      canonical,
      content,
      mounted,
    } of compositionSources(project, {
      files: html.keys(),
      readOverride: async (path) => html.get(path),
    })) {
      if (html.has(path) && !path.split("/").some(isProjectIgnoredDir))
        continue;
      const after = drafted.get(canonical) ?? content;
      if ((await renameReferences(content, path)) === after) {
        const { canonicalMedia } = await compositionVersions(project, path, {
          content: after,
          mounted,
          readChanged,
        });
        if (![...canonicalMedia.values()].some((asset) => names.has(asset)))
          continue;
      }
      throw new HttpError(
        409,
        `Renaming this freeze frame would leave a broken reference in ${path}.`,
      );
    }
  }
  return edits;
}

function moveFiles(
  moves: { absolute: string; destination: string }[],
  writeSources?: () => void,
) {
  const moved: typeof moves = [];
  try {
    for (const move of moves) {
      renameSync(move.absolute, move.destination);
      moved.push(move);
    }
    writeSources?.();
  } catch (error) {
    const failures: unknown[] = [];
    for (const { absolute, destination } of moved.reverse()) {
      try {
        renameSync(destination, absolute);
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Could not roll back the media move.",
      );
    throw error;
  }
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
  if (path === file.path) return { path, sources: [], historyId: undefined };
  const absolute = await projectWritePath(project, path, {
    allowMissing: true,
    sourceOnly: false,
  });
  const exportPath = freezeExportPath(path);
  const exportAbsolute = exportPath
    ? await projectStatePath(project, exportPath, true)
    : undefined;
  if (
    (await exists(absolute)) ||
    (exportAbsolute && (await exists(exportAbsolute)))
  )
    throw new HttpError(
      409,
      `${input.name} already exists in this folder. Choose another name.`,
    );
  const historyPaths = new Set([file.canonical, path]);
  const { value, entry } = await store.mutateWithEntry(
    project,
    `Rename ${file.name} to ${input.name}`,
    async () => {
      const names = new Map([
        [file.canonical, posix.join(posix.dirname(file.canonical), input.name)],
      ]);
      const moves = [{ absolute: file.absolute, destination: absolute }];
      if (file.companion && exportPath && exportAbsolute) {
        names.set(file.companion.path, exportPath);
        historyPaths.add(file.companion.path);
        historyPaths.add(exportPath);
        moves.push({
          absolute: file.companion.absolute,
          destination: exportAbsolute,
        });
      }
      const edits = await referenceEdits(
        project,
        names,
        exportPath !== undefined,
      );
      moveFiles(moves, () => store.writeFiles(project, edits));
      await moveSourceMarks(project, file.path, path);
      return { path, sources: edits.map((edit) => edit.sourceFile) };
    },
    who,
    { moves: historyPaths, category: "media" },
  );
  return { ...value, ...(entry && { historyId: entry.id }) };
}

/**
 * Moves a Media item into the project's trash in one history step, including its export PNG.
 */
export async function removeMedia(
  store: ProjectStore,
  project: Project,
  input: z.output<typeof MediaRemoveSchema>,
  who?: HistoryWho,
) {
  const file = await mediaFile(project, input.path);
  const historyPaths = new Set([file.canonical]);
  const { value, entry } = await store.mutateWithEntry(
    project,
    mediaRemoveLabel(file.path),
    async () => {
      for (let copy = 1; ; copy++) {
        const trash = mediaTrashPath(file.path, copy);
        const absolute = await projectWritePath(project, trash, {
          allowMissing: true,
          sourceOnly: false,
        });
        if (await exists(absolute)) continue;
        const moves = [{ absolute: file.absolute, destination: absolute }];
        if (file.companion) {
          const destination = await projectWritePath(
            project,
            mediaTrashPath(file.companion.path, copy),
            {
              allowMissing: true,
              sourceOnly: false,
            },
          );
          if (await exists(destination)) continue;
          moves.push({ absolute: file.companion.absolute, destination });
        }
        for (const { destination } of moves)
          await mkdir(dirname(destination), { recursive: true });
        historyPaths.add(trash);
        if (file.companion) {
          historyPaths.add(file.companion.path);
          historyPaths.add(mediaTrashPath(file.companion.path, copy));
        }
        moveFiles(moves);
        return { path: file.path, trash };
      }
    },
    who,
    { moves: historyPaths, category: "media" },
  );
  return { ...value, ...(entry && { historyId: entry.id }) };
}
