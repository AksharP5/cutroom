import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  applyFileMutations,
  fileContentVersion,
  historyCache,
  openProjectHistory,
} from "@hyperframes/studio-server";
import type { FileMutationInput, HistoryWho } from "@hyperframes/studio-server";
import { z } from "zod";
import {
  CreateProjectSchema,
  ProjectDocumentSchema,
  ProjectSchema,
  emptyProjectDocument,
} from "../../shared/project";
import type {
  CreateProjectInput,
  Project,
  ProjectDocument,
} from "../../shared/project";
import { HttpError } from "../../shared/errors";

const RegistrySchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(ProjectSchema),
});
const DOCUMENT_PATH = "cutroom.json";
const PERSON: HistoryWho = { kind: "person", name: "You" };

export async function projectPath(
  project: Project,
  path: string,
  allowMissing = false,
): Promise<string> {
  if (!path || isAbsolute(path) || path.includes("\0"))
    throw new HttpError(400, "Use a project-relative file path.");
  const target = resolve(project.path, path);
  const rel = relative(project.path, target);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
    throw new HttpError(403, "That path is outside the project.");
  const canonical = await realpath(target).catch(async (error: unknown) => {
    if (!isMissing(error)) throw error;
    if (!allowMissing) throw new HttpError(404, "Project file not found.");
    return join(await realpath(dirname(target)), basename(target));
  });
  const canonicalRoot = await realpath(project.path);
  const canonicalRelative = relative(canonicalRoot, canonical);
  if (
    canonicalRelative.startsWith(`..${sep}`) ||
    canonicalRelative === ".." ||
    isAbsolute(canonicalRelative)
  ) {
    throw new HttpError(403, "Links outside the project cannot be accessed.");
  }
  return canonical;
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readSource(project: Project, path = "index.html") {
  const absolute = await projectPath(project, path);
  const info = await stat(absolute);
  if (!info.isFile() || info.size > 10 * 1024 * 1024)
    throw new HttpError(422, "Choose a text file smaller than 10 MB.");
  const content = await readFile(absolute, "utf8");
  if (content.includes("\0"))
    throw new HttpError(422, "This file is not text.");
  return { path, content, version: fileContentVersion(content) };
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function starter(input: z.infer<typeof CreateProjectSchema>): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>${escapeHtml(input.name)}</title>
<style>@font-face{font-family:"IBM Plex Sans";src:url("assets/fonts/regular.woff2") format("woff2");font-weight:400;font-style:normal}@font-face{font-family:"IBM Plex Sans";src:url("assets/fonts/semibold.woff2") format("woff2");font-weight:600;font-style:normal}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#141b21;color:#f3f0e9;font-family:"IBM Plex Sans",sans-serif}.stage{position:relative;width:${input.width}px;height:${input.height}px;background:#141b21}.title{position:absolute;left:9%;top:37%;font-size:${Math.round(input.width / 18)}px;letter-spacing:-.045em;line-height:1.05;font-weight:600;max-width:80%}.rule{position:absolute;left:9%;top:29%;width:7%;height:5px;background:#df764c}.caption{position:absolute;left:9%;bottom:15%;font-size:${Math.round(input.width / 60)}px;color:#a5afb4}</style></head>
<body><main id="main" data-composition-id="main" data-no-timeline data-width="${input.width}" data-height="${input.height}" data-duration="${input.duration}" class="stage">
<div id="rule" class="clip rule" data-start="0" data-duration="${input.duration}" data-track-index="0"></div>
<div id="headline" class="clip title" data-start="0" data-duration="${input.duration}" data-track-index="1">${escapeHtml(input.name)}</div>
<div id="caption" class="clip caption" data-start="0" data-duration="${input.duration}" data-track-index="2">A new composition.</div>
</main></body></html>\n`;
}

export async function createProjectStore(options: {
  dataDir: string;
  projectsDir?: string;
}) {
  const dataDir = resolve(options.dataDir);
  const projectsDir = resolve(options.projectsDir ?? join(dataDir, "projects"));
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  const registryPath = join(dataDir, "projects.json");
  let projects: Project[] = await readFile(registryPath, "utf8")
    .then((raw) => RegistrySchema.parse(JSON.parse(raw)).projects)
    .catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
  const histories = historyCache((projectDir) =>
    openProjectHistory({
      projectDir,
      historyRoot: join(dataDir, "history"),
      undoScope: "everyone",
    }),
  );
  const documentReads = new WeakMap<ProjectDocument, string | null>();
  const queues = new Map<string, Promise<unknown>>();
  let registryQueue: Promise<unknown> = Promise.resolve();
  const saveRegistry = () => {
    const pending = registryQueue.then(() =>
      atomicJson(registryPath, { schemaVersion: 1, projects }),
    );
    registryQueue = pending.catch(() => undefined);
    return pending;
  };
  const get = async (id: string) => {
    const project = projects.find((item) => item.id === id);
    if (!project) throw new HttpError(404, "Project not found.");
    await stat(project.path).catch(() => {
      throw new HttpError(404, "The project folder is unavailable.");
    });
    return project;
  };
  const history = async (project: Project) => {
    const opened = await histories.get(project.path);
    if (!opened) throw new HttpError(503, "Project history is unavailable.");
    return opened;
  };
  const mutate = async <T>(
    project: Project,
    label: string,
    change: () => Promise<T>,
    who: HistoryWho = PERSON,
  ): Promise<T> => {
    const previous = queues.get(project.id) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(async () => {
        const ledger = await history(project);
        const window = await ledger.beginWindow(who, label);
        try {
          const result = await change();
          project.updatedAt = new Date().toISOString();
          await saveRegistry();
          return result;
        } finally {
          await window.close();
        }
      });
    queues.set(project.id, pending);
    try {
      return await pending;
    } finally {
      if (queues.get(project.id) === pending) queues.delete(project.id);
    }
  };
  const document = async (project: Project): Promise<ProjectDocument> => {
    const raw = await readFile(
      await projectPath(project, DOCUMENT_PATH, true),
      "utf8",
    ).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (raw === null) {
      const value = emptyProjectDocument();
      documentReads.set(value, null);
      return value;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new HttpError(
        422,
        "cutroom.json is not valid JSON. Restore it from project history before editing.",
      );
    }
    const parsed = ProjectDocumentSchema.safeParse(json);
    if (!parsed.success)
      throw new HttpError(
        422,
        "cutroom.json is invalid. Restore it from project history before editing.",
      );
    documentReads.set(parsed.data, raw);
    return parsed.data;
  };
  const documentMutation = async (
    project: Project,
    value: ProjectDocument,
  ): Promise<FileMutationInput> => {
    const absolute = await projectPath(project, DOCUMENT_PATH, true);
    let before = documentReads.get(value);
    if (before === undefined)
      throw new Error("Read the project document before changing it.");
    if (before === null) {
      before = `${JSON.stringify(emptyProjectDocument(), null, 2)}\n`;
      await writeFile(absolute, before, { flag: "wx" }).catch(
        (error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
            throw new HttpError(
              409,
              "Project metadata changed outside the editor. Refresh before saving.",
            );
          throw error;
        },
      );
    }
    return {
      sourceFile: DOCUMENT_PATH,
      absPath: absolute,
      before,
      after: `${JSON.stringify(value, null, 2)}\n`,
      expectedVersion: fileContentVersion(before),
    };
  };
  const writeDocument = async (
    project: Project,
    value: ProjectDocument,
    additional: FileMutationInput[] = [],
  ) => {
    ProjectDocumentSchema.parse(value);
    const mutation = await documentMutation(project, value);
    try {
      applyFileMutations(project.path, [...additional, mutation]);
      documentReads.set(value, mutation.after);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "file changed since the timeline was read"
      )
        throw new HttpError(
          409,
          "Project files changed outside the editor. Refresh before saving.",
        );
      throw error;
    }
  };
  return {
    dataDir,
    projectsDir,
    list: async () =>
      [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    get,
    history,
    historyForDir: (dir: string) => histories.get(dir),
    mutate,
    document,
    writeDocument,
    async create(raw: CreateProjectInput) {
      const input = CreateProjectSchema.parse(raw);
      const id = randomUUID();
      const slug =
        input.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "project";
      const path = join(projectsDir, `${slug}-${id.slice(0, 8)}`);
      await mkdir(path);
      const fonts = join(path, "assets", "fonts");
      await mkdir(fonts, { recursive: true });
      await Promise.all([
        copyFile(
          new URL(
            import.meta
              .resolve("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2"),
          ),
          join(fonts, "regular.woff2"),
        ),
        copyFile(
          new URL(
            import.meta
              .resolve("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2"),
          ),
          join(fonts, "semibold.woff2"),
        ),
        copyFile(
          new URL(
            "LICENSE",
            new URL(
              import.meta.resolve("@fontsource/ibm-plex-sans/package.json"),
            ),
          ),
          join(fonts, "LICENSE.txt"),
        ),
      ]);
      await writeFile(join(path, "index.html"), starter(input));
      await writeFile(
        join(path, DOCUMENT_PATH),
        `${JSON.stringify(emptyProjectDocument(), null, 2)}\n`,
      );
      const now = new Date().toISOString();
      const project: Project = {
        id,
        name: input.name,
        path,
        createdAt: now,
        updatedAt: now,
      };
      projects.push(project);
      await saveRegistry();
      return project;
    },
    async importProject(input: { path: string; name?: string }) {
      if (!isAbsolute(input.path))
        throw new HttpError(400, "Choose an absolute project folder path.");
      const path = await realpath(input.path).catch(() => {
        throw new HttpError(404, "The project folder does not exist.");
      });
      const info = await stat(join(path, "index.html")).catch(() => null);
      if (!info?.isFile())
        throw new HttpError(
          422,
          "This folder needs an index.html HyperFrames composition.",
        );
      const existing = projects.find((project) => project.path === path);
      if (existing) return existing;
      const now = new Date().toISOString();
      const project: Project = {
        id: randomUUID(),
        name: input.name ?? basename(path),
        path,
        createdAt: now,
        updatedAt: now,
      };
      projects.push(project);
      await saveRegistry();
      return project;
    },
    close: () => histories.closeAll(),
  };
}

export type ProjectStore = Awaited<ReturnType<typeof createProjectStore>>;
