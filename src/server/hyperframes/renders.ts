import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { Stats } from "node:fs";
import { z } from "zod";
import { isMissing, projectStatePath } from "../projects/path";
import { HttpError } from "../../shared/errors";
import type { Project } from "../../shared/project";
import { ExportFormatSchema } from "../../shared/export";
import type { RenderFile } from "../../shared/export";

const INDEX = ".cutroom/renders.json";
const DEFAULT_DIRECTORY = ".cutroom/renders";
const RENDER = /\.(mp4|mov|webm|gif)$/i;

/** What a published file looked like, so a file replaced or edited since is no longer Cutroom's. */
const IdentitySchema = z.object({
  path: z.string(),
  dev: z.number(),
  ino: z.number(),
  size: z.number(),
  mtimeMs: z.number(),
});
const IndexSchema = z.object({ renders: z.array(IdentitySchema) });
type Identity = z.infer<typeof IdentitySchema>;

const identity = (path: string, info: Stats): Identity => ({
  path,
  dev: info.dev,
  ino: info.ino,
  size: info.size,
  mtimeMs: info.mtimeMs,
});
const same = (a: Identity, b: Identity) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs;
const fileAt = (path: string) =>
  lstat(path).then(
    (info) => (info.isFile() ? info : undefined),
    (error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    },
  );

/**
 * The renders Cutroom made for each project: every export in the project's own `.cutroom/renders`,
 * and the ones published to other folders, which `.cutroom/renders.json` records. Only these can be
 * deleted, and only while the file is still the one Cutroom wrote.
 */
export function createRenderIndex() {
  /** Index writes per project, in order. */
  const queues = new Map<string, Promise<unknown>>();
  const queued = <T>(
    project: Pick<Project, "path">,
    task: () => Promise<T>,
  ) => {
    const next = (queues.get(project.path) ?? Promise.resolve()).then(
      task,
      task,
    );
    queues.set(
      project.path,
      next.catch(() => {}),
    );
    return next;
  };
  const readIndex = async (project: Pick<Project, "path">) => {
    const path = await projectStatePath(project, INDEX, true);
    const raw = await readFile(path, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    return {
      path,
      renders: raw ? IndexSchema.parse(JSON.parse(raw)).renders : [],
    };
  };
  const writeIndex = async (path: string, renders: Identity[]) => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ renders }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  };

  async function list(project: Pick<Project, "path">): Promise<RenderFile[]> {
    const directory = await projectStatePath(project, DEFAULT_DIRECTORY, true);
    const names = await readdir(directory).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    const inFolder = await Promise.all(
      names
        .filter((name) => RENDER.test(name))
        .map(async (name) => {
          const path = join(directory, name);
          const info = await fileAt(path);
          return info && { path, info };
        }),
    );
    const { renders } = await readIndex(project);
    const elsewhere = await Promise.all(
      renders
        .filter((render) => dirname(render.path) !== directory)
        .map(async (render) => {
          const info = await fileAt(render.path);
          return info && same(identity(render.path, info), render)
            ? { path: render.path, info }
            : undefined;
        }),
    );
    return [...inFolder, ...elsewhere]
      .filter((render) => render !== undefined)
      .map(({ path, info }) => ({
        path,
        format: ExportFormatSchema.parse(extname(path).slice(1).toLowerCase()),
        sizeBytes: info.size,
        modifiedAt: info.mtimeMs,
      }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  return {
    list,
    /** Called once an export is published at `path`. */
    record: (project: Pick<Project, "path">, path: string) =>
      queued(project, async () => {
        const info = await fileAt(path);
        if (!info) return;
        const index = await readIndex(project);
        await writeIndex(index.path, [
          ...index.renders.filter((render) => render.path !== path),
          identity(path, info),
        ]);
      }),
    /** Deletes a listed render. Anything else, including a file changed since, is refused. */
    remove: (project: Pick<Project, "path">, path: string) =>
      queued(project, async () => {
        if (!(await list(project)).some((render) => render.path === path))
          throw new HttpError(
            404,
            "That file is not one of this project's renders, or it changed since Cutroom wrote it.",
          );
        await unlink(path);
        const index = await readIndex(project);
        const kept = index.renders.filter((render) => render.path !== path);
        if (kept.length !== index.renders.length)
          await writeIndex(index.path, kept);
      }),
  };
}
