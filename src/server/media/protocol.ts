import { z } from "zod";

export const MediaKindSchema = z.enum(["peaks", "filmstrip"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;
export const MediaTaskSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cancel") }),
  z.object({
    type: z.literal("generate"),
    kind: MediaKindSchema,
    source: z.string(),
    directory: z.string(),
    ffmpeg: z.string(),
  }),
]);
export const MediaEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);
export const FilmstripSchema = z.object({
  version: z.literal(1),
  interval: z.literal(2),
  tileWidth: z.literal(160),
  tileHeight: z.literal(90),
  count: z.number().int().positive().max(3600),
  columns: z.number().int().positive().max(10),
  rows: z.number().int().positive(),
});
