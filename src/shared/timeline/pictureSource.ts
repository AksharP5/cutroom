import { MEDIA_ELEMENT_LEAD_SECONDS } from "@hyperframes/core/runtime/media-clock";
import {
  fraction,
  frames,
  micros,
  pictureAt,
  resolvePiece,
  secondsOf,
  sourceAt,
} from "./piece.ts";
import type {
  Curve,
  ExactTime,
  Piece,
  PictureIndex,
  PlacedElement,
  StoredSource,
  SourceTime,
} from "./piece.ts";
import type { Fps } from "./schema.ts";

/**
 * The viewer's picture facts as JSON: exact times as `"n/d"`, a constant-rate file as its grid,
 * any other as runs of its pictures' tick counts (see `encodeTicks`). Self-contained, because
 * the preview bridge runs a bundle of this module.
 */
type Text = string;
type TextWindow = { start: Text; end: Text };

type TickRuns = { first: number; step: Text; runs: number[] };
export type PictureSourceWire = {
  index:
    | { origin: Text; rate: Fps; count: Text }
    | { tick: Text; offset: Text; ticks: TickRuns };
  end: Text | null;
};
/** A source file's picture index and the playable end its loops wrap at. */
export type PictureSource = { index: PictureIndex; end: ExactTime | null };

/**
 * One video element as the resolver placed it in the served document. Most videos sit in the
 * root composition and play whole, so the fields that would repeat what is implied are left out:
 * `ownFps` is the table's, `origin` is zero, and `local` and `played` are `edge`.
 */
export type PictureSlot = {
  ownFps?: Fps;
  origin?: Text;
  local?: TextWindow;
  edge: TextWindow;
  played?: TextWindow;
  stored: StoredSource;
  curve: Curve;
  loop?: boolean;
};
/** Every placed video of a document, by its render id. */
export type PictureTable = { fps: Fps; videos: Record<string, PictureSlot> };

export const timeText = (time: ExactTime): Text => `${time.n}/${time.d}`;

function readTime(value: unknown): ExactTime {
  const match =
    typeof value === "string" ? /^(-?\d+)\/(\d+)$/.exec(value) : null;
  if (!match || match[2] === "0") throw new TypeError("Invalid exact time.");
  return fraction(BigInt(match[1]!), BigInt(match[2]!));
}

const textWindow = (window: { start: ExactTime; end: ExactTime }) => ({
  start: timeText(window.start),
  end: timeText(window.end),
});

/** The table the viewer selects pictures from, from `placedMedia`'s placement. */
export function pictureTable(
  placed: ReadonlyMap<string, PlacedElement>,
  fps: Fps,
): PictureTable {
  const videos: PictureTable["videos"] = {};
  for (const [id, element] of placed) {
    if (element.kind !== "media" || !id.startsWith("video:")) continue;
    const edge = textWindow(element.edge);
    const local = textWindow(element.local);
    const played = textWindow(element.played);
    const same = (window: TextWindow) =>
      window.start === edge.start && window.end === edge.end;
    videos[id.slice("video:".length)] = {
      ...((element.ownFps.num !== fps.num ||
        element.ownFps.den !== fps.den) && { ownFps: element.ownFps }),
      ...(element.origin.n !== 0n && { origin: timeText(element.origin) }),
      ...(!same(local) && { local }),
      edge,
      ...(!same(played) && { played }),
      stored: element.stored,
      curve: element.curve,
      ...(element.loop && { loop: true }),
    };
  }
  return { fps, videos };
}

const roundDiv = (n: bigint, d: bigint) => {
  const twice = 2n * n + d;
  const whole = twice / (2n * d);
  return twice < 0n && twice % (2n * d) !== 0n ? whole - 1n : whole;
};

/**
 * Tick counts as runs on a nominal grid of `step` ticks per picture: each picture is its slot
 * on the grid plus a residual, and equal (slot step, residual) pairs repeat as one run. A
 * recording that drops a picture now and then, on a millisecond clock or any other, takes a few
 * numbers per drop. Any list of ticks survives exactly; a file with no grid takes a step of one
 * tick and runs of equal gaps.
 */
