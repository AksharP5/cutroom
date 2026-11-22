import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { Hono } from "hono";
import {
  hasCode,
  pinnedDirectory,
  sourceIdentity,
} from "../../local/mediaImport";
import { HttpError } from "../../shared/errors";
import { createJobMachine } from "../../shared/jobs";
import { MEDIA_TRASH, mediaKind } from "../../shared/media";
import type { DuplicateJob, Project } from "../../shared/project";
import { AGENT_HEADER } from "../../shared/review";
import { projectMutationGuard } from "./authorization";
import { cannotLink, copyMedia, onCopyQueue, stagedName } from "./mediaImport";
import type { MediaCopy } from "./mediaImport";
import type { ReviewService } from "./review";
import { projectSlug } from "./store";
import type { ProjectStore } from "./store";

const STAGING_PREFIX = ".cutroom-duplicate-";
const stagingName =
  /^\.cutroom-duplicate-([1-9]\d*)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** Inside every staging folder, so the startup sweep only ever removes folders Cutroom made. */
const MARKER = ".cutroom-duplicate";
const CACHE = ".cutroom/cache";
/**
 * The original's history, outputs and trash. The copy starts its own history, so these would
 * only point at entries it does not have.
 */
const LEFT_BEHIND = new Set([
  ".hyperframes",
  ".thumbnails",
  MEDIA_TRASH,
  ".cutroom/renders",
  ".cutroom/renders.json",
  ".cutroom/review-ledger.json",
  ".cutroom/history-skips.json",
]);

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
  /** Text and other small files copy with the snapshot; media and cache copy after it. */
  phase: "snapshot" | "media" | "cache";
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

