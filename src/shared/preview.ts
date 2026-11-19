import { MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import { z } from "zod";

export type EditFrame = { clipId: string; time: number };

export const TrackGainPreviewSchema = z.object({
  compositions: z.array(z.string()),
  signature: z.string(),
  gains: z.array(
    z.object({
      id: z.string().min(1),
      volume: z.number().nonnegative().max(MAX_AUDIO_GAIN),
    }),
  ),
});
export type TrackGainPreview = z.infer<typeof TrackGainPreviewSchema>;

export const PreviewStateSchema = z.object({
  mixSignature: z.string().optional(),
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

/** A clip drawn on the shown frame, and its box. */
export const ShownClipSchema = z.object({
  clipId: z.string(),
  box: PictureBoxSchema,
});
export type ShownClip = z.infer<typeof ShownClipSchema>;

export const CompositionDiagnosticSchema = z.object({
  file: z.string(),
  message: z.string(),
});
export type CompositionDiagnostic = z.infer<typeof CompositionDiagnosticSchema>;
export const CompositionDiagnosticsSchema = z.object({
  source: z.literal("cutroom-preview"),
  type: z.literal("composition-errors"),
  diagnostics: z.array(CompositionDiagnosticSchema).max(20),
});

export const PreviewTimingSchema = z.object({
  structure: z.string(),
  revision: z.string(),
  clips: z.array(
    z.object({
      id: z.string(),
      values: z.record(
        z.enum([
          "data-start",
          "data-duration",
          "data-end",
          "data-media-start",
          "data-playback-start",
          "data-playback-rate",
        ]),
        z.string().nullable(),
      ),
      title: z
        .object({
          attributes: z.array(z.tuple([z.string(), z.string().nullable()])),
          // Decoded text nodes and plain breaks, retaining the compiler's break identities.
          text: z.array(
            z.union([z.string(), z.object({ br: z.string().nullable() })]),
          ),
        })
        .nullable(),
      /**
       * Where a clip that can be added or removed in place sits: its parent and the gap
       * between that parent's other nodes. Null for a clip that is part of the structure.
       */
      slot: z.string().nullable(),
      /** Hash of the clip's element without its timing and title values. */
      body: z.string().nullable(),
      /** The whitespace text just before the clip, which comes and goes with it. */
      space: z.string(),
      /** The clip's served markup, for adding it to a loaded document. */
      html: z.string().nullable(),
    }),
  ),
  titleStyle: z.string().nullable(),
  /** The top-level composition's data-duration. */
  duration: z.string().nullable(),
});
export type PreviewTiming = z.infer<typeof PreviewTimingSchema>;

export const PreviewReplySchema = z.object({
  source: z.literal("cutroom-preview"),
  id: z.string().optional(),
  state: PreviewStateSchema,
  error: z.string().optional(),
  hits: z.array(PictureHitSchema).optional(),
  boxes: z.array(ShownClipSchema).optional(),
  timingRevision: z.string().optional(),
  mixApplied: z.boolean().optional(),
  diagnostics: z.array(CompositionDiagnosticSchema).max(20).optional(),
});

export const PreviewFrameStatusSchema = z.object({
  source: z.literal("cutroom-preview"),
  type: z.literal("frame-status"),
  error: z.string().nullable(),
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
  buffering: z.boolean().default(false),
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
  /** The Transform properties the composition's own styles or animation replace here. */
  overridden: z.array(z.enum(["Position", "Scale", "Rotation", "Crop"])),
});

export type PositionWarning = z.infer<typeof PositionWarningSchema>;

export const PositionFoldSchema = z.object({
  source: z.literal("hf-preview"),
  type: z.literal("analytics"),
  event: z.literal("position_edit_fold_skipped"),
  properties: z.object({ hfId: z.string().nullable() }),
});

export const TextWarningSchema = PositionWarningSchema.extend({
  type: z.literal("text-warning"),
  text: z.string(),
  overridden: z.boolean(),
});
