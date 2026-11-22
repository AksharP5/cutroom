import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runFfprobe } from "@hyperframes/engine";
import { z } from "zod";
import { isMissing, projectStatePath } from "../projects/path.ts";
import { FpsSchema } from "../../shared/timeline/schema.ts";
import {
  add,
  decimalFraction,
  fraction,
  subtract,
} from "../../shared/timeline/piece.ts";
import type { ExactTime, PictureIndex } from "../../shared/timeline/piece.ts";
import type { Fps } from "../../shared/timeline/schema.ts";
import { localMediaInputOptions } from "./input.ts";

type Packet = { pts: bigint; duration?: bigint; key: boolean };
type PlayableEnd = { time: ExactTime; from: "stream" | "packet" | "estimate" };
export type SourcePictures = {
  path: string;
  index: PictureIndex;
  packets: readonly Packet[];
  keys: readonly number[];
  tick: ExactTime;
  stream: number;
  end?: PlayableEnd;
  proxy: { timeBase: string; start: number; audio: string | null };
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

/** Every picture and sound stream's start, and the container's name and length. */
export const mediaStreamsArgs = [
  ...localMediaInputOptions,
  "-show_entries",
  "stream=index,codec_type,codec_name,time_base,start_pts,start_time,duration_ts,duration,r_frame_rate,avg_frame_rate:stream_disposition=attached_pic:format=format_name,start_time,duration",
  "-of",
  "compact",
];

/**
 * The media clock the preview plays and export seeks, from `mediaStreamsArgs`' output. Its zero is
 * the earliest picture or sound, except that browsers play the MP4 and WebM families (MOV and
 * Matroska among them) from timestamp zero, so there a later first stream keeps its own start. A
 * stream's media time is its timestamp less `zero`.
 */
export function mediaClock(raw: string) {
  const av = [...records(raw, "stream")].filter(
    (stream) =>
      (stream.codec_type === "video" || stream.codec_type === "audio") &&
      stream["disposition:attached_pic"] !== "1",
  );
  const earliest = av
    .map(readStreamStart)
    .reduce<ReturnType<typeof readStreamStart>>(
      (first, next) =>
        next && (!first || subtract(next.time, first.time).n < 0n)
          ? next
          : first,
      undefined,
    );
  const format = records(raw, "format").next().value;
  const fromZero = /\b(mp4|webm)\b/.test(format?.format_name ?? "");
  const zero =
    !earliest || (fromZero && earliest.time.n > 0n)
      ? fraction(0n)
      : earliest.time;
  return { av, format, earliest, zero };
}

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
  signal: AbortSignal | undefined,
  probe: NonNullable<PictureOptions["probe"]>,
): Promise<Omit<SourcePictures, "path"> | null> {
  const streams = await probe(mediaStreamsArgs, signal);
  const { av, format, earliest, zero } = mediaClock(streams);
  const video = av.find((stream) => stream.codec_type === "video");
  const tick = timeBase(video?.time_base);
  if (!video || !tick || video.index === undefined) return null;
  const stream = Number(video.index);
  const duration = integer(video.duration_ts);

  const raw = await probe(
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
    true,
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
  const streamStart = videoStart?.time ?? fraction(0n);
  const origin = subtract(videoStart?.time ?? earliest?.time ?? zero, zero);
  const packetOffset = subtract(origin, streamStart);
  const rate = timeBase(video.r_frame_rate);
  const fps = rate && { num: Number(rate.n), den: Number(rate.d) };
  const avg = timeBase(video.avg_frame_rate);
  const nominal = rate && Number(rate.n) / Number(rate.d);
  const average = avg && Number(avg.n) / Number(avg.d);
  const vfr =
    nominal &&
    average &&
    Math.abs(nominal - average) / Math.max(nominal, average) > 0.1;
  const index: PictureIndex =
    fps && !vfr && onGrid(presented, tick, fps)
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
  const estimate = decimal(format?.duration);
  let playable: PlayableEnd | undefined;
  if (streamDuration && streamDuration.n > 0n)
    playable = {
      time: add(origin, streamDuration),
      from: exactLead && duration && duration > 0n ? "stream" : "estimate",
    };
  else if (lastEnd && lastEnd.n > 0n)
    playable = {
      time: add(origin, lastEnd),
      from: exactLead ? "packet" : "estimate",
    };
  else if (estimate && estimate.n > 0n)
    playable = { time: estimate, from: "estimate" };

  return {
    index,
    packets: presented,
    keys,
    tick,
    stream,
    end: playable,
    proxy: {
      timeBase: video.time_base!,
      start: Number(format?.start_time ?? 0) || 0,
      audio:
        av.find(({ codec_type }) => codec_type === "audio")?.codec_name ?? null,
    },
  };
}

const exactInteger = z
  .string()
  .regex(/^-?\d+$/)
  .transform(BigInt);
const exactTime = z.object({
  n: exactInteger,
  d: exactInteger.refine((d) => d > 0n),
});
const storedPictures = z
  .object({
    index: z.union([
      z.object({ origin: exactTime, rate: FpsSchema, count: exactInteger }),
      z.object({ times: z.array(exactTime) }),
    ]),
    packets: z.array(
      z.object({
        pts: exactInteger,
        duration: exactInteger.optional(),
        key: z.boolean(),
      }),
    ),
    keys: z.array(z.number().int().nonnegative()),
    tick: exactTime,
    stream: z.number().int().nonnegative(),
    end: z
      .object({
        time: exactTime,
        from: z.enum(["stream", "packet", "estimate"]),
      })
      .optional(),
    proxy: z.object({
      timeBase: z.string().regex(/^\d+\/\d+$/),
      start: z.number(),
      audio: z.string().nullable(),
    }),
  })
  .nullable();

type PictureOptions = {
  signal?: AbortSignal;
  projectDir?: string;
  probe?: (
    args: string[],
    signal?: AbortSignal,
    packets?: boolean,
  ) => Promise<string>;
};
const sources = new Map<string, Promise<SourcePictures | null>>();

async function mediaRevision(path: string) {
  const info = await stat(path, { bigint: true });
  return [path, info.size, info.mtimeNs, info.ctimeNs, info.dev, info.ino].join(
    "\0",
  );
}

async function readCachedPictures(artifact: string) {
  try {
    const data: unknown = JSON.parse(await readFile(artifact, "utf8"));
    return storedPictures.safeParse(data);
  } catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
    return null;
  }
}

