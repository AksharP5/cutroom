import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createCaptureProfile } from "../src/server/hyperframes/captureProfiles";

test("capture startup sweeps only marked directories with a dead owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "cap-profiles-"));
  const owner = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "inherit",
  });
  await owner.exited;
  const dead = join(root, `cutroom-capture-${owner.pid}-abcdef`);
  const live = join(root, `cutroom-capture-${process.pid}-abcdef`);
  const unmarked = join(root, "cutroom-capture-abcdef");
  const unrelated = join(root, `another-profile-${owner.pid}-abcdef`);
  const target = join(root, "source");
  const linked = join(root, `cutroom-capture-${owner.pid}-ghijkl`);
  try {
    for (const path of [dead, live, unmarked, unrelated, target]) {
      await mkdir(path);
      await writeFile(join(path, "keep"), "profile data");
    }
    await symlink(target, linked, "dir");
    const created = await createCaptureProfile(root);
    expect(created).toStartWith(join(root, `cutroom-capture-${process.pid}-`));
    expect(await readdir(root)).not.toContain(basename(dead));
    for (const path of [live, unmarked, unrelated, target, linked])
      expect(await readFile(join(path, "keep"), "utf8")).toBe("profile data");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an abandoned profile that cannot be removed does not stop a new capture profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "cap-profiles-"));
  const owner = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "inherit",
  });
  await owner.exited;
  const stuck = join(root, `cutroom-capture-${owner.pid}-abcdef`);
  try {
    await mkdir(join(stuck, "Default"), { recursive: true });
    await writeFile(join(stuck, "Default", "keep"), "profile data");
    // Unreadable, like a profile left by another user in a shared temp folder.
    await chmod(stuck, 0o000);
    const created = await createCaptureProfile(root);
    expect(created).toStartWith(join(root, `cutroom-capture-${process.pid}-`));
  } finally {
    await chmod(stuck, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
