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
/**
 * Unity sits this many pixels above the middle of the clip body and -6 dB as many below it, at
 * every track height. A hand takes a clip by the middle of its box or of its waveform, which
 * are 5.5 px apart, and the line's grab band is 3 px wide: at unity the band lies between the
 * two with a pixel to spare on each side, and from -6 dB down it is a pixel or more below both.
 * So a press on either middle moves the clip, at unity and at any level a music bed sits at.
 */
const CLEAR = 3;
/** Where -24 dB sits, in percent down the body. What is left below falls away to silence. */
const BED_END = 94;
/**
 * The clip body the line is drawn in, for a track of this height: the clip leaves 2 px of its
 * row, and its body is what remains under the name strip, less 3 px at the bottom, as
 * `.tl-mix` and `.tl-fade-curve` lay it out in timeline.css.
 */
export const mixBody = (rowHeight: number) => rowHeight - 19;

type Stops = readonly (readonly [percent: number, db: number])[];
const scales = new Map<number, Stops>();
/**
 * The gain scale of a body this many pixels tall: how far down from its top, in percent, each
 * dB level sits, in straight runs between the stops. Between unity and -6 dB a pixel is 1 dB.
 * Everything from there to `BED_END` goes to the 18 dB a music bed is set in, the most room
 * that keeps the line clear of both middles. The line is drawn on this scale and a drag reads
 * it back, so the line stays under the pointer.
 */
function scaleOf(body: number) {
  let stops = scales.get(body);
  if (!stops) {
    const clear = (CLEAR / body) * 100;
    stops = [
      [0, MAX_AUDIO_GAIN_DB],
      [50 - clear, 0],
      [50 + clear, -6],
      [BED_END, -24],
      [100, SILENCE_DB],
    ];
    if (scales.size >= 64) scales.clear();
    scales.set(body, stops);
  }
  return stops;
}
/**
 * A clip turned down still shows its waveform at this share of its height at unity, or more,
 * so the beats of a ducked music bed stay readable. Fades taper from there to nothing.
 */
const WAVE_FLOOR = 1 / 3;
/** Shift moves the line a tenth of a dB per pixel at every track height. */
const FINE_DB = 0.1;

/** Reads a body's scale from its `from` column to the other: 0 is percent, 1 is dB. */
function onScale(value: number, from: 0 | 1, body: number) {
  const scale = scaleOf(body);
  const to = from === 0 ? 1 : 0;
  // Percent rises down the stops while dB falls.
  const found = scale.findIndex(
    (stop, index) =>
      index > 0 && (from === 0 ? value <= stop[0] : value >= stop[1]),
  );
  const index = found < 0 ? scale.length - 1 : found;
  const upper = scale[index - 1]!;
  const lower = scale[index]!;
  return (
    upper[to] +
    ((value - upper[from]) / (lower[from] - upper[from])) *
      (lower[to] - upper[to])
  );
}

