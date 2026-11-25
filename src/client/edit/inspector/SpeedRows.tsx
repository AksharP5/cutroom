import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import type { Clip, Fps } from "../../../shared/timeline/schema";
import {
  sourceOutFrame,
  speedAtFrame,
  speedLevel,
  SPEED_PRESETS,
  speedPoints,
} from "../../../shared/timeline/speed";
import type { SpeedInput, SpeedPoint } from "../../../shared/timeline/speed";
import { CaretDown } from "@phosphor-icons/react";
import { KEYFRAME_EASES } from "../../../shared/timeline/schema";
import type {
  CommandInput,
  KeyframeEase,
} from "../../../shared/timeline/schema";
import { openContextMenu } from "../../components/ContextMenu";
import { editTimeline } from "../timeline";
import { resettable } from "../keys";
import { TimecodeText } from "../../components/TimecodeText";
import { formatTimecode } from "../../../shared/timeline/timecode";
import { speedPath } from "../../timeline/ClipSpeed";
import { useTransport } from "../transport";
import { ValueField } from "./ValueField";

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
  const index = points?.findIndex((point) => point.frame === frame) ?? -1;
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
      className="inspector-keyframe"
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
  const eased = points && points[easePoint(points, frame)];
  return (
    <>
      <ValueField
        key={`${clip.id}:speed`}
        label="Speed"
        value={Math.round(speed * 1e4) / 1e4}
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
        <SpeedGraph clip={clip} fps={fps} points={points} playhead={playhead} />
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
                    const at = easePoint(points, frame);
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

/** The clip's whole length, speed on a log scale from 10% to 1000%, whatever the timeline zoom. */
function SpeedGraph({
  clip,
  fps,
  points,
  playhead,
}: {
  clip: Clip;
  fps: Fps;
  points: readonly SpeedPoint[];
  playhead: number | null;
}) {
  const at = (frame: number) => `${(frame / clip.duration) * 100}%`;
  const level = (speed: number) => `${speedLevel(speed) * 100}%`;
  return (
    <div className="speed-graph" role="img" aria-label="Speed over the clip">
      {GRID.map((speed) => (
        <span
          key={speed}
          className="speed-label"
          style={{ "--level-fraction": speedLevel(speed) }}
        >
          {speed * 100}
        </span>
      ))}
      <div className="speed-plot">
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
          <path className="speed-line" d={speedPath(clip, fps)} />
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
        {points.map((point, index) => (
          <i
            key={index}
            className="speed-point"
            data-ease={point.ease}
            data-on={point.frame === playhead ? "" : undefined}
            hidden={point.frame < 0 || point.frame > clip.duration}
            style={{ "--at": at(point.frame), "--level": level(point.speed) }}
          />
        ))}
      </div>
    </div>
  );
}
