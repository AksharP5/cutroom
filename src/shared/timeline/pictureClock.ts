import * as z from "zod/mini";
import { frames, pictureAt, resolvePiece, secondsOf, sourceAt } from "./piece";
import type { ExactTime, PictureIndex, PlacedMedia } from "./piece";
import type { Fps } from "./schema";

const integer = z.string().check(z.regex(/^-?\d{1,40}$/));
const packedTime = z.tuple([
  integer,
  z.string().check(z.regex(/^[1-9]\d{0,39}$/)),
]);
export const packTime = ({ n, d }: ExactTime): [string, string] => [
  String(n),
  String(d),
];
export const unpackTime = ([n, d]: [string, string]): ExactTime => ({
  n: BigInt(n),
  d: BigInt(d),
});

export const MAX_VFR_PICTURES = 100_000;
const positiveInteger = z.int().check(z.positive());
const fpsSchema = z.object({ num: positiveInteger, den: positiveInteger });
export const PreviewPicturesSchema = z.object({
  fps: fpsSchema,
  pieces: z.array(z.object({
    id: z.string(),
    src: z.string(),
    start: packedTime,
    anchor: packedTime,
    mediaStart: z.int(),
    curve: z.optional(z.number().check(z.positive())),
    automation: z.optional(z.string()),
    loop: z.boolean(),
  })),
});
export type PreviewPictures = z.infer<typeof PreviewPicturesSchema>;

const ClockSchema = z.object({
  index: z.union([
    z.object({
      origin: packedTime,
      rate: fpsSchema,
      count: positiveInteger,
    }),
    z.object({
      times: z
        .array(packedTime)
        .check(z.minLength(1), z.maxLength(MAX_VFR_PICTURES)),
    }),
  ]),
  end: z.nullable(packedTime),
  tick: z.number().check(z.positive()),
});
export type PackedPictureClock = z.infer<typeof ClockSchema>;
export type PictureClock = {
  index: PictureIndex;
  end?: ExactTime;
  tick: number;
};

export async function fetchPictureClock(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  const parsed = ClockSchema.safeParse(await response.json());
  if (!parsed.success) return null;
  const { index, end, tick } = parsed.data;
  return {
    index:
      "times" in index
        ? { times: index.times.map(unpackTime) }
        : {
            ...index,
            origin: unpackTime(index.origin),
            count: BigInt(index.count),
          },
    end: end ? unpackTime(end) : undefined,
    tick,
  } satisfies PictureClock;
}

/** Each viewer keeps the clocks of at most eight recently opened sources. */
export function pictureClockCache(
  url: (path: string) => string,
  signal?: AbortSignal,
) {
  const clocks = new Map<string, ReturnType<typeof fetchPictureClock>>();
  return (path: string) => {
    let clock = clocks.get(path);
    if (!clock) {
      const budget = AbortSignal.timeout(4000);
      clock = fetchPictureClock(
        url(path),
        signal ? AbortSignal.any([signal, budget]) : budget,
      ).catch(() => null);
    }
    clocks.delete(path);
    clocks.set(path, clock);
    if (clocks.size > 8) clocks.delete(clocks.keys().next().value!);
    return clock;
  };
}

export function pictureFor(
  clock: PictureClock,
  media: PlacedMedia,
  fps: Fps,
  frame: number,
) {
  const piece = resolvePiece(media, fps, clock.end);
  if (media.loop && !piece.loop?.length) return null;
  const ordinal = pictureAt(clock.index, sourceAt(piece, frames(frame, fps)));
  return ordinal === null ? null : Number(ordinal);
}

export function pictureInterval(
  { index, tick }: PictureClock,
  ordinal: number,
) {
  if ("times" in index) {
    const start = secondsOf(index.times[ordinal]!);
    const next = index.times[ordinal + 1];
    const previous = index.times[ordinal - 1];
    const length = next
      ? secondsOf(next) - start
      : previous
        ? start - secondsOf(previous)
        : 1 / 30;
    return { start, length, tolerance: Math.min(2e-6, length / 4) };
  }
  const length = index.rate.den / index.rate.num;
  return {
    start: secondsOf(index.origin) + ordinal * length,
    length,
    tolerance: Math.min(tick + 2e-6, length / 4),
  };
}