/** A link the copy can keep: relative, and resolving inside the project. */
const staysInside = (path: string, target: string) => {
  if (isAbsolute(target)) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return resolved !== ".." && !resolved.startsWith("../");
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
      for (const name of await readdir(pinned)) {
        const path = parent ? `${parent}/${name}` : name;
        if (LEFT_BEHIND.has(path) || stagedName.test(name)) continue;
        const cache = path.startsWith(`${CACHE}/`);
        // Scratch folders and partial files in the cache are work in progress.
        if (cache && name.startsWith(".")) continue;
        const absolute = join(pinned, name);
        const info = await lstat(absolute, { bigint: true });
        if (info.isDirectory()) {
          // Cache folders are made as their files clone, so an unclonable cache leaves none.
          if (!cache)
            entries.push({
              kind: "directory",
              path,
              mode: Number(info.mode & 0o777n),
            });
          await visit(absolute, path);
        } else if (info.isFile())
          entries.push({
            kind: "file",
            path,
            identity: sourceIdentity(info),
            size: info.size,
            phase: cache ? "cache" : mediaKind(name) ? "media" : "snapshot",
          });
        else if (info.isSymbolicLink()) {
          const target = await readlink(absolute);
          if (staysInside(path, target))
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

/**
 * Clones one file, or byte-copies it when `fallback` allows. True when it cloned. The source is
 * opened without following a link and must still be the file the snapshot saw.
 */
async function cloneFile(
  root: string,
  stage: string,
  entry: FileEntry,
  fallback: "copy" | "none",
) {
  const file = await open(join(root, entry.path), fileFlags).catch(
    (error: unknown) => {
      if (hasCode(error, "ENOENT", "ENOTDIR", "ELOOP")) throw changed(entry);
      throw error;
    },
  );
  try {
    const unchanged = async () => {
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || sourceIdentity(info) !== entry.identity)
        throw changed(entry);
    };
    await unchanged();
    const from = pinnedDirectory(join(root, entry.path), file.fd);
    const to = join(stage, entry.path);
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

/** A hard link, as import makes on the same disk. Cutroom never rewrites media in place. */
async function linkFile(root: string, stage: string, entry: FileEntry) {
  const to = join(stage, entry.path);
  const linked = await link(join(root, entry.path), to).then(
    () => true,
    (error: unknown) => {
      if (cannotLink(error)) return false;
      if (hasCode(error, "ENOENT", "ENOTDIR")) throw changed(entry);
      throw error;
    },
  );
  if (!linked) return false;
  const info = await lstat(to, { bigint: true });
  if (!info.isFile() || sourceIdentity(info) !== entry.identity)
    throw changed(entry);
  return true;
}

/** Media and the cache: clones first, then links, then byte copies after a free-space check. */
async function copyLater(
  root: string,
  stage: string,
  files: FileEntry[],
  signal: AbortSignal,
  progress: (copied: number, total: number) => void,
) {
  const copies: MediaCopy[] = [];
  let cacheClones = true;
  for (const entry of files) {
    signal.throwIfAborted();
    if (entry.phase === "cache") {
      if (!cacheClones) continue;
      await mkdir(dirname(join(stage, entry.path)), {
        recursive: true,
        mode: 0o700,
      });
      // Proxies and waveforms are made again on demand, so a cache that cannot clone is skipped.
      cacheClones = await cloneFile(root, stage, entry, "none").catch(
        (error: unknown) => {
          if (error instanceof HttpError && error.status === 409) return true;
          throw error;
        },
      );
      continue;
    }
    if (await cloneFile(root, stage, entry, "none")) continue;
    if (await linkFile(root, stage, entry)) continue;
    copies.push({
      source: { path: join(root, entry.path), identity: entry.identity },
      name: basename(entry.path),
      temp: join(stage, entry.path),
      copyBytes: entry.size,
    });
  }
  if (copies.length)
    await copyMedia(
      stage,
      copies,
      signal,
      ({ copied, total }) => progress(copied, total),
      "There is not enough free space to copy this project.",
    );
}

/**
 * Removes staging folders a crashed Cutroom left in these folders: only folders with the staging
 * name, owned by this account, holding the marker, whose process is gone.
 */
export async function sweepDuplicates(folders: Iterable<string>) {
  const uid = process.getuid?.();
  for (const folder of new Set(folders)) {
    const names = await readdir(folder).catch(() => []);
    for (const name of names) {
      const match = stagingName.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid > 2_147_483_647) continue;
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if (!hasCode(error, "ESRCH")) continue;
      }
      const path = join(folder, name);
      try {
        const info = await lstat(path);
        const marker = await lstat(join(path, MARKER));
        if (
          !info.isDirectory() ||
          !marker.isFile() ||
          info.uid !== uid ||
          marker.uid !== uid
        )
          continue;
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        if (!hasCode(error, "ENOENT", "ENOTDIR"))
          console.warn(
            `Could not clean up an interrupted duplicate ${path}:`,
            error,
          );
      }
    }
  }
}

/**
 * Copies whole projects beside their originals. The snapshot is taken under the source's
 * mutation lock; media copies after it on the import copy queue while the original stays editable.
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
    let files: FileEntry[];
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
      await writeFile(join(stage, MARKER), "Cutroom duplicate in progress\n", {
        flag: "wx",
        mode: 0o600,
      });
      await chmod(stage, Number((await lstat(root)).mode & 0o777) | 0o700);
      const source = root;
      files = await store.serializeMutation(project, async () => {
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
          else if (entry.phase === "snapshot")
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
      throw spaceError(error);
    }

    void (async () => {
      try {
        await onCopyQueue(() =>
          copyLater(root, stage, files, signal, (copied, total) => {
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
        const destination = join(
          dirname(root),
          `${projectSlug(view.name)}-${randomUUID().slice(0, 8)}`,
        );
        const exists = await lstat(destination).then(
          () => true,
          (error: unknown) => {
            if (hasCode(error, "ENOENT")) return false;
            throw error;
          },
        );
        if (exists) throw new HttpError(409, `${destination} already exists.`);
        // Named only once complete, and listed only once named.
        await rename(staging!, destination);
        published = true;
        await unlink(join(destination, MARKER)).catch((error: unknown) =>
          console.warn(
            `Could not remove ${MARKER} from ${destination}:`,
            error,
          ),
        );
        const copy = await store.importProject({
          path: destination,
          name: view.name,
        });
        view.projectId = copy.id;
        machine.transition({ status: "done", progress: 1 });
      } catch (error) {
        const { progress } = machine.state;
        const failure = spaceError(error);
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
  api.get("/duplicates", (c) => c.json({ jobs: [...jobs.keys()].map(show) }));
  api.get("/duplicates/:job", (c) => c.json(show(c.req.param("job"))));
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
