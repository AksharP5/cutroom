import { memo } from "react";
import {
  audioGainToFaderPosition,
  audioGainToText,
} from "@hyperframes/core/audio-gain";
import { clampFadesToDuration, fadeGain } from "@hyperframes/core/audio-fade";
import type { Clip } from "../../shared/timeline/schema";
import type { Row } from "./math";

export function gainHeight(volume: Clip["volume"]) {
  return (100 - audioGainToFaderPosition(volume ?? 1)) / 2;
}

/** Draw the same native fade at its breakpoints, in frame units. */
export function fadePath(clip: Clip) {
  if (!clip.fadeIn && !clip.fadeOut) return "";
  const fades = clampFadesToDuration(clip, clip.duration);
  const times = [
    ...new Set([0, fades.fadeIn, clip.duration - fades.fadeOut, clip.duration]),
  ].sort((a, b) => a - b);
  return times
    .map(
      (time, index) =>
        `${index ? "L" : "M"}${(time / clip.duration) * 100},${(1 - fadeGain(time, clip.duration, fades)) * 100}`,
    )
    .join(" ");
}

export const ClipMix = memo(function ClipMix({
  clip,
  row,
}: {
  clip: Clip;
  row: Row;
}) {
  return (
    <div
      className={`tl-mix on-${row.track.kind}${row.track.locked ? " locked" : ""}`}
      data-clip-mix={clip.id}
      style={{ "--s": clip.start, "--d": clip.duration, top: row.top }}
    >
      <svg
        className="tl-fade-curve"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={fadePath(clip)} />
      </svg>
      <div className="tl-gain-area">
        <i
          className="tl-gain"
          data-mix="gain"
          title={`Gain ${audioGainToText(clip.volume ?? 1)}`}
          style={{ top: `${gainHeight(clip.volume)}%` }}
        />
      </div>
      <i
        className="tl-fade-handle"
        data-mix="fadeIn"
        title={`Fade in: ${clip.fadeIn} frames`}
        style={{ left: `${(clip.fadeIn / clip.duration) * 100}%` }}
      />
      <i
        className="tl-fade-handle"
        data-mix="fadeOut"
        title={`Fade out: ${clip.fadeOut} frames`}
        style={{ right: `${(clip.fadeOut / clip.duration) * 100}%` }}
      />
    </div>
  );
});
