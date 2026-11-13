import { mediaSettings, peakLevels } from "../../shared/media";
import { clipEnd } from "../../shared/timeline/apply";
import type { Clip, Fps, Timeline, Track } from "../../shared/timeline/schema";
import {
  newTrack,
  nextTrackIndex,
  shownTracks,
} from "../../shared/timeline/tracks";
import { nominal } from "../../shared/timeline/timecode";

const FLOOR = 10 ** (-48 / 20);

/**
 * Peak height as a fraction of the body. A square root lifts speech well clear of the floor while
 * loud music keeps visible dynamics, which a straight dB scale flattens into a solid band. Below
 * -48 dB is drawn as silence, and 10% headroom keeps full-scale peaks off the body edges.
 */
export function waveformPeak(amplitude: number) {
  const level = Math.min(1, Math.abs(amplitude));
  if (level < FLOOR) return 0;
  return Math.sign(amplitude) * Math.sqrt(level) * 0.9;
}

/** A CSS time in milliseconds. Built CSS is minified, which writes `220ms` as `.22s`. */
export const cssMilliseconds = (time: string) =>
  parseFloat(time) * (time.trim().endsWith("ms") ? 1 : 1000);

/**
 * A CSS `cubic-bezier()` as a function from time to progress, both 0 to 1, so the canvas can move
 * what it draws in step with an element animated by the same easing. Anything else is linear.
 */
export function cssEasing(easing: string): (time: number) => number {
  const points = /^cubic-bezier\(([^)]*)\)$/
    .exec(easing.trim())?.[1]
    ?.split(",")
    .map(Number);
  if (points?.length !== 4 || points.some((value) => !Number.isFinite(value)))
    return (time) => time;
  const [x1, y1, x2, y2] = points as [number, number, number, number];
  const curve = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  return (time) => {
    if (time <= 0) return 0;
    if (time >= 1) return 1;
    // x rises with t on any CSS curve, so halving finds the t at this time.
    let low = 0;
    let high = 1;
    for (let step = 0; step < 24; step++) {
      const mid = (low + high) / 2;
      if (curve(x1, x2, mid) < time) low = mid;
      else high = mid;
    }
    return curve(y1, y2, (low + high) / 2);
  };
}

export { clipName } from "../../shared/timeline/labels";

/** The closest zoom: one frame is this many pixels wide. */
export const MAX_PPF = 32;
/** Ruler labels never sit closer than this many pixels. */
export const LABEL_SPACING = 96;
/** A clip shows its duration once it is this wide. */
export const LENGTH_MIN_WIDTH = 200;
/** Room kept after the last frame when the whole timeline is fitted. */
const FIT_TAIL = 32;

/** Frames the timeline spans: its duration, or the end of a clip that runs past it. */
export const timelineFrames = (timeline: Timeline) =>
  timeline.clips.reduce(
    (end, clip) => Math.max(end, clipEnd(clip)),
    timeline.duration,
  );

/** The widest zoom: every frame visible. An empty timeline shows ten seconds. */
export const fitPpf = (frames: number, width: number, fps: Fps) =>
  Math.min(
    MAX_PPF,
    Math.max(1, width - FIT_TAIL) / (frames || nominal(fps) * 10),
  );

export const clampPpf = (ppf: number, fit: number) =>
  Math.min(MAX_PPF, Math.max(fit, ppf));

/** Zoom slider position, 0 at fit and 1 at the closest zoom, logarithmic between. */
export const zoomToSlider = (ppf: number, fit: number) =>
  fit >= MAX_PPF
    ? 1
    : Math.max(0, Math.min(1, Math.log(ppf / fit) / Math.log(MAX_PPF / fit)));
export const sliderToZoom = (position: number, fit: number) =>
  fit * (MAX_PPF / fit) ** Math.min(1, Math.max(0, position));

/** The frame under a pixel offset from the left edge of the visible lanes. */
export const frameAt = (x: number, scroll: number, ppf: number) =>
  Math.max(0, Math.round((x + scroll) / ppf));

/** The scroll offset that keeps `frame` (fractional) under pixel `x` at a zoom. */
export const scrollForAnchor = (frame: number, x: number, ppf: number) =>
  Math.max(0, frame * ppf - x);

/**
 * The scroll offset the next zoom step starts from. A scroller keeps whole pixels, and at a wide
 * zoom one pixel is many frames, so reading its offset back would move the anchor a little on
 * every step. The exact offset last asked for is kept while the scroller still sits on it; once
 * the scroller is somewhere else (the person scrolled, or it hit its bounds), its offset wins.
 */
export const settledScroll = (exact: number, native: number) =>
  Math.abs(native - exact) < 1 ? exact : native;

