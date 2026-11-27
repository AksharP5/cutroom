import type { ClipKind } from "./timeline/schema";

export type EditorMode =
  "select" | "trim" | "blade" | "region" | "draw" | "comment";

export interface EditorPoint {
  x: number;
  y: number;
}

/** A selected timeline clip as the agent is told about it. Times are seconds on the composition's timeline. */
export interface SelectedClip {
  id: string;
  name: string;
  kind: ClipKind;
  start: number;
  end: number;
}

export interface EditorContext {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  compositionPath: string;
  selectedElementIds: string[];
  /** The selected clips by name, for the agent. */
  selectedClips?: SelectedClip[];
}

/** A note marked on the picture, ready to save. With strokes it is a drawing, otherwise a comment. */
export interface EditorReviewDraft {
  id?: string;
  time: number;
  /** The start of the last frame the note covers. */
  endTime?: number;
  compositionPath: string;
  /** Where its pin sits. */
  point?: EditorPoint;
  strokes: EditorPoint[][];
  elementIds: string[];
}