export function encodeTicks(
  ticks: ArrayLike<number>,
  step: ExactTime,
): TickRuns {
  const first = ticks[0] ?? 0;
  const runs: number[] = [];
  let slot = 0n;
  for (let k = 1; k < ticks.length; k++) {
    const since = BigInt(ticks[k]! - first);
    const next = roundDiv(since * step.d, step.n);
    const residual = Number(since - roundDiv(next * step.n, step.d));
    const by = Number(next - slot);
    slot = next;
    const last = runs.length - 3;
    if (last >= 0 && runs[last + 1] === by && runs[last + 2] === residual)
      runs[last]!++;
    else runs.push(1, by, residual);
  }
  return { first, step: timeText(step), runs };
}

function decodeTicks({ first, step: stepText, runs }: TickRuns) {
  const step = readTime(stepText);
  let count = 1;
  for (let i = 0; i < runs.length; i += 3) count += runs[i]!;
  const ticks = new Float64Array(count);
  ticks[0] = first;
  let slot = 0n;
  let k = 1;
  for (let i = 0; i < runs.length; i += 3) {
    const by = BigInt(runs[i + 1]!);
    const residual = runs[i + 2]!;
    for (let n = runs[i]!; n > 0; n--) {
      slot += by;
      ticks[k++] = first + Number(roundDiv(slot * step.n, step.d)) + residual;
    }
  }
  return ticks;
}

/** Null for anything that is not a picture source, such as a file with no video. */
export function readPictureSource(body: unknown): PictureSource | null {
  if (!body || typeof body !== "object" || !("index" in body)) return null;
  const { index } = body;
  const end = "end" in body && body.end !== null ? readTime(body.end) : null;
  if (!index || typeof index !== "object") return null;
  if ("origin" in index && "rate" in index && "count" in index) {
    const { rate, count } = index;
    if (
      !rate ||
      typeof rate !== "object" ||
      !("num" in rate) ||
      !("den" in rate) ||
      !Number.isSafeInteger(rate.num) ||
      !Number.isSafeInteger(rate.den) ||
      Number(rate.num) <= 0 ||
      Number(rate.den) <= 0 ||
      typeof count !== "string" ||
      !/^\d+$/.test(count)
    )
      return null;
    return {
      index: {
        origin: readTime(index.origin),
        rate: { num: Number(rate.num), den: Number(rate.den) },
        count: BigInt(count),
      },
      end,
    };
  }
  if (!("tick" in index && "offset" in index && "ticks" in index)) return null;
  const runs: unknown = index.ticks;
  if (
    !runs ||
    typeof runs !== "object" ||
    !("first" in runs) ||
    !Number.isSafeInteger(runs.first) ||
    !("step" in runs) ||
    !("runs" in runs) ||
    !Array.isArray(runs.runs) ||
    runs.runs.length % 3 !== 0 ||
    !runs.runs.every((value) => Number.isSafeInteger(value))
  )
    return null;
  const ticks = decodeTicks({
    first: Number(runs.first),
    step: String(runs.step),
    runs: runs.runs,
  });
  if (!ticks.every((tick, i) => !i || tick >= ticks[i - 1]!)) return null;
  return {
    index: {
      tick: readTime(index.tick),
      offset: readTime(index.offset),
      ticks,
    },
    end,
  };
}

const isFps = (value: unknown): value is Fps =>
  !!value &&
  typeof value === "object" &&
  "num" in value &&
  "den" in value &&
  Number.isSafeInteger(value.num) &&
  Number.isSafeInteger(value.den) &&
  Number(value.num) > 0 &&
  Number(value.den) > 0;

const isWindow = (value: unknown): value is TextWindow =>
  !!value &&
  typeof value === "object" &&
  "start" in value &&
  "end" in value &&
  typeof value.start === "string" &&
  typeof value.end === "string";

function isSlot(value: unknown): value is PictureSlot {
  if (!value || typeof value !== "object") return false;
  const slot: Partial<Record<keyof PictureSlot, unknown>> = value;
  const { stored, curve } = slot;
  return (
    (slot.ownFps === undefined || isFps(slot.ownFps)) &&
    (slot.origin === undefined || typeof slot.origin === "string") &&
    (slot.local === undefined || isWindow(slot.local)) &&
    isWindow(slot.edge) &&
    (slot.played === undefined || isWindow(slot.played)) &&
    !!stored &&
    typeof stored === "object" &&
    "mediaStart" in stored &&
    Number.isFinite(stored.mediaStart) &&
    (!("offset" in stored) || Number.isFinite(stored.offset)) &&
    (typeof curve === "string" ||
      (typeof curve === "number" && Number.isFinite(curve)) ||
      (!!curve && typeof curve === "object" && "points" in curve)) &&
    (slot.loop === undefined || typeof slot.loop === "boolean")
  );
}

