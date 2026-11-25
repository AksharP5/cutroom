import type { RateSpec } from "@hyperframes/core/speed-ramp";
import type { Fps } from "../../shared/timeline/schema.ts";
import {
  attrMicros,
  decodeLocal,
  frames,
  micros,
  pictureAt,
  resolvePiece,
  sourceAt,
} from "../../shared/timeline/piece.ts";
import { nativeTimestamp } from "../media/pictureIndex.ts";
import type { SourcePictures } from "../media/pictureIndex.ts";

type VideoTiming = {
  id: string;
  src: string;
  start: number;
  end: number;
  mediaStart: number;
  playbackRate: RateSpec;
  loop?: boolean;
};

export function picturePiece(
  video: VideoTiming,
  fps: Fps,
  source: SourcePictures,
) {
  const start = decodeLocal(attrMicros(video.start), fps);
  const end = decodeLocal(attrMicros(video.end), fps);
  const window = { start, end };
  return resolvePiece(
    {
      id: video.id,
      src: video.src,
      path: "",
      origin: micros(0),
      ownFps: fps,
      edge: window,
      local: window,
      stored: {
        mediaStart: Number(attrMicros(video.mediaStart)),
        ...(typeof video.playbackRate === "object" &&
          video.playbackRate.offset !== undefined && {
            offset: Number(attrMicros(video.playbackRate.offset)),
          }),
      },
      curve: video.playbackRate,
      loop: video.loop,
    },
    fps,
    source.end?.time,
  );
}

export function picturesAt(
  piece: ReturnType<typeof picturePiece>,
  source: SourcePictures,
  fps: Fps,
  start: number,
  end: number,
) {
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => {
    const ordinal = pictureAt(
      source.index,
      sourceAt(piece, frames(start + i, fps)),
    );
    return ordinal === null ? null : Number(ordinal);
  });
}

/**
 * Keyframes further back a retry decodes from, when a seek landed after the first wanted picture.
 * Two GOPs cover a demuxer whose index runs a keyframe behind, without decoding from the start.
 */
export const RETRY_KEYFRAMES = 2;

/**
 * Decodes from a keyframe at or before the first wanted picture and keeps each wanted picture by its
 * native timestamp, then verifies every kept picture. A demuxer can land a GOP early (Matroska with
 * B-frames does), which costs only the extra decode; one that lands late fails verification, and
 * `back` retries from that many keyframes earlier.
 */
export function ordinalDecode(
  source: SourcePictures,
  ordinals: readonly number[],
  tag: number,
  back = 0,
) {
  const first = ordinals[0]!;
  // Binary search keeps the seek cost independent of the number of source GOPs.
  let lo = 0;
  let hi = source.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (source.keys[mid]! <= first) lo = mid + 1;
    else hi = mid;
  }
  // Before the first indexed keyframe (a discarded edit-list preroll holds it), decode from the start.
  const key = lo - 1 - back;
  const anchor = key >= 0 ? source.keys[key]! : 0;
  // -ss accepts microseconds. Round up so a keyframe on a fractional tick remains eligible.
  const micros = (ordinal: number) => {
    const { n, d } = nativeTimestamp(source, ordinal);
    return (n * 1_000_000n + d - 1n) / d;
  };
  // FFmpeg seeks 3/23 s early in a stream with B-frames unless its container seeks by
  // presentation time, which put a Matroska seek to a keyframe a whole GOP early. Ask for a time
  // that far past the keyframe, never as far as the next one, so either way it lands on this one.
  const next = key >= 0 ? source.keys[key + 1] : undefined;
  const start = micros(anchor);
  const late = start + 3_000_000n / 23n + 1n;
  const wanted = back ? start : micros(first);
  const reach = wanted > late ? wanted : late;
  const limit = next === undefined ? reach : micros(next) - 1n;
  const seekUs = reach < limit ? reach : limit > start ? limit : start;
  const seek = anchor > 0 && seekUs > 0n;
  // Seconds halfway between a picture and the next, so a decoded timestamp compares far from
  // either side. -copyts keeps the native timestamps the index holds.
  const between = (ordinal: number) => {
    const before = source.packets[ordinal]?.pts;
    const after = source.packets[ordinal + 1]?.pts;
    if (before === undefined || after === undefined) return undefined;
    return (
      (Number(before + after) * Number(source.tick.n)) /
      (2 * Number(source.tick.d))
    ).toFixed(9);
  };
  const ranges: { start: number; end: number }[] = [];
  for (const ordinal of ordinals) {
    const prev = ranges.at(-1);
    if (prev && prev.end + 1 === ordinal) prev.end = ordinal;
    else ranges.push({ start: ordinal, end: ordinal });
  }
  const keep = ({ start, end }: { start: number; end: number }) => {
    const after = between(start - 1);
    const before = between(end);
    return (
      [
        ...(after === undefined ? [] : [String.raw`gte(t\,${after})`]),
        ...(before === undefined ? [] : [String.raw`lt(t\,${before})`]),
      ].join("*") || "1"
    );
  };
  // The left branch includes a whole run of wanted pictures. Direct parts and capture batches
  // bound the graph size even for very sparse selection.
  const select = (start: number, end: number): string => {
    if (end - start === 1) return keep(ranges[start]!);
    const mid = (start + end) >>> 1;
    const after = between(ranges[mid]!.start - 1)!;
    return String.raw`if(lt(t\,${after})\,${select(start, mid)}\,${select(mid, end)})`;
  };
  const last = between(ordinals.at(-1)!);
  const name = `showinfo@cutroom${tag}`;
  const filters = [
    // Ends the input after the last wanted picture, so a part never decodes the rest of the file.
    ...(last === undefined ? [] : [`trim=end=${last}`]),
    `select=${select(0, ranges.length)}`,
    `${name}=checksum=0`,
  ];
  let ticks: { num: bigint; den: bigint } | undefined;
  let verified = 0;
  let mismatch: number | undefined;
  let partial = "";
  // Based on Cutroom's earlier nativeFrameClock, but compare native ticks as integers.
  const read = (chunk: string) => {
    const lines = (partial + chunk).split(/[\r\n]/);
    partial = lines.pop()!;
    for (const line of lines) {
      if (!line.includes(`[${name} @`)) continue;
      const basis = /config in time_base:\s*(\d+)\/(\d+)/.exec(line);
      if (basis) ticks = { num: BigInt(basis[1]!), den: BigInt(basis[2]!) };
      const frame = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)/.exec(line);
      if (!frame) continue;
      const expected = source.packets[ordinals[verified] ?? -1]?.pts;
      if (
        mismatch === undefined &&
        (!ticks ||
          expected === undefined ||
          Number(frame[1]) !== verified ||
          BigInt(frame[2]!) * ticks.num * source.tick.d !==
            expected * source.tick.n * ticks.den)
      )
        mismatch = ordinals[verified] ?? ordinals.at(-1)!;
      verified++;
    }
  };
  return {
    first,
    args: seek
      ? ["-noaccurate_seek", "-seek_timestamp", "1", "-ss", `${seekUs}us`]
      : [],
    filters,
    read,
    /** The first wanted picture that was missing or wrong, or undefined when all verified. */
    unverified: () => {
      read("\n");
      if (mismatch !== undefined) return mismatch;
      return verified === ordinals.length ? undefined : ordinals[verified];
    },
  };
}
