import { z } from "zod";

export const MIN_TRACK_HEIGHT = 28;
export const MAX_TRACK_HEIGHT = 200;
export const trackDensities = ["compact", "normal", "tall"] as const;
export const TimelineViewSettingsSchema = z.object({
  density: z.enum(trackDensities).default("normal"),
  heights: z
    .record(
      z.string().regex(/^\d+$/),
      z.number().int().min(MIN_TRACK_HEIGHT).max(MAX_TRACK_HEIGHT),
    )
    .default({}),
  /** Track indexes chosen as the destination of each kind. A kind left out uses its first track. */
  destinations: z
    .object({
      video: z.number().int().nonnegative().optional(),
      audio: z.number().int().nonnegative().optional(),
    })
    .default({}),
});
export type TimelineViewSettings = z.infer<typeof TimelineViewSettingsSchema>;
/** Settings as a client may send them: anything left out takes its default. */
export type TimelineViewSettingsInput = z.input<
  typeof TimelineViewSettingsSchema
>;
export const emptyTimelineViewSettings = (): TimelineViewSettings => ({
  density: "normal",
  heights: {},
  destinations: {},
});

/** Source seconds, independent of the open composition's frame rate; Out is exclusive. */
export const SourceMarksSchema = z
  .object({
    in: z.number().finite().nonnegative().nullable(),
    out: z.number().finite().positive().nullable(),
  })
  .refine(
    (marks) => marks.in === null || marks.out === null || marks.out > marks.in,
    "Out must follow In",
  );
export type SourceMarks = z.infer<typeof SourceMarksSchema>;
export const emptySourceMarks = (): SourceMarks => ({ in: null, out: null });
