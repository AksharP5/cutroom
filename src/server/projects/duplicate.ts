import { randomUUID } from "node:crypto";
import { constants, createWriteStream, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  statfs,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, posix, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  hasCode,
  pinnedDirectory,
  sourceIdentity,
} from "../../local/mediaImport";
import { HttpError } from "../../shared/errors";
import { createJobMachine } from "../../shared/jobs";
import { MEDIA_TRASH } from "../../shared/media";
import type { DuplicateJob, Project } from "../../shared/project";
import { AGENT_HEADER, REVIEW_STATE_PATH } from "../../shared/review";
import { projectMutationGuard } from "./authorization";
import { onCopyQueue, stagedName } from "./mediaImport";
import { reviewNotesOnly } from "./review";
import type { ReviewService } from "./review";
import { projectSlug } from "./store";
import type { ProjectStore } from "./store";
import { VIEW_PATH } from "./view";

const STAGING_PREFIX = ".cutroom-duplicate-";
const stagingName =
  /^\.cutroom-duplicate-([1-9]\d*)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** Inside every staging folder, so the startup sweep only ever removes folders Cutroom made. */
const MARKER = ".cutroom-duplicate";
const MarkerSchema = z.object({
  host: z.string(),
  boot: z.string().nullable(),
  pid: z.number(),
});
/** A staging folder this young may belong to a Cutroom whose process the sweep cannot see. */
const SWEEP_AGE_MS = 10 * 60 * 1000;
/** Files above this copy after the snapshot, so they never hold the project's edits. */
const SMALL_BYTES = 1024 * 1024;
/**
 * The original's history, outputs, trash and cache. The copy starts its own history, so these
 * would only point at entries it does not have. Cache keys name the source file's inode and
 * times, which a copy never matches, so the copy makes its own.
 */
const LEFT_BEHIND = new Set([
  ".hyperframes",
  ".thumbnails",
  MEDIA_TRASH,
  ".cutroom/cache",
  ".cutroom/renders",
  ".cutroom/renders.json",
  ".cutroom/review-ledger.json",
  ".cutroom/review.v1.json",
  ".cutroom/history-skips.json",
  // An export's cutouts, removed when it ends.
  "mattes/.export",
]);
/** Replaced atomically outside the project lock, so they are copied as they are when copied. */
const UNPINNED = new Set([VIEW_PATH, REVIEW_STATE_PATH]);

const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const cannotClone = (error: unknown) =>
  hasCode(
    error,
    "EXDEV",
    "EOPNOTSUPP",
    "ENOTSUP",
    "ENOSYS",
    "EINVAL",
    "ENOTTY",
  );

type FileEntry = {
  kind: "file";
  path: string;
  identity: string;
  size: bigint;
  mode: number;
};
type Entry =
  | { kind: "directory"; path: string; mode: number }
  | { kind: "link"; path: string; target: string }
  | FileEntry;

