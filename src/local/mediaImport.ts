import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { HttpError } from "../shared/errors";
import { mediaKind } from "../shared/media";
import { protectedPath } from "../shared/sourcePaths";

export const importSocketPath = (
  baseUrl: string,
  dataDir = process.env.CUTROOM_DATA_DIR ||
    join(homedir(), ".local", "share", "cutroom"),
) => resolve(dataDir, ".media-import", `${new URL(baseUrl).port || "80"}.sock`);

export const pinnedDirectory = (path: string, fd: number) =>
  process.platform === "linux" ? `/proc/self/fd/${fd}` : path;

/** Keep the socket private and address it even when the data path exceeds sun_path. */
export async function openImportSocket(socket: string, create = false) {
  const directory = dirname(socket);
  if (create)
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!hasCode(error, "EEXIST")) throw error;
    });
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (info.uid !== process.getuid?.() || info.mode & 0o077)
      throw new Error(
        "Cutroom's media import directory must be private to your account.",
      );
    return {
      handle,
      address: join(pinnedDirectory(directory, handle.fd), basename(socket)),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export const hasCode = (error: unknown, ...codes: string[]) =>
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string" &&
  codes.includes(error.code);

export const sourceIdentity = (info: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}) => [info.dev, info.ino, info.size, info.mtimeNs].join(":");

export async function openImportSource(path: string, expected?: string) {
  const name = basename(path);
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    !extname(name) ||
    !mediaKind(name) ||
    protectedPath(name, false) ||
    /[\\\p{Cc}\p{Cf}\u2028\u2029]/u.test(name)
  )
    throw new HttpError(
      400,
      "Choose a video, audio, or image file by its full path.",
    );

  const unavailable = (error: unknown): never => {
    if (hasCode(error, "ENOENT", "ENOTDIR"))
      throw new HttpError(404, `Cannot find ${name}.`);
    if (hasCode(error, "EACCES", "EPERM", "ELOOP"))
      throw new HttpError(403, `Cannot read ${name}.`);
    throw error;
  };
  // Resolve parent aliases, but refuse a symlink as the selected file itself.
  const canonical = join(
    await realpath(dirname(path)).catch(unavailable),
    name,
  );
  const before = await lstat(canonical, { bigint: true }).catch(unavailable);
  if (!before.isFile())
    throw new HttpError(400, `${name} must be a regular file.`);
  const identity = sourceIdentity(before);
  if (expected !== undefined && identity !== expected)
    throw new HttpError(409, `${name} changed before it could be imported.`);

  // Nonblocking also makes a swap to a FIFO between lstat and open harmless.
  const file = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(unavailable);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || sourceIdentity(info) !== identity)
      throw new HttpError(409, `${name} changed before it could be imported.`);
    return { file, name, canonical, identity, info };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export const ImportSourcesSchema = z.object({
  sources: z.array(z.object({ path: z.string(), identity: z.string() })).min(1),
});
export const MediaImportEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    copied: z.number(),
    total: z.number(),
  }),
  z.object({ type: z.literal("result"), files: z.array(z.string()) }),
  z.object({ type: z.literal("cancelled") }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);
export type MediaImportEvent = z.infer<typeof MediaImportEventSchema>;
export type MediaImportProgress = Extract<
  MediaImportEvent,
  { type: "progress" }
>;

/** The caller must be able to open each original in its own filesystem context. */
export async function requestMediaImport(
  socket: string,
  projectId: string,
  paths: string[],
  options: {
    id?: string;
    signal: AbortSignal;
    headers?: Record<string, string>;
    progress?: (event: MediaImportProgress) => void;
  },
) {
  const sources: z.infer<typeof ImportSourcesSchema>["sources"] = [];
  for (const path of paths) {
    options.signal.throwIfAborted();
    const { file, identity } = await openImportSource(path);
    await file.close();
    sources.push({ path, identity });
  }
  const response = await postImportSocket(
    socket,
    importEndpoint(projectId, options.id ?? randomUUID()),
    JSON.stringify({ sources }),
    options,
  );
  try {
    for await (const line of createInterface({
      input: response,
      crlfDelay: Infinity,
    })) {
      const event = MediaImportEventSchema.parse(JSON.parse(line));
      if (event.type === "error") throw new Error(event.error);
      if (event.type === "cancelled") return null;
      if (event.type === "result") return { files: event.files };
      options.progress?.(event);
    }
  } finally {
    if (!response.complete) response.destroy();
  }
  options.signal.throwIfAborted();
  throw new Error("Cutroom stopped before the media import finished.");
}

const importEndpoint = (projectId: string, id: string) =>
  `/projects/${encodeURIComponent(projectId)}/media/import/${encodeURIComponent(id)}`;

export async function cancelMediaImport(
  socket: string,
  projectId: string,
  id: string,
) {
  const response = await postImportSocket(
    socket,
    `${importEndpoint(projectId, id)}/cancel`,
    "",
  );
  response.resume();
  if (response.statusCode !== 204)
    throw new Error("Cutroom could not cancel the import.");
}

async function postImportSocket(
  socket: string,
  path: string,
  body: string,
  options?: { headers?: Record<string, string>; signal?: AbortSignal },
) {
  const { handle, address } = await openImportSocket(socket).catch(
    (error: unknown) => {
      if (hasCode(error, "ENOENT"))
        throw new Error("The local media import service is unavailable.");
      throw error;
    },
  );
  try {
    const socketInfo = await lstat(address);
    if (!socketInfo.isSocket() || socketInfo.uid !== process.getuid?.())
      throw new Error("The local media import service is unavailable.");
    return await new Promise<IncomingMessage>((accept, reject) => {
      const pending = request(
        {
          socketPath: address,
          path,
          method: "POST",
          headers: {
            ...options?.headers,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          signal: options?.signal,
          agent: false,
        },
        accept,
      );
      pending.on("error", reject);
      pending.end(body);
    });
  } finally {
    await handle.close();
  }
}
