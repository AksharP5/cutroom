export type EditorMode = "select" | "draw" | "comment";

export interface EditorPoint {
  x: number;
  y: number;
}

export interface EditorContext {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  compositionPath: string;
  selectedElementIds: string[];
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
