import { MEDIA_ELEMENT_LEAD_SECONDS } from "@hyperframes/core/runtime/media-clock";
import {
  sourceTimeAt,
  timeAtSourceTime,
  type RateSpec,
} from "@hyperframes/core/speed-ramp";
import type { Fps } from "./schema.ts";

/** Seconds as a reduced fraction with a positive denominator. */
export type ExactTime = Readonly<{ n: bigint; d: bigint }>;

const MICROS = 1_000_000n;
export const AUDIO_SAMPLE_RATE = 48_000;
const SAMPLES = BigInt(AUDIO_SAMPLE_RATE);
const FRAME_TOLERANCE = 1000n;
const abs = (n: bigint) => (n < 0n ? -n : n);

export function fraction(n: bigint, d = 1n): ExactTime {
  if (d === 0n) throw new RangeError("A time denominator cannot be zero.");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = d;
  let b = abs(n) % d;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return { n: n / a, d: d / a };
}

const ZERO = fraction(0n);
const ONE = fraction(1n);
export const add = (a: ExactTime, b: ExactTime) =>
  fraction(a.n * b.d + b.n * a.d, a.d * b.d);
export const subtract = (a: ExactTime, b: ExactTime) =>
  fraction(a.n * b.d - b.n * a.d, a.d * b.d);
const multiply = (a: ExactTime, b: ExactTime) => fraction(a.n * b.n, a.d * b.d);
const difference = (a: ExactTime, b: ExactTime) => a.n * b.d - b.n * a.d;
const min = (a: ExactTime, b: ExactTime) => (difference(a, b) <= 0n ? a : b);
const max = (a: ExactTime, b: ExactTime) => (difference(a, b) >= 0n ? a : b);

function floorDiv(n: bigint, d: bigint) {
  const whole = n / d;
  return n < 0n && n % d !== 0n ? whole - 1n : whole;
}

const halfUp = (n: bigint, d: bigint) => floorDiv(2n * n + d, 2n * d);
export const frames = (count: number | bigint, fps: Fps) =>
  fraction(BigInt(count) * BigInt(fps.den), BigInt(fps.num));
export const micros = (count: number | bigint) =>
  fraction(BigInt(count), MICROS);
export const secondsOf = (time: ExactTime) => Number(time.n) / Number(time.d);

/** Read validated decimal seconds, including compiler-generated float spellings. */
export const attrMicros = (seconds: string | number) =>
  BigInt(Math.round(Number(seconds) * Number(MICROS)));

/** Snap an authored position or length only on the grid of the file it came from. */
export function decodeLocal(us: bigint, fps: Fps): ExactTime {
  const n = us * BigInt(fps.num);
  const d = BigInt(fps.den) * MICROS;
  const frame = halfUp(n, d);
  const offset = abs(n - frame * d);
  return offset <= BigInt(fps.num) || offset * FRAME_TOLERANCE <= d
    ? frames(frame, fps)
    : micros(us);
}

/** Move an edited edge to the nearest frame, with ties going to the later frame. */
export const nearestFrame = (position: ExactTime, fps: Fps) =>
  halfUp(position.n * BigInt(fps.num), position.d * BigInt(fps.den));

export const sampleOf = (position: ExactTime) =>
  halfUp(position.n * SAMPLES, position.d);

/** On the output grid, snapping decides visibility without changing the position. */
export function firstFrame(position: ExactTime, fps: Fps): bigint {
  const n = position.n * BigInt(fps.num);
  const d = position.d * BigInt(fps.den);
  const nearest = halfUp(n, d);
  return abs(n - nearest * d) * FRAME_TOLERANCE <= d
    ? nearest
    : -floorDiv(-n, d);
}

