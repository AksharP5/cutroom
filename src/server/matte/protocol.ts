import { z } from "zod";

export const SegmenterOptionsSchema = z.object({
  weights: z.string(),
  /** The folder whose node_modules holds onnxruntime-node. */
  runtime: z.string(),
  threads: z.number().int().positive(),
});
export type SegmenterOptions = z.infer<typeof SegmenterOptionsSchema>;

/** What a segmenter module exports as `createSegmenter`: square RGB in, 8-bit mask out. */
export interface Segmenter {
  /** The side of the square RGB frames it takes and masks it returns. */
  size: number;
  /** The mask, or null when there is nothing to keep in the frame. */
  segment(rgb: Uint8Array): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export const MatteTaskSchema = z.object({
  ffmpeg: z.string(),
  source: z.string(),
  output: z.string(),
  /** A video's frame range on its grid, or null for a still image. */
  range: z
    .object({
      /** Input seconds to seek to: half a frame before the first frame. */
      seek: z.number().nonnegative(),
      frames: z.number().int().positive(),
      /** FFmpeg's rate, such as `30000/1001`. */
      rate: z.string().regex(/^\d+(\/\d+)?$/),
      /** Variable frame rate: pictures are taken at grid slots rather than one per frame. */
      variable: z.boolean(),
    })
    .nullable(),
  /** The module that exports `createSegmenter`, as a file URL. */
  segmenter: z.string(),
  model: SegmenterOptionsSchema,
});
export type MatteTask = z.infer<typeof MatteTaskSchema>;

export const MatteEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), done: z.number().int() }),
  /** Also after a stop: `done` frames are in the file, or none were and there is no file. */
  z.object({
    type: z.literal("done"),
    done: z.number().int(),
    subject: z.boolean(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type MatteEvent = z.infer<typeof MatteEventSchema>;
