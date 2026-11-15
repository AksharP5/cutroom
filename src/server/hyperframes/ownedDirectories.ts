import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
    } catch (error) {
      if (!(error instanceof Error && "code" in error)) throw error;
      if (error.code === "ESRCH")
        // Another user's or an unremovable directory must not stop new work from starting.
        await rm(join(directory, entry.name), {
          recursive: true,
          force: true,
        }).catch((failure: unknown) =>
          console.warn(
            `Could not remove the abandoned ${entry.name}:`,
            failure instanceof Error ? failure.message : failure,
          ),
        );
      else if (error.code !== "EPERM") throw error;
    }
  }
}

/** The PID is part of mkdir itself, even if the owner dies before its next write. */
export async function createOwnedDirectory(directory: string, prefix: string) {
  await mkdir(directory, { recursive: true });
  await sweepOwnedDirectories(directory, prefix);
  return mkdtemp(join(directory, `${prefix}-${process.pid}-`));
}