export type Start = { us: bigint } | { ref: string; offsetUs: bigint };
type AuthoredWindow = {
  id: string;
  start: Start;
  durationUs?: bigint;
  endUs?: bigint;
  naturalSeconds?: number;
};
type Host = AuthoredWindow & {
  kind: "host";
  mediaStartUs?: bigint;
  child: Composition;
};
type Visual = AuthoredWindow & { kind: "text" | "image" };
type Media = AuthoredWindow & {
  kind: "media";
  src: string;
  stored: StoredSource;
  curve: Curve;
  loop?: boolean;
  global?: boolean;
  /** Plays no sound: muted, or a video marked as having no audio. */
  silent?: boolean;
};
export type Composition = {
  fps: Fps;
  elements: readonly (Host | Visual | Media)[];
};
type Window = { start: ExactTime; end: ExactTime };
type Placement = {
  path: string;
  ownFps: Fps;
  origin: ExactTime;
  local: Window;
  edge: Window;
  played: Window;
};
export type PlacedMedia = Pick<
  Media,
  "id" | "src" | "stored" | "curve" | "loop"
> &
  Omit<Placement, "played"> & { played?: Window };
export type PlacedElement = (Media | Visual) & Placement;

/** Where an element that starts at `start` ends on its own grid: `data-duration` before `data-end`. */
export function windowEnd(
  el: Omit<AuthoredWindow, "id" | "start">,
  start: ExactTime,
  fps: Fps,
) {
  if (el.durationUs !== undefined && el.durationUs >= 0n)
    return add(start, decodeLocal(el.durationUs, fps));
  if (el.endUs !== undefined) {
    const end = decodeLocal(el.endUs, fps);
    return difference(end, start) > 0n ? end : null;
  }
  if (el.naturalSeconds !== undefined && el.naturalSeconds > 0)
    return add(start, decodeLocal(attrMicros(el.naturalSeconds), fps));
  return null;
}

export function localWindows<Element extends AuthoredWindow>({
  fps,
  elements,
}: {
  fps: Fps;
  elements: readonly Element[];
}) {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const starts = new Map<string, ExactTime>();
  const visiting = new Set<string>();

  function startOf(el: AuthoredWindow): ExactTime {
    const known = starts.get(el.id);
    if (known) return known;
    if (visiting.has(el.id)) return ZERO;
    visiting.add(el.id);

    let start = ZERO;
    if ("us" in el.start) {
      start = max(ZERO, decodeLocal(el.start.us, fps));
    } else {
      const target = byId.get(el.start.ref);
      if (target) {
        const targetStart = startOf(target);
        const base = windowEnd(target, targetStart, fps) ?? targetStart;
        start = max(ZERO, add(base, decodeLocal(el.start.offsetUs, fps)));
      }
    }

    visiting.delete(el.id);
    starts.set(el.id, start);
    return start;
  }

  return elements.map((el) => {
    const start = startOf(el);
    return { el, start, end: windowEnd(el, start, fps) };
  });
}

/** Place decoded timing through the composition tree, keeping the host's played window. */
export function place(root: Composition): PlacedElement[] {
  const placed: PlacedElement[] = [];

  function walk(
    comp: Composition,
    parentPath: string,
    parentOrigin: ExactTime,
    limit: ExactTime | null,
    trimStart: ExactTime | null,
  ) {
    for (const { el, start, end } of localWindows(comp)) {
      const path = `${parentPath}/${el.id}`;
      if (el.kind === "host") {
        const inPoint = decodeLocal(el.mediaStartUs ?? 0n, comp.fps);
        const hostStart = add(parentOrigin, start);
        const hostEnd = end === null ? limit : add(parentOrigin, end);
        walk(
          el.child,
          path,
          subtract(hostStart, inPoint),
          limit && hostEnd ? min(limit, hostEnd) : hostEnd,
          inPoint.n > 0n &&
            (!trimStart || difference(hostStart, trimStart) > 0n)
            ? hostStart
            : trimStart,
        );
        continue;
      }
      if (end === null) continue;

      const origin = el.kind === "media" && el.global ? ZERO : parentOrigin;
      const absoluteStart = add(origin, start);
      if (limit && difference(absoluteStart, limit) >= 0n) continue;
      const absoluteEnd = add(origin, end);
      const edge = {
        start: absoluteStart,
        end: limit ? min(absoluteEnd, limit) : absoluteEnd,
      };
      const playedStart = trimStart ? max(edge.start, trimStart) : edge.start;
      if (
        difference(playedStart, edge.end) >= 0n &&
        difference(edge.end, edge.start) > 0n
      )
        continue;

      placed.push({
        ...el,
        path,
        ownFps: comp.fps,
        origin,
        local: { start, end },
        edge,
        played: { start: playedStart, end: max(playedStart, edge.end) },
      });
    }
  }

  walk(root, "", ZERO, null, null);
  return placed;
}

