import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Project } from "../../shared/project";
import {
  SourceMarksSchema,
  emptySourceMarks,
  TimelineViewSettingsSchema,
  emptyTimelineViewSettings,
} from "../../shared/timeline/view";
import type {
  SourceMarks,
  TimelineViewSettings,
} from "../../shared/timeline/view";
import { isMissing, projectStatePath } from "./path";

export const VIEW_PATH = ".cutroom/view.json";
const ViewFileSchema = z.object({
  timelines: z.record(z.string(), TimelineViewSettingsSchema),
  sources: z.record(z.string(), SourceMarksSchema).default({}),
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
  return parsed.success ? parsed.data : { timelines: {}, sources: {} };
}

/** View preferences never pass through content mutations, history, or review attribution. */
export function createProjectViewStore() {
  const scheduled = new Map<
    string,
    {
      updates: z.infer<typeof ViewFileSchema>;
      timer: ReturnType<typeof setTimeout> | null;
      completion: ReturnType<typeof Promise.withResolvers<void>>;
    }
  >();
  const writes = new Map<string, Promise<void>>();
  const save = (project: Project, updates: z.infer<typeof ViewFileSchema>) => {
    let batch = scheduled.get(project.id);
    if (!batch) {
      batch = {
        updates: { timelines: {}, sources: {} },
        timer: null,
        completion: Promise.withResolvers<void>(),
      };
      scheduled.set(project.id, batch);
    }
    if (batch.timer) clearTimeout(batch.timer);
    Object.assign(batch.updates.timelines, updates.timelines);
    Object.assign(batch.updates.sources, updates.sources);
    const pending = batch;
    batch.timer = setTimeout(() => {
      scheduled.delete(project.id);
      const write = (writes.get(project.id) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const current = await readViews(project);
          const value = {
            timelines: { ...current.timelines, ...pending.updates.timelines },
            sources: { ...current.sources, ...pending.updates.sources },
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
  };
  return {
    /** The latest settings, including a save still waiting to be written. */
    async read(project: Project, composition: string) {
      return (
        scheduled.get(project.id)?.updates.timelines[composition] ??
        (await readViews(project)).timelines[composition] ??
        emptyTimelineViewSettings()
      );
    },
    save(
      project: Project,
      composition: string,
      settings: TimelineViewSettings,
    ) {
      return save(project, {
        timelines: { [composition]: settings },
        sources: {},
      });
    },
    async readSource(project: Project, fingerprint: string) {
      return (
        scheduled.get(project.id)?.updates.sources[fingerprint] ??
        (await readViews(project)).sources[fingerprint] ??
        emptySourceMarks()
      );
    },
    saveSource(project: Project, fingerprint: string, marks: SourceMarks) {
      return save(project, {
        timelines: {},
        sources: { [fingerprint]: marks },
      });
    },
  };
}
