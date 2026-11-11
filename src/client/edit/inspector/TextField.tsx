import { useId, useRef, useState } from "react";
import { canonicalText } from "../../../shared/timeline/schema";
import { showToast } from "../../workspace";

/**
 * A text clip's words. Enter or leaving the field commits one edit, Shift+Enter breaks the line,
 * and Escape puts the saved words back. `reason` says why the words cannot be edited here.
 */
export function TextField({
  value,
  disabled = false,
  reason,
  onCommit,
}: {
  value: string;
  disabled?: boolean;
  reason?: string;
  onCommit(text: string): void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const shown = draft ?? value;
  return (
    <div className="inspector-text">
      <textarea
        aria-label="Text"
        aria-describedby={reason ? `${id}-reason` : undefined}
        rows={Math.min(4, shown.split("\n").length)}
        disabled={disabled || Boolean(reason)}
        value={shown}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = cancelled.current ? null : draft;
          cancelled.current = false;
          setDraft(null);
          if (next === null) return;
          const text = canonicalText(next);
          if (!text) showToast("Text cannot be empty.");
          else if (text !== value) onCommit(text);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") event.stopPropagation();
          if (
            event.key === "Escape" ||
            (event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing)
          ) {
            event.preventDefault();
            cancelled.current = event.key === "Escape";
            // Leaving the field returns Space, undo and the other shortcuts to the editor.
            event.currentTarget.blur();
          }
        }}
      />
      {reason && (
        <small id={`${id}-reason`} className="inspector-field-hint">
          {reason}
        </small>
      )}
    </div>
  );
}