type PictureData = Omit<SourcePictures, "path">;
async function cachePictures(
  directory: string,
  read: () => Promise<PictureData | null>,
  signal: AbortSignal | undefined,
) {
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EACCES", "EPERM", "EROFS"].includes(String(error.code))
    )
      return read();
    throw error;
  }
  const artifact = join(directory, "picture-index.json");
  const lock = join(directory, "picture-index.pending");
  // The media and render workers can meet on a cold source. Only one scans it.
  for (;;) {
    signal?.throwIfAborted();
    const cached = await readCachedPictures(artifact);
    if (cached?.success) {
      const now = new Date();
      await utimes(directory, now, now).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
      return cached.data;
    }
    const claim = await open(lock, "wx").catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
      return null;
    });
    if (!claim) {
      const age = await stat(lock).then(
        ({ mtimeMs }) => Date.now() - mtimeMs,
        (error: unknown) => {
          if (!isMissing(error)) throw error;
          return 0;
        },
      );
      // A force-stopped worker can leave its claim behind.
      if (age > 120_000) await rm(lock, { force: true });
      await delay(100, undefined, { signal });
      continue;
    }
    const temp = join(directory, `.picture-${randomUUID()}.json`);
    try {
      const saved = await readCachedPictures(artifact);
      if (saved?.success) return saved.data;
      const result = await read();
      await writeFile(
        temp,
        JSON.stringify(result, (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
        { flag: "wx" },
      );
      await rename(temp, artifact);
      return result;
    } finally {
      await claim.close();
      await Promise.all([rm(temp, { force: true }), rm(lock, { force: true })]);
    }
  }
}

/** The preview's media cache also holds the source packet index used by export. */
export async function sourcePictures(
  path: string,
  options: PictureOptions = {},
) {
  const { signal, projectDir } = options;
  const original = await realpath(path);
  const revision = await mediaRevision(original);
  const key = createHash("sha256")
    .update(`picture-index-v1\0${revision}`)
    .digest("hex");
  const memoKey = `${projectDir ?? ""}\0${key}`;
  const cached = sources.get(memoKey);
  if (cached) return cached;

  const probe =
    options.probe ??
    ((args, abort, packets) =>
      runFfprobe(
        original,
        args,
        abort,
        packets ? { maxChars: 64 * 1024 * 1024 } : undefined,
      ));
  const read = async () => {
    const data = await readPictures(signal, probe);
    if ((await mediaRevision(original)) !== revision)
      throw new Error("Source media changed while indexing its pictures.");
    return data;
  };
  const pending = (async () => {
    const data = projectDir
      ? await cachePictures(
          await projectStatePath(
            { path: projectDir },
            `.cutroom/cache/${key}`,
            true,
          ),
          read,
          signal,
        )
      : await read();
    return data && { ...data, path: original };
  })();
  sources.set(memoKey, pending);
  pending.catch(() => {
    if (sources.get(memoKey) === pending) sources.delete(memoKey);
  });
  if (sources.size > 16) sources.delete(sources.keys().next().value!);
  return pending;
}

export const nativeTimestamp = (source: SourcePictures, ordinal: number) =>
  ticks(source.packets[ordinal]!.pts, source.tick);
