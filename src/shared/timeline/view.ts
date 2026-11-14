import { z } from "zod";

export const MIN_TRACK_HEIGHT = 28;
export const MAX_TRACK_HEIGHT = 200;
export const trackDensities = ["compact", "normal", "tall"] as const;
export const TimelineDestinationsSchema = z.object({
  video: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Index of the video destination track"),
  audio: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Index of the audio destination track"),
  videoEnabled: z
    .boolean()
    .optional()
    .describe(
      "Whether incoming picture is placed. Defaults to true; false remembers the chosen track but skips picture.",
    ),
  audioEnabled: z
    .boolean()
    .optional()
    .describe(
      "Whether incoming sound is placed, including a video's sound. Defaults to true; false remembers the chosen track but skips sound.",
    ),
});
export const TimelineViewSettingsSchema = z.object({
  density: z.enum(trackDensities).default("normal"),
  heights: z
    .record(
      z.string().regex(/^\d+$/),
      z.number().int().min(MIN_TRACK_HEIGHT).max(MAX_TRACK_HEIGHT),
    )
    .default({}),
  /** An omitted index uses the first track; an omitted enable flag means enabled. */
  destinations: TimelineDestinationsSchema.default({}),
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

export const SourceIdentitySchema = z.object({
  size: z.number().int().nonnegative(),
  duration: z.number().finite().positive(),
});
export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;
export const SourceViewSchema = SourceMarksSchema.safeExtend({
  identity: SourceIdentitySchema.nullable(),
});
export const SourceMarksSaveSchema = SourceViewSchema.safeExtend({
  identity: SourceIdentitySchema,
});
export type SourceMarksSave = z.infer<typeof SourceMarksSaveSchema>;
