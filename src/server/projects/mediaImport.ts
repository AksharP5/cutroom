import { atomicTempPath } from "@hyperframes/core/atomic-file";
import type { HistoryWho } from "@hyperframes/studio-server";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
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
import { projectStatePath } from "./path";
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
  const directory = await open(
    assets,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  // Keep writes and cleanup on the directory we checked, even if it is replaced mid-copy.
  const pinned = pinnedDirectory(assets, directory.fd);
  const staged: Array<{
    source: (typeof sources)[number];
    name: string;
    temp: string;
    copyBytes: bigint;
    linked: boolean;
  }> = [];
  try {
    if ((await realpath(pinned)) !== assets)
      throw new HttpError(403, "The project's assets folder changed.");
    const { dev } = await directory.stat({ bigint: true });
    for (const source of sources) {
      signal.throwIfAborted();
      const original = await openImportSource(source.path, source.identity);
      const temp = atomicTempPath(join(pinned, `.import-${randomUUID()}`));
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

    const totalBytes = staged.reduce((sum, entry) => sum + entry.copyBytes, 0n);
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
    if (total) await options.progress?.({ type: "progress", copied, total });
    for (const entry of staged) {
      if (entry.linked) continue;
      signal.throwIfAborted();
      const { file } = await openImportSource(
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
                options.progress &&
                (performance.now() - lastProgress >= 75 || copied === total)
              ) {
                lastProgress = performance.now();
                await options.progress({ type: "progress", copied, total });
              }
              yield chunk;
            }
          },
          createWriteStream(entry.temp, { flags: "wx" }),
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
      } finally {
        await file.close();
      }
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
