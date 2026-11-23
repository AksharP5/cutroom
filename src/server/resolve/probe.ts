import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { z } from "zod";
import { sourcePictures } from "../media/pictureIndex";
import { fraction } from "../../shared/timeline/piece";
import type { PictureIndex } from "../../shared/timeline/piece";
import { localMediaInputOptions } from "../media/input";
import { timecodeFrames } from "./fcpxml";
import type { Rate } from "./fcpxml";

/** What the timeline needs to know about a media file to cut it frame-accurately in Resolve. */
export interface MediaFacts {
  /** Canonical absolute path. */
  path: string;
  video: {
    rate: Rate;
    width: number;
    height: number;
    /** The pictures export selects from, which Resolve counts as its source frames. */
    pictures: PictureIndex;
    /** Frames before the first one, from the file's timecode; Resolve numbers source frames from it. */
    timecode: number;
  } | null;
  audio: { channels: number; sampleRate: number; codec: string } | null;
  /** Length in seconds. */
  duration: number;
}

const ProbeSchema = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        r_frame_rate: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        channels: z.number().optional(),
        sample_rate: z.coerce.number().optional(),
        disposition: z
          .object({ attached_pic: z.number().optional() })
          .optional(),
        tags: z.object({ timecode: z.string().optional() }).optional(),
      }),
    )
    .default([]),
  format: z
    .object({
      duration: z.coerce.number().optional(),
      tags: z.object({ timecode: z.string().optional() }).optional(),
    })
    .default({}),
});

const parseRate = (text: string | undefined): Rate | null => {
  const [num, den] = (text ?? "").split("/").map(Number);
  return num && den && Number.isSafeInteger(num) && Number.isSafeInteger(den)
    ? { num, den }
    : null;
};

/**
 * Probe a local video or audio file; null when FFmpeg cannot read it. A project's files keep
 * their picture index in its cache.
 */
export async function probeMedia(
  path: string,
  projectDir?: string,
): Promise<MediaFacts | null> {
  const ffprobe = findFfBinary("ffprobe", { configuredMustExist: true });
  if (!ffprobe) throw new Error("FFmpeg's ffprobe is needed to read media.");
  const child = Bun.spawn(
    [
      ffprobe,
      ...["-v", "error", ...localMediaInputOptions],
      "-show_entries",
      "stream=codec_type,codec_name,r_frame_rate,width,height,channels,sample_rate:stream_disposition=attached_pic:stream_tags=timecode:format=duration:format_tags=timecode",
      ...["-of", "json", path],
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0) return null;
  const { streams, format } = ProbeSchema.parse(JSON.parse(output));
  const picture = streams.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  const sound = streams.find((stream) => stream.codec_type === "audio");
  const rate = parseRate(picture?.r_frame_rate);
  const indexed =
    picture && rate ? await sourcePictures(path, { projectDir }) : null;
  // A file export cannot index still has its pictures, on the grid its rate reports.
  const pictures: PictureIndex | null =
    indexed?.index ??
    (rate && {
      origin: fraction(0n),
      rate,
      count: format.duration
        ? BigInt(
            Math.max(1, Math.round((format.duration * rate.num) / rate.den)),
          )
        : 2n ** 53n,
    });
  const timecode =
    picture?.tags?.timecode ??
    streams.find((stream) => stream.tags?.timecode)?.tags?.timecode ??
    format.tags?.timecode;
  return {
    path,
    video:
      picture && rate && pictures && picture.width && picture.height
        ? {
            rate,
            width: picture.width,
            height: picture.height,
            pictures,
            timecode: (timecode && timecodeFrames(timecode, rate)) || 0,
          }
        : null,
    audio:
      sound?.channels && sound.sample_rate
        ? {
            channels: sound.channels,
            sampleRate: sound.sample_rate,
            codec: sound.codec_name ?? "",
          }
        : null,
    duration: format.duration ?? 0,
  };
}
