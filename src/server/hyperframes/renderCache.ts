import { mkdirSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIB = 1024 ** 2;
const DEFAULT_CACHE_MIB = 2048;

export function renderCacheConfig(env = process.env) {
  const home = homedir();
  const xdg = env.XDG_CACHE_HOME;
  const local = env.LOCALAPPDATA;
  const root =
    process.platform === "darwin"
      ? join(home, "Library", "Caches", "Cutroom")
      : process.platform === "win32"
        ? join(
            local && isAbsolute(local) ? local : join(home, "AppData", "Local"),
            "Cutroom",
            "Cache",
          )
        : join(xdg && isAbsolute(xdg) ? xdg : join(home, ".cache"), "cutroom");
  const configured = env.CUTROOM_EXPORT_CACHE_MB?.trim();
  const mib = configured ? Number(configured) : DEFAULT_CACHE_MIB;
  const bytes = mib * MIB;
  return {
    scratchDir: join(root, "scratch"),
    frameCache: {
      dir: join(root, "frames"),
      maxBytes:
        Number.isSafeInteger(bytes) && bytes >= 0
          ? bytes
          : DEFAULT_CACHE_MIB * MIB,
    },
  };
}

/** A render and a sweep must never use this cache at the same time, even in separate app instances. */
export function lockFrameCache(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(dirname(dir), "frames-lock.sqlite"));
  try {
    // SQLite's OS lock is released even if the renderer is killed. No database rows are needed.
    lock.exec("BEGIN IMMEDIATE");
    return lock;
  } catch (error) {
    lock.close();
    if (error instanceof Error && "errcode" in error && error.errcode === 5)
      return undefined; // SQLITE_BUSY
    throw error;
  }
}

const frames = /^hfcache-v\d+-[a-f0-9]{16}$/;
const partial =
  /^(?:hfcache-v\d+-[a-f0-9]{16}\.partial-\d+-[a-f0-9]{8}|__superset-\d+\.partial-\d+)$/;
const gif = /^hfgif-v\d+-[a-f0-9]{24}\.webm$/;
const partialGif = /^hfgif-v\d+-[a-f0-9]{24}\.webm\.tmp-\d+-\d+$/;

async function fileInfo(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
}

async function frameBytes(dir: string) {
  const files = await readdir(dir);
  let bytes = 0;
  for (let offset = 0; offset < files.length; offset += 64) {
    const stats = await Promise.all(
      files.slice(offset, offset + 64).map((file) => fileInfo(join(dir, file))),
    );
    for (const stat of stats) bytes += stat?.size ?? 0;
  }
  return bytes;
}

export async function pruneFrameCache(dir: string, maxBytes: number) {
  const lock = lockFrameCache(dir);
  if (!lock) return;
  try {
    const entries: { path: string; bytes: number; lastUsed: number }[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (partial.test(entry.name)) {
        await rm(path, { recursive: true, force: true });
      } else if (frames.test(entry.name)) {
        const complete = await fileInfo(join(path, ".hf-complete"));
        if (!complete?.isFile()) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        entries.push({
          path,
          bytes: await frameBytes(path),
          lastUsed: complete.mtimeMs,
        });
      } else if (entry.name === "animated-gif") {
        for (const file of await readdir(path, { withFileTypes: true })) {
          if (!file.isFile()) continue;
          const converted = join(path, file.name);
          if (partialGif.test(file.name)) {
            await rm(converted, { force: true });
          } else if (gif.test(file.name)) {
            const stat = await fileInfo(converted);
            if (stat)
              entries.push({
                path: converted,
                bytes: stat.size,
                lastUsed: stat.mtimeMs,
              });
          }
        }
      }
    }
    let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    for (const entry of entries.sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (maxBytes > 0 && bytes <= maxBytes) break;
      await rm(entry.path, { recursive: true, force: true });
      bytes -= entry.bytes;
    }
  } finally {
    lock.close();
  }
}
