import { create } from "zustand";
import type { z } from "zod";
import { api, subscribeProjectEvents } from "./api";
import { reportEditorError } from "./workspace";

interface SaveQueue<T> {
  running: boolean;
  pending: T | null;
  latest: T | null;
}
interface Open<T> {
  path: string;
  queue: SaveQueue<T>;
  reads: number;
  onRead?: () => void;
  closing: AbortController;
}

/** Per-file saves outlive navigation; each viewer accepts only its newest read. */
export function createViewPreferences<T extends object>(
  schema: z.ZodType<T>,
  defaults: () => T,
) {
  const usePreferences = create(defaults);
  const queues = new Map<string, SaveQueue<T>>();
  let open: Open<T> | null = null;

  function read(target: Open<T>) {
    const sequence = ++target.reads;
    // The drain reads again after all pending choices reach the server.
    if (target.queue.running) return;
    void api(target.path, schema, { signal: target.closing.signal })
      .then((settings) => {
        if (open !== target || target.reads !== sequence) return;
        target.queue.latest = settings;
        if (
          JSON.stringify(settings) !== JSON.stringify(usePreferences.getState())
        )
          usePreferences.setState(settings, true);
        target.onRead?.();
      })
      .catch((error: unknown) => {
        if (!target.closing.signal.aborted && target.reads === sequence)
          reportEditorError("timeline", error);
      });
  }

  async function drain(path: string, queue: SaveQueue<T>) {
    if (queue.running) return;
    queue.running = true;
    while (queue.pending !== null) {
      const settings = queue.pending;
      queue.pending = null;
      await api(path, schema, {
        method: "PUT",
        body: JSON.stringify(settings),
      }).catch((error: unknown) => reportEditorError("timeline", error));
    }
    queue.running = false;
    if (open?.queue === queue) read(open);
    else queues.delete(path);
  }

  function save(settings: T) {
    const target = open;
    if (!target) return;
    ++target.reads;
    target.queue.latest = settings;
    target.queue.pending = settings;
    void drain(target.path, target.queue);
    usePreferences.setState(settings, true);
  }

  function load(projectId: string, path: string, onRead?: () => void) {
    const queue = queues.get(path) ?? {
      running: false,
      pending: null,
      latest: null,
    };
    queues.set(path, queue);
    const target: Open<T> = {
      path,
      queue,
      reads: 0,
      onRead,
      closing: new AbortController(),
    };
    open = target;
    usePreferences.setState(queue.latest ?? defaults(), true);
    read(target);
    const unsubscribe = subscribeProjectEvents(projectId, "view", () =>
      read(target),
    );
    return () => {
      target.closing.abort();
      unsubscribe();
      if (open === target) open = null;
      if (!queue.running && open?.queue !== queue) queues.delete(path);
    };
  }
  return { use: usePreferences, save, open: load };
}
