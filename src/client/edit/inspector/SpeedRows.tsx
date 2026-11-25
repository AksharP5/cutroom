import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import type { Clip, Fps } from "../../../shared/timeline/schema";
import {
  sourceOutFrame,
  speedAtFrame,
  speedLevel,
  limitSpeedPoint,
  SPEED_PRESETS,
  speedAtLevel,
  speedPoints,
  speedProjection,
  withSpeedPoints,
} from "../../../shared/timeline/speed";
import type { SpeedInput, SpeedPoint } from "../../../shared/timeline/speed";
import { CaretDown } from "@phosphor-icons/react";
import { KEYFRAME_EASES } from "../../../shared/timeline/schema";
import type {
  CommandInput,
  KeyframeEase,
} from "../../../shared/timeline/schema";
import { openContextMenu } from "../../components/ContextMenu";
import { useTimeline, editTimeline } from "../timeline";
import { resettable } from "../keys";
import { TimecodeText } from "../../components/TimecodeText";
import { formatTimecode } from "../../../shared/timeline/timecode";
import { speedPath } from "../../timeline/ClipSpeed";
import { useTransport } from "../transport";
import { ValueField } from "./ValueField";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

const GRID = [4, 2, 1, 0.5, 0.25];

/** The read-only source Out: the last source frame the clip plays, which a ramp moves. */
export function SourceOut({ clip, fps }: { clip: Clip; fps: Fps }) {
  const out = sourceOutFrame(clip, fps);
  if (out === null) return null;
  return (
    <div
      className="inspector-cell inspector-net"
      title="The last source frame the clip plays"
    >
      <span aria-hidden="true">Out</span>
      {/* Not an <output>: that is a live region, and Out changes with every speed edit. */}
      <span aria-label="Source out" className="inspector-net-value mono">
        <TimecodeText timecode={formatTimecode(out, fps)} />
      </span>
    </div>
  );
}

const EASE_NAMES = {
  linear: "Linear",
  "ease-in": "Ease in",
  "ease-out": "Ease out",
  "ease-in-out": "Ease in and out",
  hold: "Hold",
} satisfies Record<KeyframeEase, string>;
const EASE_ICONS = {
  linear: "M2 12 12 2",
  "ease-in": "M2 12C9 12 12 7 12 2",
  "ease-out": "M2 12C2 7 5 2 12 2",
  "ease-in-out": "M2 12C8 12 6 2 12 2",
  hold: "M2 12H10V2",
} satisfies Record<KeyframeEase, string>;

/** Points as an edit sends them back: a custom shape is kept by leaving its ease out. */
const inputs = (points: readonly SpeedPoint[]): SpeedInput[] =>
  points.map(({ frame, speed, ease }) =>
    ease === "custom" ? { frame, speed } : { frame, speed, ease },
  );

/** The point the Ease row shows: the one at or before the frame, or the first. */
const easePoint = (points: readonly SpeedPoint[], frame: number) =>
  points.findLastIndex((point) => point.frame <= frame) >= 0
    ? points.findLastIndex((point) => point.frame <= frame)
    : 0;

