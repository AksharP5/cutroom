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
