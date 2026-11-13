import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, posix } from "node:path";
import {
  createStudioApi,
  fileContentVersion,
} from "@hyperframes/studio-server";
import type {
  FileMutationInput,
  HistoryWho,
  StudioApiAdapter,
} from "@hyperframes/studio-server";
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
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import { compositionScope, parseComposition } from "../timeline/composition";
import { compositionFiles } from "./media";
import { isMissing, projectWritePath } from "./path";
import { readSource } from "./store";
import type { ProjectStore } from "./store";

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

/** Timeline clips that play `path` in any composition. A clip and its linked sound count once. */
export async function mediaUses(project: Project, raw: string) {
  const { path } = await mediaFile(project, raw);
  let uses = 0;
  for (const file of await compositionFiles(project)) {
    const composition = file.replaceAll("\\", "/");
    const source = await readSource(project, composition);
    try {
      const { timeline } = parseComposition(
        source.content,
        emptyTimelineSettings(),
        { scope: compositionScope(composition) },
      );
      uses += new Set(
        timeline.clips
          .filter(
            (clip) =>
              clip.src !== null &&
              localMediaPath(composition, clip.src) === path,
          )
          .map((clip) => clip.link ?? clip.id),
      ).size;
    } catch (error) {
      // A file that is not a timeline holds no clips to count.
      if (!(error instanceof TimelineError)) throw error;
    }
  }
  return uses;
}

/**
 * The source edits that point every reference at `to`. HyperFrames' rename rewrites references in
 * every text file it finds, hidden agent settings and instruction files included, so it runs on a
 * copy that holds only the sources Cutroom may edit. Every other file is an empty stand-in, there
 * so the rewriter can tell which file a relative reference names.
 */
async function referenceEdits(project: Project, from: string, to: string) {
  const copy = await mkdtemp(join(tmpdir(), "cutroom-rename-"));
  try {
    const sources: { path: string; absolute: string; before: string }[] = [];
    const directories = [""];
    for (const directory of directories) {
      await mkdir(join(copy, directory), { recursive: true });
      for (const entry of await readdir(join(project.path, directory), {
        withFileTypes: true,
      })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules")
          continue;
        const path = posix.join(directory, entry.name);
        if (entry.isDirectory()) directories.push(path);
        if (!entry.isFile()) continue;
        const absolute = await projectWritePath(project, path).catch(
          (error: unknown) => {
            if (error instanceof HttpError && error.status === 403) return null;
            throw error;
          },
        );
        const source =
          absolute !== null && (await lstat(absolute)).size <= SOURCE_BYTES
            ? { path, absolute, before: await readFile(absolute, "utf8") }
            : null;
        if (source) sources.push(source);
        await writeFile(join(copy, path), source?.before ?? "");
      }
    }
    const unused = () => {
      throw new Error("A rename only rewrites references.");
    };
    const adapter: StudioApiAdapter = {
      listProjects: () => [],
      resolveProject: (id) => ({ id, dir: copy }),
      bundle: unused,
      lint: unused,
      runtimeUrl: "",
      rendersDir: unused,
      startRender: unused,
    };
    const response = await createStudioApi(adapter).request(
      `http://localhost/projects/copy/files/${from.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPath: to }),
      },
    );
    if (!response.ok)
      throw new Error(
        `HyperFrames could not rewrite the references (${response.status}): ${await response.text()}`,
      );
    const edits: FileMutationInput[] = [];
    for (const { path, absolute, before } of sources) {
      const after = await readFile(join(copy, path), "utf8");
      if (after !== before)
        edits.push({
          sourceFile: path,
          absPath: absolute,
          before,
          after,
          expectedVersion: fileContentVersion(before),
        });
    }
    return edits;
  } finally {
    await rm(copy, { recursive: true, force: true });
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
