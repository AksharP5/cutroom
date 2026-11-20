import { createHash } from "node:crypto";
import { basename } from "node:path";
import { normalizeRateSpec } from "@hyperframes/core";
import { timeAtSourceTime } from "@hyperframes/core/speed-ramp";
import { runFfmpeg, VideoSourceExtractionError } from "@hyperframes/engine";
import type { VideoElement, VideoMetadata } from "@hyperframes/engine";
import { z } from "zod";
import { sourcePictures } from "../media/pictureIndex.ts";
import { localMediaInputOptions } from "../media/input.ts";
import { secondsOf } from "../../shared/timeline/piece.ts";
import { FpsSchema, type Fps } from "../../shared/timeline/schema.ts";
import { ordinalDecode, picturePiece, picturesAt } from "./pictureSelection.ts";

export const PictureSlotsSchema = z.object({
  first: z.number().int(),
  fps: FpsSchema,
  slots: z.array(z.number().int().nonnegative().nullable()),
});

export async function capturePictures(
  video: VideoElement,
  path: string,
  metadata: VideoMetadata,
  fps: Fps,
  timelineEnd: number | undefined,
  range: { start: number; end: number } | undefined,
  signal: AbortSignal | undefined,
) {
  // Streams read remotely by a distributed renderer still use its range decoder.
  if (/^https?:\/\//i.test(path)) return null;
  const source = await sourcePictures(path, metadata, signal);
  if (!source || (!source.end && (video.loop || !Number.isFinite(video.end))))
    return null;
  const playbackRate = normalizeRateSpec(video.playbackRate);
  const sourceEnd = source.end ? secondsOf(source.end.time) : 0;
  const naturalEnd =
    video.start +
    timeAtSourceTime(playbackRate, Math.max(0, sourceEnd - video.mediaStart));
  const end = Math.min(
    Number.isFinite(video.end) ? video.end : naturalEnd,
    timelineEnd ?? Infinity,
  );
  const piece = picturePiece({ ...video, end, playbackRate }, fps, source);
  if (video.loop && !piece.loop?.length) return null;
  const first = Math.max(0, Number(piece.frames.start), range?.start ?? 0);
  const last = Math.min(Number(piece.frames.end), range?.end ?? Infinity);
  const selected = picturesAt(piece, source, fps, first, last);
  const ordinals = [
    ...new Set(
      selected.flatMap((ordinal) => (ordinal === null ? [] : [ordinal])),
    ),
  ].sort((a, b) => a - b);
  const index = new Map(ordinals.map((ordinal, i) => [ordinal, i]));
  const slots = selected.map((ordinal) =>
    ordinal === null ? null : index.get(ordinal)!,
  );
  return {
    source,
    ordinals,
    lookup: { first, fps, slots },
    cacheKey:
      "ordinals-v1-" +
      createHash("sha256").update(ordinals.join(",")).digest("hex"),
  };
}

type CapturePictures = NonNullable<Awaited<ReturnType<typeof capturePictures>>>;

/** Decode each wanted source picture once, including across any number of loop wraps. */
export async function extractPictures(input: {
  plan: CapturePictures;
  decodeArgs: string[];
  filters: string[];
  encodeArgs: string[];
  signal?: AbortSignal;
  timeout: number;
  done: (count: number) => void;
}) {
  const { plan, signal } = input;
  const { source, ordinals } = plan;
  // Bounds the filter argument within the OS command-line limit even for sparse ordinals.
  const batchSize = process.platform === "win32" ? 250 : 1200;
  for (let first = 0; first < ordinals.length; first += batchSize) {
    const batch = ordinals.slice(first, first + batchSize);
    for (const retry of [false, true]) {
      signal?.throwIfAborted();
      const decode = ordinalDecode(source, batch, 0, retry);
      const result = await runFfmpeg(
        [
          "-loglevel",
          "info",
          "-nostdin",
          "-copyts",
          ...input.decodeArgs,
          ...localMediaInputOptions,
          ...decode.args,
          "-i",
          source.path,
          "-map",
          `0:${source.stream}`,
          "-vf",
          [...decode.filters, ...input.filters].join(","),
          "-fps_mode",
          "passthrough",
          "-start_number",
          String(first + 1),
          "-frames:v",
          String(batch.length),
          ...input.encodeArgs,
        ],
        { signal, timeout: input.timeout, onStderr: decode.read },
      );
      signal?.throwIfAborted();
      const matches = decode.verified();
      const diskFull = /no space left on device|disk quota exceeded/i.test(
        result.stderr,
      );
      const missedSeek =
        decode.args.length > 0 &&
        !matches &&
        result.terminationReason === "exit" &&
        /nothing was written|output file is empty/i.test(result.stderr);
      if (!result.success && !missedSeek) {
        throw new VideoSourceExtractionError(
          diskFull ? "disk_full" : "ffmpeg_failed",
          false,
          diskFull
            ? "The disk filled up while video frames were extracted"
            : "Video source could not be decoded",
          `${basename(source.path)}, picture ${batch[0]}: ${result.stderr.slice(-500)}`,
        );
      }
      if (matches) {
        input.done(batch.length);
        break;
      }
      if (retry)
        throw new VideoSourceExtractionError(
          "ffmpeg_failed",
          false,
          "The decoded pictures did not match the source timestamps",
          `Could not verify picture ${batch[0]} in ${basename(source.path)} after retrying from an earlier keyframe.`,
        );
    }
  }
}
