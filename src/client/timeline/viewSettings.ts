import { create } from "zustand";
import {
  TimelineViewSettingsSchema,
  emptyTimelineViewSettings,
} from "../../shared/timeline/view";
import type { TimelineViewSettings } from "../../shared/timeline/view";
import { api, subscribeProjectEvents } from "../api";
import { reportEditorError } from "../workspace";

/**
 * How the open composition's timeline is shown and where placed media goes: track heights,
 * density and destination tracks. Saved in `.cutroom/view.json`, outside undo history.
 */
export const useViewSettings = create(emptyTimelineViewSettings);

const path = (projectId: string, composition: string) =>
  `/projects/${encodeURIComponent(projectId)}/timeline-view?composition=${encodeURIComponent(composition)}`;

/** Saves this editor has sent and not heard back about; their answers outrank a read. */
let saving = 0;

/** Shows the settings at once and saves them. */
export function saveViewSettings(
  projectId: string,
  composition: string,
  settings: TimelineViewSettings,
) {
  useViewSettings.setState(settings, true);
  saving++;
  void api(path(projectId, composition), TimelineViewSettingsSchema, {
    method: "PUT",
    body: JSON.stringify(settings),
  })
    .catch((error: unknown) => reportEditorError("timeline", error))
    .finally(() => saving--);
}

/** Reads a composition's settings and follows changes an agent makes to them. */
export function openViewSettings(projectId: string, composition: string) {
  const closing = new AbortController();
  const read = () =>
    void api(path(projectId, composition), TimelineViewSettingsSchema, {
      signal: closing.signal,
    })
      .then((settings) => {
        // A change made here since the read was sent is newer than its answer, and this
        // editor's own save comes back unchanged: neither lays the timeline out again.
        if (
          !saving &&
          JSON.stringify(settings) !==
            JSON.stringify(useViewSettings.getState())
        )
          useViewSettings.setState(settings, true);
      })
      .catch((error: unknown) => {
        if (!closing.signal.aborted) reportEditorError("timeline", error);
      });
  useViewSettings.setState(emptyTimelineViewSettings(), true);
  read();
  const unsubscribe = subscribeProjectEvents(projectId, "view", read);
  return () => {
    closing.abort();
    unsubscribe();
  };
}
