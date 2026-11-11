import { memo } from "react";
import {
  audioGainToFaderPosition,
  audioFaderPositionToGain,
  audioGainToDb,
  audioDbToGain,
  MAX_AUDIO_GAIN,
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

function volumeLane(clip: Clip) {
  return clip.automation
    ? parseAutomation(clip.automation).lanes.find(
        (lane) => lane.target === VOLUME_TARGET,
      )
    : undefined;
}

/** Fades are linear amplitude ramps from the envelope to silence at the body's bottom. */
export function envelopeHeight(
  clip: Clip,
  fps: Fps,
  time: number,
  lane = volumeLane(clip) ?? null,
) {
  const value = lane
    ? sampleAutomationLane(lane, (time * fps.den) / fps.num)
    : 1;
  const level = gainHeight(gainTimesLane(clip.volume ?? 1, value));
  return 100 - (100 - level) * fadeGain(time, clip.duration, clip);
}

/** Invert the drawn envelope at the grabbed frame, including its fades and volume lane. */
export function gainFromDrag(
  clip: Clip,
  fps: Fps,
  frame: number,
  dy: number,
  height: number,
) {
  const time = Math.max(0, Math.min(clip.duration, frame - clip.start));
  const lane = volumeLane(clip);
  const value = lane
    ? sampleAutomationLane(lane, (time * fps.den) / fps.num)
    : 1;
  const fade = fadeGain(time, clip.duration, clip);
  const position =
    envelopeHeight(clip, fps, time, lane ?? null) + (dy / height) * 100;
  const level = fade > 0 ? 100 - (100 - position) / fade : position;
  const drawn = audioFaderPositionToGain(100 - level * 2);
  const volume = Math.min(
    MAX_AUDIO_GAIN,
    value > 0 && fade > 0 ? drawn / value : drawn,
  );
  return volume > 0
    ? audioDbToGain(Math.round(audioGainToDb(volume) * 10) / 10)
    : 0;
}

/** Draw native automation and fades at the clip's gain level. */
export function fadePath(clip: Clip, fps: Fps) {
  const fades = clipFades(clip);
  const lane = volumeLane(clip) ?? null;
  const framesPerSecond = fps.num / fps.den;
  const times = [
    ...new Set([
      ...(lane
        ? Array.from({ length: 33 }, (_, index) => (clip.duration * index) / 32)
        : [0, clip.duration]),
      fades.fadeIn,
      clip.duration - fades.fadeOut,
      ...(lane?.points.map((point) => point.t * framesPerSecond) ?? []),
    ]),
  ]
    .filter((time) => time >= 0 && time <= clip.duration)
    .sort((a, b) => a - b);
  return times
    .map((time, index) => {
      return `${index ? "L" : "M"}${((time / clip.duration) * 100).toFixed(2)},${envelopeHeight(clip, fps, time, lane).toFixed(2)}`;
    })
    .join(" ");
}

export const ClipMix = memo(function ClipMix({
  clip,
  row,
  fps,
  selected,
}: {
  clip: Clip;
  row: Row;
  fps: Fps;
  selected: boolean;
}) {
  const path = fadePath(clip, fps);
  const fades = clipFades(clip);
  return (
    <div
      className={`tl-mix on-${row.track.kind}${row.track.locked ? " locked" : ""}${selected ? " selected" : ""}`}
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
          <title>
            {`Gain ${audioGainToText(clip.volume ?? 1)}. Alt for fine adjustment.${
              clip.automation
                ? " Volume automation present: clear it in Inspector > Audio."
                : ""
            }`}
          </title>
        </path>
      </svg>
      <i
        className="tl-fade-handle"
        data-mix="fadeIn"
        title={`Fade in: ${clip.fadeIn} authored frames`}
        style={{
          "--fade": `${(fades.fadeIn / clip.duration) * 100}%`,
          "--level": envelopeHeight(clip, fps, fades.fadeIn),
        }}
      />
      <i
        className="tl-fade-handle"
        data-mix="fadeOut"
        title={`Fade out: ${clip.fadeOut} authored frames`}
        style={{
          "--fade": `${(fades.fadeOut / clip.duration) * 100}%`,
          "--level": envelopeHeight(clip, fps, clip.duration - fades.fadeOut),
        }}
      />
    </div>
  );
});
