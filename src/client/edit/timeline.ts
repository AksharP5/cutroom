import { create } from "zustand";
import { TimelineViewSchema } from "../../shared/timeline/schema";
import type {
  CommandInput,
  Timeline,
  TimelineView,
} from "../../shared/timeline/schema";
import { api, json } from "../api";

/** The engine's timeline for the open composition, shared by the viewer, transport, and timeline. */
export const useTimeline = create(() => ({
  view: null as TimelineView | null,
}));

export async function loadTimeline(projectId: string) {
  const view = await api(
    `/projects/${encodeURIComponent(projectId)}/timeline`,
    TimelineViewSchema,
  );
  useTimeline.setState({ view });
  return view;
}

let edits = Promise.resolve();

/**
 * Applies commands as one undo step. Edits run one at a time, and each builds its commands from
 * the timeline the previous one left, so quick key presses never send a stale revision.
 */
export function editTimeline(
  projectId: string,
  label: string,
  commands: (timeline: Timeline) => CommandInput[],
) {
  const edit = edits.then(async () => {
    const current =
      useTimeline.getState().view ?? (await loadTimeline(projectId));
    const view = await api(
      `/projects/${encodeURIComponent(projectId)}/commands`,
      TimelineViewSchema,
      json("POST", {
        composition: current.composition,
        expectedRevision: current.revision,
        label,
        commands: commands(current.timeline),
      }),
    );
    useTimeline.setState({ view });
  });
  edits = edit.catch(() => {});
  return edit;
}
