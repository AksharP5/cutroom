import {
  compileHfColorCurve,
  compileHfHueCurve,
  HF_COLOR_CURVE_MAX_POINTS,
  normalizeHfColorGrading,
} from "@hyperframes/core/color-grading";
import { useEffect, useRef, useState } from "react";
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
/** Points closer than this on the input axis would share a sample. */
const GAP = 0.01;
const SIZE = 200;
const round = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const samePoints = (first: PlotProps["points"], second: PlotProps["points"]) =>
  first.length === second.length &&
  first.every(
    ([x, y], index) => x === second[index]?.[0] && y === second[index]?.[1],
  );

type PlotProps = {
  points: readonly (readonly [number, number])[];
  disabled: boolean;
  onPreview(points: CurvePoint[]): void;
  onCommit(points: CurvePoint[]): void;
  onCancel(): void;
};

export function CurveEditor({
  channel,
  onChannel,
  ...plot
}: PlotProps & {
  channel: CurveChannel;
  onChannel(channel: CurveChannel): void;
}) {
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
            disabled={plot.disabled}
            onClick={() => onChannel(each)}
          >
            {CHANNEL_LABELS[each]}
          </button>
        ))}
      </div>
      <GradeCurvePlot
        label={CHANNEL_LABELS[channel]}
        {...plot}
        points={
          normalizeHfColorGrading({ curves: { [channel]: plot.points } })
            ?.curves[channel] ?? IDENTITY
        }
      />
    </div>
  );
}

