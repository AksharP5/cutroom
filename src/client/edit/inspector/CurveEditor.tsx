import { compileHfColorCurve } from "@hyperframes/core/color-grading";
import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

export type CurvePoint = [number, number];
export const CURVE_CHANNELS = ["master", "red", "green", "blue"] as const;
export type CurveChannel = (typeof CURVE_CHANNELS)[number];
export const IDENTITY: CurvePoint[] = [
  [0, 0],
  [1, 1],
];
const CHANNEL_LABELS: Record<CurveChannel, string> = {
  master: "Master",
  red: "Red",
  green: "Green",
  blue: "Blue",
};
/** HyperFrames reads at most this many points, ends included. */
const MAX_POINTS = 16;
/** Points closer than this on the input axis would share a sample. */
const GAP = 0.01;
const SIZE = 200;
const round = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * One channel's curve, as Resolve's and Lumetri's curves edit it: drag a point, press the line
 * to add one there, double-click a point between the ends to remove it. The ends move only up
 * and down. Each change drafts into the viewer while it moves and saves once when it lets go.
 * Focused points move with the arrow keys and go with Delete.
 */
export function CurveEditor({
  channel,
  points,
  disabled,
  onChannel,
  onPreview,
  onCommit,
  onCancel,
}: {
  channel: CurveChannel;
  points: readonly (readonly [number, number])[];
  disabled: boolean;
  onChannel(channel: CurveChannel): void;
  onPreview(points: CurvePoint[]): void;
  onCommit(points: CurvePoint[]): void;
  onCancel(): void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<CurvePoint[] | null>(null);
  // Pointer handlers read the latest points, which a render may not have caught up with.
  const live = useRef<CurvePoint[] | null>(null);
  const drag = useRef<{ index: number; moved: boolean } | null>(null);
  const shown: CurvePoint[] =
    draft ?? points.map(([x, y]) => [x, y] satisfies CurvePoint);
  const samples = compileHfColorCurve(shown, 64);
  const path = Array.from(
    samples,
    (value, index) =>
      `${index ? "L" : "M"}${((index / 63) * SIZE).toFixed(1)} ${((1 - value) * SIZE).toFixed(1)}`,
  ).join("");

  const at = (event: { clientX: number; clientY: number }) => {
    const box = svg.current!.getBoundingClientRect();
    return [
      clamp((event.clientX - box.left) / box.width, 0, 1),
      clamp(1 - (event.clientY - box.top) / box.height, 0, 1),
    ] as const;
  };
  /** The point within a few units of (x, y), or -1. */
  const nearest = (x: number, y: number) =>
    shown.findIndex(([px, py]) => Math.hypot(px - x, py - y) * SIZE < 8);
  /** Moves point `index` to (x, y) within its neighbours; the ends keep their inputs. */
  const moved = (
    current: CurvePoint[],
    index: number,
    x: number,
    y: number,
  ): CurvePoint[] => {
    const last = current.length - 1;
    const input =
      index === 0
        ? current[0]![0]
        : index === last
          ? current[last]![0]
          : clamp(
              x,
              current[index - 1]![0] + GAP,
              current[index + 1]![0] - GAP,
            );
    return current.map((point, each) =>
      each === index ? [round(input), round(y)] : point,
    );
  };
  const change = (next: CurvePoint[]) => {
    live.current = next;
    setDraft(next);
    onPreview(next);
  };
  const finish = (next: CurvePoint[] | null) => {
    live.current = null;
    setDraft(null);
    if (next) onCommit(next);
    else onCancel();
  };

  const press = (event: PointerEvent<SVGSVGElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const [x, y] = at(event);
    const near = nearest(x, y);
    let index = near;
    let next = shown;
    if (index === -1) {
      if (shown.length >= MAX_POINTS) return;
      index = shown.findIndex(([px]) => px > x);
      if (
        index <= 0 ||
        x - shown[index - 1]![0] < GAP ||
        shown[index]![0] - x < GAP
      )
        return;
      next = [
        ...shown.slice(0, index),
        [round(x), round(y)],
        ...shown.slice(index),
      ];
      change(next);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { index, moved: near === -1 };
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const current = drag.current;
    if (!current) return;
    const [x, y] = at(event);
    current.moved = true;
    change(moved(live.current ?? shown, current.index, x, y));
  };
  const release = () => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    finish(current.moved ? (live.current ?? shown) : null);
  };
  const remove = (index: number) => {
    if (disabled || index === 0 || index === shown.length - 1) return;
    finish(shown.filter((_, each) => each !== index));
  };
  const key = (event: KeyboardEvent<SVGCircleElement>, index: number) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const [x, y] = shown[index]!;
    const target =
      event.key === "ArrowLeft"
        ? [x - step, y]
        : event.key === "ArrowRight"
          ? [x + step, y]
          : event.key === "ArrowUp"
            ? [x, y + step]
            : event.key === "ArrowDown"
              ? [x, y - step]
              : null;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      remove(index);
      return;
    }
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    finish(moved(shown, index, target[0]!, clamp(target[1]!, 0, 1)));
  };

  return (
    <div className="inspector-curve" data-channel={channel}>
      <div
        className="inspector-curve-channels"
        role="radiogroup"
        aria-label="Curve"
      >
        {CURVE_CHANNELS.map((each) => (
          <button
            key={each}
            type="button"
            role="radio"
            aria-checked={each === channel}
            disabled={disabled}
            onClick={() => onChannel(each)}
          >
            {CHANNEL_LABELS[each]}
          </button>
        ))}
      </div>
      <svg
        ref={svg}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="group"
        aria-label={`${CHANNEL_LABELS[channel]} curve`}
        aria-disabled={disabled}
        onPointerDown={press}
        // The plot captures the pointer, so a double-click lands here, not on the point.
        onDoubleClick={(event) => {
          const near = nearest(...at(event));
          if (near !== -1) remove(near);
        }}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={() => {
          drag.current = null;
          finish(null);
        }}
      >
        {[0.25, 0.5, 0.75].map((line) => (
          <g key={line} className="inspector-curve-grid">
            <line x1={line * SIZE} x2={line * SIZE} y1={0} y2={SIZE} />
            <line y1={line * SIZE} y2={line * SIZE} x1={0} x2={SIZE} />
          </g>
        ))}
        <line
          className="inspector-curve-neutral"
          x1={0}
          y1={SIZE}
          x2={SIZE}
          y2={0}
        />
        <path className="inspector-curve-line" d={path} />
        {shown.map(([x, y], index) => (
          <circle
            key={index}
            className="inspector-curve-point"
            cx={x * SIZE}
            cy={(1 - y) * SIZE}
            r={4}
            tabIndex={disabled ? -1 : 0}
            role="slider"
            aria-label={`${CHANNEL_LABELS[channel]} point ${index + 1}`}
            aria-valuetext={`input ${Math.round(x * 100)}, output ${Math.round(y * 100)}`}
            aria-valuenow={Math.round(y * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            onKeyDown={(event) => key(event, index)}
          />
        ))}
      </svg>
    </div>
  );
}
