import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { fileContentVersion } from "@hyperframes/studio-server";
import type { Project } from "../../shared/project";
import type { ProjectStore } from "./store";
import type { Timeline } from "../../shared/timeline/schema";
import type { TweenWindows } from "../../shared/preview";
import { toSeconds } from "../../shared/timeline/apply";
import { isMissing, projectStatePath } from "./path";

const PATH = ".cutroom/animation-baselines.json";
const ClipStateSchema = z.object({
  signature: z.string(),
  command: z.number().int().nonnegative(),
  baseline: z
    .object({
      source: z.number().int().nonnegative(),
      command: z.number().int().nonnegative(),
      offsets: z.record(z.string(), z.number().finite()),
    })
    .optional(),
});
const StateSchema = z.object({
  version: z.literal(1),
  revision: z.string(),
  sequence: z.number().int().nonnegative(),
  source: z.number().int().nonnegative(),
  compositions: z.record(z.string(), z.record(z.string(), ClipStateSchema)),
});
type State = z.infer<typeof StateSchema>;
type Sources = ReadonlyMap<
  string,
  { sourceVersion: string; animationClips: ReadonlyMap<string, string> }
>;

/** Called only in the review queue. Content history never owns these observations or offsets. */
export function createAnimationBaselines(
  persistState: ProjectStore["persistState"] = (write) => write(),
) {
  const projects = new Map<string, Promise<State>>();
  const pending = new Map<string, Promise<void>>();
  const writes = new Map<string, Promise<void>>();
  const load = (project: Project) => {
    let state = projects.get(project.id);
    if (!state) {
      state = (async () => {
        const raw = await projectStatePath(project, PATH, true)
          .then((path) => readFile(path, "utf8"))
          .catch((error: unknown) => {
            if (isMissing(error)) return "null";
            throw error;
          });
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          value = null;
        }
        const parsed = StateSchema.safeParse(value);
        return parsed.success
          ? parsed.data
          : {
              version: 1 as const,
              revision: "",
              sequence: 0,
              source: 0,
              compositions: Object.create(null),
            };
      })();
      projects.set(project.id, state);
    }
    return state;
  };
  const save = (project: Project, state: State) => {
    const previous = pending.get(project.id);
    if (previous) return previous;
    const completion = Promise.withResolvers<void>();
    const done = persistState(() => {
      setTimeout(() => {
        pending.delete(project.id);
        const bytes = `${JSON.stringify(state)}\n`;
        const write = (writes.get(project.id) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            await mkdir(await projectStatePath(project, ".cutroom", true), {
              recursive: true,
            });
            const path = await projectStatePath(project, PATH, true);
            const temporary = `${path}.${randomUUID()}.tmp`;
            await writeFile(temporary, bytes, { mode: 0o600 });
            await rename(temporary, path);
          });
        writes.set(project.id, write);
        void write.then(completion.resolve, completion.reject).finally(() => {
          if (writes.get(project.id) === write) writes.delete(project.id);
        });
      }, 150);
      return completion.promise;
    });
    pending.set(project.id, done);
    return done;
  };
  return {
    async observe(project: Project, sources: Sources, command = false) {
      const state = await load(project);
      const revision = fileContentVersion(
        JSON.stringify(
          [...sources]
            .map(([path, value]) => [path, value.sourceVersion])
            .sort(),
        ),
      );
      if (state.revision === revision)
        return { revision, intent: String(state.source) };
      const initial = !state.revision;
      state.sequence++;
      if (!command) state.source = state.sequence;
      for (const [composition, value] of sources) {
        const clips = (state.compositions[composition] ??= Object.create(null));
        for (const [id, signature] of value.animationClips) {
          const previous = Object.hasOwn(clips, id) ? clips[id] : undefined;
          clips[id] = {
            ...previous,
            signature,
            command:
              command && !initial && previous?.signature !== signature
                ? state.sequence
                : (previous?.command ?? 0),
          };
        }
        for (const id of Object.keys(clips))
          if (!value.animationClips.has(id)) delete clips[id];
      }
      for (const composition of Object.keys(state.compositions))
        if (!sources.has(composition)) delete state.compositions[composition];
      state.revision = revision;
      void save(project, state).catch((error: unknown) =>
        console.error("Cannot save animation baselines:", error),
      );
      return { revision, intent: String(state.source) };
    },
    async report(
      project: Project,
      composition: string,
      timeline: Timeline,
      windows: TweenWindows,
    ) {
      const state = await load(project);
      const clips = (state.compositions[composition] ??= Object.create(null));
      const verified: TweenWindows = Object.create(null);
      for (const clip of timeline.clips) {
        const entry = clips[clip.id];
        if (!entry) continue;
        const inherited =
          clip.animationSource && Object.hasOwn(clips, clip.animationSource)
            ? clips[clip.animationSource]?.baseline
            : undefined;
        const baseline = entry.baseline ?? inherited;
        const pairs = Object.hasOwn(windows, clip.id) ? windows[clip.id]! : [];
        const origin =
          toSeconds(clip.start, timeline.fps) -
          (clip.mediaStart ?? clip.animationInPoint ?? 0) / clip.playbackRate;
        const sourceChanged = !baseline || state.source !== baseline.source;
        // A source revision after the last command is a clean opportunity to establish intent.
        // A source revision followed by an unseen command cannot certify that moved state.
        const clean =
          entry.command <= (baseline?.command ?? 0) ||
          state.source > entry.command;
        if (sourceChanged && !clean) continue;
        const offsets = sourceChanged
          ? (Object.create(null) as Record<string, number>)
          : { ...baseline!.offsets };
        for (const [id, start] of pairs) {
          if (Object.hasOwn(offsets, id)) continue;
          if (clean) offsets[id] = start - origin;
        }
        entry.baseline = {
          source: state.source,
          command: sourceChanged ? entry.command : baseline!.command,
          offsets,
        };
        verified[clip.id] = Object.entries(offsets).map(([id, offset]) => [
          id,
          offset,
        ]);
      }
      await save(project, state);
      return verified;
    },
  };
}
