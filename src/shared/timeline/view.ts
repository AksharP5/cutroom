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
});
export type TimelineViewSettings = z.infer<typeof TimelineViewSettingsSchema>;
export const emptyTimelineViewSettings = (): TimelineViewSettings => ({
  density: "normal",
  heights: {},
});
