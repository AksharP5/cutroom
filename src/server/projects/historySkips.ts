import { replaceFileAtomically } from "@hyperframes/core/atomic-file";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Project } from "../../shared/project";
import { isMissing, projectStatePath } from "./path";

const path = ".cutroom/history-skips.json";
const SkipsSchema = z.object({ entries: z.array(z.string()) });

export async function readHistorySkips(project: Project) {
  const file = await projectStatePath(project, path, true);
  const raw = await readFile(file, "utf8").catch((error: unknown) => {
    if (!isMissing(error)) throw error;
    return null;
  });
  return new Set(
    raw === null ? [] : SkipsSchema.parse(JSON.parse(raw)).entries,
  );
}

/**
 * The project mutation queue owns both updates and the selected undo entry. Skips of entries
 * the log no longer holds are dropped, so the file stays as small as the history.
 */
export async function recordHistorySkip(
  project: Project,
  skipped: ReadonlySet<string>,
  id: string,
  log: readonly { id: string }[],
) {
  const file = await projectStatePath(project, path, true);
  await mkdir(dirname(file), { recursive: true });
  const live = new Set(log.map((entry) => entry.id));
  const entries = [...skipped, id].filter((entry) => live.has(entry));
  await replaceFileAtomically(
    file,
    `${JSON.stringify({ entries: [...new Set(entries)] })}\n`,
    0o600,
  );
}