/** A preset's shape at a glance: its points on the log speed scale, 32 by 14. */
function PresetGlyph({ shape }: (typeof SPEED_PRESETS)[number]) {
  const points = shape(100, 50, { num: 30, den: 1 });
  const y = (speed: number) => (speedLevel(speed) * 2 - 0.5) * 14;
  const d = [
    { frame: 0, speed: points[0]!.speed },
    ...points,
    { frame: 100, speed: points.at(-1)!.speed },
  ]
    .map(
      ({ frame, speed }, index) =>
        `${index ? "L" : "M"}${(frame * 0.32).toFixed(1)},${Math.max(1, Math.min(13, y(speed))).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg className="speed-glyph" viewBox="0 0 32 14" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/**
 * Speed in Timing, with a keyframe diamond and Presets. A constant speed is typed here as before.
 * Once the clip has points, the field shows and sets the point at the playhead, the graph shows
 * the whole clip, and Ease shapes the change from the point at or before the playhead.
 */
export function SpeedRows({
  projectId,
  clip,
  fps,
  disabled,
}: {
  projectId: string;
  clip: Clip;
  fps: Fps;
  disabled: boolean | undefined;
}) {
  const points = speedPoints(clip, fps);
  const [chosen, setChosen] = useState<number | null>(null);
  useEffect(() => {
    if (chosen === null) return;
    const clear = (event: globalThis.PointerEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest(".speed-point, .speed-ease")
      )
        setChosen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChosen(null);
    };
    document.addEventListener("pointerdown", clear, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", clear, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [chosen]);
  // A constant clip renders only when the playhead crosses its edges, never per frame.
  const local = useTransport(({ frame }) => {
    const at = frame - clip.start;
    if (at < 0 || at >= clip.duration) return null;
    return points ? at : 0;
  });
  const inside = local !== null;
  // The selector settles on 0 for a constant clip; actions read the playhead when they run.
  const now = () => {
    const at = useTransport.getState().frame - clip.start;
    return at >= 0 && at < clip.duration ? at : null;
  };
  const playhead = points ? local : null;
  const frame = playhead ?? 0;
  const speed = points ? speedAtFrame(clip, fps, frame) : clip.playbackRate;
  const index = points?.findIndex((point) => point.frame === playhead) ?? -1;
  const send = (label: string, command: CommandInput) =>
    void editTimeline(projectId, label, () => [command]);
  const setPoints = (label: string, next: SpeedInput[]) =>
    send(
      label,
      next.length
        ? { type: "setSpeed", clipId: clip.id, points: next }
        : { type: "setSpeed", clipId: clip.id, speed },
    );
  const setSpeed = (value: number) => {
    if (!points)
      return send("Edit speed", {
        type: "setSpeed",
        clipId: clip.id,
        speed: value,
      });
    const at = now();
    if (at === null) return;
    const next = inputs(points);
    const point = points.findIndex(({ frame }) => frame === at);
    if (point >= 0) next[point] = { ...next[point]!, speed: value };
    else next.push({ frame: at, speed: value });
    setPoints("Edit speed point", next);
  };
  const diamond = (
    <button
      type="button"
      className="inspector-keyframe speed-diamond"
      data-state={index >= 0 ? "on" : points ? "keyed" : "off"}
      aria-label="Speed point"
      aria-pressed={index >= 0}
      title={
        !inside
          ? "Move the playhead into the clip to add a point."
          : index >= 0
            ? "Remove the speed point here"
            : "Add a speed point here"
      }
      disabled={disabled || !inside}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (index < 0)
          return setPoints("Add speed point", [
            ...(points ? inputs(points) : []),
            { frame: now() ?? frame, speed },
          ]);
        const rest = inputs(points!).filter((_, at) => at !== index);
        // Removing the last point leaves its speed as the constant speed.
        setPoints("Remove speed point", rest);
      }}
    />
  );
  const presets = (
    <button
      type="button"
      className="text-button speed-presets"
      aria-haspopup="menu"
      disabled={disabled}
      onClick={(event) => {
        const anchor = event.currentTarget;
        const box = anchor.getBoundingClientRect();
        openContextMenu(
          {
            preventDefault: () => event.preventDefault(),
            button: event.detail === 0 ? -1 : 0,
            clientX: box.left,
            clientY: box.bottom + 2,
          },
          "Speed presets",
          [
            ...SPEED_PRESETS.map((preset) => ({
              label: preset.label,
              glyph: <PresetGlyph {...preset} />,
              run: () =>
                send(preset.label, {
                  type: "setSpeed",
                  clipId: clip.id,
                  preset: preset.id,
                  ...(now() !== null && { at: now()! }),
                }),
            })),
            "separator",
            {
              action: "clipResetRetime",
              disabled: !resettable([clip]).length,
            },
          ],
          anchor,
        );
      }}
    >
      Presets
      <CaretDown size={10} aria-hidden />
    </button>
  );
  // A selected point outranks the playhead for Ease.
  const easeIndex =
    points &&
    (chosen !== null && points[chosen] ? chosen : easePoint(points, frame));
  const eased = points && easeIndex !== null && points[easeIndex];
  return (
    <>
      <ValueField
        key={`${clip.id}:speed`}
        label="Speed"
        value={Math.round(speed * 100) / 100}
        initial={points ? undefined : 1}
        unit="percent"
        min={MIN_PLAYBACK_RATE}
        max={MAX_PLAYBACK_RATE}
        fps={fps}
        disabled={disabled}
        keyframe={diamond}
        after={presets}
        onReset={() =>
          send("Reset speed", { type: "setSpeed", clipId: clip.id, speed: 1 })
        }
        onCommit={(value) => value !== null && setSpeed(value)}
      />
      {points && (
        <SpeedGraph
          key={clip.id}
          clip={clip}
          fps={fps}
          points={points}
          playhead={playhead}
          disabled={disabled}
          selected={chosen}
          onSelect={setChosen}
          onPoints={setPoints}
        />
      )}
      {points && eased && (
        <div className="inspector-field speed-ease">
          <span className="inspector-label">Ease</span>
          <div className="inspector-value">
            <div
              className="inspector-segments"
              role="radiogroup"
              aria-label="Ease"
              title={
                eased.ease === "custom"
                  ? "Custom shape. Choose an ease to replace it."
                  : undefined
              }
            >
              {KEYFRAME_EASES.map((ease) => (
                <button
                  key={ease}
                  type="button"
                  role="radio"
                  aria-checked={eased.ease === ease}
                  aria-label={EASE_NAMES[ease]}
                  title={EASE_NAMES[ease]}
                  disabled={disabled}
                  onClick={() => {
                    const next = inputs(points);
                    const at = easeIndex!;
                    next[at] = { ...next[at]!, ease };
                    setPoints(`Ease ${EASE_NAMES[ease].toLowerCase()}`, next);
                  }}
                >
                  <svg viewBox="0 0 14 14" aria-hidden="true">
                    <path d={EASE_ICONS[ease]} />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Up and Down step a focused point through these speeds; Shift steps by 1%. */
const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 10];
const nextStep = (speed: number, up: boolean) =>
  up
    ? (STEPS.find((step) => step > speed + 1e-9) ?? speed)
    : (STEPS.findLast((step) => step < speed - 1e-9) ?? speed);

/**
 * The clip's whole length, speed on a log scale from 10% to 1000%, whatever the timeline zoom.
 * A press on the line adds a point there at the line's speed, so nothing changes until a drag.
 * Points drag sideways in whole frames between their neighbours and up and down in speed,
 * take the arrow keys when focused, and are removed by a double-click or Delete. A right-click
 * offers the eases. Each change is one undo step; Esc during a drag puts the point back.
 */
function SpeedGraph({
  clip,
  fps,
  points,
  playhead,
  disabled,
  selected,
  onSelect,
  onPoints,
}: {
  clip: Clip;
  fps: Fps;
  points: readonly SpeedPoint[];
  playhead: number | null;
  disabled: boolean | undefined;
  selected: number | null;
  onSelect(index: number | null): void;
  onPoints(label: string, points: SpeedInput[]): void;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{
    points: SpeedInput[];
    hint: string | null;
  } | null>(null);
  const shown = draft
    ? {
        ...clip,
        automation: withSpeedPoints(clip, draft.points, fps),
      }
    : clip;
  const drawn = draft ? (speedPoints(shown, fps) ?? []) : points;
  const at = (frame: number) => `${(frame / clip.duration) * 100}%`;
  const level = (speed: number) => `${speedLevel(speed) * 100}%`;
  const fromPointer = (clientX: number, clientY: number) => {
    const box = plot.current!.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
    return {
      frame: Math.round(((clientX - box.left) / box.width) * clip.duration),
      speed: speedAtLevel(fraction),
      height: box.height,
    };
  };
  /** Keeps a moved point between its neighbours and inside what the source can play. */
  const place = (index: number, frame: number, speed: number) => {
    const next = inputs(points);
    const before = points[index - 1];
    const after = points[index + 1];
    const low = before ? Math.floor(before.frame) + 1 : Math.min(0, frame);
    const high = after
      ? Math.ceil(after.frame) - 1
      : Math.max(clip.duration, frame);
    const clamped = {
      ...next[index]!,
      frame: Math.max(low, Math.min(high, frame)),
      speed: Math.round(speed * 1e4) / 1e4,
    };
    next[index] = clamped;
    const project = speedProjection(
      clip,
      useTimeline.getState().view?.timeline.clips ?? [clip],
      fps,
    );
    return (
      limitSpeedPoint(project, next, index, points[index]!, fps) ?? {
        points: next,
        hint: null,
      }
    );
  };
  const press = (event: PointerEvent<HTMLElement>, index: number) => {
    if (event.button !== 0 || disabled) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(index);
    const target = event.currentTarget;
    target.focus();
    target.setPointerCapture(event.pointerId);
    const start = points[index]!;
    let latest: ReturnType<typeof place> | null = null;
    const move = (moved: globalThis.PointerEvent) => {
      const { frame, speed } = fromPointer(moved.clientX, moved.clientY);
      latest = place(index, frame, speed);
      setDraft(latest);
    };
    const stop = (commit: boolean) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      setDraft(null);
      if (!commit) {
        onSelect(null);
        target.blur();
        if (target.hasPointerCapture(event.pointerId))
          target.releasePointerCapture(event.pointerId);
        return;
      }
      const moved = latest?.points[index];
      if (
        latest &&
        moved &&
        (moved.frame !== start.frame || moved.speed !== start.speed)
      )
        onPoints("Move speed point", latest.points);
    };
    const up = () => stop(true);
    const cancel = () => stop(false);
    const escape = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      stop(false);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
  };
  const remove = (index: number) => {
    onSelect(null);
    onPoints(
      "Remove speed point",
      inputs(points).filter((_, other) => other !== index),
    );
  };
  return (
    <>
      <div
        className="speed-graph"
        role="group"
        aria-label="Speed over the clip"
        aria-disabled={disabled}
      >
        {GRID.map((speed) => (
          <span
            key={speed}
            className="speed-label"
            aria-hidden="true"
            style={{ "--level-fraction": speedLevel(speed) }}
          >
            {speed * 100}
          </span>
        ))}
        <div
          className="speed-plot"
          ref={plot}
          onPointerDown={(event) => {
            // A press on the line adds a point at the line's speed there.
            if (
              event.button !== 0 ||
              disabled ||
              (event.target !== event.currentTarget &&
                !(event.target instanceof SVGElement))
            )
              return;
            const { frame, height } = fromPointer(event.clientX, event.clientY);
            if (frame < 0 || frame > clip.duration) return;
            const line = speedAtFrame(clip, fps, frame);
            const box = plot.current!.getBoundingClientRect();
            const y = box.top + speedLevel(line) * height;
            if (Math.abs(event.clientY - y) > 4) return onSelect(null);
            if (points.some((point) => Math.round(point.frame) === frame))
              return;
            event.preventDefault();
            onPoints("Add speed point", [
              ...inputs(points),
              { frame, speed: Math.round(line * 1e4) / 1e4 },
            ]);
          }}
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            {GRID.map((speed) => (
              <line
                key={speed}
                className={speed === 1 ? "unity" : undefined}
                x1="0"
                x2="100"
                y1={speedLevel(speed) * 100}
                y2={speedLevel(speed) * 100}
              />
            ))}
            <path className="speed-line" d={speedPath(shown, fps)} />
            {playhead !== null && (
              <line
                className="speed-playhead"
                x1={(playhead / clip.duration) * 100}
                x2={(playhead / clip.duration) * 100}
                y1="-6"
                y2="106"
              />
            )}
          </svg>
          {drawn.map((point, index) => (
            <button
              key={index}
              type="button"
              className="speed-point"
              data-ease={point.ease}
              data-on={point.frame === playhead ? "" : undefined}
              aria-pressed={selected === index}
              aria-label={`Speed point at ${formatTimecode(clip.start + Math.round(point.frame), fps)}, ${Math.round(point.speed * 100)}%`}
              disabled={disabled}
              hidden={point.frame < 0 || point.frame > clip.duration}
              style={{ "--at": at(point.frame), "--level": level(point.speed) }}
              onPointerDown={(event) => press(event, index)}
              onDoubleClick={() => remove(index)}
              onContextMenu={(event) => {
                onSelect(index);
                openContextMenu(
                  event,
                  "Speed point",
                  [
                    ...KEYFRAME_EASES.map((ease) => ({
                      label: EASE_NAMES[ease],
                      checked: point.ease === ease,
                      radio: true,
                      run: () => {
                        const next = inputs(points);
                        next[index] = { ...next[index]!, ease };
                        onPoints(
                          `Ease ${EASE_NAMES[ease].toLowerCase()}`,
                          next,
                        );
                      },
                    })),
                    "separator",
                    { label: "Delete", run: () => remove(index) },
                  ],
                  event.currentTarget,
                );
              }}
              onKeyDown={(event) => {
                const by = event.shiftKey ? 10 : 1;
                const point = points[index]!;
                const moves: Record<string, () => ReturnType<typeof place>> = {
                  ArrowLeft: () => place(index, point.frame - by, point.speed),
                  ArrowRight: () => place(index, point.frame + by, point.speed),
                  ArrowUp: () =>
                    place(
                      index,
                      point.frame,
                      event.shiftKey
                        ? point.speed + 0.01
                        : nextStep(point.speed, true),
                    ),
                  ArrowDown: () =>
                    place(
                      index,
                      point.frame,
                      event.shiftKey
                        ? Math.max(0.1, point.speed - 0.01)
                        : nextStep(point.speed, false),
                    ),
                };
                if (event.key === "Delete" || event.key === "Backspace") {
                  event.preventDefault();
                  event.stopPropagation();
                  return remove(index);
                }
                if (event.key === "Escape") {
                  event.stopPropagation();
                  onSelect(null);
                  event.currentTarget.blur();
                  return;
                }
                const step = moves[event.key];
                if (!step) return;
                // The timeline's arrow keys never see a focused point's.
                event.preventDefault();
                event.stopPropagation();
                const next = step();
                const moved = next.points[index]!;
                if (moved.frame !== point.frame || moved.speed !== point.speed)
                  onPoints("Move speed point", next.points);
              }}
              onFocus={() => onSelect(index)}
            />
          ))}
        </div>
      </div>
      {draft?.hint && <p className="speed-hint">{draft.hint}</p>}
    </>
  );
}
