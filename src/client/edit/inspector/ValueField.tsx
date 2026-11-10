import { useId, useRef, useState } from "react";
import type { Fps } from "../../../shared/timeline/schema";
import { showToast } from "../../workspace";
import { formatField, parseField } from "./fields";
import type { FieldUnit } from "./fields";

/** Typing and label scrubbing both commit once. A drag keeps its starting value until release. */
export function ValueField({
  label,
  value,
  unit,
  fps,
  disabled = false,
  allowAuto = false,
  min = 0,
  max = Infinity,
  onCommit,
}: {
  label: string;
  value: number | null;
  unit: FieldUnit;
  fps: Fps;
  disabled?: boolean;
  allowAuto?: boolean;
  min?: number;
  max?: number;
  onCommit(value: number | null): void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<{
    x: number;
    value: number;
    next: number;
    moved: boolean;
  } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const commit = () => {
    if (draft === null) return;
    try {
      const next =
        allowAuto && draft.trim().toLowerCase() === "auto"
          ? null
          : parseField(draft, unit, fps);
      if (next !== null && (next < min || next > max))
        throw new Error(
          `${label} must be between ${formatField(min, unit, fps)} and ${formatField(max, unit, fps)}.`,
        );
      if (next !== value) onCommit(next);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
    setDraft(null);
  };
  return (
    <div className="inspector-field">
      <label
        htmlFor={id}
        aria-disabled={disabled}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const initial = value ?? 1;
          drag.current = {
            x: event.clientX,
            value: initial,
            next: initial,
            moved: false,
          };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) return;
          const delta = Math.round(event.clientX - current.x);
          // A click that wobbles a pixel is still a click.
          if (!current.moved && Math.abs(delta) < 3) return;
          current.moved = true;
          current.next = Math.min(
            max,
            Math.max(
              min,
              current.value +
                delta *
                  (unit === "timecode" ? 1 : 0.01) *
                  (event.shiftKey ? 0.1 : 1),
            ),
          );
          if (unit === "timecode") current.next = Math.round(current.next);
          setDraft(formatField(current.next, unit, fps));
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          drag.current = null;
          if (!current) return;
          setDraft(null);
          if (!current.moved) input.current?.focus();
          else if (current.next !== current.value) onCommit(current.next);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDraft(null);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setDraft(null);
        }}
      >
        {label}
      </label>
      <div className="inspector-value">
        <input
          ref={input}
          id={id}
          title={
            allowAuto
              ? "Auto uses source styles. Type a percentage to set static inline opacity."
              : undefined
          }
          type="text"
          spellCheck={false}
          disabled={disabled}
          value={draft ?? formatField(value, unit, fps)}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (cancelled.current) setDraft(null);
            else commit();
            cancelled.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") event.stopPropagation();
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              try {
                const current =
                  draft === null || draft.trim().toLowerCase() === "auto"
                    ? (value ?? 1)
                    : parseField(draft, unit, fps);
                const step =
                  (unit === "timecode" ? 1 : 0.01) *
                  (event.shiftKey ? 10 : 1) *
                  (event.key === "ArrowUp" ? 1 : -1);
                setDraft(
                  formatField(
                    Math.min(max, Math.max(min, current + step)),
                    unit,
                    fps,
                  ),
                );
              } catch (error) {
                showToast(
                  error instanceof Error ? error.message : String(error),
                );
              }
            }
            // Leaving the field returns Space, undo and the other shortcuts to the editor.
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              cancelled.current = event.key === "Escape";
              event.currentTarget.blur();
            }
          }}
        />
        {allowAuto && (
          <button
            type="button"
            aria-label="Use automatic opacity"
            aria-pressed={value === null}
            title="Use source styles"
            onClick={() => {
              setDraft(null);
              if (value !== null) onCommit(null);
            }}
          >
            Auto
          </button>
        )}
      </div>
    </div>
  );
}
