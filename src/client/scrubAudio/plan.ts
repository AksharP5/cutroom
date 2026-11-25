import {
  VOLUME_TARGET,
  gainedVolume,
  gainedVolumePoints,
  isBentSegment,
  parseAutomation,
  sampleAutomationLane,
  volumeSegmentSampleCount,
} from "@hyperframes/core/audio-automation";
import { clampFadesToDuration } from "@hyperframes/core/audio-fade";
import { clampAudioGain } from "@hyperframes/core/audio-gain";
import { previewMediaPath } from "../../shared/media";
import { toSeconds } from "../../shared/timeline/apply";
import { resolveClip } from "../../shared/timeline/clipTiming";
import { elementClip } from "../../shared/timeline/element";
import {
  AUDIO_SAMPLE_RATE,
  decimalFraction,
  fraction,
  rampSourceTimes,
  sourceAt,
  sourceSampleOffset,
} from "../../shared/timeline/piece";
import type { ExactTime, Piece } from "../../shared/timeline/piece";
import { isAudioKind } from "../../shared/timeline/schema";
import type { Clip, Timeline } from "../../shared/timeline/schema";
import { mixSilences, trackMix } from "../../shared/timeline/tracks";
import { RAMP_STEP } from "./segment";
import type { GainPoint, Segment, SourceKey, SourceMap } from "./segment";

/** How far a straight piece of the envelope may stray from the product it stands for. */
const ENVELOPE_TOLERANCE = 1e-4;

/**
 * Every clip that sounds, as the export mix plays it, ordered by start. Gain is clip gain, fades,
 * volume automation and transition crossfades, then track or bus gain and main gain; a clip the
 * mix silences keeps its segment at zero. Not applied: effects, nested compositions, and a bus's
 * own automation lane, which the timeline does not carry.
 */
export function scrubPlan(
  timeline: Timeline,
  media: {
    composition: string;
    versions: Readonly<Record<string, string | null>>;
  },
): Segment[] {
  const mix = trackMix(timeline);
  const buses = new Map(
    (timeline.authoredAudioGroups ?? []).map((bus) => [bus.id, bus]),
  );
  const tracks = new Map(timeline.tracks.map((track) => [track.index, track]));
  const main = timeline.main?.volume ?? 1;
  const segments: Segment[] = [];
  // A dialogue timeline cuts many clips from a few files.
  const sources = new Map<string, SourceKey | null>();
  const sourceOf = (src: string) => {
    if (sources.has(src)) return sources.get(src)!;
    const path = previewMediaPath(media.composition, src, media.versions);
    const version = path === null ? null : media.versions[path];
    const key =
      path === null || version === null
        ? null
        : { path, version: version ?? "" };
    sources.set(src, key);
    return key;
  };

  for (const clip of timeline.clips) {
    if (!clip.hasAudio || !clip.src) continue;
    if (clip.kind !== "video" && !isAudioKind(clip.kind)) continue;
    const source = sourceOf(clip.src);
    if (!source) continue;

    const playableEnd =
      clip.loop && clip.sourceDuration !== null
        ? decimalFraction(clip.sourceDuration)
        : undefined;
    const piece = resolveClip(clip, timeline.fps, true, playableEnd);
    const samples = {
      start: Number(piece.samples.start),
      end: Number(piece.samples.end),
    };
    if (samples.end <= samples.start) continue;

    const bus = clip.authoredAudioGroupId
      ? buses.get(clip.authoredAudioGroupId)
      : undefined;
    const silent = !clip.enabled || mixSilences(mix, clip) || bus?.muted;
    const stage = clip.authoredAudioGroupId
      ? (bus?.volume ?? 1)
      : (tracks.get(clip.track)?.volume ?? 1);

    segments.push({
      clipId: clip.id,
      source,
      samples,
      map: sourceMap(piece, samples),
      ...(piece.loop?.length != null && {
        loop: {
          start: samplesOf(piece.loop.start),
          length: samplesOf(piece.loop.length),
        },
      }),
      gain: silent
        ? [{ at: samples.start, gain: 0 }]
        : envelope(clip, timeline, samples.start, stage * main),
    });
  }
  return segments.sort((a, b) => a.samples.start - b.samples.start);
}

const samplesOf = (time: ExactTime | number) => {
  if (typeof time === "number") return time * AUDIO_SAMPLE_RATE;
  const scaled = time.n * BigInt(AUDIO_SAMPLE_RATE);
  return Number(scaled / time.d) + Number(scaled % time.d) / Number(time.d);
};

