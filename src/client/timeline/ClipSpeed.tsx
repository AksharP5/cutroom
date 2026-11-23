import { memo } from "react";
import { create } from "zustand";
import type { Clip, Fps } from "../../shared/timeline/schema";
import {
  speedCurve,
  speedLevel,
  speedPoints,
} from "../../shared/timeline/speed";
import type { Row } from "./math";

/** Constant-speed clips whose speed line Ctrl+R shows, so a ramp can be started on the clip. */
export const useSpeedShown = create(() => ({
  ids: new Set<string>() as ReadonlySet<string>,
}));

/** Shows the speed line on these clips, or hides it when every one already shows it. */
export function toggleSpeedLines(ids: readonly string[]) {
  const { ids: shown } = useSpeedShown.getState();
  const hide = ids.length > 0 && ids.every((id) => shown.has(id));
  const next = new Set(shown);
  for (const id of ids) {
    if (hide) next.delete(id);
    else next.add(id);
  }
  useSpeedShown.setState({ ids: next });
}

/** The clip's speed as an SVG path across its body: log scale, 10% at the foot, 1000% at the top. */
export const speedPath = (clip: Clip, fps: Fps) =>
  speedCurve(clip, fps)
    .map(
      ({ frame, speed }, index) =>
        `${index ? "L" : "M"}${((frame / clip.duration) * 100).toFixed(2)},${(speedLevel(speed) * 100).toFixed(2)}`,
    )
    .join(" ");

const percent = (speed: number) => `${Math.round(speed * 100)}%`;

/**
 * A clip's speed, drawn across its filmstrip like the gain line on sound: always on a ramp, so an
 * agent's ramp is visible at a glance, and on a constant clip once Ctrl+R shows it. The line and
 * its points take presses through the timeline's gestures.
 */
export const ClipSpeed = memo(function ClipSpeed({
  clip,
  row,
  fps,
  points: showPoints,
}: {
  clip: Clip;
  row: Row;
  fps: Fps;
  /** Narrow clips draw the line without its points. */
  points: boolean;
}) {
  const path = speedPath(clip, fps);
  const points = speedPoints(clip, fps);
  const speeds = points?.map(({ speed }) => speed) ?? [clip.playbackRate];
  const low = Math.min(...speeds);
  const high = Math.max(...speeds);
  return (
    <div
      className={`tl-mix tl-speed on-${row.track.kind}${row.track.locked ? " locked" : ""}`}
      data-clip-speed={clip.id}
      style={{ "--s": clip.start, "--d": clip.duration, top: 0 }}
    >
      <svg
        className="tl-fade-curve"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path className="tl-envelope-edge" d={path} />
        <path d={path} />
        <path className="tl-gain" data-speed="line" d={path}>
          <title>
            {`Speed ${low === high ? percent(low) : `${percent(low)} to ${percent(high)}`}. Shift for fine adjustment. Alt-click adds a speed point.`}
          </title>
        </path>
      </svg>
      {showPoints &&
        points?.map(({ frame, speed, ease }, index) => (
          <i
            key={index}
            className="tl-volume-point"
            data-speed={index}
            data-speed-point={index}
            data-ease={ease}
            hidden={frame < 0 || frame > clip.duration}
            title="Speed point. Drag to move it, Alt-click to remove it."
            style={{
              "--at": `${(frame / clip.duration) * 100}%`,
              "--level": speedLevel(speed) * 100,
            }}
          />
        ))}
    </div>
  );
});
