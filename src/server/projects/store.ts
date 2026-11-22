import { historyCache } from "../history/historyCache";
import {
  openProjectHistory,
  readProjectHistory,
} from "../history/projectHistory";
import { fpsToFfmpegArg } from "@hyperframes/core";
import { projectEditedAt } from "./edited";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { ownerWho } from "./historyActor";
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
} from "@hyperframes/studio-server";
import type { FileMutationInput } from "@hyperframes/studio-server";
import type { HistoryEntry, HistoryWho } from "../history/historyLog";
import { z } from "zod";
import {
  CreateProjectSchema,
  ProjectDocumentSchema,
  ProjectNameSchema,
  ProjectSchema,
  emptyProjectDocument,
  PROJECT_DOCUMENT_PATH,
} from "../../shared/project";
import type {
  CreateProjectInput,
  Project,
  ProjectDocument,
} from "../../shared/project";
import { HttpError } from "../../shared/errors";
import { guardFreezeHistory } from "./freezeHistory";
import { rememberTimelineWrite } from "../timeline/watch";
import { guardSceneRemoval } from "./historyDependencies";
import { isMissing, projectPath, projectWritePath } from "./path";

export { isMissing, projectPath } from "./path";

const RegistrySchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(ProjectSchema),
});

/** cutroom.json cannot be read. Project history can still restore it. */
export class ProjectDocumentError extends HttpError {
  constructor(detail: string) {
    super(
      422,
      `cutroom.json ${detail}. Restore it from project history before editing.`,
    );
  }
}

