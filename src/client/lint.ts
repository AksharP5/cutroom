import { useEffect } from "react";
import { z } from "zod";
import { create } from "zustand";
import { compactLint } from "../shared/lint";
import { useTimeline } from "./edit/timeline";
import { subscribeProjectEvents } from "./api";

type Lint = ReturnType<typeof compactLint>;

const fileChangeSchema = z.object({ affectsPreview: z.boolean() });
/** Saves arrive in bursts; one lint after the last is enough. */
const SETTLE_MS = 400;

/** The open project's HyperFrames lint, shared by everything that shows it. */
const useLintState = create<{
  projectId: string | null;
  lint: Lint | null;
  failure: string | null;
}>(() => ({ projectId: null, lint: null, failure: null }));

const watchers = new Map<string, { count: number; stop(): void }>();

/** The timeline being edited, the one above an open scene. */
const openTimeline = () => {
  const { composition, parents } = useTimeline.getState();
  return parents[0] ?? composition;
};

/** Lints when the project opens and again after each source change, while anything watches. */
function watch(projectId: string) {
  const known = watchers.get(projectId);
  if (known) known.count++;
  else {
    useLintState.setState({ projectId, lint: null, failure: null });
    let request = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      // Until the editor knows which timeline it opens, there is nothing to lint in full.
      if (useTimeline.getState().projectId !== projectId) return;
      request.abort();
      request = new AbortController();
      const { signal } = request;
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/lint?${new URLSearchParams({ composition: openTimeline() })}`,
          { signal },
        );
        const body: unknown = await response.json();
        if (!response.ok)
          throw new Error(
            z.object({ error: z.string() }).safeParse(body).data?.error ??
              `Lint returned ${response.status}`,
          );
        useLintState.setState({
          projectId,
          lint: compactLint(body),
          failure: null,
        });
      } catch (error) {
        if (signal.aborted) return;
        useLintState.setState({
          projectId,
          failure: error instanceof Error ? error.message : String(error),
        });
      }
    };
    void check();
    const unsubscribe = subscribeProjectEvents(
      projectId,
      "file-change",
      (event) => {
        const change = fileChangeSchema.safeParse(JSON.parse(event.data));
        if (!change.success || !change.data.affectsPreview) return;
        clearTimeout(timer);
        timer = setTimeout(() => void check(), SETTLE_MS);
      },
    );
    // The open timeline is linted in full, so switching timelines lints again, once the switch
    // has read its timeline: lint keeps a server thread busy for a few hundred milliseconds.
    const stopTimeline = useTimeline.subscribe((state, previous) => {
      if (
        state.projectId === projectId &&
        (previous.projectId !== projectId ||
          (state.parents[0] ?? state.composition) !==
            (previous.parents[0] ?? previous.composition))
      ) {
        clearTimeout(timer);
        timer = setTimeout(() => void check(), SETTLE_MS);
      }
    });
    watchers.set(projectId, {
      count: 1,
      stop() {
        unsubscribe();
        stopTimeline();
        clearTimeout(timer);
        request.abort();
      },
    });
  }
  return () => {
    const watcher = watchers.get(projectId);
    if (!watcher || --watcher.count) return;
    watcher.stop();
    watchers.delete(projectId);
  };
}

/** The project's lint findings, or the reason lint failed. Null until the first answer. */
export function useLint(projectId: string) {
  useEffect(() => watch(projectId), [projectId]);
  const shown = useLintState((state) => state.projectId === projectId);
  const lint = useLintState((state) => state.lint);
  const failure = useLintState((state) => state.failure);
  return shown ? { lint, failure } : { lint: null, failure: null };
}
