import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectStore } from "../src/server/projects/store";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("opening a project keeps the undo history of a project that went missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cutroom-history-retention-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  // A project folder that moved, or lost .hyperframes/history-id, looks gone to the engine.
  const missing = join(dir, "history", crypto.randomUUID());
  await mkdir(missing, { recursive: true });
  await writeFile(
    join(missing, "project.json"),
    JSON.stringify({
      dir: join(dir, "moved-project"),
      ino: 1,
      born: 1,
      dev: (await stat(dir)).dev,
    }),
  );
  await writeFile(join(missing, "log.jsonl"), "");
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await utimes(join(missing, "project.json"), monthAgo, monthAgo);
  await utimes(join(missing, "log.jsonl"), monthAgo, monthAgo);

  const store = await createProjectStore({ dataDir: dir });
  cleanups.push(() => store.close());
  const project = await store.create({ name: "Open history" });
  await store.history(project);
  await new Promise((resolve) => setTimeout(resolve, 250));

  expect(existsSync(missing)).toBe(true);
});