/** A table sent across the preview's message boundary, or null when it is not one. */
export function readPictureTable(value: unknown): PictureTable | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("fps" in value) ||
    !isFps(value.fps) ||
    !("videos" in value) ||
    !value.videos ||
    typeof value.videos !== "object"
  )
    return null;
  const videos: PictureTable["videos"] = {};
  for (const [id, slot] of Object.entries(value.videos)) {
    if (!isSlot(slot)) return null;
    videos[id] = slot;
  }
  return { fps: value.fps, videos };
}

/** A piece of a table, resolved on its source's playable end. */
export function slotPiece(
  id: string,
  slot: PictureSlot,
  fps: Fps,
  end: ExactTime | null,
): Piece {
  const window = ({ start, end }: TextWindow) => ({
    start: readTime(start),
    end: readTime(end),
  });
  const edge = window(slot.edge);
  return resolvePiece(
    {
      id,
      src: "",
      path: "",
      ownFps: slot.ownFps ?? fps,
      origin: slot.origin ? readTime(slot.origin) : fraction(0n),
      local: slot.local ? window(slot.local) : edge,
      edge,
      played: slot.played ? window(slot.played) : edge,
      stored: slot.stored,
      curve: slot.curve,
      loop: slot.loop,
    },
    fps,
    end ?? undefined,
  );
}

/** The ordinal export shows at an output frame, or null where the piece shows nothing. */
export function framePicture(
  piece: Piece,
  index: PictureIndex,
  frame: number,
  fps: Fps,
) {
  if (frame < piece.frames.start || frame >= piece.frames.end) return null;
  return pictureAt(index, sourceAt(piece, frames(frame, fps)));
}

/**
 * Where a paused player is put to show picture `ordinal`: a quarter of the way in. That is past
 * a container's millisecond rounding and the millisecond Chromium can show a Matroska picture
 * late, and short of the middle, past which an HLS player that shows the nearest picture shows
 * the next. The last picture of a variable-rate file has no successor, so it takes a quarter of
 * the interval before it.
 */
export function pictureSeek(index: PictureIndex, ordinal: bigint) {
  if (!("ticks" in index)) {
    const { origin, rate } = index;
    return secondsOf(origin) + ((Number(ordinal) + 0.25) * rate.den) / rate.num;
  }
  const { ticks, tick, offset } = index;
  const at = Math.min(Number(ordinal), ticks.length - 1);
  const seconds = (count: number) =>
    secondsOf(offset) + count * secondsOf(tick);
  const start = seconds(ticks[at]!);
  const gap =
    at + 1 < ticks.length
      ? seconds(ticks[at + 1]!) - start
      : at > 0
        ? start - seconds(ticks[at - 1]!)
        : 0.004;
  return start + gap / 4;
}

/**
 * The picture export shows at a source time a player was asked for. HyperFrames' runtime and
 * Cutroom's edit frames ask with the runtime's lead already added.
 */
export const timePicture = (index: PictureIndex, asked: number) =>
  pictureAt(index, asked - MEDIA_ELEMENT_LEAD_SECONDS);

/** Where a decoder finds the picture export writes, using an exact source time when available. */
export function pictureTime(
  pictures: PictureSource | null,
  asked: number,
  source?: SourceTime,
) {
  if (!pictures) return asked;
  const ordinal =
    source === undefined
      ? timePicture(pictures.index, asked)
      : pictureAt(pictures.index, source);
  return ordinal === null ? asked : pictureSeek(pictures.index, ordinal);
}

/**
 * The picture a decoded frame's microsecond timestamp belongs to. A constant-rate file's
 * timestamps keep its container's rounding, such as Matroska's milliseconds, which the grid
 * undoes, so there it is the nearest picture on the grid. Otherwise the timestamps are the
 * index's own.
 */
export function presentedPicture(index: PictureIndex, timestamp: number) {
  if ("ticks" in index) return pictureAt(index, micros(Math.round(timestamp)));
  const { origin, rate, count } = index;
  const slot = Math.round(
    ((timestamp / 1e6 - secondsOf(origin)) * rate.num) / rate.den,
  );
  return BigInt(Math.max(0, Math.min(Number(count) - 1, slot)));
}

/** What the preview bridge runs from its bundled copy of this module. */
export const viewerPictures = {
  readPictureSource,
  readPictureTable,
  slotPiece,
  framePicture,
  timePicture,
  pictureSeek,
  presentedPicture,
};
