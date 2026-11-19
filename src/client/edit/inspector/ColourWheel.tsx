import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { Grade } from "../../../shared/timeline/grade";
import type { Fps } from "../../../shared/timeline/schema";
import { useWorkspace } from "../../workspace";
import { ValueField } from "./ValueField";

export type WheelRange = keyof NonNullable<Grade["wheels"]>;
type Wheel = Required<NonNullable<NonNullable<Grade["wheels"]>[WheelRange]>>;
const neutral: Wheel = { hue: 0, amount: 0, level: 0 };

type Drag = {
  pointer: number;
  bounds: DOMRect;
  value: Wheel;
  release(): void;
};

export function ColourWheel({
  label,
  value,
  fps,
  disabled,
  onPreview,
  onCommit,
  onCancel,
}: {
  label: string;
  value: Partial<Wheel> | undefined;
  fps: Fps;
  disabled: boolean;
  onPreview(value: Wheel): void;
  onCommit(value: Wheel): void;
  onCancel(): void;
}) {
  const editor = useRef<Drag | null>(null);
  const cancelPreview = useRef(onCancel);
  cancelPreview.current = onCancel;
  const [draft, setDraft] = useState<Wheel | null>(null);
  // Hue has no saved effect in a neutral wheel. Keep the typed direction until
  // an amount is set, so either field can be entered first.
  const [direction, setDirection] = useState(0);
  const saved = { ...neutral, hue: direction, ...value };
  const shown = draft ?? saved;

  useEffect(
    () => () => {
      const drag = editor.current;
      if (!drag) return;
      drag.release();
      useWorkspace.setState({ gesture: false });
      cancelPreview.current();
    },
    [],
  );

  const finish = (commit: boolean) => {
    const drag = editor.current;
    if (!drag) return;
    editor.current = null;
    drag.release();
    useWorkspace.setState({ gesture: false });
    setDraft(null);
    if (commit) onCommit(drag.value);
    else onCancel();
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const drag = editor.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const { left, top, width, height } = drag.bounds;
    const x = (2 * (event.clientX - left)) / width - 1;
    const y = (2 * (event.clientY - top)) / height - 1;
    const amount = Number(Math.min(1, Math.hypot(x, y)).toFixed(4));
    const degrees = Math.atan2(y, x) * (180 / Math.PI);
    const hue = (Math.round(degrees * 100) / 100 + 360) % 360;
    const next = {
      ...saved,
      hue: amount ? hue : drag.value.hue,
      amount,
    };
    drag.value = next;
    setDraft(next);
    onPreview(next);
  };

  const press = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0 || editor.current) return;
    event.preventDefault();
    const pad = event.currentTarget;
    const pointer = event.pointerId;
    const escape = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopImmediatePropagation();
      finish(false);
    };
    pad.setPointerCapture(pointer);
    window.addEventListener("keydown", escape, true);
    editor.current = {
      pointer,
      bounds: pad.getBoundingClientRect(),
      value: saved,
      release() {
        window.removeEventListener("keydown", escape, true);
        if (pad.hasPointerCapture(pointer)) pad.releasePointerCapture(pointer);
      },
    };
    useWorkspace.setState({ gesture: true });
    move(event);
  };

  const angle = (shown.hue * Math.PI) / 180;
  const marker = {
    left: `${50 + 50 * Math.cos(angle) * shown.amount}%`,
    top: `${50 + 50 * Math.sin(angle) * shown.amount}%`,
  };

  const fields = [
    { key: "hue", label: "Hue", unit: "degrees", min: 0, max: 359.9999 },
    { key: "amount", label: "Amount", unit: "percent", min: 0, max: 1 },
    { key: "level", label: "Level", unit: "percent", min: -1, max: 1 },
  ] as const;
  return (
    <div className="inspector-wheel">
      <div
        className="inspector-wheel-pad"
        role="group"
        aria-label={`${label} colour wheel`}
        aria-disabled={disabled}
        title="Drag from the centre to push colour toward a hue"
        onPointerDown={press}
        onPointerMove={move}
        onPointerUp={(event) =>
          editor.current?.pointer === event.pointerId && finish(true)
        }
        onLostPointerCapture={onPointerCancel}
        onPointerCancel={onPointerCancel}
      >
        <span className="inspector-wheel-centre" aria-hidden />
        <span className="inspector-wheel-marker" style={marker} aria-hidden />
      </div>
      <div className="inspector-wheel-fields">
        {fields.map(({ key, label, unit, min, max }) => (
          <ValueField
            key={key}
            label={label}
            unit={unit}
            value={shown[key]}
            initial={0}
            min={min}
            max={max}
            fps={fps}
            disabled={disabled || draft !== null}
            onPreview={(next) => onPreview({ ...saved, [key]: next })}
            onCommit={(next) => {
              if (next === null) return;
              if (key === "hue" && !saved.amount && !saved.level) {
                setDirection(next);
                onCancel();
                return;
              }
              onCommit({ ...saved, [key]: next });
            }}
            onCancel={onCancel}
          />
        ))}
      </div>
    </div>
  );

  function onPointerCancel(event: PointerEvent<HTMLDivElement>) {
    if (editor.current?.pointer === event.pointerId) finish(false);
  }
}
