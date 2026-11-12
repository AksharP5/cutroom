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
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  applyFileMutations,
  fileContentVersion,
  historyCache,
  openProjectHistory,
  readProjectHistory,
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
import { isMissing, projectPath, projectWritePath } from "./path";

export { isMissing, projectPath } from "./path";

const RegistrySchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(ProjectSchema),
});
const DOCUMENT_PATH = "cutroom.json";

/** cutroom.json cannot be read. Project history can still restore it. */
export class ProjectDocumentError extends HttpError {
  constructor(detail: string) {
    super(
      422,
      `cutroom.json ${detail}. Restore it from project history before editing.`,
    );
  }
}
const PERSON: HistoryWho = { kind: "person", name: "You" };

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
<style>
@font-face {
  font-family: "Instrument Sans";
  src: url("assets/fonts/InstrumentSans-var.woff2") format("woff2");
  font-weight: 400 700;
  font-stretch: 75% 100%;
  font-style: normal;
  font-display: block;
}
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
body { color: #ededed; background: #111111; font-family: "Instrument Sans", system-ui, sans-serif; }
.stage { position: relative; width: 100%; height: 100%; overflow: hidden; }
.background { position: absolute; inset: 0; background: #111111; }
.title {
  position: absolute; left: 12%; right: 12%; bottom: 44%; margin: 0;
  font-size: ${Math.round(Math.min(input.width / 20, input.height / 9))}px;
  font-weight: 500; letter-spacing: -.035em; line-height: 1.1;
  overflow-wrap: anywhere;
}
.caption {
  position: absolute; left: 12%; right: 12%; top: 61%; margin: 0;
  font-size: ${Math.round(Math.min(input.width, input.height) / 36)}px;
  font-weight: 400; line-height: 1.5; color: #a8a8a8;
}
</style></head>
<body><main id="main" data-composition-id="main" data-no-timeline data-width="${input.width}" data-height="${input.height}" data-duration="${input.duration}" class="stage">
<div id="rule" class="clip background" data-start="0" data-duration="${input.duration}" data-track-index="0" data-label="Background"></div>
<div id="headline" class="clip title" data-start="0" data-duration="${input.duration}" data-track-index="1" data-label="Project title">${escapeHtml(input.name)}</div>
<div id="caption" class="clip caption" data-start="0" data-duration="${input.duration}" data-track-index="2" data-label="Getting started">Drop media in, or ask your agent to start.</div>
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
  const operations = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const track = <T>(change: () => Promise<T>): Promise<T> => {
    if (closing)
      return Promise.reject(
        new HttpError(503, "The project store is shutting down."),
      );
    const pending = change();
    operations.add(pending);
    void pending.then(
      () => operations.delete(pending),
      () => operations.delete(pending),
    );
    return pending;
  };
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
  const mutate = <T>(
    project: Project,
    label: string,
    change: () => Promise<T>,
    who: HistoryWho = PERSON,
  ): Promise<T> =>
    track(async () => {
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
    });
  const document = async (project: Project): Promise<ProjectDocument> => {
    const raw = await readFile(
      await projectWritePath(project, DOCUMENT_PATH, { allowMissing: true }),
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
      throw new ProjectDocumentError("is not valid JSON");
    }
    const parsed = ProjectDocumentSchema.safeParse(json);
    if (!parsed.success) throw new ProjectDocumentError("is invalid");
    documentReads.set(parsed.data, raw);
    return parsed.data;
  };
  const documentMutation = async (
    project: Project,
    value: ProjectDocument,
  ): Promise<FileMutationInput> => {
    const absolute = await projectWritePath(project, DOCUMENT_PATH, {
      allowMissing: true,
    });
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
  const writeFiles = (project: Project, mutations: FileMutationInput[]) => {
    try {
      applyFileMutations(project.path, mutations);
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
  const writeDocument = async (
    project: Project,
    value: ProjectDocument,
    additional: FileMutationInput[] = [],
  ) => {
    ProjectDocumentSchema.parse(value);
    const mutation = await documentMutation(project, value);
    writeFiles(project, [...additional, mutation]);
    documentReads.set(value, mutation.after);
  };
  return {
    /** Drain app-owned sidecar writes on shutdown without adding content history. */
    persistState: track,
    dataDir,
    projectsDir,
    list: async () =>
      [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    get,
    history,
    readHistory: (project: Project) =>
      readProjectHistory({
        projectDir: project.path,
        historyRoot: join(dataDir, "history"),
      }),
    historyForDir: (dir: string) => histories.get(dir),
    mutate,
    document,
    writeDocument,
    writeFiles,
    async create(raw: CreateProjectInput) {
      return track(async () => {
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
              "../../client/fonts/InstrumentSans-var.woff2",
              import.meta.url,
            ),
            join(fonts, "InstrumentSans-var.woff2"),
          ),
          copyFile(
            new URL("../../../licenses/INSTRUMENT-SANS.txt", import.meta.url),
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
      });
    },
    async importProject(input: { path: string; name?: string }) {
      return track(async () => {
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
      });
    },
    close() {
      closing ??= (async () => {
        await Promise.allSettled([...operations]);
        await registryQueue;
        await histories.closeAll();
      })();
      return closing;
    },
  };
}

export type ProjectStore = Awaited<ReturnType<typeof createProjectStore>>;
