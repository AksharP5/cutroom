import { create } from "zustand";
import { noNotes, notesReducer } from "./notes";
import type { NoteEvent, Notes } from "./notes";

/** Drafts and in-flight saves belong to projects, even while their editors are unmounted. */
export const useProjectNotes = create(() => ({
  projects: {} as Record<string, Notes>,
}));

export function dispatchNote(projectId: string, event: NoteEvent) {
  useProjectNotes.setState(({ projects }) => ({
    projects: {
      ...projects,
      [projectId]: notesReducer(projects[projectId] ?? noNotes, event),
    },
  }));
}

const saves = new Map<string, Promise<void>>();
const captures = new Map<string, Set<Promise<unknown>>>();

/** Track from the save's start until its frame has been attached, without holding later saves. */
export function trackNoteCapture<T>(projectId: string, capture: Promise<T>) {
  const pending = captures.get(projectId) ?? new Set<Promise<unknown>>();
  captures.set(projectId, pending);
  pending.add(capture);
  const settled = () => {
    pending.delete(capture);
    if (!pending.size && captures.get(projectId) === pending)
      captures.delete(projectId);
  };
  void capture.then(settled, settled);
  return capture;
}

/** Give this project's pending images up to three seconds before sending chat. */
export async function waitForNoteCaptures(
  projectId: string,
  timeoutMs = 3_000,
) {
  const pending = captures.get(projectId);
  if (!pending?.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Preserve annotation commit order. Captures stay outside this queue; failures reach the caller. */
export function saveNoteInOrder<T>(projectId: string, save: () => Promise<T>) {
  const result = (saves.get(projectId) ?? Promise.resolve()).then(save);
  // A refused save must not block the next note in this project.
  const settled = result.then(
    () => {},
    () => {},
  );
  saves.set(projectId, settled);
  void settled.then(() => {
    if (saves.get(projectId) === settled) saves.delete(projectId);
  });
  return result;
}