/** A decimal constant rate, or the original ramp points. */
export type Curve = string | RateSpec;
type Ramp = Exclude<RateSpec, number>;
/** Curve-zero frame, its remainder in microseconds, and source microseconds at curve zero. */
export type SourceMap = { c: number; tau: number; zero: number };
/** The stored in-point and optional ramp offset, both in whole microseconds. */
export type StoredSource = { mediaStart: number; offset?: number };

export function decimalFraction(value: string | number): ExactTime {
  const [decimal = "", exponent] = String(value)
    .trim()
    .toLowerCase()
    .split("e");
  const [whole = "", digits = ""] = decimal.split(".");
  const scale = digits.length - Number(exponent ?? 0);
  const units = BigInt(whole + digits);
  return scale > 0
    ? fraction(units, 10n ** BigInt(scale))
    : fraction(units * 10n ** BigInt(-scale));
}

// The period can sit just below an integer even when a floating-point product
// rounds up to it. The inclusive remainder range depends on this floor.
function sourcePeriodFloor(curve: Curve, fps: Fps) {
  const rate = typeof curve === "object" ? ONE : decimalFraction(curve);
  const period =
    (rate.n * BigInt(fps.den) * MICROS) / (rate.d * BigInt(fps.num));
  if (period < 3n)
    throw new RangeError(
      "A source map requires at least three microseconds per frame.",
    );
  return Number(period);
}

/** Scale a source edge around the group start, rounding exact half frames up. */
export function retimedFrames(
  offset: number,
  before: number,
  after: number,
  phase: number,
  span?: { frames: number; rate: number },
) {
  const oldRate = decimalFraction(before);
  const newRate = decimalFraction(after);
  const head = add(
    fraction(BigInt(offset) * oldRate.n, oldRate.d),
    decimalFraction(phase),
  );
  const width = span && decimalFraction(span.rate);
  const edge =
    span && width
      ? add(head, fraction(BigInt(span.frames) * width.n, width.d))
      : head;
  return Number(halfUp(edge.n * newRate.d, edge.d * newRate.n));
}

function microsOf(time: ExactTime) {
  const numerator = time.n * MICROS;
  return (
    Number(numerator / time.d) + Number(numerator % time.d) / Number(time.d)
  );
}

const since = (start: ExactTime, c: number, fps: Fps) =>
  microsOf(subtract(start, frames(c, fps)));

// Keep the zero on a decoded map identical on either side of a frame.
const roundMicros = (us: number) => Math.round(us) + 0;
const rampMicros = (curve: Ramp, elapsedUs: number) =>
  roundMicros(sourceTimeAt(curve, elapsedUs / Number(MICROS)) * Number(MICROS));

export function encode(
  map: SourceMap,
  curve: Curve,
  start: ExactTime,
  fps: Fps,
): StoredSource {
  sourcePeriodFloor(curve, fps);
  const elapsed = since(start, map.c, fps);
  if (typeof curve !== "object")
    return { mediaStart: map.zero + roundMicros(Number(curve) * elapsed) };
  return {
    offset: roundMicros(elapsed) - map.tau,
    mediaStart: map.zero + rampMicros(curve, elapsed - map.tau),
  };
}

