import { atomicTempPath } from "@hyperframes/core/atomic-file";
import type { HistoryWho } from "../history/historyLog";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { z } from "zod";
import {
  hasCode,
  openImportSource,
  pinnedDirectory,
  sourceIdentity,
} from "../../local/mediaImport";
import type {
  ImportSourcesSchema,
  MediaImportProgress,
} from "../../local/mediaImport";
import { HttpError } from "../../shared/errors";
import type { Project } from "../../shared/project";
import { projectStatePath, unavailableProjectFile } from "./path";
import type { ReviewService } from "./review";
import type { ProjectStore } from "./store";

const cannotLink = (error: unknown) =>
  hasCode(
    error,
    "EXDEV",
    "EPERM",
    "EACCES",
    "EMLINK",
    "EOPNOTSUPP",
    "ENOTSUP",
    "ENOSYS",
  );

const discard = (path: string) =>
  unlink(path).catch((error: unknown) => {
    if (!hasCode(error, "ENOENT")) throw error;
  });

type StagedMedia = {
  source: z.infer<typeof ImportSourcesSchema>["sources"][number];
  name: string;
  temp: string;
  copyBytes: bigint;
  linked: boolean;
};

const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const stagedName =
  /^\.import-(?:([1-9]\d*)-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.hf[0-9a-f]{6}\.tmp$/;

export async function sweepMediaImports(project: Pick<Project, "path">) {
  try {
    const assets = await projectStatePath(project, "assets");
    const directory = await open(assets, directoryFlags);
    try {
      const pinned = pinnedDirectory(assets, directory.fd);
      if ((await realpath(pinned)) !== assets) return;
      for (const entry of await readdir(pinned, { withFileTypes: true })) {
        const match = stagedName.exec(entry.name);
        if (!entry.isFile() || !match) continue;
        if (match[1]) {
          const pid = Number(match[1]);
          if (pid > 2_147_483_647) continue;
          try {
            process.kill(pid, 0);
            continue;
          } catch (error) {
            if (!hasCode(error, "ESRCH")) continue;
          }
        }
        await discard(join(pinned, entry.name));
      }
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!unavailableProjectFile(error))
      console.warn(
        `Could not clean up interrupted media imports in ${project.path}:`,
        error,
      );
  }
}

// Copies across all projects share a disk-space check. Hard links can still land immediately.
let copyQueue = Promise.resolve();

export async function importMedia(
  store: ProjectStore,
  reviews: ReviewService,
  project: Project,
  { sources }: z.infer<typeof ImportSourcesSchema>,
  options: {
    signal: AbortSignal;
    progress?: (event: MediaImportProgress) => Promise<unknown> | void;
    agentToken?: string;
    who?: HistoryWho;
  },
) {
  const { signal } = options;
  signal.throwIfAborted();
  const assets = await projectStatePath(project, "assets", true);
  await mkdir(assets).catch((error: unknown) => {
    if (!hasCode(error, "EEXIST")) throw error;
  });
  const directory = await open(assets, directoryFlags);
  // Keep writes and cleanup on the directory we checked, even if it is replaced mid-copy.
  const pinned = pinnedDirectory(assets, directory.fd);
  const staged: StagedMedia[] = [];
  try {
    if ((await realpath(pinned)) !== assets)
      throw new HttpError(403, "The project's assets folder changed.");
    const { dev } = await directory.stat({ bigint: true });
    for (const source of sources) {
      signal.throwIfAborted();
      const original = await openImportSource(source.path, source.identity);
      const temp = atomicTempPath(
        join(pinned, `.import-${process.pid}-${randomUUID()}`),
      );
      try {
        const linked =
          dev === original.info.dev &&
          (await link(original.canonical, temp).then(
            () => true,
            (error: unknown) => {
              if (cannotLink(error)) return false;
              throw error;
            },
          ));
        staged.push({
          source,
          name: original.name,
          temp,
          copyBytes: linked ? 0n : original.info.size,
          linked,
        });
        if (linked) {
          const info = await lstat(temp, { bigint: true });
          if (!info.isFile() || sourceIdentity(info) !== original.identity)
            throw new HttpError(
              409,
              `${original.name} changed before it could be linked.`,
            );
        }
      } finally {
        await original.file.close();
      }
    }

    const copies = staged.filter((entry) => !entry.linked);
    if (copies.length) {
      const pending = copyQueue.then(async () => {
        signal.throwIfAborted();
        try {
          await copyMedia(pinned, copies, signal, options.progress);
        } catch (error) {
          await Promise.all(copies.map(({ temp }) => discard(temp)));
          throw error;
        }
      });
      copyQueue = pending.catch(() => {});
      await pending;
    }

    const label =
      staged.length === 1
        ? `Import ${staged[0]!.name}`
        : `Import ${staged.length} media files`;
    return await reviews.editAssets(project, options.agentToken, () =>
      store.mutate(
        project,
        label,
        async () => {
          signal.throwIfAborted();
          if (
            (await projectStatePath(project, "assets")) !==
            (await realpath(pinned))
          )
            throw new HttpError(403, "The project's assets folder changed.");
          const files: string[] = [];
          try {
            // From here all copies are complete. Publish the batch as one history operation.
            for (const { temp, name } of staged) {
              files.push(await publishMedia(pinned, temp, name));
              await discard(temp);
            }
          } catch (error) {
            await Promise.all(files.map((file) => discard(join(pinned, file))));
            throw error;
          }
          return { files: files.map((file) => `assets/${file}`) };
        },
        options.who,
      ),
    );
  } catch (error) {
    if (hasCode(error, "ENOSPC", "EDQUOT"))
      throw new HttpError(
        409,
        "There is not enough free space to import these files.",
      );
    throw error;
  } finally {
    try {
      await Promise.all(staged.map(({ temp }) => discard(temp)));
    } finally {
      await directory.close();
    }
  }
}

async function copyMedia(
  pinned: string,
  copies: StagedMedia[],
  signal: AbortSignal,
  progress?: (event: MediaImportProgress) => Promise<unknown> | void,
) {
  const totalBytes = copies.reduce((sum, entry) => sum + entry.copyBytes, 0n);
  if (totalBytes) {
    const { bavail, bsize } = await statfs(pinned, { bigint: true });
    if (totalBytes > bavail * bsize)
      throw new HttpError(
        409,
        "There is not enough free space to import these files.",
      );
  }
  const total = Number(totalBytes);
  let copied = 0;
  let lastProgress = -Infinity;
  if (total) await progress?.({ type: "progress", copied, total });
  for (const entry of copies) {
    signal.throwIfAborted();
    const { file, info } = await openImportSource(
      entry.source.path,
      entry.source.identity,
    );
    const start = copied;
    try {
      await pipeline(
        file.createReadStream({
          autoClose: false,
          highWaterMark: 1024 * 1024,
        }),
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            copied += chunk.length;
            if (copied - start > Number(entry.copyBytes))
              throw new HttpError(
                409,
                `${entry.name} changed while it was being copied.`,
              );
            if (
              progress &&
              (performance.now() - lastProgress >= 75 || copied === total)
            ) {
              lastProgress = performance.now();
              await progress({ type: "progress", copied, total });
            }
            yield chunk;
          }
        },
        createWriteStream(entry.temp, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      const after = await file.stat({ bigint: true });
      if (
        copied - start !== Number(entry.copyBytes) ||
        sourceIdentity(after) !== entry.source.identity
      )
        throw new HttpError(
          409,
          `${entry.name} changed while it was being copied.`,
        );
      const destination = await open(
        entry.temp,
        constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const staged = await destination.stat();
        if (!staged.isFile() || staged.nlink !== 1)
          throw new HttpError(
            409,
            `${entry.name} changed while it was being copied.`,
          );
        await destination.chmod(Number(info.mode & 0o777n));
      } finally {
        await destination.close();
      }
    } finally {
      await file.close();
    }
  }
}

async function publishMedia(directory: string, temp: string, original: string) {
  const extension = extname(original);
  const stem = original.slice(0, -extension.length);
  for (let n = 1; ; n++) {
    let name = original;
    if (n > 1) {
      const suffix = ` ${n}${extension}`;
      const shortened = Array.from(stem);
      while (Buffer.byteLength(shortened.join("") + suffix) > 255)
        shortened.pop();
      name = shortened.join("") + suffix;
    }
    const target = join(directory, name);
    try {
      // Publish without overwriting a file created after we picked its name.
      await link(temp, target);
      return name;
    } catch (error) {
      if (hasCode(error, "EEXIST")) continue;
      if (!cannotLink(error)) throw error;
    }
    // Volumes without hard links still get an atomic rename under the project write lock.
    const exists = await lstat(target).then(
      () => true,
      (error: unknown) => {
        if (hasCode(error, "ENOENT")) return false;
        throw error;
      },
    );
    if (exists) continue;
    await rename(temp, target);
    return name;
  }
}
