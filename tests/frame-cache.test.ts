import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameCacheSource } from "../src/server/hyperframes/frameCache";

test("a plan's copy is cached under the project file only while that file is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "frame-cache-"));
  const project = join(root, "project");
  const copied = join(root, "span", "plan", ".plan-work", "compiled");
  try {
    await mkdir(join(project, "media"), { recursive: true });
    await mkdir(join(copied, "media"), { recursive: true });
    await writeFile(join(project, "media", "talk.mp4"), "video");
    await copyFile(
      join(project, "media", "talk.mp4"),
      join(copied, "media", "talk.mp4"),
    );
    const copy = join(copied, "media", "talk.mp4");
    expect(frameCacheSource(copy, project)).toBe(
      join(project, "media", "talk.mp4"),
    );
    // Replaced after the plan copied it: the copy's frames are not the project file's.
    await utimes(
      join(project, "media", "talk.mp4"),
      new Date(),
      new Date(Date.now() + 60_000),
    );
    expect(frameCacheSource(copy, project)).toBe(copy);
    expect(frameCacheSource(join(copied, "downloaded.mp4"), project)).toBe(
      join(copied, "downloaded.mp4"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
