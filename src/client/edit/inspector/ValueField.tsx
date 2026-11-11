import { useEffect, useId, useRef, useState } from "react";
import type { Fps } from "../../../shared/timeline/schema";
import { showToast, useWorkspace } from "../../workspace";
import { formatField, parseField, stepField } from "./fields";
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
  hint,
  onCommit,
  onPreview,
  onCancel,
}: {
  label: string;
  value: number | null;
  unit: FieldUnit;
  fps: Fps;
  disabled?: boolean;
  allowAuto?: boolean;
  min?: number;
  max?: number;
  hint?: string;
  onCommit(value: number | null): void;
  onPreview?(value: number): void;
  onCancel?(): void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<{
    x: number;
    distance: number;
    value: number;
    next: number;
    moved: boolean;
    release(): void;
  } | null>(null);
  const endDrag = (cancel = true) => {
    if (!drag.current) return;
    if (cancel) onCancel?.();
    drag.current.release();
    drag.current = null;
    setDraft(null);
    useWorkspace.setState({ gesture: false });
  };
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const stepping = useRef(false);
  const cancelPreview = useRef(onCancel);
  cancelPreview.current = onCancel;
  useEffect(
    () => () => {
      if (drag.current) useWorkspace.setState({ gesture: false });
      drag.current?.release();
      if (drag.current || stepping.current) cancelPreview.current?.();
    },
    [],
  );
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
      onCancel?.();
      showToast(error instanceof Error ? error.message : String(error));
    }
    setDraft(null);
    stepping.current = false;
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
          // Esc during a scrub cancels it, before the drawer or editor sees the key.
          const cancel = (key: KeyboardEvent) => {
            if (key.key !== "Escape") return;
            key.preventDefault();
            key.stopImmediatePropagation();
            endDrag();
          };
          window.addEventListener("keydown", cancel, true);
          // Like a timeline drag, a scrub owns Esc while it lasts.
          useWorkspace.setState({ gesture: true });
          drag.current = {
            x: event.clientX,
            distance: 0,
            value: initial,
            next: initial,
            moved: false,
            release: () => window.removeEventListener("keydown", cancel, true),
          };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) return;
          const delta = event.clientX - current.x;
          // A click that wobbles a pixel is still a click.
          if (!current.moved && Math.abs(delta) < 3) return;
          current.x = event.clientX;
          current.distance +=
            delta *
            ((unit === "gain" ? event.altKey : event.shiftKey)
              ? unit === "pixels"
                ? 10
                : 0.1
              : 1);
          current.moved = true;
          current.next = Math.min(
            max,
            Math.max(min, stepField(current.value, current.distance, unit)),
          );
          setDraft(formatField(current.next, unit, fps));
          onPreview?.(current.next);
        }}
        onPointerUp={() => {
          const current = drag.current;
          endDrag(false);
          if (!current) return;
          if (!current.moved) input.current?.focus();
          else if (current.next !== current.value) onCommit(current.next);
          else onCancel?.();
        }}
        onPointerCancel={() => endDrag()}
        onLostPointerCapture={() => endDrag()}
      >
        {label}
      </label>
      <div className="inspector-value">
        <input
          ref={input}
          id={id}
          title={
            unit === "pixels"
              ? "Offset in composition pixels. Drag the label or use Up/Down. Shift for 10 pixels."
              : allowAuto
                ? "Auto uses source styles. Type a percentage to set static inline opacity."
                : unit === "gain"
                  ? "Gain in dB. Drag the label or use Up/Down. Alt for fine adjustment. Type -∞ for silence."
                  : undefined
          }
          aria-describedby={hint ? `${id}-hint` : undefined}
          type="text"
          spellCheck={false}
          disabled={disabled}
          value={draft ?? formatField(value, unit, fps)}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (cancelled.current) {
              onCancel?.();
              stepping.current = false;
              setDraft(null);
            } else commit();
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
                  (event.shiftKey ? 10 : 1) *
                  (unit === "gain" && event.altKey ? 0.1 : 1) *
                  (event.key === "ArrowUp" ? 1 : -1);
                const next = Math.min(
                  max,
                  Math.max(min, stepField(current, step, unit)),
                );
                setDraft(formatField(next, unit, fps));
                if (onPreview) {
                  stepping.current = true;
                  onPreview(next);
                }
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
          onKeyUp={(event) => {
            if (
              stepping.current &&
              (event.key === "ArrowUp" || event.key === "ArrowDown")
            )
              commit();
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
      {hint && (
        <small id={`${id}-hint`} className="inspector-field-hint">
          {hint}
        </small>
      )}
    </div>
  );
}
