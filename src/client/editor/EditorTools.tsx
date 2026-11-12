import { createContext, useContext } from "react";
import {
  ArrowsOutSimple,
  ChatTeardropText,
  Cursor,
  PencilSimple,
} from "@phosphor-icons/react";
import type { EditorMode } from "../../shared/editor";
import { blurPointerButton, hint, keymap } from "../keymap";

export const EditorToolsContext = createContext<{
  mode: EditorMode;
  setMode: (mode: EditorMode) => void;
  /** The work panels are hidden so the editor has the whole window. */
  focused: boolean;
  focusEditor: () => void;
} | null>(null);

export function EditorTools() {
  const tools = useContext(EditorToolsContext);
  if (!tools) return null;
  return (
    <div className="editor-tools">
      <div
        className="mode-switch"
        role="toolbar"
        aria-label="Preview tools"
        onClick={blurPointerButton}
      >
        {(
          [
            { id: "select", action: "editPointer", icon: Cursor },
            { id: "draw", action: "cutroomDraw", icon: PencilSimple },
            {
              id: "comment",
              action: "cutroomComment",
              icon: ChatTeardropText,
            },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            className="tool-button"
            aria-label={hint(item.action)}
            title={hint(item.action)}
            aria-pressed={tools.mode === item.id}
            onClick={() => tools.setMode(item.id)}
          >
            <item.icon
              size={15}
              weight={tools.mode === item.id ? "fill" : "regular"}
            />
            <span>{keymap[item.action].label}</span>
            <kbd aria-hidden="true">{keymap[item.action].keys[0]}</kbd>
          </button>
        ))}
      </div>
      <button
        className="icon-button focus-editor"
        aria-label="Focus editor"
        title="Focus editor"
        aria-pressed={tools.focused}
        onClick={tools.focusEditor}
      >
        <ArrowsOutSimple />
      </button>
    </div>
  );
}
