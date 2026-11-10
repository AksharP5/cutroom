import { z } from "zod";
import { mediaSettings } from "../../shared/media";

export const MediaKindSchema = z.enum(["probe", "peaks", "filmstrip", "frame"]);
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
    })
    .optional(),
});
export const MediaTaskSchema = z.object({
  kind: MediaKindSchema,
  source: z.string(),
  directory: z.string(),
  ffmpeg: z.string(),
  ffprobe: z.string(),
  info: MediaInfoSchema.optional(),
  time: z.number().nonnegative().optional(),
});
export type MediaTask = z.infer<typeof MediaTaskSchema>;
export const MediaEventSchema = z.discriminatedUnion("type", [
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
