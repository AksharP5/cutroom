import { z } from "zod";
import { canonicalText } from "./timeline/schema";

export const LayerTextQuerySchema = z.object({
  composition: z.string().default("index.html"),
  clipId: z.string().min(1),
});

export const LayerTextUpdateSchema = LayerTextQuerySchema.extend({
  expectedVersion: z.string().min(1),
  layerId: z.string().min(1),
  text: z
    .string()
    .max(20_000)
    .overwrite(canonicalText)
    .refine((text) => text.length > 0, "Text cannot be empty."),
}).strict();

export const LayerTextSnapshotSchema = LayerTextQuerySchema.extend({
  version: z.string(),
  locked: z.boolean(),
  layers: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      reason: z.string().nullable(),
    }),
  ),
});

export type LayerTextSnapshot = z.infer<typeof LayerTextSnapshotSchema>;