export async function readSource(
  project: Pick<Project, "path">,
  path = "index.html",
) {
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

/**
 * Open-licence fonts every new project carries and declares, so a title's Font menu has real
 * choices and export finds the same faces. Each file sits beside its licence in `assets/fonts`.
 */
const PROJECT_FONTS = [
  {
    family: "Instrument Sans",
    file: "InstrumentSans-var.woff2",
    source: new URL(
      "../../client/fonts/InstrumentSans-var.woff2",
      import.meta.url,
    ),
    license: "INSTRUMENT-SANS.txt",
    axes: "font-weight: 400 700;\n  font-stretch: 75% 100%;",
  },
  {
    family: "Oswald",
    file: "Oswald-var.woff2",
    source: new URL("fonts/Oswald-var.woff2", import.meta.url),
    license: "OSWALD.txt",
    axes: "font-weight: 200 700;",
  },
  {
    family: "Fraunces",
    file: "Fraunces-var.woff2",
    source: new URL("fonts/Fraunces-var.woff2", import.meta.url),
    license: "FRAUNCES.txt",
    axes: "font-weight: 100 900;",
  },
  {
    family: "Martian Mono",
    file: "MartianMono-var.woff2",
    source: new URL("fonts/MartianMono-var.woff2", import.meta.url),
    license: "MARTIAN-MONO.txt",
    axes: "font-weight: 100 800;\n  font-stretch: 75% 112.5%;",
  },
] as const;

type PageFormat = Pick<
  z.infer<typeof CreateProjectSchema>,
  "name" | "width" | "height" | "fps" | "duration"
>;

/**
 * A timeline page with the project's fonts and styles, holding `clips`: empty for a new timeline,
 * or the starter clips of a new project.
 */
export function timelinePage(input: PageFormat, clips = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>${escapeHtml(input.name)}</title>
<script src="assets/vendor/gsap.min.js"></script>
<style>
${PROJECT_FONTS.map(
  (font) => `@font-face {
  font-family: "${font.family}";
  src: url("assets/fonts/${font.file}") format("woff2");
  ${font.axes}
  font-style: normal;
  font-display: block;
}
`,
).join("")}* { box-sizing: border-box; }
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
<body><main id="main" data-composition-id="main" data-no-timeline data-width="${input.width}" data-height="${input.height}" data-fps="${fpsToFfmpegArg(input.fps)}" data-duration="${input.duration}" class="stage">
${clips}</main></body></html>\n`;
}

function starter(input: z.infer<typeof CreateProjectSchema>): string {
  return timelinePage(
    input,
    `<div id="rule" class="clip background" data-start="0" data-duration="${input.duration}" data-track-index="0" data-label="Background"></div>
<div id="headline" class="clip title" data-start="0" data-duration="${input.duration}" data-track-index="1" data-label="Project title">${escapeHtml(input.name)}</div>
<div id="caption" class="clip caption" data-start="0" data-duration="${input.duration}" data-track-index="2" data-label="Getting started">Drop media in, or ask your agent to start.</div>
`,
  );
}

/** A project folder's name stem, from its display name. */
export const projectSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "project";

const committedEntries = new AsyncLocalStorage<{ id?: string }>();

/** Runs a request and returns the newest history entry its writes committed, so the editor can address its next Undo. */
export async function trackCommittedEntry(run: () => Promise<void>) {
  const committed: { id?: string } = {};
  await committedEntries.run(committed, run);
  return committed.id;
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
      onError: (error) =>
        console.warn(
          "Cutroom history:",
          error instanceof Error ? error.message : String(error),
        ),
      beforeReplay: async (changes, readBlob, context) => {
        await guardFreezeHistory(
          { path: projectDir },
          changes,
          readBlob,
          context,
        );
        if (context.replay)
          await guardSceneRemoval({ path: projectDir }, changes, readBlob);
      },
      // A moved folder or a deleted .hyperframes/history-id looks like a gone project.
      // Undo history is only removed by the owner, never on a timer.
      pruneGoneProjectsBudgetMs: 0,
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
  const find = (id: string) => {
    const project = projects.find((item) => item.id === id);
    if (!project) throw new HttpError(404, "Project not found.");
    return project;
  };
  const get = async (id: string) => {
    const project = find(id);
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
  const serializeMutation = <T>(project: Project, change: () => Promise<T>) =>
    track(async () => {
      const previous = queues.get(project.path) ?? Promise.resolve();
      const pending = previous.catch(() => undefined).then(change);
      queues.set(project.path, pending);
      try {
        return await pending;
      } finally {
        if (queues.get(project.path) === pending) queues.delete(project.path);
      }
    });
  const ownWrites = new AsyncLocalStorage<{
    root: string;
    changes: Map<string, { before: string | null; after: string }[]>;
  }>();
  const recordedHash = (content: string | Uint8Array) =>
    createHash("sha256").update(content).digest("hex");
  const captureWrite = (
    absolute: string,
    before: string | null,
    after: string,
  ) => {
    const scope = ownWrites.getStore();
    if (!scope) return;
    const path = relative(scope.root, absolute).split(sep).join("/");
    const changes = scope.changes.get(path) ?? [];
    changes.push({ before, after });
    scope.changes.set(path, changes);
  };
  const captureHistoryCreation = (
    absolute: string,
    content: string | Uint8Array,
  ) => captureWrite(absolute, null, recordedHash(content));
  /**
   * Writes a new file at the first of `paths` nobody has, never over an existing one, as part of
   * the running mutation's history entry. Null when every path is taken.
   */
  const createFile = async (
    project: Project,
    paths: Iterable<string>,
    content: (path: string) => string,
  ) => {
    for (const path of paths) {
      const absolute = await projectWritePath(project, path, {
        allowMissing: true,
      });
      await mkdir(dirname(absolute), { recursive: true });
      const text = content(path);
      const written = await writeFile(absolute, text, { flag: "wx" }).then(
        () => true,
        (error: unknown) => {
          if (!(error instanceof Error && "code" in error)) throw error;
          if (error.code === "EEXIST") return false;
          if (error.code === "ENAMETOOLONG")
            throw new HttpError(400, "That name is too long for a file.");
          throw error;
        },
      );
      if (!written) continue;
      captureHistoryCreation(absolute, text);
      return path;
    }
    return null;
  };
  const mutateWithEntry = <T>(
    project: Project,
    label: string,
    change: () => Promise<T>,
    who: HistoryWho = ownerWho,
    options?: {
      moves?: ReadonlySet<string>;
      category?: HistoryEntry["category"];
    },
  ) =>
    serializeMutation(project, async () => {
      const ledger = await history(project);
      const scope: NonNullable<ReturnType<typeof ownWrites.getStore>> = {
        root: await realpath(project.path),
        changes: new Map(),
      };
      let finished = false;
      const window = await ledger.beginWindow(who, label, {
        idleMs: Infinity,
        accepts: (path, before, after) => {
          if (options?.moves?.has(path)) return true;
          const changes = scope.changes.get(path);
          if (!changes) return false;
          for (let index = changes.length - 1; index >= 0; index--) {
            const written = changes[index]!;
            if (written.after !== after) continue;
            if (written.before === before) return true;
            after = written.before;
          }
          return false;
        },
        category: options?.category,
        incomplete: (recorded) => {
          if (!finished && !recorded.size) return false;
          for (const [path, changes] of scope.changes) {
            const before = changes[0]?.before;
            const after = changes.at(-1)?.after;
            if (before === after) continue;
            const file = recorded.get(path);
            if (!file || file.before !== before || file.after !== after)
              return true;
          }
          return (
            !!options?.moves &&
            [...options.moves].some((path) => !recorded.has(path))
          );
        },
      });
      let value: T;
      let entry: HistoryEntry | null;
      try {
        value = await ownWrites.run(scope, change);
        finished = true;
        project.updatedAt = new Date().toISOString();
        await saveRegistry();
      } finally {
        entry = await window.close();
      }
      return { value, entry };
    }).then((result) => {
      const committed = committedEntries.getStore();
      // Ordinary Undo skips imports, so they never become the editor's next target.
      if (committed && result.entry && result.entry.category !== "import")
        committed.id = result.entry.id;
      return result;
    });
  const mutate = <T>(
    project: Project,
    label: string,
    change: () => Promise<T>,
    who?: HistoryWho,
  ) => mutateWithEntry(project, label, change, who).then(({ value }) => value);
  const document = async (project: Project): Promise<ProjectDocument> => {
    const raw = await readFile(
      await projectWritePath(project, PROJECT_DOCUMENT_PATH, {
        allowMissing: true,
      }),
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
    const absolute = await projectWritePath(project, PROJECT_DOCUMENT_PATH, {
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
      captureHistoryCreation(absolute, before);
    }
    return {
      sourceFile: PROJECT_DOCUMENT_PATH,
      absPath: absolute,
      before,
      after: `${JSON.stringify(value, null, 2)}\n`,
      expectedVersion: fileContentVersion(before),
    };
  };
  const writeFiles = (
    project: Project,
    mutations: FileMutationInput[],
    origin?: string,
  ) => {
    try {
      const applied = applyFileMutations(project.path, mutations);
      const capture = ownWrites.getStore();
      for (const [index, file] of applied.entries()) {
        if (!file.changed) continue;
        const { absPath } = mutations[index]!;
        rememberTimelineWrite(absPath, () => file.version, origin);
        if (capture)
          captureWrite(
            absPath,
            recordedHash(file.before),
            recordedHash(file.after),
          );
      }
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
    origin?: string,
  ) => {
    ProjectDocumentSchema.parse(value);
    const mutation = await documentMutation(project, value);
    writeFiles(project, [...additional, mutation], origin);
    documentReads.set(value, mutation.after);
  };
  return {
    dataDir,
    projectsDir,
    list: async () => {
      const current = await Promise.all(
        projects.map(async (project) => ({
          ...project,
          updatedAt: await projectEditedAt(project),
        })),
      );
      return current.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    get,
    history,
    readHistory: (project: Project) =>
      readProjectHistory({
        projectDir: project.path,
        historyRoot: join(dataDir, "history"),
      }),
    historyForDir: (dir: string) => histories.get(dir),
    mutate,
    mutateWithEntry,
    captureHistoryCreation,
    createFile,
    serializeMutation,
    document,
    writeDocument,
    writeFiles,
    async create(raw: CreateProjectInput) {
      return track(async () => {
        const input = CreateProjectSchema.parse(raw);
        const id = randomUUID();
        const path = join(
          projectsDir,
          `${projectSlug(input.name)}-${id.slice(0, 8)}`,
        );
        await mkdir(path);
        const fonts = join(path, "assets", "fonts");
        await mkdir(fonts, { recursive: true });
        await Promise.all(
          PROJECT_FONTS.flatMap((font) => [
            copyFile(font.source, join(fonts, font.file)),
            copyFile(
              new URL(`../../../licenses/${font.license}`, import.meta.url),
              join(fonts, font.file.replace("-var.woff2", "-LICENSE.txt")),
            ),
          ]),
        );
        const vendor = join(path, "assets", "vendor");
        await mkdir(vendor);
        // Keep the distribution's license notice with the project, including offline exports.
        await copyFile(
          Bun.resolveSync("gsap/dist/gsap.min.js", import.meta.dir),
          join(vendor, "gsap.min.js"),
        );
        await writeFile(join(path, "index.html"), starter(input));
        await writeFile(
          join(path, PROJECT_DOCUMENT_PATH),
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
    /** Changes only the display name. The folder, its history and every agent keep their keys. */
    async rename(id: string, name: string) {
      return track(async () => {
        const project = find(id);
        const previous = project.name;
        project.name = ProjectNameSchema.parse(name);
        await saveRegistry().catch((error: unknown) => {
          project.name = previous;
          throw error;
        });
        return project;
      });
    },
    /**
     * Takes a project off the list and leaves its folder and history on disk, so importing the
     * folder again brings the history back. `busy` names work that must finish first.
     */
    async remove(id: string, busy: (project: Project) => string | undefined) {
      return track(async () => {
        const project = find(id);
        // Edits already admitted finish first; later ones find no project.
        await serializeMutation(project, async () => {
          const reason = busy(project);
          if (reason) throw new HttpError(409, reason);
          projects = projects.filter((item) => item !== project);
          await saveRegistry().catch((error: unknown) => {
            projects = [...projects, project];
            throw error;
          });
        });
        const opened = histories.peek(project.path);
        histories.forget(project.path);
        await opened?.then((history) => history?.close());
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
