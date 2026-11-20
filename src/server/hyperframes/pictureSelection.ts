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

/** Use a presentation-time keyframe, then verify its decoded ordinal and every kept picture. */
export function ordinalDecode(
  source: SourcePictures,
  ordinals: readonly number[],
  tag: number,
  retry: boolean,
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
  const anchor = source.keys[lo - (retry ? 2 : 1)] ?? 0;
  const pts = nativeTimestamp(source, anchor);
  // -ss accepts microseconds. Round up so a keyframe on a fractional tick remains eligible.
  const seekUs = (pts.n * 1_000_000n + pts.d - 1n) / pts.d;
  const seek = anchor > 0 && seekUs > 0n;
  const base = seek ? anchor : 0;
  const prefix = base < first;
  const checked = prefix ? [base, ...ordinals] : ordinals;
  const ranges: { start: number; end: number }[] = [];
  for (const ordinal of checked) {
    const frame = ordinal - base;
    const prev = ranges.at(-1);
    if (prev && prev.end + 1 === frame) prev.end = frame;
    else ranges.push({ start: frame, end: frame });
  }
  // The left branch includes a whole run of wanted ordinals. Direct parts and capture batches
  // bound the graph size even for very sparse selection.
  const select = (start: number, end: number): string => {
    const mid = (start + end) >>> 1;
    const range = ranges[mid]!;
    if (end - start === 1)
      return range.start === range.end
        ? String.raw`eq(n\,${range.start})`
        : String.raw`between(n\,${range.start}\,${range.end})`;
    return String.raw`if(lt(n\,${range.start})\,${select(start, mid)}\,${select(mid, end)})`;
  };
  const name = `showinfo@cutroom${tag}`;
  const filters = [
    `trim=end_frame=${ordinals.at(-1)! - base + 1}`,
    ...(ranges.length === 1 && ranges[0]!.start === 0
      ? []
      : [`select=${select(0, ranges.length)}`]),
    `${name}=checksum=0`,
    ...(prefix ? ["trim=start_frame=1"] : []),
  ];
  let ticks: { num: bigint; den: bigint } | undefined;
  let verified = 0;
  let mismatch = false;
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
      const expected = source.packets[checked[verified] ?? -1]?.pts;
      if (
        !ticks ||
        expected === undefined ||
        Number(frame[1]) !== verified ||
        BigInt(frame[2]!) * ticks.num * source.tick.d !==
          expected * source.tick.n * ticks.den
      )
        mismatch = true;
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
    verified: () => {
      read("\n");
      return !mismatch && verified === checked.length;
    },
  };
}
