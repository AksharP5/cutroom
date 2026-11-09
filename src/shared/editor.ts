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

export interface EditorReviewDraft {
  kind: "draw" | "comment";
  time: number;
  compositionPath: string;
  points: EditorPoint[];
  elementIds: string[];
  frameUrl: string;
}
