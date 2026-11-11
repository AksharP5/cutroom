import { z } from "zod";
import type { Timeline } from "./timeline/schema";

export const ExportRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .refine(({ start, end }) => end > start, "Out must follow In.");

/** Extra intent on the existing Studio render request. Omit it for Studio's usual defaults. */
export const ExportOptionsSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^/\\\x00-\x1f]+\.mp4$/i, "Use an MP4 file name without folders."),
  directory: z.string().trim().min(1),
  range: ExportRangeSchema.nullable(),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

export const exportQualities = ["draft", "standard", "high"] as const;
export const ExportQualitySchema = z.enum(exportQualities);
export type ExportQuality = z.infer<typeof ExportQualitySchema>;

export const ExportStageSchema = z.object({
  code: z.enum([
    "compile",
    "extract_video",
    "process_audio",
    "start_browsers",
    "capture",
    "encode",
    "assemble",
  ]),
  done: z.number().nonnegative().optional(),
  total: z.number().positive().optional(),
});
export type ExportStage = z.infer<typeof ExportStageSchema>;

/**
 * Marks are half-open in the engine. A lone mark never silently shortens the export.
 * Out past the end (left there by a ripple delete) stops at the end, as playback does.
 */
export function exportRange(
  timeline: Pick<Timeline, "range" | "duration">,
  choice: "timeline" | "marks",
) {
  if (timeline.duration <= 0) throw new Error("The timeline is empty.");
  if (choice === "timeline") return { start: 0, end: timeline.duration };
  const { in: start, out } = timeline.range;
  if (start === null || out === null)
    throw new Error("Set both In and Out first.");
  const end = Math.min(out, timeline.duration);
  if (start >= end) throw new Error("In and Out must be inside the timeline.");
  return { start, end };
}

export const defaultExportRange = (timeline: Pick<Timeline, "range">) =>
  timeline.range.in !== null && timeline.range.out !== null
    ? "marks"
    : "timeline";
