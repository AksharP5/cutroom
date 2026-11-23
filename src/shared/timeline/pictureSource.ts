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
} from "./piece.ts";
import type { Fps } from "./schema.ts";

/**
 * The viewer's picture facts as JSON: exact times as `"n/d"`, a constant-rate file as its grid,
 * any other as the integer ticks of its presented pictures on one clock. Self-contained, because
 * the preview bridge runs a bundle of this module.
 */
type Text = string;
type TextWindow = { start: Text; end: Text };

export type PictureSourceWire = {
  index:
    | { origin: Text; rate: Fps; count: Text }
    | { tick: Text; offset: Text; ticks: number[] };
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
  const { ticks } = index;
  if (
    !Array.isArray(ticks) ||
    !ticks.length ||
    !ticks.every(
      (tick, i) => Number.isSafeInteger(tick) && (!i || tick >= ticks[i - 1]),
    )
  )
    return null;
  const unit = readTime(index.tick);
  const offset = readTime(index.offset);
  return {
    index: {
      times: ticks.map((tick: number) =>
        fraction(
          offset.n * unit.d + BigInt(tick) * unit.n * offset.d,
          offset.d * unit.d,
        ),
      ),
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
  if (!("times" in index)) {
    const { origin, rate } = index;
    return secondsOf(origin) + ((Number(ordinal) + 0.25) * rate.den) / rate.num;
  }
  const { times } = index;
  const at = Math.min(Number(ordinal), times.length - 1);
  const start = secondsOf(times[at]!);
  const next = times[at + 1];
  const previous = times[at - 1];
  const gap = next
    ? secondsOf(next) - start
    : previous
      ? start - secondsOf(previous)
      : 0.004;
  return start + gap / 4;
}

/**
 * The picture export shows at a source time a player was asked for. HyperFrames' runtime and
 * Cutroom's edit frames ask with the runtime's lead already added.
 */
export const timePicture = (index: PictureIndex, asked: number) =>
  pictureAt(index, asked - MEDIA_ELEMENT_LEAD_SECONDS);

/**
 * The picture a decoded frame's microsecond timestamp belongs to. A constant-rate file's
 * timestamps keep its container's rounding, such as Matroska's milliseconds, which the grid
 * undoes, so there it is the nearest picture on the grid. Otherwise the timestamps are the
 * index's own.
 */
export function presentedPicture(index: PictureIndex, timestamp: number) {
  if ("times" in index) return pictureAt(index, micros(Math.round(timestamp)));
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
