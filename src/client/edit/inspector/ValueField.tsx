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
  onCommit,
}: {
  label: string;
  value: number | null;
  unit: FieldUnit;
  fps: Fps;
  disabled?: boolean;
  allowAuto?: boolean;
  onCommit(value: number | null): void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<{ x: number; value: number; next: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const commit = () => {
    if (draft === null) return;
    try {
      const next =
        allowAuto && draft.trim().toLowerCase() === "auto"
          ? null
          : parseField(draft, unit, fps);
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
          drag.current = { x: event.clientX, value: initial, next: initial };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) return;
          const delta = Math.round(event.clientX - current.x);
          current.next = Math.max(
            0,
            current.value +
              delta *
                (unit === "timecode" ? 1 : 0.01) *
                (event.shiftKey ? 0.1 : 1),
          );
          if (unit === "timecode") current.next = Math.round(current.next);
          setDraft(formatField(current.next, unit, fps));
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          drag.current = null;
          if (!current) return;
          setDraft(null);
          if (event.clientX === current.x) input.current?.focus();
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
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
          }
        }}
      />
    </div>
  );
}