/** Find the frame whose encoded remainder fits, or settle a foreign value on its nearest edge. */
export function decode(
  stored: StoredSource,
  curve: Curve,
  start: ExactTime,
  fps: Fps,
): SourceMap {
  const ramp = typeof curve === "object";
  const frameUs = (fps.den * Number(MICROS)) / fps.num;
  const rate = ramp ? 1 : Number(curve);
  const period = rate * frameUs;
  const count = sourcePeriodFloor(curve, fps) - 1;
  const lo = -Math.floor(count / 2);
  const hi = lo + count - 1;
  const offset = stored.offset ?? 0;
  const startUs = microsOf(start);
  const guess =
    Math.round(
      ramp
        ? (startUs - offset) / frameUs
        : (rate * startUs - stored.mediaStart) / period,
    ) + 0;
  let c = guess;
  let remainder = 0;
  let miss = Infinity;

  for (const candidate of [guess, guess - 1, guess + 1]) {
    const elapsed = since(start, candidate, fps);
    const value = ramp
      ? roundMicros(elapsed) - offset
      : stored.mediaStart - roundMicros(rate * elapsed);
    const clamped = Math.min(hi, Math.max(lo, value));
    const distance = Math.abs(value - clamped);
    if (distance < miss) {
      c = candidate;
      remainder = clamped;
      miss = distance;
    }
    if (distance === 0) break;
  }

  if (!ramp) return { c, tau: 0, zero: remainder };
  return {
    c,
    tau: remainder,
    zero:
      stored.mediaStart - rampMicros(curve, since(start, c, fps) - remainder),
  };
}

/** Express the same source line on another grid before encoding any of its edges. */
export function regridSourceMap(
  map: SourceMap,
  curve: Curve,
  from: Fps,
  to: Fps,
): SourceMap {
  const oldAnchor = frames(map.c, from);
  const anchor = frames(nearestFrame(oldAnchor, to), to);
  const stored = encode(map, curve, anchor, from);
  const next = decode(stored, curve, anchor, to);
  if (typeof curve === "object") return { ...next, zero: map.zero };
  if (Number(curve) !== 1) return next;

  // A sub-microsecond change in the intercept can cross a 48 kHz half-sample.
  // Choose the closest writable value on the original sample's side of the tie.
  const sample = sampleOf(subtract(micros(map.zero), oldAnchor));
  const sampleAt = ({ zero, c }: SourceMap) =>
    sampleOf(subtract(micros(zero), frames(c, to)));
  const shifted = sampleAt(next);
  if (sample === shifted) return next;
  const direction = sample > shifted ? 1 : -1;
  for (const by of [1, 2]) {
    const adjusted = decode(
      { mediaStart: stored.mediaStart + direction * by },
      curve,
      anchor,
      to,
    );
    if (sampleAt(adjusted) === sample) return adjusted;
  }
  throw new Error(
    "Cannot represent the source audio sample on the new frame grid.",
  );
}

export type SourceTime = ExactTime | number;
/** Seconds of a source time, for a consumer that hands it to FFmpeg or the browser. */
export const sourceSeconds = (time: SourceTime) =>
  typeof time === "number" ? time : secondsOf(time);
type Loop =
  | { kind: "exact"; start: ExactTime; length: ExactTime | null }
  | { kind: "ramp"; start: number; length: number | null };
type Line =
  | { kind: "exact"; rate: ExactTime; curveZero: ExactTime }
  | { kind: "ramp"; rate: Ramp; curveZero: ExactTime };
type IndexWindow = { start: bigint; end: bigint };

export type Piece = Placement &
  SourceMap & {
    id: string;
    src: string;
    curve: Curve;
    frames: IndexWindow;
    samples: IndexWindow;
    loop: Loop | null;
    line: Line;
  };

function lineAt(line: Line, zero: number, position: ExactTime): SourceTime {
  const elapsed = subtract(position, line.curveZero);
  if (line.kind === "exact")
    return add(micros(zero), multiply(line.rate, elapsed));
  return zero / Number(MICROS) + sourceTimeAt(line.rate, secondsOf(elapsed));
}

