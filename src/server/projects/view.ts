import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Project } from "../../shared/project";
import {
  TimelineViewSettingsSchema,
  emptyTimelineViewSettings,
} from "../../shared/timeline/view";
import type { TimelineViewSettings } from "../../shared/timeline/view";
import { isMissing, projectStatePath } from "./path";

const VIEW_PATH = ".cutroom/view.json";
const ViewFileSchema = z.object({
  timelines: z.record(z.string(), TimelineViewSettingsSchema),
});

async function readViews(project: Project) {
  const raw = await projectStatePath(project, VIEW_PATH, true)
    .then((path) => readFile(path, "utf8"))
    .catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
  let json: unknown = null;
  try {
    if (raw !== null) json = JSON.parse(raw);
  } catch {
    // Unreadable preferences use defaults; composition content stays editable.
  }
  const parsed = ViewFileSchema.safeParse(json);
  return parsed.success ? parsed.data : { timelines: {} };
}

/** View preferences never pass through content mutations, history, or review attribution. */
export function createTimelineViewStore() {
  const scheduled = new Map<
    string,
    {
      updates: Map<string, TimelineViewSettings>;
      timer: ReturnType<typeof setTimeout> | null;
      completion: ReturnType<typeof Promise.withResolvers<void>>;
    }
  >();
  const writes = new Map<string, Promise<void>>();
  return {
    async read(project: Project, composition: string) {
      return (
        (await readViews(project)).timelines[composition] ??
        emptyTimelineViewSettings()
      );
    },
    save(
      project: Project,
      composition: string,
      settings: TimelineViewSettings,
    ) {
      let batch = scheduled.get(project.id);
      if (!batch) {
        batch = {
          updates: new Map(),
          timer: null,
          completion: Promise.withResolvers<void>(),
        };
        scheduled.set(project.id, batch);
      }
      if (batch.timer) clearTimeout(batch.timer);
      batch.updates.set(composition, settings);
      const pending = batch;
      batch.timer = setTimeout(() => {
        scheduled.delete(project.id);
        const write = (writes.get(project.id) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            const current = await readViews(project);
            const value = {
              timelines: {
                ...current.timelines,
                ...Object.fromEntries(pending.updates),
              },
            };
            await mkdir(await projectStatePath(project, ".cutroom", true), {
              recursive: true,
            });
            const path = await projectStatePath(project, VIEW_PATH, true);
            const temporary = `${path}.${randomUUID()}.tmp`;
            await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
              mode: 0o600,
            });
            await rename(temporary, path);
          });
        writes.set(project.id, write);
        void write
          .then(pending.completion.resolve, pending.completion.reject)
          .finally(() => {
            if (writes.get(project.id) === write) writes.delete(project.id);
          });
      }, 150);
      return batch.completion.promise;
    },
  };
}
