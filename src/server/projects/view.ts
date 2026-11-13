import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import type { Project } from "../../shared/project";
import {
  SourceMarksSchema,
  SourceIdentitySchema,
  emptySourceMarks,
  TimelineViewSettingsSchema,
  emptyTimelineViewSettings,
} from "../../shared/timeline/view";
import type {
  SourceIdentity,
  SourceMarksSave,
  TimelineViewSettings,
} from "../../shared/timeline/view";
import { isMissing, projectPath, projectStatePath } from "./path";

export const VIEW_PATH = ".cutroom/view.json";
const SourceEntrySchema = SourceMarksSchema.safeExtend({
  // Legacy entries lack duration; their next mark save supplies it.
  identity: SourceIdentitySchema.extend({
    duration: SourceIdentitySchema.shape.duration.nullable(),
  }),
});
const ViewFileSchema = z.object({
  timelines: z.record(z.string(), TimelineViewSettingsSchema),
  sources: z.record(z.string(), SourceEntrySchema),
});
type Views = z.infer<typeof ViewFileSchema>;
const records = z.record(z.string(), z.unknown());
const legacyKey = z.tuple([
  z.string(),
  z.number().int().nonnegative(),
  z.number(),
]);

function preferenceAt<T>(entries: Record<string, T>, path: string) {
  return Object.hasOwn(entries, path) ? entries[path] : undefined;
}

async function readViews(project: Project): Promise<Views> {
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
    /* Truncated preferences use defaults. */
  }
  const sections = records.safeParse(json);
  const timelines = new Map<string, TimelineViewSettings>();
  const sources = new Map<string, z.infer<typeof SourceEntrySchema>>();
  const entries = (value: unknown) =>
    Object.entries(records.safeParse(value).data ?? {});
  for (const [path, value] of entries(sections.data?.timelines)) {
    const parsed = TimelineViewSettingsSchema.safeParse(value);
    if (parsed.success) timelines.set(path, parsed.data);
  }
  for (const [path, value] of entries(sections.data?.sources)) {
    const parsed = SourceEntrySchema.safeParse(value);
    if (parsed.success) {
      sources.set(path, parsed.data);
      continue;
    }
    // Migrate old [path,size,mtime] keys without discarding valid marks or retaining every version.
    let key: unknown = null;
    try {
      key = JSON.parse(path);
    } catch {
      continue;
    }
    const legacy = legacyKey.safeParse(key);
    const marks = SourceMarksSchema.safeParse(value);
    if (legacy.success && marks.success)
      sources.set(legacy.data[0], {
        ...marks.data,
        identity: { size: legacy.data[1], duration: null },
      });
  }
  return {
    timelines: Object.fromEntries(timelines),
    sources: Object.fromEntries(sources),
  };
}

/** View preferences share one atomic write queue, outside content history and review. */
export function createProjectViewStore() {
  const scheduled = new Map<
    string,
    {
      updates: Views;
      timer: ReturnType<typeof setTimeout> | null;
      completion: ReturnType<typeof Promise.withResolvers<void>>;
    }
  >();
  const writes = new Map<string, Promise<void>>();
  const write = (project: Project, update: (current: Views) => Views) => {
    const completion = (writes.get(project.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const current = await readViews(project);
        const value = update(current);
        if (value === current) return;
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
    writes.set(project.id, completion);
    const finished = () => {
      if (writes.get(project.id) === completion) writes.delete(project.id);
    };
    void completion.then(finished, finished);
    return completion;
  };
  const flush = (project: Project) => {
    const pending = scheduled.get(project.id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    scheduled.delete(project.id);
    void write(project, (current) => ({
      timelines: { ...current.timelines, ...pending.updates.timelines },
      sources: { ...current.sources, ...pending.updates.sources },
    })).then(pending.completion.resolve, pending.completion.reject);
  };
  const save = (project: Project, updates: Views) => {
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
    batch.updates = {
      timelines: { ...batch.updates.timelines, ...updates.timelines },
      sources: { ...batch.updates.sources, ...updates.sources },
    };
    batch.timer = setTimeout(() => flush(project), 150);
    return batch.completion.promise;
  };
  return {
    async read(project: Project, composition: string) {
      await writes.get(project.id);
      return (
        preferenceAt(
          scheduled.get(project.id)?.updates.timelines ?? {},
          composition,
        ) ??
        preferenceAt((await readViews(project)).timelines, composition) ??
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
    async readSource(project: Project, path: string, identity: SourceIdentity) {
      await writes.get(project.id);
      const entry =
        preferenceAt(scheduled.get(project.id)?.updates.sources ?? {}, path) ??
        preferenceAt((await readViews(project)).sources, path);
      return entry?.identity.size === identity.size &&
        (entry.identity.duration === null ||
          entry.identity.duration === identity.duration)
        ? { in: entry.in, out: entry.out }
        : emptySourceMarks();
    },
    saveSource(project: Project, path: string, entry: SourceMarksSave) {
      return save(project, { timelines: {}, sources: { [path]: entry } });
    },
    moveSource(project: Project, from: string, to: string) {
      if (from === to) return Promise.resolve();
      flush(project);
      return write(project, (current) => {
        const entry = preferenceAt(current.sources, from);
        if (!entry && !preferenceAt(current.sources, to)) return current;
        const sources = { ...current.sources };
        if (entry) sources[to] = entry;
        else delete sources[to];
        delete sources[from];
        return { ...current, sources };
      });
    },
  };
}
export const projectViews = createProjectViewStore();

/** Call after a successful media rename. Pending mark saves are included in the same queue. */
export async function moveSourceMarks(
  project: Project,
  from: string,
  to: string,
) {
  await projectPath(project, from, true);
  await projectPath(project, to);
  const canonical = (path: string) =>
    posix.normalize(path.replaceAll("\\", "/"));
  await projectViews.moveSource(project, canonical(from), canonical(to));
}
