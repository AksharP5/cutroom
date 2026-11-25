import { memo } from "react";
import type { Clip, Fps } from "../../shared/timeline/schema";
import {
  speedCurve,
  speedLevel,
  speedPoints,
} from "../../shared/timeline/speed";
import type { Row } from "./math";

/** The clip's speed as an SVG path across its body: log scale, 10% at the foot, 1000% at the top. */
export const speedPath = (clip: Clip, fps: Fps) =>
  speedCurve(clip, fps)
    .map(
      ({ frame, speed }, index) =>
        `${index ? "L" : "M"}${((frame / clip.duration) * 100).toFixed(2)},${(speedLevel(speed) * 100).toFixed(2)}`,
    )
    .join(" ");

/**
 * A ramped clip's speed, drawn across its filmstrip like the gain line on sound, whether or not
 * the clip is selected, so a ramp is visible at a glance.
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
      </svg>
      {showPoints &&
        speedPoints(clip, fps)!.map(({ frame, speed }, index) => (
          <i
            key={index}
            className="tl-volume-point"
            data-speed-point={index}
            hidden={frame < 0 || frame > clip.duration}
            style={{
              "--at": `${(frame / clip.duration) * 100}%`,
              "--level": speedLevel(speed) * 100,
            }}
          />
        ))}
    </div>
  );
});
