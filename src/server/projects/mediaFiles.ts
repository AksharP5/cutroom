import { renameSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, join, posix, relative } from "node:path";
import { fileContentVersion } from "@hyperframes/studio-server";
import type { FileMutationInput, HistoryWho } from "@hyperframes/studio-server";
import type { z } from "zod";
import { HttpError } from "../../shared/errors";
import {
  FREEZE_DIR,
  FREEZE_EXPORT_DIR,
  MEDIA_TRASH,
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
import { compositionFiles } from "./media";
import { isMissing, projectStatePath, projectWritePath } from "./path";
import { readSource } from "./store";
import type { ProjectStore } from "./store";
import { compositionVersions } from "./changes";
import { mediaReferenceRenamer } from "./mediaReferences";
import type { ProjectEntry } from "./mediaReferences";
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
  let uses = 0;
  for (const composition of await compositionFiles(project)) {
    const { references, canonicalMedia } = await compositionVersions(
      project,
      composition,
    );
    const usesFile = (paths: Set<string> | undefined) =>
      paths &&
      [...paths].some((reference) => {
        const resolved = canonicalMedia.get(reference);
        return (
          resolved === canonical ||
          (companion !== undefined && resolved === companion.path)
        );
      });
    const source = await readSource(project, composition);
    const owners = new Set<string>();
    try {
      const { timeline } = parseComposition(
        source.content,
        emptyTimelineSettings(),
        { scope: compositionScope(composition) },
      );
      for (const clip of timeline.clips) {
        if (usesFile(references.get(clip.id))) owners.add(clip.link ?? clip.id);
      }
    } catch (error) {
      if (!(error instanceof TimelineError)) throw error;
    }
    uses += Math.max(owners.size, usesFile(references.get(null)) ? 1 : 0);
  }
  return uses;
}

/** Read only editable sources, resolving references against each source's directory. */
async function referenceEdits(project: Project, names: Map<string, string>) {
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
  if (path === file.path) return { path, sources: [] };
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
  return store.mutate(
    project,
    `Rename ${file.name} to ${input.name}`,
    async () => {
      const names = new Map([
        [file.canonical, posix.join(posix.dirname(file.canonical), input.name)],
      ]);
      const moves = [{ absolute: file.absolute, destination: absolute }];
      if (file.companion && exportPath && exportAbsolute) {
        names.set(file.companion.path, exportPath);
        moves.push({
          absolute: file.companion.absolute,
          destination: exportAbsolute,
        });
      }
      const edits = await referenceEdits(project, names);
      moveFiles(moves, () => store.writeFiles(project, edits));
      await moveSourceMarks(project, file.path, path);
      return { path, sources: edits.map((edit) => edit.sourceFile) };
    },
    who,
  );
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
  return store.mutate(
    project,
    `Remove ${file.name}`,
    async () => {
      const extension = extname(file.name);
      const stem = file.name.slice(0, file.name.length - extension.length);
      for (let copy = 1; ; copy++) {
        const name = `${stem}${copy === 1 ? "" : ` ${copy}`}${extension}`;
        const trash = `${MEDIA_TRASH}/${name}`;
        const absolute = await projectWritePath(project, trash, {
          allowMissing: true,
          sourceOnly: false,
        });
        if (await exists(absolute)) continue;
        const moves = [{ absolute: file.absolute, destination: absolute }];
        if (file.companion) {
          const destination = await projectWritePath(
            project,
            `${MEDIA_TRASH}/${FREEZE_EXPORT_DIR}/${name}`,
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
        moveFiles(moves);
        return { path: file.path, trash };
      }
    },
    who,
  );
}
