import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import type { Fps } from "../../../shared/timeline/schema";
import { showToast, useWorkspace } from "../../workspace";
import { formatField, parseField, stepField } from "./fields";
import type { FieldUnit } from "./fields";

type FieldProps = {
  /** The input's accessible name, such as "Position X". */
  label: string;
  value: number | null;
  /** The value a clip has until someone sets it. A value at its default recedes. */
  initial?: number | null;
  unit: FieldUnit;
  fps: Fps;
  disabled?: boolean;
  allowAuto?: boolean;
  /** Several clips with different values share the field: `value` is null and typing sets them all. */
  mixed?: boolean;
  min?: number;
  max?: number;
  /** The input's tooltip, in place of the unit's own. */
  tip?: string;
  /** A line under the value, such as the fade length playback actually uses. */
  hint?: string;
  /** Pixels without their unit, for four values across one row. Typing " px" still works. */
  bare?: boolean;
  onCommit(value: number | null): void;
  onPreview?(value: number): void;
  onCancel?(): void;
};

/** Typing and handle scrubbing both commit once. A drag keeps its starting value until release. */
function useValue({
  label,
  value,
  initial,
  unit,
  fps,
  disabled = false,
  allowAuto = false,
  mixed = false,
  min = 0,
  max = Infinity,
  tip,
  hint,
  bare = false,
  onCommit,
  onPreview,
  onCancel,
}: FieldProps) {
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
  const format = (next: number | null) =>
    bare && next !== null ? String(next) : formatField(next, unit, fps);
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
      else onCancel?.();
    } catch (error) {
      onCancel?.();
      showToast(error instanceof Error ? error.message : String(error));
    }
    setDraft(null);
    stepping.current = false;
  };
  const handle = {
    htmlFor: id,
    "aria-disabled": disabled,
    onPointerDown(event: PointerEvent<HTMLLabelElement>) {
      if (disabled || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const start = value ?? 1;
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
        value: start,
        next: start,
        moved: false,
        release: () => window.removeEventListener("keydown", cancel, true),
      };
    },
    onPointerMove(event: PointerEvent<HTMLLabelElement>) {
      const current = drag.current;
      if (!current) return;
      const delta = event.clientX - current.x;
      // A click that wobbles a pixel is still a click.
      if (!current.moved && Math.abs(delta) < 3) return;
      current.x = event.clientX;
      current.distance +=
        delta *
        ((unit === "gain" ? event.altKey : event.shiftKey)
          ? unit === "pixels" || unit === "degrees"
            ? 10
            : 0.1
          : 1);
      current.moved = true;
      current.next = Math.min(
        max,
        Math.max(min, stepField(current.value, current.distance, unit)),
      );
      setDraft(format(current.next));
      onPreview?.(current.next);
    },
    onPointerUp() {
      const current = drag.current;
      endDrag(false);
      if (!current) return;
      if (!current.moved) input.current?.focus();
      else if (current.next !== current.value) onCommit(current.next);
      else onCancel?.();
    },
    onPointerCancel: () => endDrag(),
    onLostPointerCapture: () => endDrag(),
  };
  const field = (
    <input
      ref={input}
      id={id}
      aria-label={label}
      aria-describedby={hint ? `${id}-hint` : undefined}
      title={
        tip ??
        (unit === "pixels"
          ? "Offset in composition pixels. Drag the label or use Up/Down. Shift for 10 pixels."
          : allowAuto
            ? "Auto uses source styles. Type a percentage to set static inline opacity."
            : unit === "gain"
              ? "Gain in dB. Drag the label or use Up/Down. Alt for fine adjustment. Type -∞ for silence."
              : undefined)
      }
      type="text"
      spellCheck={false}
      disabled={disabled}
      data-timecode={unit === "timecode" ? "" : undefined}
      data-default={
        initial !== undefined && !mixed && value === initial ? "" : undefined
      }
      value={draft ?? (mixed ? "Mixed" : format(value))}
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
            setDraft(format(next));
            if (onPreview) {
              stepping.current = true;
              onPreview(next);
            }
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error));
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
  );
  return { id, handle, field, setDraft };
}

/**
 * One value on a row: dragging the row's label scrubs it, double-clicking the label resets it.
 * `after` shares the row, such as the paired cell that completes Start and Duration.
 */
export function ValueField({
  before,
  after,
  half = false,
  onReset,
  ...props
}: FieldProps & {
  /** Takes one column of a paired row, so it lines up with the pairs around it. */
  half?: boolean;
  /** A control that shares the row, ahead of the value. */
  before?: ReactNode;
  /** Paired cells after the value, one column each. */
  after?: ReactNode;
  onReset?(): void;
}) {
  const { id, handle, field, setDraft } = useValue(props);
  const { allowAuto, value, disabled, onCommit } = props;
  return (
    <div className="inspector-field">
      <label
        {...handle}
        title={onReset && !disabled ? "Double-click to reset" : undefined}
        onDoubleClick={disabled ? undefined : onReset}
      >
        {props.label}
      </label>
      <div
        className="inspector-value"
        data-paired={after || half ? "" : undefined}
      >
        {before}
        {field}
        {allowAuto && value !== null && (
          <button
            type="button"
            aria-label="Restore source opacity"
            title="Restore source opacity"
            disabled={disabled}
            onClick={() => {
              setDraft(null);
              onCommit(null);
            }}
          >
            <ArrowCounterClockwise size={14} aria-hidden />
          </button>
        )}
        {after}
      </div>
      {props.hint && (
        <small id={`${id}-hint`} className="inspector-field-hint">
          {props.hint}
        </small>
      )}
    </div>
  );
}

/** One of a row's paired values, scrubbed by its own short label: X, L, In, Dur. */
export function ValueCell({ axis, ...props }: FieldProps & { axis: string }) {
  const { id, handle, field } = useValue(props);
  return (
    <>
      <div className="inspector-cell" aria-disabled={props.disabled}>
        <label {...handle} aria-hidden="true">
          {axis}
        </label>
        {field}
      </div>
      {props.hint && (
        <small id={`${id}-hint`} className="inspector-field-hint">
          {props.hint}
        </small>
      )}
    </>
  );
}

/** A row of paired cells under one label. Double-clicking the label resets every cell. */
export function FieldRow({
  label,
  disabled,
  extra,
  onReset,
  children,
}: {
  label: string;
  disabled?: boolean;
  /** A control beside the label, such as the scale link. */
  extra?: ReactNode;
  onReset?(): void;
  children: ReactNode;
}) {
  return (
    <div className="inspector-field">
      <span
        className="inspector-label"
        title={onReset && !disabled ? "Double-click to reset" : undefined}
        onDoubleClick={disabled ? undefined : onReset}
      >
        {label}
        {extra}
      </span>
      <div className="inspector-value" data-paired="">
        {children}
      </div>
    </div>
  );
}