function sourceMap(piece: Piece, samples: Segment["samples"]): SourceMap {
  const offset = sourceSampleOffset(piece);
  if (offset !== null) return { kind: "line", offset: Number(offset) };
  const start = fraction(BigInt(samples.start), BigInt(AUDIO_SAMPLE_RATE));
  // Wrap after interpolation so the last ramp entry never interpolates back to the first.
  const line = piece.loop ? { ...piece, loop: null } : piece;
  if (piece.line.kind === "exact")
    return {
      kind: "rate",
      start: samplesOf(sourceAt(line, start)),
      rate: Number(piece.line.rate.n) / Number(piece.line.rate.d),
    };
  const steps = Math.ceil((samples.end - samples.start) / RAMP_STEP);
  const times = rampSourceTimes(
    line,
    start,
    RAMP_STEP / AUDIO_SAMPLE_RATE,
    steps + 1,
  );
  return { kind: "table", positions: times.map(samplesOf) };
}

type Knot = { t: number; v: number };

/** Linear between knots and held past either end, as the export's envelope baker reads them. */
function linear(knots: readonly Knot[], t: number) {
  let low = 0;
  let high = knots.length - 1;
  if (t <= knots[low]!.t) return knots[low]!.v;
  if (t >= knots[high]!.t) return knots[high]!.v;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (knots[middle]!.t <= t) low = middle;
    else high = middle;
  }
  const a = knots[low]!;
  const b = knots[high]!;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/**
 * The volume lane as the export bakes it (HyperFrames `volumeLaneKeyframes`): clip gain times the
 * lane, bent pieces sampled, the first value held from 0 and the last held to the end.
 */
function laneKnots(
  automation: string | null,
  volume: number,
  duration: number,
) {
  const lane = automation
    ? parseAutomation(automation).lanes.find(
        ({ target }) => target === VOLUME_TARGET,
      )
    : undefined;
  if (!lane?.points.length) return [{ t: 0, v: clampAudioGain(volume) }];
  const points = gainedVolumePoints(lane, volume);
  const knots: Knot[] = points[0]!.t > 0 ? [{ t: 0, v: points[0]!.v }] : [];
  points.forEach((a, index) => {
    knots.push({ t: a.t, v: a.v });
    const b = points[index + 1];
    if (!b || !isBentSegment(a)) return;
    const steps = volumeSegmentSampleCount(b.t - a.t);
    for (let k = 1; k < steps; k++) {
      const t = a.t + ((b.t - a.t) * k) / steps;
      knots.push({ t, v: gainedVolume(sampleAutomationLane(lane, t), volume) });
    }
  });
  if (duration > points.at(-1)!.t)
    knots.push({ t: duration, v: points.at(-1)!.v });
  return knots;
}

/** The clip's element as written for export, its lane times its edge fades, in output samples. */
function envelope(
  clip: Clip,
  timeline: Timeline,
  start: number,
  stage: number,
) {
  const { fps } = timeline;
  const element = elementClip(clip, fps);
  const duration = toSeconds(element.duration, fps);
  const lane = laneKnots(element.automation, element.volume ?? 1, duration);
  const { fadeIn, fadeOut } = clampFadesToDuration(
    {
      fadeIn: toSeconds(element.fadeIn, fps),
      fadeOut: toSeconds(element.fadeOut, fps),
    },
    duration,
  );
  const fade: Knot[] = [
    { t: 0, v: fadeIn > 0 ? 0 : 1 },
    { t: fadeIn, v: 1 },
    { t: duration - fadeOut, v: 1 },
    { t: duration, v: fadeOut > 0 ? 0 : 1 },
  ];
  if (lane.length === 1 && !fadeIn && !fadeOut)
    return [{ at: start, gain: lane[0]!.v * stage }];
  const value = (t: number) => linear(lane, t) * linear(fade, t) * stage;
  const times = [
    ...new Set(
      [...lane, ...fade]
        .map(({ t }) => t)
        .filter((t) => t >= 0 && t <= duration),
    ),
  ].sort((a, b) => a - b);

  const at = (t: number) => start + t * AUDIO_SAMPLE_RATE;
  const points: GainPoint[] = [{ at: at(times[0]!), gain: value(times[0]!) }];
  for (let index = 1; index < times.length; index++) {
    const from = times[index - 1]!;
    const to = times[index]!;
    // Two ramps meeting multiply into a parabola; split it until each straight piece is close.
    const middle = (from + to) / 2;
    const bend = Math.abs(value(middle) - (value(from) + value(to)) / 2);
    const pieces = Math.max(1, Math.ceil(Math.sqrt(bend / ENVELOPE_TOLERANCE)));
    for (let piece = 1; piece <= pieces; piece++) {
      const t = from + ((to - from) * piece) / pieces;
      points.push({ at: at(t), gain: value(t) });
    }
  }
  return points;
}