/** How far down a body of this height a gain's line sits, in percent. */
export function gainLevel(volume: Clip["volume"], body: number) {
  const gain = clampAudioGain(volume ?? 1);
  return onScale(
    gain > 0 ? Math.max(SILENCE_DB, audioGainToDb(gain)) : SILENCE_DB,
    1,
    body,
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

const laneAt = (fps: Fps, time: number, lane: Lane) =>
  lane ? sampleAutomationLane(lane, (time * fps.den) / fps.num) : 1;

/** Core's linear fade ramps from already clamped fades, so a waveform column allocates nothing. */
function fadeAt(clip: Clip, time: number, { fadeIn, fadeOut }: Fades) {
  const head = fadeIn > 0 ? Math.max(0, Math.min(1, time / fadeIn)) : 1;
  const tail =
    fadeOut > 0
      ? Math.max(0, Math.min(1, (clip.duration - time) / fadeOut))
      : 1;
  return head * tail;
}

/**
 * How tall the clip's waveform is drawn `time` frames in, against its height at unity gain.
 * Peaks are on a square-root scale, so the gain on the volume lane scales them by its root, held
 * at the floor, and a fade tapers that to nothing.
 */
export function waveformScale(
  clip: Clip,
  fps: Fps,
  time: number,
  lane: Lane,
  fades: Fades,
) {
  return Math.sqrt(
    Math.max(
      WAVE_FLOOR ** 2,
      gainTimesLane(clip.volume ?? 1, laneAt(fps, time, lane)),
    ) * fadeAt(clip, time, fades),
  );
}

/**
 * Where the line is drawn, in percent down a body of this height, for a clip gain on a volume
 * lane's value through a fade. Fades are linear amplitude ramps from the gain's level to silence
 * at the bottom.
 */
const drawn = (gain: number, lane: number, fade: number, body: number) =>
  100 - (100 - gainLevel(gainTimesLane(gain, lane), body)) * fade;

export function envelopeHeight(
  clip: Clip,
  fps: Fps,
  time: number,
  body: number,
  lane: Lane = volumeLane(clip),
  fades = clipFades(clip),
) {
  return drawn(
    clip.volume ?? 1,
    laneAt(fps, time, lane),
    fadeAt(clip, time, fades),
    body,
  );
}

/** What shapes the line `time` frames in besides the clip's gain: the lane's value and the fades' gain. */
export const envelopeAt = (clip: Clip, fps: Fps, time: number) => ({
  lane: laneAt(fps, time, volumeLane(clip)),
  fade: fadeAt(clip, time, clipFades(clip)),
});

export interface GainDrag {
  /** The clip's gain when the pointer, or a change of Shift, last took hold of the line. */
  from: number;
  /** Pointer travel since then, in pixels down. */
  dy: number;
  /** Shift is held: a tenth of a dB per pixel, whatever the line's shape. */
  fine: boolean;
  /** Height of the clip body the line is drawn in, in pixels. */
  body: number;
  /** The volume lane's value where the line is held. */
  lane: number;
  /** The fades' gain where the line is held. */
  fade: number;
}

/** A dB level as the gain a drag writes: tenths of a dB, silent at the floor, capped at +12 dB. */
const gainOf = (db: number) =>
  db <= SILENCE_DB
    ? 0
    : Math.min(MAX_AUDIO_GAIN, audioDbToGain(Math.round(db * 10) / 10));

/**
 * The gain a drag leaves. The line stays under the pointer where it was taken hold of, so the
 * drawn envelope is read back there: through the fade and the volume lane to the clip's gain,
 * stopping at the gain that can be reached. A line within half a pixel of unity lands on it, so
 * 0 dB can be reached at any track height; a clip that starts inside that half pixel without
 * being at unity is left to move freely.
 */
export function gainFromDrag({ from, dy, fine, body, lane, fade }: GainDrag) {
  if (!dy) return from;
  if (fine)
    return gainOf(
      (from > 0 ? Math.max(SILENCE_DB, audioGainToDb(from)) : SILENCE_DB) -
        dy * FINE_DB,
    );
  // A lane or a fade at nothing leaves no line to follow; the drag reads the plain scale there.
  const on = lane > 0 ? lane : 1;
  const through = fade > 0 ? fade : 1;
  const pixel = 100 / body;
  const reach = pixel / 2 + 1e-6;
  const start = drawn(from, on, through, body);
  const unity = drawn(1, on, through, body);
  const sticky = from === 1 || Math.abs(start - unity) > reach;
  const at = Math.max(0, Math.min(100, start + dy * pixel));
  if (sticky && Math.abs(at - unity) <= reach) return 1;
  const db = onScale(Math.max(0, 100 - (100 - at) / through), 0, body);
  return db <= SILENCE_DB ? 0 : gainOf(db - audioGainToDb(on));
}

/** Draw native automation and fades at the clip's gain level, in a body of this height. */
export function fadePath(clip: Clip, fps: Fps, body: number) {
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
      return `${index ? "L" : "M"}${((time / clip.duration) * 100).toFixed(2)},${envelopeHeight(clip, fps, time, body, lane, fades).toFixed(2)}`;
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
  const body = mixBody(row.height);
  const path = fadePath(clip, fps, body);
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
          "--level": envelopeHeight(clip, fps, fades.fadeIn, body),
        }}
      />
      <i
        className="tl-fade-handle"
        data-mix="fadeOut"
        title={`Fade out: ${clip.fadeOut} authored frames`}
        style={{
          "--fade": `${(fades.fadeOut / clip.duration) * 100}%`,
          "--level": envelopeHeight(
            clip,
            fps,
            clip.duration - fades.fadeOut,
            body,
          ),
        }}
      />
    </div>
  );
});