/** Playback pages when the playhead is past PAGE_AT of the view and lands it at PAGE_TO. */
const PAGE_AT = 0.9;
const PAGE_TO = 0.1;

/**
 * Where paging should put the playhead, in pixels from the left of the view, or null to leave the
 * view alone. `x` is the playhead's offset in a view `width` wide and `direction` the way
 * playback runs: 1 forward, -1 in reverse. Forward playback pages once the playhead is 90% across
 * and when it is left of the view, as after a loop wraps to the in point; reverse mirrors that.
 * The direction is the transport's, not the last frame change, so a wrap is not read as a turn.
 */
export function pageTarget(
  x: number,
  width: number,
  direction: 1 | -1,
): number | null {
  if (direction > 0)
    return x >= width * PAGE_AT || x < 0 ? width * PAGE_TO : null;
  return x <= width * PAGE_TO || x > width ? width * PAGE_AT : null;
}

export interface TickStep {
  /** Frames between labelled ticks. */
  major: number;
  /** Frames between unlabelled ticks, or null when the major step has no even division. */
  minor: number | null;
}

/**
 * The smallest of 1f, 2f, 5f, 10f, 1s, 2s, 5s, 10s, 30s, 1m, 5m, 10m, 30m, 1h that keeps ruler
 * labels 96px apart. Minor ticks use the largest earlier step that splits it into 4 to 12 parts,
 * or failing that into any whole number of parts.
 */
export function tickStep(ppf: number, fps: Fps): TickStep {
  const base = nominal(fps);
  const steps = [
    1,
    2,
    5,
    10,
    ...[1, 2, 5, 10, 30, 60, 300, 600, 1800, 3600].map(
      (seconds) => seconds * base,
    ),
  ].filter((step, index, all) => index === 0 || step > all[index - 1]!);
  const major =
    steps.find((step) => step * ppf >= LABEL_SPACING) ?? steps.at(-1)!;
  const divisors = steps.filter((step) => step < major && major % step === 0);
  const minor =
    divisors.findLast((step) => major / step >= 4 && major / step <= 12) ??
    divisors.at(-1);
  return { major, minor: minor ?? null };
}

export interface Row {
  track: Track;
  /** `V1`, `A2`: numbered away from the divider. */
  id: string;
  top: number;
  height: number;
}
export interface RowSizes {
  video: number;
  audio: number;
  /** Seam under every lane. */
  seam: number;
  divider: number;
  dropZones?: boolean;
  heights?: Readonly<Record<string, number>>;
}
export interface RowLayout {
  rows: Row[];
  newRows: Record<Track["kind"], Row>;
  dividerTop: number;
  height: number;
}

/**
 * Video tracks stack upward from the divider and audio tracks downward. There is always at least
 * one of each: a kind with no track yet shows an empty one on the first free index, so an empty
 * timeline is V1 over A1.
 */
export function trackRows(
  tracks: readonly Track[],
  sizes: RowSizes,
): RowLayout {
  const all = shownTracks(tracks);
  const video = all.filter((track) => track.kind === "video");
  const audio = all.filter((track) => track.kind === "audio");
  const nextIndex = nextTrackIndex(all);
  const videoHeight = sizes.heights?.[nextIndex] ?? sizes.video;
  const audioHeight = sizes.heights?.[nextIndex] ?? sizes.audio;
  const rows: Row[] = [];
  // The upper drop target overlays the ruler. Its preview occupies the future top row.
  let top = 0;
  for (const [index, track] of video.toReversed().entries()) {
    rows.push({
      track,
      id: `V${video.length - index}`,
      top,
      height: sizes.heights?.[track.index] ?? sizes.video,
    });
    top += rows.at(-1)!.height + sizes.seam;
  }
  const dividerTop = top;
  top += sizes.divider;
  for (const [index, track] of audio.entries()) {
    rows.push({
      track,
      id: `A${index + 1}`,
      top,
      height: sizes.heights?.[track.index] ?? sizes.audio,
    });
    top += rows.at(-1)!.height + sizes.seam;
  }
  return {
    rows,
    newRows: {
      video: {
        track: newTrack(nextIndex, "video"),
        id: "New video track",
        top: 0,
        height: videoHeight,
      },
      audio: {
        track: newTrack(nextIndex, "audio"),
        id: "New audio track",
        top,
        height: audioHeight,
      },
    },
    dividerTop,
    height: top + (sizes.dropZones ? audioHeight + sizes.seam : 0),
  };
}

/** Rows that touch a vertical span. */
export const rowsBetween = (
  rows: readonly Row[],
  top: number,
  bottom: number,
) => rows.filter((row) => row.top < bottom && row.top + row.height > top);

