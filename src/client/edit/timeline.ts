import { z } from "zod";
import { create } from "zustand";
import { TimelineError, applyAll } from "../../shared/timeline/apply";
import {
  CommandSchema,
  TimelineViewSchema,
} from "../../shared/timeline/schema";
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
  /** The engine's last answer with the edits it has not answered yet applied on top. */
  view: null as TimelineView | null,
  history: { canUndo: false, canRedo: false },
}));

/** Builds an edit's commands from the timeline it applies to. */
type Build = (timeline: Timeline) => CommandInput[];

const project = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}`;

let queue = Promise.resolve();
/** The engine's last answer, which the shown view starts from. */
let confirmed: { projectId: string; view: TimelineView } | null = null;
/** Edits shown already and not yet answered, oldest first. */
let pending: { projectId: string; build: Build }[] = [];

/** Opens a project's timeline, dropping what was shown for the last one. */
export function openTimeline(projectId: string) {
  confirmed = null;
  pending = [];
  useTimeline.setState({ projectId, view: null });
}

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

const commandsFor = (build: Build, timeline: Timeline) =>
  z.array(CommandSchema).parse(build(timeline));

/**
 * The engine's last answer with each pending edit applied again on top. An edit that no longer
 * applies is left out here; its own request reports why.
 */
function shown(projectId: string): TimelineView | null {
  if (confirmed?.projectId !== projectId) return null;
  const { view } = confirmed;
  const timeline = pending
    .filter((edit) => edit.projectId === projectId)
    .reduce((current, edit) => {
      try {
        return applyAll(current, commandsFor(edit.build, current));
      } catch (error) {
        if (error instanceof TimelineError) return current;
        throw error;
      }
    }, view.timeline);
  return timeline === view.timeline ? view : { ...view, timeline };
}

async function read(projectId: string) {
  const [view, history] = await Promise.all([
    api(`${project(projectId)}/timeline`, TimelineViewSchema),
    api(`${project(projectId)}/history`, HistorySchema),
  ]);
  if (useTimeline.getState().projectId !== projectId) return view;
  confirmed = { projectId, view };
  useTimeline.setState({ view: shown(projectId), history });
  // The engine read this timeline, so an earlier refusal no longer stands.
  reportEditorError("timeline", null);
  return view;
}

export const loadTimeline = (projectId: string) =>
  enqueue(async () => {
    await read(projectId);
  });

/**
 * Applies the commands `build` makes from the timeline as one undo step. The shared engine shows
 * the result at once, so whatever reads the timeline next sees it; the server's answer then
 * replaces it, and a refusal takes it back. `build` runs again on the timeline the server holds
 * when the edit's turn comes, so quick presses each build on the last.
 */
export async function editTimeline(
  projectId: string,
  label: string,
  build: Build,
) {
  const edit = { projectId, build };
  try {
    const { view, projectId: open } = useTimeline.getState();
    if (view && open === projectId) {
      const commands = commandsFor(build, view.timeline);
      if (!commands.length) return;
      const timeline = applyAll(view.timeline, commands);
      pending.push(edit);
      useTimeline.setState({ view: { ...view, timeline } });
    } else pending.push(edit);
    await enqueue(async () => {
      try {
        const base =
          confirmed?.projectId === projectId
            ? confirmed.view
            : await read(projectId);
        const commands = commandsFor(build, base.timeline);
        if (commands.length)
          await api(
            `${project(projectId)}/commands`,
            TimelineViewSchema,
            json("POST", {
              composition: base.composition,
              expectedRevision: base.revision,
              label,
              commands,
            }),
          );
      } finally {
        pending = pending.filter((item) => item !== edit);
      }
      await read(projectId);
    });
  } catch (error) {
    pending = pending.filter((item) => item !== edit);
    const view = shown(projectId);
    if (view && useTimeline.getState().projectId === projectId)
      useTimeline.setState({ view });
    throw error;
  }
}

export const stepHistory = (projectId: string, step: "undo" | "redo") =>
  enqueue(async () => {
    await api(
      `${project(projectId)}/history/${step}`,
      z.unknown(),
      json("POST"),
    );
    await read(projectId);
  });
