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
import { clipFades } from "../../shared/timeline/mix";
import type { Row } from "./math";

export function gainHeight(volume: Clip["volume"]) {
  return (100 - audioGainToFaderPosition(volume ?? 1)) / 2;
}

/** Draw native automation and fades at the clip's gain level. */
export function fadePath(clip: Clip, fps: Fps) {
  const fades = clipFades(clip);
  const lane = clip.automation
    ? parseAutomation(clip.automation).lanes.find(
        (lane) => lane.target === VOLUME_TARGET,
      )
    : undefined;
  const framesPerSecond = fps.num / fps.den;
  const times = [
    ...new Set([
      ...Array.from({ length: 33 }, (_, index) => (clip.duration * index) / 32),
      fades.fadeIn,
      clip.duration - fades.fadeOut,
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
  const path = fadePath(clip, fps);
  const fades = clipFades(clip);
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
        <path d={path} />
        <path className="tl-gain" data-mix="gain" d={path}>
          <title>{`Gain ${audioGainToText(clip.volume ?? 1)}`}</title>
        </path>
      </svg>
      <i
        className="tl-fade-handle"
        data-mix="fadeIn"
        title={`Fade in: ${clip.fadeIn} authored frames`}
        style={{ "--fade": `${(fades.fadeIn / clip.duration) * 100}%` }}
      />
      <i
        className="tl-fade-handle"
        data-mix="fadeOut"
        title={`Fade out: ${clip.fadeOut} authored frames`}
        style={{ "--fade": `${(fades.fadeOut / clip.duration) * 100}%` }}
      />
    </div>
  );
});
