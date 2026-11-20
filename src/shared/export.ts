import { z } from "zod";
import { FpsSchema } from "./timeline/schema.ts";
import type { Fps, Timeline } from "./timeline/schema";
import { VariableValuesSchema } from "./variables.ts";

export const exportFormats = ["mp4", "mov", "webm", "gif"] as const;
export const ExportFormatSchema = z.enum(exportFormats);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;
export const GifLoopSchema = z.number().int().min(0).max(65535);
/** What each format carries. MOV and WebM keep transparency, for overlays in another editor. */
export const exportFormatDetails: Record<ExportFormat, string> = {
  mp4: "H.264 / AAC",
  mov: "ProRes 4444 with alpha / AAC",
  webm: "VP9 with alpha / Opus",
  gif: "Animated, no sound",
};

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
    .regex(
      /^[^/\\\x00-\x1f]+\.(mp4|mov|webm|gif)$/i,
      "Use an MP4, MOV, WebM or GIF file name without folders.",
    ),
  directory: z.string().trim().min(1),
  /** In the composition's frames. */
  range: ExportRangeSchema.nullable(),
  /** Encode on the GPU when the export is drawn wholly from its sources and NVENC works. */
  gpu: z.boolean().default(true),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

export const ExportDestinationSchema = ExportOptionsSchema.pick({
  filename: true,
  directory: true,
});

export type ExportDestination = z.infer<typeof ExportDestinationSchema>;

export const exportQualities = ["draft", "standard", "high"] as const;
export const ExportQualitySchema = z.enum(exportQualities);
export type ExportQuality = z.infer<typeof ExportQualitySchema>;

export const exportSizes = ["project", "1080p", "4k"] as const;
export const ExportSizeSchema = z.enum(exportSizes);
export type ExportSize = z.infer<typeof ExportSizeSchema>;

const sizePresets = {
  landscape: { "1080p": [1920, 1080], "4k": [3840, 2160] },
  portrait: { "1080p": [1080, 1920], "4k": [2160, 3840] },
  square: { "1080p": [1080, 1080], "4k": [2160, 2160] },
} as const;

/**
 * The frame an export renders: the composition's own, or 1080p or 4K in its orientation. The
 * browser draws the page at the larger size rather than stretching frames, so it may only grow
 * by a whole factor, as HyperFrames' supersampling requires. `resolution` is HyperFrames' preset.
 */
export function exportSize(
  choice: ExportSize,
  composition: { width: number; height: number },
):
  | {
      width: number;
      height: number;
      resolution?: `${keyof typeof sizePresets}${"" | "-4k"}`;
    }
  | { problem: string } {
  const { width, height } = composition;
  if (choice === "project") return { width, height };
  const orientation =
    width > height ? "landscape" : width < height ? "portrait" : "square";
  const [targetWidth, targetHeight] = sizePresets[orientation][choice];
  const name = choice === "4k" ? "4K" : choice;
  if (width * targetHeight !== height * targetWidth)
    return {
      problem: `${name} needs a 16:9, 9:16 or square composition, and this one is ${width} × ${height}.`,
    };
  const scale = targetWidth / width;
  if (scale > 1 && !Number.isInteger(scale))
    return {
      problem: `${name} is ${scale} times this ${width} × ${height} composition. Only whole multiples are drawn sharp.`,
    };
  if (scale === 1) return { width, height };
  return {
    width: targetWidth,
    height: targetHeight,
    resolution: `${orientation}${choice === "4k" ? "-4k" : ""}`,
  };
}

export const exportRates = [24, 25, 30, 60] as const;
export const ExportRateSchema = z.literal(exportRates);

/** The rate an export plays at. GIF stops at 30 fps, as HyperFrames' render route does. */
export const exportFps = (format: ExportFormat, fps: Fps): Fps =>
  format === "gif" && fps.num / fps.den > 30 ? { num: 30, den: 1 } : fps;

/** A composition's frames as frames of an export at another rate: those whose time falls inside. */
export function retimeFrames(
  frames: { start: number; end: number },
  from: Fps,
  to: Fps,
) {
  const at = (frame: number) =>
    Math.ceil((frame * from.den * to.num) / (from.num * to.den));
  return { start: at(frames.start), end: at(frames.end) };
}