export function resolvePiece(
  media: PlacedMedia,
  rootFps: Fps,
  playableEnd?: ExactTime,
): Piece {
  const {
    id,
    src,
    path,
    ownFps,
    origin,
    edge,
    local,
    played = edge,
    curve,
  } = media;
  const map = decode(media.stored, curve, local.start, ownFps);
  // A trimmed mount restarts a loop at the played edge with its original in-point.
  const anchor = media.loop ? played.start : edge.start;
  const curveZero = add(
    subtract(anchor, local.start),
    add(frames(map.c, ownFps), micros(map.tau)),
  );
  const line: Line =
    typeof curve === "object"
      ? { kind: "ramp", rate: curve, curveZero }
      : { kind: "exact", rate: decimalFraction(curve), curveZero };
  let loop: Loop | null = null;
  if (media.loop) {
    const start = lineAt(line, map.zero, anchor);
    if (typeof start === "number") {
      const length =
        playableEnd === undefined ? 0 : secondsOf(playableEnd) - start;
      loop = { kind: "ramp", start, length: length > 0 ? length : null };
    } else {
      const length =
        playableEnd === undefined ? ZERO : subtract(playableEnd, start);
      loop = { kind: "exact", start, length: length.n > 0n ? length : null };
    }
  }

  return {
    id,
    src,
    path,
    ownFps,
    origin,
    local,
    edge,
    played,
    ...map,
    curve,
    line,
    loop,
    frames: {
      start: firstFrame(played.start, rootFps),
      end: firstFrame(played.end, rootFps),
    },
    samples: { start: sampleOf(played.start), end: sampleOf(played.end) },
  };
}

function wrapExact(time: ExactTime, start: ExactTime, length: ExactTime) {
  const elapsed = subtract(time, start);
  if (difference(elapsed, length) < 0n) return time;
  const numerator = elapsed.n * length.d;
  const divisor = elapsed.d * length.n;
  return add(start, fraction(numerator % divisor, elapsed.d * length.d));
}

/** The floating-point form of the source loop, in seconds or samples. */
export function wrapSource(time: number, start: number, length: number) {
  const elapsed = time - start;
  return elapsed >= length ? start + (elapsed % length) : time;
}

function wrapRamp(loop: Loop | null, time: number) {
  return loop?.kind === "ramp" && loop.length !== null
    ? wrapSource(time, loop.start, loop.length)
    : time;
}

export function sourceAt(piece: Piece, position: ExactTime): SourceTime {
  const time = lineAt(piece.line, piece.zero, position);
  const { loop } = piece;
  if (loop?.length == null) return time;
  if (loop.kind === "exact" && typeof time !== "number")
    return wrapExact(time, loop.start, loop.length);
  return typeof time === "number" ? wrapRamp(loop, time) : time;
}

/**
 * A ramp's source seconds at `count` positions `step` seconds apart from `from`, on the integral
 * `sourceAt` reads. Exact arithmetic runs once, so a long table costs one integral per entry.
 */
export function rampSourceTimes(
  piece: Piece,
  from: ExactTime,
  step: number,
  count: number,
) {
  if (piece.line.kind !== "ramp")
    throw new TypeError("Only a ramp has a table of source times.");
  const { rate, curveZero } = piece.line;
  const elapsed = secondsOf(subtract(from, curveZero));
  const zero = piece.zero / Number(MICROS);
  return Float64Array.from({ length: count }, (_, index) =>
    wrapRamp(piece.loop, zero + sourceTimeAt(rate, elapsed + index * step)),
  );
}

/** Timeline position at a source time on the unwrapped, monotone line. */
export function positionAtSource(piece: Piece, source: SourceTime): ExactTime {
  const { line } = piece;
  if (typeof source === "number") {
    const elapsed = source - piece.zero / Number(MICROS);
    return add(
      line.curveZero,
      decimalFraction(
        line.kind === "exact"
          ? (elapsed * Number(line.rate.d)) / Number(line.rate.n)
          : timeAtSourceTime(line.rate, elapsed),
      ),
    );
  }
  const elapsed = subtract(source, micros(piece.zero));
  const time =
    line.kind === "exact"
      ? fraction(elapsed.n * line.rate.d, elapsed.d * line.rate.n)
      : decimalFraction(timeAtSourceTime(line.rate, secondsOf(elapsed)));
  return add(line.curveZero, time);
}