/** A normalized editing surface shared by tonal curves and periodic hue curves. */
export function GradeCurvePlot({
  label,
  points,
  disabled,
  hueRange,
  onPreview,
  onCommit,
  onCancel,
}: PlotProps & { label: string; hueRange?: number }) {
  const hue = hueRange !== undefined;
  const xMax = hue ? 359.9999 / 360 : 1;
  const svg = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<CurvePoint[] | null>(null);
  const drag = useRef<{
    index: number;
    pointer: number;
    start: PlotProps["points"];
    draft: CurvePoint[];
    previewed: boolean;
    release(): void;
  } | null>(null);
  const cancelPreview = useRef(onCancel);
  cancelPreview.current = onCancel;
  useEffect(
    () => () => {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      current.release();
      if (current.previewed) cancelPreview.current();
    },
    [],
  );
  const shown = draft ?? points;
  const samples = hue
    ? Array.from(
        compileHfHueCurve(
          shown.map(([x, y]) => [x * 360, (y * 2 - 1) * hueRange]),
          -hueRange,
          hueRange,
          64,
        ),
        (value) => 0.5 + value / (2 * hueRange),
      )
    : Array.from(compileHfColorCurve(shown, 64));
  if (hue) samples.push(samples[0]!);
  // Include exact input positions so narrow authored peaks remain visible.
  const vertices = new Map(
    samples.map((output, index) => [index / (samples.length - 1), output]),
  );
  for (const [input, output] of shown) vertices.set(input, output);
  const path = [...vertices]
    .sort(([a], [b]) => a - b)
    .map(
      ([x, y], index) =>
        `${index ? "L" : "M"}${(x * SIZE).toFixed(1)} ${((1 - y) * SIZE).toFixed(1)}`,
    )
    .join("");

  const at = (event: { clientX: number; clientY: number }) => {
    const box = svg.current!.getBoundingClientRect();
    return [
      clamp((event.clientX - box.left) / box.width, 0, 1),
      clamp(1 - (event.clientY - box.top) / box.height, 0, 1),
    ] as const;
  };
  /** The point within a few units of (x, y), or -1. */
  const nearest = (x: number, y: number) => {
    let index = -1;
    let distance = 8 / SIZE;
    for (const [each, [px, py]] of shown.entries()) {
      const offset = Math.hypot(px - x, py - y);
      if (offset >= distance) continue;
      distance = offset;
      index = each;
    }
    return index;
  };
  /** Moves point `index` without changing the untouched axis. */
  const moved = (
    current: PlotProps["points"],
    index: number,
    x: number,
    y: number,
  ): CurvePoint[] => {
    const [previousX, previousY] = current[index]!;
    const left = current[index - 1]?.[0];
    const right = current[index + 1]?.[0];
    const fixed = !hue && (left === undefined || right === undefined);
    const minimum = left === undefined ? 0 : Math.min(previousX, left + GAP);
    const maximum =
      right === undefined ? xMax : Math.max(previousX, right - GAP);
    const candidate =
      fixed || x === previousX ? previousX : clamp(round(x), minimum, maximum);
    const outside =
      (left !== undefined && candidate <= left) ||
      (right !== undefined && candidate >= right);
    return current.map(([input, output], each) =>
      each === index
        ? [
            outside ? previousX : candidate,
            y === previousY ? previousY : round(y),
          ]
        : [input, output],
    );
  };

  const finish = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    current.release();
    setDraft(null);
    if (
      commit &&
      !disabled &&
      samePoints(current.start, points) &&
      !samePoints(current.start, current.draft)
    ) {
      onCommit(current.draft);
    } else if (current.previewed) {
      onCancel();
    }
  };

  const press = (event: PointerEvent<SVGSVGElement>) => {
    if (disabled || event.button !== 0 || drag.current) return;
    event.preventDefault();
    const [x, y] = at(event);
    const near = nearest(x, y);
    let index = near;
    const next = shown.map(([input, output]): CurvePoint => [input, output]);
    if (index === -1) {
      if (shown.length >= HF_COLOR_CURVE_MAX_POINTS) return;
      const input = Math.min(round(x), xMax);
      const after = shown.findIndex(([px]) => px > input);
      index = after < 0 ? shown.length : after;
      const left = shown[index - 1]?.[0];
      const right = shown[index]?.[0];
      if (!hue && (left === undefined || right === undefined)) return;
      if (
        (left !== undefined && input - left < GAP) ||
        (right !== undefined && right - input < GAP)
      )
        return;
      next.splice(index, 0, [input, round(y)]);
    }
    const target = event.currentTarget;
    const pointer = event.pointerId;
    const escape = (key: globalThis.KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopImmediatePropagation();
      finish(false);
    };
    target.setPointerCapture(pointer);
    window.addEventListener("keydown", escape, true);
    drag.current = {
      index,
      pointer,
      start: points,
      draft: next,
      previewed: near === -1,
      release() {
        window.removeEventListener("keydown", escape, true);
        if (target.hasPointerCapture(pointer))
          target.releasePointerCapture(pointer);
      },
    };
    if (near === -1) {
      setDraft(next);
      onPreview(next);
    }
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (disabled || !samePoints(current.start, points)) {
      finish(false);
      return;
    }
    const [x, y] = at(event);
    const next = moved(current.draft, current.index, x, y);
    if (samePoints(next, current.draft)) return;
    current.draft = next;
    current.previewed = true;
    setDraft(next);
    onPreview(next);
  };
  const cancelPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointer === event.pointerId) finish(false);
  };
  const remove = (index: number) => {
    if (
      disabled ||
      drag.current ||
      (hue ? shown.length <= 3 : index === 0 || index === shown.length - 1)
    )
      return;
    onCommit(shown.filter((_, each) => each !== index).map(([x, y]) => [x, y]));
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
    const deleting = event.key === "Delete" || event.key === "Backspace";
    if (!target && !deleting) return;
    event.preventDefault();
    event.stopPropagation();
    if (disabled || drag.current) return;
    if (deleting) remove(index);
    if (target) {
      const next = moved(shown, index, target[0]!, clamp(target[1]!, 0, 1));
      if (!samePoints(next, shown)) onCommit(next);
    }
  };

  const output = (y: number) =>
    Math.round(hue ? (y * 2 - 1) * (hueRange === 180 ? 180 : 100) : y * 100);
  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="group"
      aria-label={`${label} curve`}
      aria-disabled={disabled}
      onPointerDown={press}
      // The plot captures the pointer, so a double-click lands here, not on the point.
      onDoubleClick={(event) => {
        const near = nearest(...at(event));
        if (near !== -1) remove(near);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        if (drag.current?.pointer === event.pointerId) finish(true);
      }}
      onPointerCancel={cancelPointer}
      onLostPointerCapture={cancelPointer}
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
        y1={hue ? SIZE / 2 : SIZE}
        x2={SIZE}
        y2={hue ? SIZE / 2 : 0}
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
          aria-label={`${label} point ${index + 1}`}
          aria-valuetext={
            hue
              ? `Hue ${Math.round(x * 360)} degrees, change ${output(y)}${hueRange === 180 ? " degrees" : " percent"}`
              : `input ${Math.round(x * 100)}, output ${output(y)}`
          }
          aria-valuenow={output(y)}
          aria-valuemin={hue ? output(0) : 0}
          aria-valuemax={output(1)}
          onKeyDown={(event) => key(event, index)}
        />
      ))}
    </svg>
  );
}
