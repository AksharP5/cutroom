import { create } from "zustand";
import type { z } from "zod";
import { ApiError, api, subscribeProjectEvents } from "./api";
import { reportEditorError } from "./workspace";

interface SaveQueue<T> {
  running: boolean;
  pending: T | null;
  latest: T | null;
  resumed: boolean;
  stopReady: (() => void) | null;
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

  function release(path: string, queue: SaveQueue<T>) {
    if (queue.running || queue.pending !== null || open?.queue === queue)
      return;
    if (queues.get(path) === queue) queues.delete(path);
    queue.stopReady?.();
    queue.stopReady = null;
  }

  function read(target: Open<T>) {
    const sequence = ++target.reads;
    // The drain reads again after all pending choices reach the server.
    if (target.queue.running || target.queue.pending !== null) return;
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
      queue.resumed = false;
      const settings = queue.pending;
      queue.pending = null;
      try {
        await api(path, schema, {
          method: "PUT",
          body: JSON.stringify(settings),
        });
      } catch (error) {
        reportEditorError("timeline", error);
        if (
          error instanceof TypeError ||
          (error instanceof ApiError && error.status >= 500)
        ) {
          queue.pending ??= settings;
          // Reconnect may arrive before the failed request finishes. Otherwise wait for it.
          if (queue.resumed) continue;
          break;
        }
      }
    }
    queue.running = false;
    if (open?.queue === queue) read(open);
    release(path, queue);
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
    let queue = queues.get(path);
    if (!queue) {
      const created: SaveQueue<T> = {
        running: false,
        pending: null,
        latest: null,
        resumed: false,
        stopReady: subscribeProjectEvents(projectId, "ready", () => {
          created.resumed = true;
          if (created.pending !== null) void drain(path, created);
          else if (open?.queue === created) read(open);
        }),
      };
      queue = created;
      queues.set(path, queue);
    }
    const target: Open<T> = {
      path,
      queue,
      reads: 0,
      onRead,
      closing: new AbortController(),
    };
    open = target;
    usePreferences.setState(queue.latest ?? defaults(), true);
    if (queue.pending !== null) void drain(path, queue);
    else read(target);
    const unsubscribe = subscribeProjectEvents(projectId, "view", () =>
      read(target),
    );
    return () => {
      target.closing.abort();
      unsubscribe();
      if (open === target) open = null;
      release(path, queue);
    };
  }
  return { use: usePreferences, save, open: load };
}
