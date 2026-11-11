import { z } from "zod";

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

export const PreviewReplySchema = z.object({
  source: z.literal("cutroom-preview"),
  id: z.string().optional(),
  state: PreviewStateSchema,
  error: z.string().optional(),
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
