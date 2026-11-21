import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Removes `<prefix>-<pid>-XXXXXX` directories whose owning process has exited,
 * which is how a crashed or killed owner's scratch is reclaimed.
 */
export async function sweepOwnedDirectories(directory: string, prefix: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    },
  );
  const marked = new RegExp(`^${prefix}-([1-9]\\d*)-[A-Za-z0-9]{6}$`);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const owner = marked.exec(entry.name);
    if (!owner) continue;
    const pid = Number(owner[1]);
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch (error) {
      if (!(error instanceof Error && "code" in error)) throw error;
      if (error.code === "EPERM") continue;
      if (error.code !== "ESRCH") throw error;
    }
    // Another user's or an unremovable directory must not stop new work from starting.
    const path = join(directory, entry.name);
    try {
      const stat = await lstat(path);
      if (
        !stat.isDirectory() ||
        (process.getuid && stat.uid !== process.getuid())
      )
        continue;
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      console.warn(
        `Could not remove the abandoned ${entry.name}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/** The PID is part of mkdir itself, even if the owner dies before its next write. */
export async function createOwnedDirectory(directory: string, prefix: string) {
  await mkdir(directory, { recursive: true });
  await sweepOwnedDirectories(directory, prefix);
  return mkdtemp(join(directory, `${prefix}-${process.pid}-`));
}

/** Leave room for Chromium's Linux process singleton socket, including its terminating NUL. */
export function chromiumSocketPathFits(root: string) {
  if (process.platform !== "linux") return true;
  const socket = join(root, "org.chromium.Chromium.XXXXXX", "SingletonSocket");
  return Buffer.byteLength(socket) < 108;
}

export function browserTempRoot() {
  const root = tmpdir();
  return chromiumSocketPathFits(root) ? root : "/tmp";
}
