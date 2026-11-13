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

/** The composition whose settings the store holds, and what this editor has done to them. */
interface Open {
  projectId: string;
  composition: string;
  /** Counts the choices made here, so an answer read before the latest one is known to be old. */
  choices: number;
  /** Saves sent and not yet answered. */
  saving: number;
  /** A read was set aside while a save was out, and is owed once the saves have landed. */
  owed: boolean;
  closing: AbortController;
}
let open: Open | null = null;

const path = ({ projectId, composition }: Open) =>
  `/projects/${encodeURIComponent(projectId)}/timeline-view?composition=${encodeURIComponent(composition)}`;

/**
 * Reads what the server holds for the open composition. The answer is shown unless this editor
 * has chosen something newer: with a save still out, the read waits for it and runs again, and
 * an answer read before the latest choice is read again now that the choice is saved.
 */
function read(target: Open) {
  const { choices } = target;
  void api(path(target), TimelineViewSettingsSchema, {
    signal: target.closing.signal,
  })
    .then((settings) => {
      if (open !== target) return;
      if (target.saving) {
        target.owed = true;
        return;
      }
      if (target.choices !== choices) return read(target);
      // This editor's own save comes back unchanged, and does not lay the timeline out again.
      if (
        JSON.stringify(settings) !== JSON.stringify(useViewSettings.getState())
      )
        useViewSettings.setState(settings, true);
    })
    .catch((error: unknown) => {
      if (!target.closing.signal.aborted) reportEditorError("timeline", error);
    });
}

/** Shows the open composition's new settings at once and saves them. */
export function saveViewSettings(settings: TimelineViewSettings) {
  const target = open;
  if (!target) return;
  useViewSettings.setState(settings, true);
  target.choices++;
  target.saving++;
  void api(path(target), TimelineViewSettingsSchema, {
    method: "PUT",
    body: JSON.stringify(settings),
  })
    .catch((error: unknown) => reportEditorError("timeline", error))
    .finally(() => {
      target.saving--;
      if (open !== target || target.saving || !target.owed) return;
      target.owed = false;
      read(target);
    });
}

/**
 * Opens a composition's settings and follows changes an agent makes to them. Another
 * composition's saves still out belong to it alone and never hold this one's read back.
 */
export function openViewSettings(projectId: string, composition: string) {
  const target: Open = {
    projectId,
    composition,
    choices: 0,
    saving: 0,
    owed: false,
    closing: new AbortController(),
  };
  open = target;
  useViewSettings.setState(emptyTimelineViewSettings(), true);
  read(target);
  const unsubscribe = subscribeProjectEvents(projectId, "view", () =>
    read(target),
  );
  return () => {
    target.closing.abort();
    unsubscribe();
    if (open === target) open = null;
  };
}
