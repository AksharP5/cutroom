import { create } from "zustand";
import { z } from "zod";
import { ClipSourcesSchema } from "../../../shared/code";
import { SourceSchema } from "../../../shared/project";
import { ApiError, api, json, subscribeProjectEvents } from "../../api";
import { showToast } from "../../workspace";

/**
 * The code panel's open file. `content` and `version` are the file as last read or saved, which the
 * buffer is compared with and saves against. `load` changes when the buffer must take the file's
 * text; a save only moves the base under the buffer.
 */
export interface CodeFile {
  path: string;
  content: string;
  version: string;
  load: number;
}

export const useCode = create(() => ({
  projectId: null as string | null,
  file: null as CodeFile | null,
  /** The buffer differs from the file it was loaded from. The editor keeps this current. */
  edited: false,
  saving: false,
  /** The file changed or was deleted (`version: null`) on disk while the buffer held edits. */
  outside: null as
    { version: string; content: string } | { version: null } | null,
  /** A place to show: an offset into the file's text at `version`. */
  reveal: null as { offset: number; version: string; id: number } | null,
}));

const get = useCode.getState;
const set = useCode.setState;
let loads = 0;
let reveals = 0;
/** The buffer's text, once the editor has mounted. Before that the buffer is the file. */
let buffer = () => get().file?.content ?? "";
export const attachBuffer = (read: () => string) => {
  buffer = read;
  return () => {
    if (buffer === read) buffer = () => get().file?.content ?? "";
  };
};

/** Reads, saves and outside refreshes run one at a time, so each sees the last one's version. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

const notice = (text: string) =>
  showToast(text, null, { tone: "info", transient: true });
const fail = (error: unknown) =>
  showToast(error instanceof Error ? error.message : String(error));

const sourceUrl = (projectId: string, path: string) =>
  `/projects/${encodeURIComponent(projectId)}/source?path=${encodeURIComponent(path)}`;

/** The file as it is on disk, or null once it is gone. */
const readFile = (projectId: string, path: string) =>
  api(sourceUrl(projectId, path), SourceSchema).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });

/** Follows one project's files; returns the cleanup that forgets it. */
export function startCode(projectId: string) {
  set({
    projectId,
    file: null,
    edited: false,
    saving: false,
    outside: null,
    reveal: null,
  });
  const stop = subscribeProjectEvents(projectId, "message", (event) => {
    const change = z
      .object({ changed: z.string() })
      .safeParse(JSON.parse(String(event.data)));
    if (change.success && change.data.changed === get().file?.path)
      void serial(refresh).catch(fail);
  });
  return () => {
    stop();
    if (get().projectId === projectId) set({ projectId: null, file: null });
  };
}

/** Takes an outside change into a clean buffer, and flags it over an edited one. */
async function refresh() {
  const { projectId, file } = get();
  if (!projectId || !file) return;
  const source = await readFile(projectId, file.path);
  if (get().file?.path !== file.path) return;
  if (!source) {
    if (get().edited) set({ outside: { version: null } });
    else set({ file: null, outside: null });
    return;
  }
  if (source.version === get().file?.version) return;
  if (!get().edited || buffer() === source.content)
    set({ file: { ...source, load: ++loads }, outside: null });
  else set({ outside: { version: source.version, content: source.content } });
}

/**
 * Opens a project file. Unsaved edits to another file are kept; the person chooses to discard
 * them. Resolves whether `path` is open.
 */
export function openFile(path: string, discard = false): Promise<boolean> {
  return serial(async () => {
    const { projectId, file, edited } = get();
    if (!projectId) return false;
    if (file?.path === path) return true;
    if (file && edited && !discard) {
      showToast(
        `Unsaved changes in ${file.path}.`,
        { label: "Discard", run: () => void openFile(path, true) },
        { tone: "info" },
      );
      return false;
    }
    const source = await api(sourceUrl(projectId, path), SourceSchema);
    if (get().projectId !== projectId) return false;
    set({
      file: { ...source, load: ++loads },
      edited: false,
      outside: null,
      reveal: null,
    });
    return true;
  }).catch((error: unknown) => {
    fail(error);
    return false;
  });
}

/**
 * Saves the buffer through the source writer, against the version it was loaded from: one undo
 * step. A file changed since is a conflict to resolve, never overwritten.
 */
export function saveFile(over?: string | null) {
  return serial(async () => {
    const { projectId, file, edited, outside } = get();
    if (!projectId || !file) return;
    // The conflict notice already says what to do.
    if (outside && over === undefined) return;
    if (!edited && over === undefined) return;
    const content = buffer();
    set({ saving: true });
    try {
      const saved = await api(
        `/projects/${encodeURIComponent(projectId)}/source`,
        SourceSchema,
        json("PUT", {
          path: file.path,
          content,
          expectedVersion: over === undefined ? file.version : over,
        }),
      );
      if (get().file?.path !== file.path) return;
      set((state) => ({
        file: state.file && { ...state.file, ...saved },
        outside: null,
      }));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      await refresh();
    } finally {
      set({ saving: false });
    }
  }).catch(fail);
}

/** Resolves an outside change: take the file as it is now, or save the buffer over it. */
export function resolveOutside(keep: "theirs" | "mine") {
  const { outside } = get();
  if (!outside) return;
  if (keep === "mine") return void saveFile(outside.version);
  set((state) => ({
    file:
      outside.version === null || !state.file
        ? null
        : {
            path: state.file.path,
            content: outside.content,
            version: outside.version,
            load: ++loads,
          },
    outside: null,
  }));
}

let following = 0;
/** Shows a clip's element in its composition's source, opening that file when it is not open. */
export async function revealClip(composition: string, clipId: string) {
  const id = ++following;
  const { projectId, file } = get();
  if (!projectId) return;
  if (file?.path !== composition && !(await openFile(composition))) return;
  const sources = await api(
    `/projects/${encodeURIComponent(projectId)}/timeline/sources?composition=${encodeURIComponent(composition)}`,
    ClipSourcesSchema,
  ).catch(() => null);
  const offset = sources?.clips[clipId];
  if (id !== following || !sources || offset === undefined) return;
  set({ reveal: { offset, version: sources.version, id: ++reveals } });
}

/** Whether leaving the project keeps no unsaved code; says what to do when it would. */
export function codeCanLeave() {
  const { file, edited } = get();
  if (!file || !edited) return true;
  showToast(
    `Unsaved changes in ${file.path}. Save or discard them first.`,
    {
      label: "Discard",
      // The buffer takes the file back; leaving then goes ahead on the next try.
      run: () =>
        set((state) => ({
          file: state.file && { ...state.file, load: ++loads },
          outside: null,
        })),
    },
    { tone: "info" },
  );
  return false;
}