export const ExportStartSchema = ExportDestinationSchema.partial().extend({
  composition: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The composition to render, such as compositions/intro.html; the root, index.html, when omitted. Ranges, marks, size and rate are that composition's",
    ),
  range: z.union([z.enum(["timeline", "marks"]), ExportRangeSchema]).optional(),
  quality: ExportQualitySchema.default("standard"),
  format: z
    .enum([...exportFormats, "resolve"])
    .default("mp4")
    .describe(
      "resolve writes a folder for DaVinci Resolve instead of rendering: the timeline as FCPXML linked to the original media, its markers, and a summary of what Resolve can't show",
    ),
  copyMedia: z
    .boolean()
    .default(false)
    .describe(
      "resolve only: copy the media into the folder instead of linking it where it is",
    ),
  gifLoop: GifLoopSchema.optional().describe(
    "GIF loop count. Zero or omitted repeats forever.",
  ),
  size: ExportSizeSchema.default("project").describe(
    "project renders at the composition's size; 1080p and 4K draw the page at that size in its orientation, so a 4K export of a 1080p project is sharp",
  ),
  fps: ExportRateSchema.optional().describe(
    "Frames per second; the composition's own rate when omitted. GIF stops at 30",
  ),
  gpu: z
    .boolean()
    .default(true)
    .describe(
      "Encode on an NVIDIA GPU when every frame is drawn from the sources and NVENC works",
    ),
  variables: VariableValuesSchema.optional().describe(
    "Composition variable overrides by id, as variables_list declares them, like hyperframes render --variables. Each value must fit its declaration; omitted variables render their defaults. The preview's overrides are not applied unless passed here",
  ),
});

/** What a Resolve export wrote: a new folder holding the timeline, its markers and a summary. */
export const ResolveExportSchema = z.object({
  outputPath: z.string().describe("The new folder"),
  timeline: z.string().describe("The FCPXML file to import in Resolve"),
  markers: z
    .string()
    .nullable()
    .describe(
      "The marker list, for Timeline > Import > Timeline Markers from EDL; null without markers",
    ),
  summary: z.string(),
  importScript: z
    .string()
    .nullable()
    .optional()
    .describe("Resolve console script for the complete timeline import"),
  gradeScript: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Resolve console script that imports the timeline and applies the grades",
    ),
  notes: z
    .array(z.string())
    .describe("What Resolve won't show as Cutroom does, one sentence each"),
});
export type ResolveExport = z.infer<typeof ResolveExportSchema>;

/** What an export of one composition is called: the project, then the scene's file name. */
export const compositionExportName = (
  projectName: string,
  composition: string,
) =>
  composition === "index.html"
    ? projectName
    : `${projectName} ${(composition.split("/").at(-1) ?? composition).replace(/\.html?$/i, "")}`;

export const exportFilename = (name: string, format: ExportFormat = "mp4") =>
  `${
    name
      .replace(/[/\\\x00-\x1f]/g, "-")
      .trim()
      .slice(0, 199 - format.length) || "Cut"
  }.${format}`;

/** A finished render Cutroom made for a project, wherever it was saved. */
export const RenderFileSchema = z.object({
  path: z.string(),
  format: ExportFormatSchema,
  sizeBytes: z.number().nonnegative(),
  modifiedAt: z.number(),
});
export type RenderFile = z.infer<typeof RenderFileSchema>;
export const RendersSchema = z.object({ renders: z.array(RenderFileSchema) });

/** A frame to save as a PNG still, named by the timecode the person saw. */
export const StillRequestSchema = z.object({
  composition: z.string().min(1).default("index.html"),
  time: z.number().nonnegative().finite(),
  timecode: z.string().regex(/^\d{2}:\d{2}:\d{2}:\d{2}$/),
});
export const StillFrameRequestSchema = StillRequestSchema.pick({
  composition: true,
}).extend({
  frame: z
    .number()
    .int()
    .nonnegative()
    .describe("Zero-based composition frame"),
});
export const StillSchema = z.object({ path: z.string(), filename: z.string() });

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

export const ExportJobSchema = z.object({
  jobId: z.string(),
  projectId: z.string(),
  name: z.string(),
  status: z.enum(["rendering", "complete", "failed", "cancelled"]),
  progress: z.number().min(0).max(100),
  stage: z.string(),
  stageProgress: ExportStageSchema.optional(),
  estimate: z
    .object({ milliseconds: z.number(), stage: z.string() })
    .nullable(),
  outputPath: z.string(),
  sizeBytes: z.number().nonnegative().nullable(),
  audioLoweredDb: z.number().optional(),
  error: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  fps: FpsSchema,
  quality: ExportQualitySchema,
  format: ExportFormatSchema,
  /** The rendered frame; null for a render started without Cutroom's options. */
  size: z.object({ width: z.number(), height: z.number() }).nullable(),
  /** In the export's own frames, at `fps`. */
  range: ExportRangeSchema.nullable(),
  /** Set once an export drawn from its sources finishes. */
  encoder: z.enum(["libx264", "h264_nvenc"]).optional(),
});

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
