/** What a scrub plan hands the audio thread, as plain data. */
import { wrapSource } from "../../shared/timeline/piece";

/** Output samples between two entries of a ramp's source table. */
export const RAMP_STEP = 480;
/** A source file as every media route names it: its project path and the version it was listed at. */
export type SourceKey = { path: string; version: string };
/** A source key as one string, the way the audio thread files its chunks. */
export const sourceId = ({ path, version }: SourceKey) => `${path}\n${version}`;

/**
 * Where output sample `n` reads its source, in 48 kHz source samples.
 * - `line`: a 1x piece reads `n + offset`, one integer for every piece on the line.
 * - `rate`: other constant speeds read `start + (n - samples.start) * rate`.
 * - `table`: a ramp's source position every RAMP_STEP samples from `samples.start`.
 */
export type SourceMap =
  | { kind: "line"; offset: number }
  | { kind: "rate"; start: number; rate: number }
  | { kind: "table"; positions: Float64Array };

/** Gain at an output sample, straight between points and held past either end. */
export type GainPoint = { at: number; gain: number };

export type Segment = {
  clipId: string;
  source: SourceKey;
  /** Output samples `[start, end)`, transition handles included. */
  samples: { start: number; end: number };
  map: SourceMap;
  /** A repeat from the source In point to its playable end, in source samples. */
  loop?: { start: number; length: number };
  gain: readonly GainPoint[];
};

/** Where output sample `n` falls on the source line before wrapping. */
export function unwrappedSourcePosition({ map, samples }: Segment, n: number) {
  if (map.kind === "line") return n + map.offset;
  if (map.kind === "rate") return map.start + (n - samples.start) * map.rate;
  const { positions } = map;
  const at = (n - samples.start) / RAMP_STEP;
  const step = Math.max(0, Math.min(positions.length - 2, Math.floor(at)));
  const from = positions[step]!;
  const to = positions[step + 1] ?? from;
  return from + (to - from) * (at - step);
}

export function sourcePosition(segment: Segment, n: number) {
  return wrapPosition(segment.loop, unwrappedSourcePosition(segment, n));
}

export const wrapPosition = (loop: Segment["loop"], at: number) =>
  loop ? wrapSource(at, loop.start, loop.length) : at;

/** Gain at output sample `n`, read from straight pieces between points. */
export function gainAt(points: readonly GainPoint[], n: number) {
  const first = points[0];
  if (!first || n <= first.at) return first?.gain ?? 0;
  let low = 0;
  let high = points.length - 1;
  if (n >= points[high]!.at) return points[high]!.gain;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (points[middle]!.at <= n) low = middle;
    else high = middle;
  }
  const a = points[low]!;
  const b = points[high]!;
  return a.gain + ((b.gain - a.gain) * (n - a.at)) / (b.at - a.at);
}
