import { z } from "zod";
import { create } from "zustand";
import { TimelineViewSchema } from "../../shared/timeline/schema";
import type {
  CommandInput,
  Timeline,
  TimelineView,
} from "../../shared/timeline/schema";
import { api, json } from "../api";
import { reportEditorError } from "../workspace";

const HistorySchema = z.object({ canUndo: z.boolean(), canRedo: z.boolean() });

/** The engine's timeline for the open composition, shared by the viewer, transport, and timeline. */
export const useTimeline = create(() => ({
  /** The project the views belong to; a read for another project is dropped. */
  projectId: null as string | null,
  view: null as TimelineView | null,
  history: { canUndo: false, canRedo: false },
}));

const project = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}`;

let queue = Promise.resolve();

/**
 * Reads, edits, undo, and redo run one at a time. Each step starts from the view the previous one
 * left, so quick key presses never send a stale revision and a slow read never lands over a
 * newer view.
 */
function enqueue(step: () => Promise<void>) {
  const run = queue.then(step);
  queue = run.catch(() => {});
  return run;
}

async function read(projectId: string) {
  const [view, history] = await Promise.all([
    api(`${project(projectId)}/timeline`, TimelineViewSchema),
    api(`${project(projectId)}/history`, HistorySchema),
  ]);
  if (useTimeline.getState().projectId !== projectId) return view;
  useTimeline.setState({ view, history });
  // The engine read this timeline, so an earlier refusal no longer stands.
  reportEditorError("timeline", null);
  return view;
}

export const loadTimeline = (projectId: string) =>
  enqueue(async () => {
    await read(projectId);
  });

/** Applies commands built from the current timeline as one undo step. */
export const editTimeline = (
  projectId: string,
  label: string,
  commands: (timeline: Timeline) => CommandInput[],
) =>
  enqueue(async () => {
    const current = useTimeline.getState().view ?? (await read(projectId));
    await api(
      `${project(projectId)}/commands`,
      TimelineViewSchema,
      json("POST", {
        composition: current.composition,
        expectedRevision: current.revision,
        label,
        commands: commands(current.timeline),
      }),
    );
    await read(projectId);
  });

export const stepHistory = (projectId: string, step: "undo" | "redo") =>
  enqueue(async () => {
    await api(
      `${project(projectId)}/history/${step}`,
      z.unknown(),
      json("POST"),
    );
    await read(projectId);
  });
