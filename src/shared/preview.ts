import { z } from "zod";

export type EditFrame = { clipId: string; time: number };

export const PreviewStateSchema = z.object({
  ready: z.boolean(),
  root: z.boolean(),
  error: z.string().nullable(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
  fps: z.string().nullable(),
  time: z.number().nonnegative().finite(),
  playing: z.boolean(),
});
export type PreviewState = z.infer<typeof PreviewStateSchema>;

export const PlaybackClockSchema = z.object({
  source: z.literal("cutroom-preview"),
  type: z.literal("clock"),
  time: z.number().nonnegative().finite(),
  /** Absolute performance time, shared across the opaque iframe and editor. */
  at: z.number().nonnegative().finite(),
});
export type PlaybackClock = z.infer<typeof PlaybackClockSchema>;

export const PreviewUnloadedSchema = z.object({
  source: z.literal("cutroom-preview"),
  type: z.literal("unloaded"),
});

/** A clip's box in composition pixels, as the preview lays it out at the shown frame. */
export const PictureBoxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
});
export type PictureBox = z.infer<typeof PictureBoxSchema>;

/** A clip under a point on the picture. `painted` is false where only its empty box is. */
export const PictureHitSchema = z.object({
  clipId: z.string(),
  painted: z.boolean(),
  box: PictureBoxSchema,
});
export type PictureHit = z.infer<typeof PictureHitSchema>;

export const PreviewReplySchema = z.object({
  source: z.literal("cutroom-preview"),
  id: z.string().optional(),
  state: PreviewStateSchema,
  error: z.string().optional(),
  hits: z.array(PictureHitSchema).optional(),
});

export const ClipBoxSchema = z.object({
  source: z.literal("cutroom-preview"),
  type: z.literal("clip-box"),
  clipId: z.string(),
  box: PictureBoxSchema.nullable(),
});

export const RuntimeStateSchema = z.object({
  source: z.literal("hf-preview"),
  type: z.literal("state"),
  currentTime: z.number().nonnegative().finite(),
  isPlaying: z.boolean(),
});

export const PreviewLevelsSchema = z.object({
  source: z.literal("cutroom-preview"),
  type: z.literal("levels"),
  playing: z.boolean(),
  l: z.number().nonnegative().finite(),
  r: z.number().nonnegative().finite(),
});

export const PositionWarningSchema = z.object({
  source: z.literal("cutroom-preview"),
  type: z.literal("position-warning"),
  clipId: z.string(),
  time: z.number().nonnegative().finite(),
  overridden: z.boolean(),
});

export const PositionFoldSchema = z.object({
  source: z.literal("hf-preview"),
  type: z.literal("analytics"),
  event: z.literal("position_edit_fold_skipped"),
  properties: z.object({ hfId: z.string().nullable() }),
});

export const TextWarningSchema = PositionWarningSchema.extend({
  type: z.literal("text-warning"),
  text: z.string(),
});
