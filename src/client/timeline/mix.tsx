import { memo } from "react";
import {
  audioDbToGain,
  audioGainToDb,
  audioGainToText,
  clampAudioGain,
  gainTimesLane,
  MAX_AUDIO_GAIN,
  MAX_AUDIO_GAIN_DB,
} from "@hyperframes/core/audio-gain";
import {
  parseAutomation,
  sampleAutomationLane,
  VOLUME_TARGET,
} from "@hyperframes/core/audio-automation";
import type { HfAutomationLane } from "@hyperframes/core/audio-automation";
import type { Clip, Fps } from "../../shared/timeline/schema";
import { clipFades } from "../../shared/timeline/mix";
import type { Row } from "./math";

const SILENCE_DB = -60;
const UNITY = 50;
/**
 * The gain scale of a clip body: how far down from its top, in percent, each dB level sits, in
 * straight runs between these stops. Unity stays at the middle, where a press on the middle of
 * the clip's box misses the line. The line is drawn on this scale and a drag reads it back, so
 * the line stays under the pointer.
 */
const SCALE = [
  [0, MAX_AUDIO_GAIN_DB],
  [UNITY, 0],
  [90, -30],
  [100, SILENCE_DB],
] as const;
/** Shift moves the line a tenth of a dB per pixel at every track height. */
const FINE_DB = 0.1;

/** Reads the scale from its `from` column to the other: 0 is percent, 1 is dB. */
function onScale(value: number, from: 0 | 1) {
  const to = from === 0 ? 1 : 0;
  // Percent rises down the stops while dB falls.
  const found = SCALE.findIndex(
    (stop, index) =>
      index > 0 && (from === 0 ? value <= stop[0] : value >= stop[1]),
  );
  const index = found < 0 ? SCALE.length - 1 : found;
  const upper = SCALE[index - 1]!;
  const lower = SCALE[index]!;
  return (
    upper[to] +
    ((value - upper[from]) / (lower[from] - upper[from])) *
      (lower[to] - upper[to])
  );
}

export function gainLevel(volume: Clip["volume"]) {
  const gain = clampAudioGain(volume ?? 1);
  return onScale(
    gain > 0 ? Math.max(SILENCE_DB, audioGainToDb(gain)) : SILENCE_DB,
    1,
  );
}

/** Parsed volume lanes by their automation text, so a repaint or a drag does not parse again. */
const volumeLanes = new Map<string, HfAutomationLane | undefined>();

export function volumeLane({ automation }: Clip) {
  if (!automation) return undefined;
  if (!volumeLanes.has(automation)) {
    if (volumeLanes.size >= 256) volumeLanes.clear();
    volumeLanes.set(
      automation,
      parseAutomation(automation).lanes.find(
        (lane) => lane.target === VOLUME_TARGET,
      ),
    );
  }
  return volumeLanes.get(automation);
}

type Fades = ReturnType<typeof clipFades>;
type Lane = HfAutomationLane | undefined;

const laneGain = (clip: Clip, fps: Fps, time: number, lane: Lane) =>
  gainTimesLane(
    clip.volume ?? 1,
    lane ? sampleAutomationLane(lane, (time * fps.den) / fps.num) : 1,
  );

/** Core's linear fade ramps from already clamped fades, so a waveform column allocates nothing. */
function fadeAt(clip: Clip, time: number, { fadeIn, fadeOut }: Fades) {
  const head = fadeIn > 0 ? Math.max(0, Math.min(1, time / fadeIn)) : 1;
  const tail =
    fadeOut > 0
      ? Math.max(0, Math.min(1, (clip.duration - time) / fadeOut))
      : 1;
  return head * tail;
}

/** The clip's linear gain `time` frames in: its gain on the volume lane, through both fades. */
export function envelopeGain(
  clip: Clip,
  fps: Fps,
  time: number,
  lane: Lane,
  fades: Fades,
) {
  return laneGain(clip, fps, time, lane) * fadeAt(clip, time, fades);
}

/** Fades are linear amplitude ramps from the envelope to silence at the body's bottom. */
export function envelopeHeight(
  clip: Clip,
  fps: Fps,
  time: number,
  lane: Lane = volumeLane(clip),
  fades = clipFades(clip),
) {
  const level = gainLevel(laneGain(clip, fps, time, lane));
  return 100 - (100 - level) * fadeAt(clip, time, fades);
}

export interface GainDrag {
  /** Pointer travel down the body, in pixels. */
  dy: number;
  /** Pointer travel with Shift held, in pixels. */
  fine: number;
  /** Height of the clip body the line is drawn in, in pixels. */
  body: number;
}

/**
 * The gain a drag leaves: the line moves with the pointer, in tenths of a dB. A line within half
 * a pixel of unity lands on it, so 0 dB can be reached at any track height. A clip that starts
 * inside that half pixel without being at unity is left to move freely.
 */
export function gainFromDrag(clip: Clip, { dy, fine, body }: GainDrag) {
  const pixel = 100 / body;
  const from = gainLevel(clip.volume);
  const reach = pixel / 2 + 1e-6;
  const sticky = from === UNITY || Math.abs(from - UNITY) > reach;
  const level = Math.max(0, Math.min(100, from + dy * pixel));
  const coarse =
    sticky && Math.abs(level - UNITY) <= reach ? 0 : onScale(level, 0);
  const db = Math.min(MAX_AUDIO_GAIN_DB, coarse - fine * FINE_DB);
  return db <= SILENCE_DB
    ? 0
    : Math.min(MAX_AUDIO_GAIN, audioDbToGain(Math.round(db * 10) / 10));
}

/** Draw native automation and fades at the clip's gain level. */
export function fadePath(clip: Clip, fps: Fps) {
  const fades = clipFades(clip);
  const lane = volumeLane(clip);
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
      return `${index ? "L" : "M"}${((time / clip.duration) * 100).toFixed(2)},${envelopeHeight(clip, fps, time, lane, fades).toFixed(2)}`;
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
        <path className="tl-gain" data-mix="gain" d={path}>
          <title>
            {`Gain ${audioGainToText(clip.volume ?? 1)}. Shift for fine adjustment.${
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
