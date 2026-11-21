import { z } from "zod";
import { ExportRangeSchema } from "../../shared/export.ts";
import { GradeSchema } from "../../shared/timeline/grade.ts";

const frame = z.number().int().nonnegative();
const edge = z.number().int().nonnegative();
/**
 * How Cutroom's inspector placed a clip that is not a plain full-frame copy: its Position offset,
 * Scale and Rotation about the frame's centre, an inset Crop of its box in whole pixels, and
 * Opacity, which the browser applies in that order.
 */
const PlacementSchema = z.object({
  x: z.number(),
  y: z.number(),
  scaleX: z.number().positive(),
  scaleY: z.number().positive(),
  /** Degrees, clockwise. */
  rotation: z.number(),
  crop: z.object({ top: edge, right: edge, bottom: edge, left: edge }),
  opacity: z.number().min(0).max(1),
  /**
   * The page colour drawn where the clip leaves the frame uncovered or shows through, as
   * `#rrggbb`. Null when other clips or an unknown background lie beneath, so the clip must cover
   * the frame.
   */
  beneath: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .nullable(),
});
/** A run of frames whose picture is one clip, with nothing over it. */
const SourceSegmentSchema = z.object({
  kind: z.literal("source"),
  start: frame,
  end: frame,
  /** Project-relative source path, as the clip's `src` names it. */
  src: z.string().min(1),
  /** The authored in-point and its timeline anchor, even when a range starts later. */
  mediaStart: z.number().nonnegative(),
  clipStart: frame.optional(),
  /** A still image's fit and pixel size, which the server reads from the file once planned. */
  still: z
    .object({
      fit: z.enum(["contain", "cover", "fill"]),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    })
    .optional(),
  /** Absent for a plain full-frame clip, drawn as a straight copy of the source. */
  placement: PlacementSchema.optional(),
  /** The clip's colour grade, drawn as a 3D LUT baked from it before placement. */
  grade: GradeSchema.optional(),
});
/** A run of frames the browser draws. */
const CaptureSegmentSchema = z.object({
  kind: z.literal("capture"),
  start: frame,
  end: frame,
});
export const DirectPlanSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Frames in the whole composition, which the audio mix needs even for a range. */
  durationFrames: z.number().int().positive(),
  frames: ExportRangeSchema,
  /** In frame order, covering the range. At least one draws from a source. */
  segments: z
    .array(
      z.discriminatedUnion("kind", [SourceSegmentSchema, CaptureSegmentSchema]),
    )
    .min(1),
});
export type SourceSegment = z.infer<typeof SourceSegmentSchema>;
export type Placement = z.infer<typeof PlacementSchema>;
export type DirectPlan = z.infer<typeof DirectPlanSchema>;
