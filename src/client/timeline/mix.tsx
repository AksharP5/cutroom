import { memo } from "react";
import {
  audioGainToFaderPosition,
  audioGainToText,
  gainTimesLane,
} from "@hyperframes/core/audio-gain";
import {
  parseAutomation,
  sampleAutomationLane,
  VOLUME_TARGET,
} from "@hyperframes/core/audio-automation";
import { fadeGain } from "@hyperframes/core/audio-fade";
import type { Clip, Fps } from "../../shared/timeline/schema";
import type { Row } from "./math";

export function gainHeight(volume: Clip["volume"]) {
  return (100 - audioGainToFaderPosition(volume ?? 1)) / 2;
}

/** Draw native automation and fades at the clip's gain level. */
export function fadePath(clip: Clip, fps: Fps) {
  const lane = clip.automation
    ? parseAutomation(clip.automation).lanes.find(
        (lane) => lane.target === VOLUME_TARGET,
      )
    : undefined;
  const framesPerSecond = fps.num / fps.den;
  const times = [
    ...new Set([
      ...Array.from({ length: 33 }, (_, index) => (clip.duration * index) / 32),
      clip.fadeIn,
      clip.duration - clip.fadeOut,
      ...(lane?.points.map((point) => point.t * framesPerSecond) ?? []),
    ]),
  ]
    .filter((time) => time >= 0 && time <= clip.duration)
    .sort((a, b) => a - b);
  return times
    .map((time, index) => {
      const gain =
        gainTimesLane(
          clip.volume ?? 1,
          lane ? sampleAutomationLane(lane, time / framesPerSecond) : 1,
        ) * fadeGain(time, clip.duration, clip);
      return `${index ? "L" : "M"}${((time / clip.duration) * 100).toFixed(2)},${gainHeight(gain).toFixed(2)}`;
    })
    .join(" ");
}

export const ClipMix = memo(function ClipMix({
  clip,
  row,
  fps,
}: {
  clip: Clip;
  row: Row;
  fps: Fps;
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
        <path d={fadePath(clip, fps)} />
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
