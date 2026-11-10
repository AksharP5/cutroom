import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createCaptureProfile(directory = tmpdir()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const owner = /^cutroom-capture-([1-9]\d*)-[A-Za-z0-9]{6}$/.exec(
      entry.name,
    );
    if (!owner) continue;
    const pid = Number(owner[1]);
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (!(error instanceof Error && "code" in error)) throw error;
      if (error.code === "ESRCH")
        // Another user's or an unremovable profile must not stop this capture from starting.
        await rm(join(directory, entry.name), {
          recursive: true,
          force: true,
        }).catch((failure: unknown) =>
          console.warn(
            `Could not remove the abandoned capture profile ${entry.name}:`,
            failure instanceof Error ? failure.message : failure,
          ),
        );
      else if (error.code !== "EPERM") throw error;
    }
  }
  // The PID is part of mkdir itself, even if the owner dies before its next write.
  return mkdtemp(join(directory, `cutroom-capture-${process.pid}-`));
}
