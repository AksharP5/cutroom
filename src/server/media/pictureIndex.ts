import { stat } from "node:fs/promises";
import { resolvePlayableVideoDuration, runFfprobe } from "@hyperframes/engine";
import type { VideoMetadata } from "@hyperframes/engine";
import { fileFingerprint } from "../../shared/media.ts";
import {
  add,
  decimalFraction,
  fraction,
  subtract,
} from "../../shared/timeline/piece.ts";
import type { ExactTime, PictureIndex } from "../../shared/timeline/piece.ts";
import type { Fps } from "../../shared/timeline/schema.ts";
import { localMediaInputOptions } from "./input.ts";

type Packet = { pts: bigint; duration: bigint | undefined; key: boolean };
type PlayableEnd = { time: ExactTime; from: "stream" | "packet" | "estimate" };
export type SourcePictures = {
  path: string;
  index: PictureIndex;
  packets: readonly Packet[];
  keys: readonly number[];
  tick: ExactTime;
  stream: number;
  end: PlayableEnd | undefined;
};

const integer = (value: string | undefined) =>
  value && /^-?\d+$/.test(value) ? BigInt(value) : undefined;

function timeBase(value: string | undefined) {
  const [num, den] = (value ?? "").split("/").map(integer);
  return num && num > 0n && den && den > 0n ? fraction(num, den) : undefined;
}

function decimal(value: string | undefined) {
  return value && /^-?\d+(\.\d+)?$/.test(value)
    ? decimalFraction(value)
    : undefined;
}

// Compact ffprobe fields are text all the way to BigInt, including 64-bit PTS.
function* records(
  raw: string,
  section: string,
): Generator<Record<string, string | undefined>> {
  for (const line of raw.split("\n")) {
    const [type, ...fields] = line.trimEnd().split("|");
    if (type === section)
      yield Object.fromEntries(fields.map((field) => field.split("=", 2)));
  }
}

function ticks(value: bigint, base: ExactTime) {
  return fraction(value * base.n, base.d);
}

const readStreamStart = (stream: Record<string, string | undefined>) => {
  const base = timeBase(stream.time_base);
  const start = integer(stream.start_pts);
  if (base && start !== undefined)
    return { time: ticks(start, base), exact: true };
  const time = decimal(stream.start_time);
  return time && { time, exact: false };
};

function onGrid(packets: Packet[], tick: ExactTime, rate: Fps) {
  const first = packets[0]!.pts;
  // A millisecond Matroska clock rounds CFR starts. Keep the rational cadence
  // only when the timestamps fit it to within the container's tick.
  const num = tick.n * BigInt(rate.num);
  const den = tick.d * BigInt(rate.den);
  return packets.every(({ pts }, ordinal) => {
    const error = (pts - first) * num - BigInt(ordinal) * den;
    return error > -num && error < num;
  });
}