/** Source sample at absolute output sample zero on the unwrapped 1× line. */
export function sourceSampleOffset(piece: Piece): bigint | null {
  if (piece.line.kind !== "exact" || piece.line.rate.n !== piece.line.rate.d)
    return null;
  return sampleOf(subtract(micros(piece.zero), piece.line.curveZero));
}

/**
 * The source a piece's sound reads from its first output sample to its end, as the mixer reads
 * it: whole source samples on a 1× line, otherwise the line at those samples.
 */
export function soundSource(piece: Piece) {
  const offset = sourceSampleOffset(piece);
  const at = (sample: bigint) =>
    offset === null
      ? sourceAt(piece, fraction(sample, SAMPLES))
      : fraction(sample + offset, SAMPLES);
  return { start: at(piece.samples.start), end: at(piece.samples.end) };
}

/**
 * A source's presented pictures: a constant-rate grid, or each picture's start as a whole
 * number of `tick`s after `offset`, in presentation order. Integers keep a long recording's
 * index small and its lookups cheap.
 */
export type PictureIndex =
  | { origin: ExactTime; rate: Fps; count: bigint }
  | { tick: ExactTime; offset: ExactTime; ticks: ArrayLike<number> };

/** The start of picture `ordinal` of a variable-rate index. */
export const pictureStart = (
  index: Extract<PictureIndex, { ticks: unknown }>,
  ordinal: number,
) =>
  add(
    index.offset,
    fraction(BigInt(index.ticks[ordinal]!) * index.tick.n, index.tick.d),
  );

const PICTURE_LEAD_US = attrMicros(MEDIA_ELEMENT_LEAD_SECONDS);
// The pinned extractor treats a stream starting 1 second away (within 1 µs) as hidden.
const HIDDEN_LEAD_US = MICROS - 1n;

/**
 * The frame of an `fps` grid from zero that shows a source time by the picture rule, such as the
 * source viewer's frame for the picture export shows.
 */
export const frameShowing = (time: SourceTime, fps: Fps) =>
  Number(pictureAt({ origin: ZERO, rate: fps, count: 2n ** 53n }, time) ?? 0n);

/** Last presented picture at or before the source time plus the runtime's picture lead. */
export function pictureAt(
  index: PictureIndex,
  time: SourceTime,
): bigint | null {
  if ("ticks" in index && !index.ticks.length) return null;
  const origin = "ticks" in index ? pictureStart(index, 0) : index.origin;
  const elapsed =
    typeof time === "number"
      ? time - secondsOf(origin)
      : subtract(time, origin);
  if (
    typeof elapsed === "number"
      ? elapsed <= -Number(HIDDEN_LEAD_US) / Number(MICROS)
      : elapsed.n * MICROS <= -HIDDEN_LEAD_US * elapsed.d
  )
    return null;

  if (!("ticks" in index)) {
    if (index.count === 0n) return null;
    const { rate } = index;
    const ordinal =
      typeof elapsed === "number"
        ? BigInt(
            Math.floor(
              ((elapsed + MEDIA_ELEMENT_LEAD_SECONDS) * rate.num) / rate.den,
            ),
          )
        : floorDiv(
            (elapsed.n * MICROS + PICTURE_LEAD_US * elapsed.d) *
              BigInt(rate.num),
            elapsed.d * MICROS * BigInt(rate.den),
          );
    return ordinal < 0n
      ? 0n
      : ordinal >= index.count
        ? index.count - 1n
        : ordinal;
  }

  // The last picture starting at or before the time plus the lead, found among integers:
  // `bound` is the latest tick count at or before it.
  const { tick, offset, ticks } = index;
  let bound: number;
  if (typeof time === "number")
    bound =
      (time + MEDIA_ELEMENT_LEAD_SECONDS - secondsOf(offset)) / secondsOf(tick);
  else {
    const since = subtract(add(time, micros(PICTURE_LEAD_US)), offset);
    bound = Number(floorDiv(since.n * tick.d, since.d * tick.n));
  }
  let low = 0;
  let high = ticks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ticks[middle]! <= bound) low = middle + 1;
    else high = middle;
  }
  return BigInt(Math.max(0, low - 1));
}