/** "<name> copy", then "<name> copy 2" and on, within the 120 characters a project name allows. */
export function copyName(name: string, taken: Iterable<string>) {
  const names = new Set(taken);
  for (let copy = 1; ; copy++) {
    const suffix = copy === 1 ? " copy" : ` copy ${copy}`;
    const stem = Array.from(name);
    while (stem.join("").length + suffix.length > 120) stem.pop();
    const candidate = `${stem.join("").trimEnd()}${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
}

const inside = (root: string, path: string) =>
  path === root || path.startsWith(`${root}${sep}`);

/** Identifies this boot, so a staging folder from before a restart is known to be abandoned. */
const bootId = () => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
};

/**
 * Lists what the copy takes, never following a link: each folder is opened without following
 * one and read through that open handle, so a folder swapped for a link mid-walk is refused.
 */
async function snapshot(root: string) {
  const entries: Entry[] = [];
  const visit = async (directory: string, parent: string) => {
    const handle = await open(directory, directoryFlags);
    try {
      const pinned = pinnedDirectory(directory, handle.fd);
      for (const raw of await readdir(pinned, { encoding: "buffer" })) {
        const name = raw.toString("utf8");
        const path = parent ? `${parent}/${name}` : name;
        if (!Buffer.from(name, "utf8").equals(raw))
          throw new HttpError(
            422,
            `"${path}" has a name that is not valid UTF-8. Rename it, then duplicate the project.`,
          );
        if (LEFT_BEHIND.has(path) || stagedName.test(name)) continue;
        // Atomic writes in progress.
        if (parent === ".cutroom" && name.endsWith(".tmp")) continue;
        const absolute = join(pinned, name);
        const info = await lstat(absolute, { bigint: true });
        const mode = Number(info.mode & 0o777n);
        if (info.isDirectory()) {
          entries.push({ kind: "directory", path, mode });
          await visit(absolute, path);
        } else if (info.isFile())
          entries.push({
            kind: "file",
            path,
            identity: sourceIdentity(info),
            size: info.size,
            mode,
          });
        else if (info.isSymbolicLink()) {
          // Kept only when it resolves inside the project, through every link along the way.
          const target = await readlink(absolute);
          if (isAbsolute(target)) continue;
          const resolved = await realpath(join(root, path)).catch(() => null);
          if (resolved && inside(root, resolved))
            entries.push({ kind: "link", path, target });
        }
      }
    } finally {
      await handle.close();
    }
  };
  await visit(root, "");
  return entries;
}

const changed = (entry: FileEntry) =>
  new HttpError(
    409,
    `${entry.path} changed while the project was being copied. Try again.`,
  );

/** Opens a source without following a link; a pinned one must still be the file the walk saw. */
async function openSource(root: string, entry: FileEntry) {
  const file = await open(join(root, entry.path), fileFlags).catch(
    (error: unknown) => {
      if (hasCode(error, "ENOENT", "ENOTDIR", "ELOOP")) throw changed(entry);
      throw error;
    },
  );
  const unchanged = async () => {
    const info = await file.stat({ bigint: true });
    if (
      !info.isFile() ||
      (!UNPINNED.has(entry.path) && sourceIdentity(info) !== entry.identity)
    )
      throw changed(entry);
  };
  try {
    await unchanged();
  } catch (error) {
    await file.close();
    throw error;
  }
  return {
    file,
    unchanged,
    from: pinnedDirectory(join(root, entry.path), file.fd),
  };
}

/** Clones one file, or byte-copies it when `fallback` allows. True when it cloned. */
async function cloneFile(
  root: string,
  stage: string,
  entry: FileEntry,
  fallback: "copy" | "none",
) {
  const { file, unchanged, from } = await openSource(root, entry);
  try {
    const to = join(stage, entry.path);
    if (entry.path === REVIEW_STATE_PATH) {
      const raw = await file.readFile("utf8");
      await writeFile(to, reviewNotesOnly(raw) ?? raw, {
        flag: "wx",
        mode: entry.mode,
      });
      return false;
    }
    const cloned = await copyFile(
      from,
      to,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE,
    ).then(
      () => true,
      (error: unknown) => {
        if (cannotClone(error)) return false;
        throw error;
      },
    );
    if (!cloned && fallback === "none") return false;
    if (!cloned) await copyFile(from, to, constants.COPYFILE_EXCL);
    await unchanged();
    return cloned;
  } finally {
    await file.close();
  }
}

/**
 * Large files: clones first, then byte copies after a free-space check, with progress. Never hard
 * links: an agent or tool rewriting a file in place in the copy must not change the original.
 */
async function copyLarge(
  root: string,
  stage: string,
  files: FileEntry[],
  signal: AbortSignal,
  progress: (copied: number, total: number) => void,
) {
  const copies: FileEntry[] = [];
  for (const entry of files) {
    signal.throwIfAborted();
    if (!(await cloneFile(root, stage, entry, "none"))) copies.push(entry);
  }
  const total = copies.reduce((sum, { size }) => sum + size, 0n);
  if (!total) return;
  const { bavail, bsize } = await statfs(stage, { bigint: true });
  if (total > bavail * bsize)
    throw new HttpError(
      409,
      "There is not enough free space to copy this project.",
    );
  let copied = 0;
  let reported = -Infinity;
  progress(0, Number(total));
  for (const entry of copies) {
    signal.throwIfAborted();
    const { file, unchanged } = await openSource(root, entry);
    const start = copied;
    try {
      const to = join(stage, entry.path);
      await pipeline(
        file.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 }),
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            copied += chunk.length;
            if (copied - start > Number(entry.size)) throw changed(entry);
            if (performance.now() - reported >= 75) {
              reported = performance.now();
              progress(copied, Number(total));
            }
            yield chunk;
          }
        },
        createWriteStream(to, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      if (copied - start !== Number(entry.size)) throw changed(entry);
      await unchanged();
      await chmod(to, entry.mode);
    } finally {
      await file.close();
    }
  }
  progress(copied, Number(total));
}

/**
 * Removes staging folders a crashed Cutroom left in these folders: only folders with the staging
 * name, owned by this account, holding a marker from this machine at least ten minutes old, whose
 * process is gone or whose boot has ended.
 */
export async function sweepDuplicates(folders: Iterable<string>) {
  const uid = process.getuid?.();
  const host = hostname();
  const boot = bootId();
  for (const folder of new Set(folders)) {
    const names = await readdir(folder).catch(() => []);
    for (const name of names) {
      const match = stagingName.exec(name);
      if (!match) continue;
      const path = join(folder, name);
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.uid !== uid) continue;
        const handle = await open(join(path, MARKER), fileFlags);
        let marker: z.infer<typeof MarkerSchema>;
        try {
          const made = await handle.stat();
          if (
            !made.isFile() ||
            made.uid !== uid ||
            Date.now() - made.mtimeMs < SWEEP_AGE_MS
          )
            continue;
          const parsed = MarkerSchema.safeParse(
            JSON.parse(await handle.readFile("utf8")),
          );
          if (!parsed.success) continue;
          marker = parsed.data;
        } finally {
          await handle.close();
        }
        if (marker.host !== host || marker.pid !== Number(match[1])) continue;
        // A different boot means the process is gone; otherwise it must have exited.
        if (boot === null || marker.boot === null || marker.boot === boot) {
          try {
            process.kill(marker.pid, 0);
            continue;
          } catch (error) {
            if (!hasCode(error, "ESRCH")) continue;
          }
        }
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        if (
          !hasCode(error, "ENOENT", "ENOTDIR", "ELOOP") &&
          !(error instanceof SyntaxError)
        )
          console.warn(
            `Could not clean up an interrupted duplicate ${path}:`,
            error,
          );
      }
    }
  }
}

/** A failure's message without the `/proc/self/fd` paths the copy works through. */
const publicError = (error: unknown) => {
  if (hasCode(error, "ENOSPC", "EDQUOT"))
    return new HttpError(
      409,
      "There is not enough free space to copy this project.",
    );
  if (error instanceof HttpError || !(error instanceof Error)) return error;
  if (!("code" in error)) return error;
  console.warn("Duplicate failed:", error);
  return new Error(`The project could not be copied (${String(error.code)}).`);
};

/**
 * Copies whole projects beside their originals. The snapshot is taken under the source's
 * mutation lock; files over 1 MiB copy after it on the import copy queue while the original stays
 * editable.
 * `busy` names work that must finish first; `native` is true when the running agent asked.
 */
export function createDuplicateRoutes(
  store: ProjectStore,
  reviews: ReviewService,
  busy: (project: Project, native: boolean) => string | undefined,
) {
  const api = new Hono();
  const lifetime = new AbortController();
  const jobs = new Map<
    string,
    {
      view: Omit<DuplicateJob, "state">;
      machine: ReturnType<typeof createJobMachine>;
      cancel: AbortController;
      done: Promise<void>;
      publishing: boolean;
    }
  >();
  const show = (id: string) => {
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, "Duplicate not found.");
    return { ...job.view, state: job.machine.state };
  };

  async function start(project: Project, native: boolean) {
    const id = randomUUID();
    const taken = [
      ...(await store.list()).map(({ name }) => name),
      ...[...jobs.values()].map(({ view }) => view.name),
    ];
    const view: Omit<DuplicateJob, "state"> = {
      id,
      sourceId: project.id,
      name: copyName(project.name, taken),
    };
    const machine = createJobMachine();
    const cancel = new AbortController();
    const finished = Promise.withResolvers<void>();
    const job = {
      view,
      machine,
      cancel,
      done: finished.promise,
      publishing: false,
    };
    jobs.set(id, job);
    const signal = AbortSignal.any([lifetime.signal, cancel.signal]);

    let staging: string | undefined;
    let stage = "";
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;
    const cleanup = async () => {
      await handle?.close();
      if (staging && !published)
        await rm(staging, { recursive: true, force: true });
    };
    let root: string;
    let large: FileEntry[];
    try {
      root = await realpath(project.path);
      const parent = dirname(root);
      const folder = join(parent, `${STAGING_PREFIX}${process.pid}-${id}`);
      await mkdir(folder, { mode: 0o700 }).catch((error: unknown) => {
        if (hasCode(error, "EACCES", "EPERM", "EROFS"))
          throw new HttpError(
            403,
            `Cutroom cannot write in ${parent}, where the copy would go.`,
          );
        throw error;
      });
      staging = folder;
      handle = await open(folder, directoryFlags);
      // Write only into the folder made above, even if its path is swapped while copying.
      stage = pinnedDirectory(folder, handle.fd);
      if (
        (await realpath(stage)) !== folder ||
        (await handle.stat()).uid !== process.getuid?.()
      )
        throw new HttpError(403, "The folder for the copy changed.");
      await writeFile(
        join(stage, MARKER),
        JSON.stringify({ host: hostname(), boot: bootId(), pid: process.pid }),
        { flag: "wx", mode: 0o600 },
      );
      const source = root;
      large = await store.serializeMutation(project, async () => {
        const reason = busy(project, native);
        if (reason) throw new HttpError(409, reason);
        await (await store.history(project)).checkpoint();
        const entries = await snapshot(source);
        if (!entries.some(({ path }) => path === "index.html"))
          throw new HttpError(422, "This project has no index.html to copy.");
        const later: FileEntry[] = [];
        for (const entry of entries) {
          signal.throwIfAborted();
          const to = join(stage, entry.path);
          if (entry.kind === "directory")
            await mkdir(to, { mode: entry.mode | 0o700 });
          else if (entry.kind === "link") await symlink(entry.target, to);
          else if (entry.size <= SMALL_BYTES || UNPINNED.has(entry.path))
            await cloneFile(source, stage, entry, "copy");
          else later.push(entry);
        }
        return later;
      });
      machine.transition({ status: "running", progress: 0 });
    } catch (error) {
      jobs.delete(id);
      finished.resolve();
      await cleanup();
      throw publicError(error);
    }

    void (async () => {
      try {
        await onCopyQueue(() =>
          copyLarge(root, stage, large, signal, (copied, total) => {
            if (machine.state.status === "running")
              machine.transition({
                status: "running",
                progress: copied / total,
              });
          }),
        );
        signal.throwIfAborted();
        // From here the copy is complete, so Cancel no longer applies.
        job.publishing = true;
        await chmod(stage, Number((await lstat(root)).mode & 0o777) | 0o700);
        // An empty folder of our own takes the name, and the rename replaces only it: a folder
        // someone else made, or filled meanwhile, is never overwritten.
        let destination = "";
        for (let attempt = 0; !destination; attempt++) {
          const candidate = join(
            dirname(root),
            `${projectSlug(view.name)}-${randomUUID().slice(0, 8)}`,
          );
          await mkdir(candidate, { mode: 0o700 }).then(
            () => (destination = candidate),
            (error: unknown) => {
              if (!hasCode(error, "EEXIST") || attempt > 4) throw error;
            },
          );
        }
        await rename(staging!, destination).catch(async (error: unknown) => {
          await rmdir(destination).catch((cleanup: unknown) =>
            console.warn(`Could not remove ${destination}:`, cleanup),
          );
          throw error;
        });
        // Listed only once complete and named. The marker stays until then.
        const copy = await store
          .importProject({ path: destination, name: view.name })
          .catch(async (error: unknown) => {
            await rename(destination, staging!).catch((undo: unknown) =>
              console.warn(
                `Could not move the unlisted copy ${destination} back to ${staging}:`,
                undo,
              ),
            );
            throw error;
          });
        published = true;
        await unlink(join(destination, MARKER)).catch((error: unknown) =>
          console.warn(
            `Could not remove ${MARKER} from ${destination}:`,
            error,
          ),
        );
        view.projectId = copy.id;
        machine.transition({ status: "done", progress: 1 });
      } catch (error) {
        const { progress } = machine.state;
        const failure = publicError(error);
        if (machine.state.status === "cancelling")
          machine.transition({ status: "cancelled", progress });
        else
          machine.transition({
            status: "failed",
            progress,
            error: failure instanceof Error ? failure.message : String(failure),
          });
      } finally {
        await cleanup().catch((error: unknown) =>
          console.warn(`Could not remove ${staging}:`, error),
        );
        finished.resolve();
      }
    })();
    return show(id);
  }

  api.use("/projects/:id/*", projectMutationGuard(reviews));
  api.post("/projects/:id/duplicate", async (c) => {
    if (lifetime.signal.aborted)
      throw new HttpError(503, "Cutroom is closing.");
    const project = await store.get(c.req.param("id"));
    const native =
      reviews.authorize(c.req.header(AGENT_HEADER), project.id) !== undefined;
    return c.json(await start(project, native), 202);
  });
  /** An in-app agent sees only the duplicates of the project its turn runs in. */
  const visible = (c: Context, sourceId: string) => {
    try {
      reviews.authorize(c.req.header(AGENT_HEADER), sourceId);
      return true;
    } catch {
      return false;
    }
  };
  api.get("/duplicates", (c) =>
    c.json({
      jobs: [...jobs.values()]
        .filter(({ view }) => visible(c, view.sourceId))
        .map(({ view }) => show(view.id)),
    }),
  );
  api.get("/duplicates/:job", (c) => {
    const job = jobs.get(c.req.param("job"));
    if (!job || !visible(c, job.view.sourceId))
      throw new HttpError(404, "Duplicate not found.");
    return c.json(show(job.view.id));
  });
  // Cancel removes the unfinished copy, so only the owner does it.
  api.post("/duplicates/:job/cancel", (c) => {
    if (c.req.header(AGENT_HEADER) !== undefined)
      throw new HttpError(403, "Only the owner can cancel a duplicate.");
    const job = jobs.get(c.req.param("job"));
    if (!job) throw new HttpError(404, "Duplicate not found.");
    const { status, progress } = job.machine.state;
    if (status === "running" && !job.publishing) {
      job.machine.transition({ status: "cancelling", progress });
      job.cancel.abort();
    }
    return c.json(show(c.req.param("job")));
  });
  return {
    api,
    async dispose() {
      lifetime.abort();
      await Promise.all([...jobs.values()].map(({ done }) => done));
    },
  };
}

const spaceError = (error: unknown) =>
  hasCode(error, "ENOSPC", "EDQUOT")
    ? new HttpError(409, "There is not enough free space to copy this project.")
    : error;
