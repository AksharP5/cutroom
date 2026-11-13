import { create } from "zustand";
import type { z } from "zod";
import { api, subscribeProjectEvents } from "./api";
import { reportEditorError } from "./workspace";

/** The file whose preferences this editor holds, and the choices it has made. */
interface Open {
  projectId: string;
  path: string;
  onRead?: () => void;
  /** Counts the choices made here, so an answer read before the latest one is known to be old. */
  choices: number;
  /** Saves sent and not yet answered. */
  saving: number;
  /** A read was set aside while a save was out, and is owed once the saves have landed. */
  owed: boolean;
  closing: AbortController;
}

/**
 * Reads what the server holds for the open file. The answer is shown unless this editor
 * has chosen something newer: with a save still out, the read waits for it and runs again, and
 * an answer read before the latest choice is read again now that the choice is saved.
 */
export function createViewPreferences<T extends object>(
  schema: z.ZodType<T>,
  defaults: () => T,
) {
  const usePreferences = create(defaults);
  let open: Open | null = null;

  function read(target: Open) {
    const { choices } = target;
    void api(target.path, schema, {
      signal: target.closing.signal,
    })
      .then((settings) => {
        if (open !== target) return;
        if (target.saving) {
          target.owed = true;
          return;
        }
        if (target.choices !== choices) return read(target);
        // This editor's own save comes back unchanged, and does not update subscribers again.
        if (
          JSON.stringify(settings) !== JSON.stringify(usePreferences.getState())
        )
          usePreferences.setState(settings, true);
        target.onRead?.();
      })
      .catch((error: unknown) => {
        if (!target.closing.signal.aborted)
          reportEditorError("timeline", error);
      });
  }

  /** Shows the open file's new settings at once and saves them. */
  function save(settings: T) {
    const target = open;
    if (!target) return;
    usePreferences.setState(settings, true);
    target.choices++;
    target.saving++;
    void api(target.path, schema, {
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
   * Opens a file's settings and follows changes an agent makes to them. Another
   * file's saves still out belong to it alone and never hold this one's read back.
   */
  function load(projectId: string, path: string, onRead?: () => void) {
    const target: Open = {
      projectId,
      path,
      onRead,
      choices: 0,
      saving: 0,
      owed: false,
      closing: new AbortController(),
    };
    open = target;
    usePreferences.setState(defaults(), true);
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

  return { use: usePreferences, save, open: load };
}
