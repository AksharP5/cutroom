import { createContext } from "react";
import type { EditorMode } from "../../shared/editor";

/** The viewer's tool. The shell owns it so Escape returns to the pointer from anywhere. */
export const EditorToolsContext = createContext<{
  mode: EditorMode;
  setMode: (mode: EditorMode) => void;
} | null>(null);
