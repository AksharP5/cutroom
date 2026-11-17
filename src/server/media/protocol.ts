import { z } from "zod";
import { mediaSettings } from "../../shared/media";

export const MediaKindSchema = z.enum([
  "probe",
  "peaks",
  "filmstrip",
  "frame",
  "scrub",
  "proxy",
  "pieces",
]);
export type MediaKind = z.infer<typeof MediaKindSchema>;
export const MediaInfoSchema = z.object({
  channels: z.number().int().positive().optional(),
  video: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      pixelAspect: z.number().positive(),
      fps: z.number().positive(),
      duration: z.number().nonnegative(),
      codec: z.string(),
      alpha: z.boolean(),
      hdr: z.boolean(),
    })
    .optional(),
});
/**
 * How an editing proxy is cut into pieces of about four seconds that play as soon as each is made.
 * Times are on the proxy's clock, the source's own with its start at zero.
 */
export const PiecesSchema = z.object({
  /** The source's video clock, which the proxy keeps. */
  timeBase: z.string().regex(/^\d+\/\d+$/),
  /** The source's first timestamp, where the proxy's clock starts, as export reads it. */
  start: z.number(),
  /** The source's first sound stream, which AAC pieces carry as it is. */
  audio: z.string().nullable(),
  /** The first picture on the proxy's clock. */
  videoStart: z.number().finite(),
  /** Where each piece after the first starts: midway between two frames. */
  cuts: z.array(z.number().nonnegative()),
  /** The first sample in each piece after the first, for the playlist clock. */
  starts: z.array(z.number().nonnegative()),
  /** Where the last frame ends. */
  end: z.number().positive(),
});
export type Pieces = z.infer<typeof PiecesSchema>;
export const MediaTaskSchema = z.object({
  kind: MediaKindSchema,
  source: z.string(),
  directory: z.string(),
  ffmpeg: z.string(),
  ffprobe: z.string(),
  info: MediaInfoSchema.optional(),
  time: z.number().nonnegative().optional(),
  encoder: z.enum(["nvenc", "x264"]).optional(),
  /** An editing proxy is made a run of pieces at a time, then joined into one file. */
  proxy: z
    .discriminatedUnion("step", [
      z.object({
        step: z.literal("encode"),
        pieces: PiecesSchema,
        first: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      }),
      z.object({ step: z.literal("join"), pieces: PiecesSchema }),
    ])
    .optional(),
});
export type MediaTask = z.infer<typeof MediaTaskSchema>;
export const MediaEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), progress: z.number().min(0).max(1) }),
  z.object({ type: z.literal("piece"), index: z.number().int().nonnegative() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);
export const FilmstripSchema = z.object({
  version: z.literal(2),
  interval: z.literal(mediaSettings.filmstripInterval),
  tileWidth: z.number().int().positive(),
  tileHeight: z.literal(mediaSettings.tileHeight),
  count: z.number().int().positive(),
  sheets: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        start: z.number().int().nonnegative(),
        count: z.number().int().positive().max(mediaSettings.tilesPerSheet),
        columns: z.number().int().positive().max(mediaSettings.columns),
        rows: z.number().int().positive(),
      }),
    )
    .min(1),
});