async function readPictures(
  path: string,
  metadata: VideoMetadata,
  signal?: AbortSignal,
): Promise<SourcePictures | null> {
  const streams = await runFfprobe(
    path,
    [
      ...localMediaInputOptions,
      "-show_entries",
      "stream=index,codec_type,time_base,start_pts,start_time,duration_ts,duration,r_frame_rate:stream_disposition=attached_pic:format=format_name",
      "-of",
      "compact",
    ],
    signal,
  );
  const av = [...records(streams, "stream")].filter(
    (stream) =>
      (stream.codec_type === "video" || stream.codec_type === "audio") &&
      stream["disposition:attached_pic"] !== "1",
  );
  const video = av.find((stream) => stream.codec_type === "video");
  const tick = timeBase(video?.time_base);
  if (!video || !tick || video.index === undefined) return null;
  const stream = Number(video.index);
  const duration = integer(video.duration_ts);

  const raw = await runFfprobe(
    path,
    [
      ...localMediaInputOptions,
      "-select_streams",
      String(stream),
      "-show_entries",
      "packet=pts,duration,flags",
      "-of",
      "compact",
    ],
    signal,
    { maxChars: 64 * 1024 * 1024 },
  );
  const presented: Packet[] = [];
  for (const packet of records(raw, "packet")) {
    // The demuxer marks edit-list preroll as discarded. A stream's reported duration
    // can end before a reordered picture's PTS, so it cannot filter this list.
    if (packet.flags?.includes("D")) continue;
    const pts = integer(packet.pts);
    if (pts === undefined) return null;
    presented.push({
      pts,
      duration: integer(packet.duration),
      key: packet.flags?.includes("K") ?? false,
    });
  }
  if (!presented.length) return null;
  presented.sort((a, b) => (a.pts < b.pts ? -1 : a.pts > b.pts ? 1 : 0));
  const first = presented[0]!;
  const last = presented.at(-1)!;
  const keys = presented.flatMap((packet, ordinal) =>
    packet.key ? [ordinal] : [],
  );
  const videoStart = readStreamStart(video);
  const earliest = av
    .map(readStreamStart)
    .reduce<ReturnType<typeof readStreamStart>>(
      (first, next) =>
        next && (!first || subtract(next.time, first.time).n < 0n)
          ? next
          : first,
      undefined,
    );
  const lead =
    earliest && videoStart
      ? subtract(videoStart.time, earliest.time)
      : fraction(0n);
  const format = records(streams, "format").next().value;
  const fromZero = /\b(mp4|webm)\b/.test(format?.format_name ?? "");
  const offset =
    fromZero && earliest && earliest.time.n > 0n ? earliest.time : fraction(0n);
  const streamStart = videoStart?.time ?? fraction(0n);
  const origin = add(lead, offset);
  const packetOffset = subtract(origin, streamStart);
  const rate = timeBase(video.r_frame_rate);
  const fps = rate && { num: Number(rate.n), den: Number(rate.d) };
  const index: PictureIndex =
    fps && !metadata.isVFR && onGrid(presented, tick, fps)
      ? {
          origin: add(ticks(first.pts, tick), packetOffset),
          rate: fps,
          count: BigInt(presented.length),
        }
      : {
          times: presented.map(({ pts }) =>
            add(ticks(pts, tick), packetOffset),
          ),
        };

  const streamDuration =
    duration && duration > 0n ? ticks(duration, tick) : decimal(video.duration);
  const lastEnd =
    last.duration && last.duration > 0n
      ? subtract(ticks(last.pts + last.duration, tick), streamStart)
      : undefined;
  const exactLead = videoStart?.exact && earliest?.exact;
  const estimate = resolvePlayableVideoDuration(metadata);
  let playable: PlayableEnd | undefined;
  if (streamDuration && streamDuration.n > 0n)
    playable = {
      time: add(lead, streamDuration),
      from: exactLead && duration && duration > 0n ? "stream" : "estimate",
    };
  else if (lastEnd && lastEnd.n > 0n)
    playable = {
      time: add(lead, lastEnd),
      from: exactLead ? "packet" : "estimate",
    };
  else if (estimate > 0 && Number.isFinite(estimate))
    playable = { time: decimalFraction(estimate), from: "estimate" };

  return { path, index, packets: presented, keys, tick, stream, end: playable };
}

const sources = new Map<string, Promise<SourcePictures | null>>();

/** One demux pass per source revision, lazily when the export needs pictures. */
export async function sourcePictures(
  path: string,
  metadata: VideoMetadata,
  signal?: AbortSignal,
) {
  const key = fileFingerprint(path, await stat(path));
  let pending = sources.get(key);
  if (!pending) {
    pending = readPictures(path, metadata, signal);
    sources.set(key, pending);
    pending.catch(() => {
      if (sources.get(key) === pending) sources.delete(key);
    });
    if (sources.size > 16) sources.delete(sources.keys().next().value!);
  }
  return pending;
}

export const nativeTimestamp = (source: SourcePictures, ordinal: number) =>
  ticks(source.packets[ordinal]!.pts, source.tick);