export interface FrameRange {
  from: number;
  to: number;
}

/**
 * The frame range to keep mounted. The mounted range is kept while it covers what is visible and
 * is at most four times as long, so scrolling and zooming re-render only when they leave it.
 */
export function mountedRange(
  mounted: FrameRange | null,
  visible: FrameRange,
): FrameRange {
  const span = visible.to - visible.from;
  if (
    mounted &&
    mounted.from <= visible.from &&
    mounted.to >= visible.to &&
    mounted.to - mounted.from <= span * 4
  )
    return mounted;
  return {
    from: Math.max(0, Math.floor(visible.from - span / 2)),
    to: Math.ceil(visible.to + span / 2),
  };
}

export interface TrackClips {
  clips: readonly Clip[];
  /** `ends[i]` is the latest end among `clips[0..i]`, so overlapping clips are still found. */
  ends: readonly number[];
}

/** Each track's clips in start order, as the timeline projection already sorts them. */
export function clipsByTrack(clips: readonly Clip[]): Map<number, TrackClips> {
  const tracks = new Map<number, { clips: Clip[]; ends: number[] }>();
  for (const clip of clips) {
    const track = tracks.get(clip.track) ?? { clips: [], ends: [] };
    tracks.set(clip.track, track);
    track.clips.push(clip);
    track.ends.push(Math.max(track.ends.at(-1) ?? 0, clipEnd(clip)));
  }
  return tracks;
}

function firstIndex(length: number, passes: (index: number) => boolean) {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (passes(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The clips of one track that touch `[from, to)`. */
export function clipsInRange(
  { clips, ends }: TrackClips,
  { from, to }: FrameRange,
): Clip[] {
  const first = firstIndex(clips.length, (index) => ends[index]! > from);
  const last = firstIndex(clips.length, (index) => clips[index]!.start >= to);
  return clips.slice(first, last).filter((clip) => clipEnd(clip) > from);
}

/** Seconds of source media under one pixel of a clip. */
export const sourceSecondsPerPixel = (
  ppf: number,
  fps: Fps,
  playbackRate: number,
) => (fps.den / fps.num / ppf) * playbackRate;

/**
 * The waveform level to draw at a zoom: the coarsest whose buckets are no longer than one pixel,
 * so every pixel column has a minimum and maximum of its own. The finest level when even its
 * buckets are longer than a pixel.
 */
export const peakLevel = (secondsPerPixel: number) =>
  Math.max(
    0,
    peakLevels.findLastIndex(
      (samples) => samples / mediaSettings.peakSampleRate <= secondsPerPixel,
    ),
  );

/**
 * Seconds between the source frames a filmstrip shows. The sprite holds one frame per
 * `filmstripInterval`; when a tile covers less than that, the interval halves until neighbouring
 * tiles get frames of their own. Zooms that share a step share their frames.
 */
export function frameStep(tileSeconds: number): number {
  let step: number = mediaSettings.filmstripInterval;
  while (step > tileSeconds) step /= 2;
  return step;
}

export interface FilmTile {
  /** Pixels from the clip's left edge to the tile's. */
  x: number;
  /** Source seconds of the frame the tile shows. */
  time: number;
}

/**
 * The filmstrip tiles of a clip that touch `[from, to)`, measured in pixels from the clip's left
 * edge. Tiles are `width` wide and the first starts on the clip's first frame, so no tile moves
 * when the view scrolls. Each shows the source frame under its left edge, held back to a whole
 * number of `step`s after the clip's media start: the first tile is exactly the clip's first
 * frame, and a clip asks for the same frames at every zoom that shares a step.
 */
export function filmTiles(
  clip: Pick<Clip, "mediaStart" | "playbackRate">,
  width: number,
  secondsPerPixel: number,
  step: number,
  from: number,
  to: number,
): FilmTile[] {
  const first = Math.max(0, Math.floor(from / width));
  return Array.from(
    { length: Math.max(0, Math.ceil(to / width) - first) },
    (_, index) => {
      const x = (first + index) * width;
      // An offset a hair under a step, from the division, belongs to that step.
      const steps = Math.floor((x * secondsPerPixel) / step + 1e-6);
      return { x, time: (clip.mediaStart ?? 0) + steps * step };
    },
  );
}

/** Frames of the labelled ruler ticks that fall in a range. */
export function majorTicks({ from, to }: FrameRange, major: number): number[] {
  const first = Math.floor(from / major) * major;
  return Array.from(
    { length: Math.max(0, Math.ceil((to - first) / major)) },
    (_, index) => first + index * major,
  );
}
