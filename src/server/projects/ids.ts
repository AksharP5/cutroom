import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import type { Project } from "../../shared/project";
import { isMissing, projectPath } from "./store";

const LEDGER_PATH = ".cutroom/ids.json";
const LedgerSchema = z.object({ ids: z.array(z.string()) });

/** Appends run one at a time per project, so two edits never drop each other's ids. */
const appends = new Map<string, Promise<unknown>>();

/**
 * Every clip id the project has used, kept outside undo history. Undo and redo swap whole files,
 * so a clip that was undone can come back; no other clip may take its id in the meantime.
 */
export async function usedClipIds(project: Project): Promise<Set<string>> {
  const raw = await projectPath(project, LEDGER_PATH, true)
    .then((path) => readFile(path, "utf8"))
    .catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
  if (raw === null) return new Set();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // Reported below with the schema failure.
  }
  const parsed = LedgerSchema.safeParse(json);
  if (!parsed.success)
    throw new HttpError(
      500,
      `${LEDGER_PATH} is unreadable. It lists every clip id this project has used; repair or restore it before editing.`,
    );
  return new Set(parsed.data.ids);
}

/** Adds ids to the project's list. Ids are only ever added. */
export function recordClipIds(project: Project, ids: Iterable<string>) {
  const adding = [...ids];
  const run = (appends.get(project.id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const used = await usedClipIds(project);
      const before = used.size;
      for (const id of adding) used.add(id);
      if (used.size === before) return;
      await mkdir(await projectPath(project, ".cutroom", true), {
        recursive: true,
      });
      const path = await projectPath(project, LEDGER_PATH, true);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ ids: [...used].sort() }, null, 2)}\n`,
      );
      await rename(temporary, path);
    });
  appends.set(project.id, run);
  return run;
}
