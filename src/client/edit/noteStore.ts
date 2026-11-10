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
