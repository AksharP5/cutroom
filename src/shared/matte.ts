import { z } from "zod";

/** The folder beside the composition that holds mattes, an ordinary visible one like `luts`. */
export const MATTES_FOLDER = "mattes";

/** Seconds of source kept matted on each side of what a clip plays, so small trims need no work. */
export const MATTE_HANDLE_SECONDS = 1;

/** The background-removal weights, as HyperFrames' `remove-background` command downloads them. */
export const MATTE_MODEL = {
  name: "u2net_human_seg",
  url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx",
  bytes: 175_997_641,
  /** The weights are trusted only with these bytes; a truncated or altered file is fetched again. */
  sha256: "01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c",
} as const;

/** The download question's size, as "168 MB". */
export const matteModelSize = `${Math.round(MATTE_MODEL.bytes / 2 ** 20)} MB`;

const frame = z.number().int().nonnegative();

/**
 * One piece of matte work: source frames `[first, first + frames)` of one file, on the grid
 * `start + k / rate` the footage pipeline and export read it on.
 */
export const MatteJobSchema = z.object({
  id: z.string(),
  /** The source, relative to the project. */
  src: z.string(),
  first: frame,
  frames: z.number().int().positive(),
  /** Frames in the source: a clip that plays to its end needs no frame past it. */
  count: z.number().int().positive(),
  /** Frames already made. */
  done: frame,
  status: z.enum([
    "waiting",
    "running",
    "needs-model",
    "done",
    "stopped",
    "failed",
    "no-subject",
  ]),
  /** Seconds since it started running. */
  elapsed: z.number().nonnegative(),
  /** The raw failure, for Details. */
  error: z.string().optional(),
  /** Set when the failure was running out of memory. */
  memory: z.literal(true).optional(),
});
export type MatteJob = z.infer<typeof MatteJobSchema>;

export const MatteModelStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }),
  z.object({ status: z.literal("missing"), bytes: z.number().int() }),
  z.object({ status: z.literal("downloading"), progress: z.number() }),
  z.object({ status: z.literal("failed"), error: z.string() }),
  /** The ONNX runtime is not installed; Cutroom does not install runtimes. */
  z.object({ status: z.literal("no-runtime"), error: z.string() }),
]);
export type MatteModelState = z.infer<typeof MatteModelStateSchema>;

/** What the `matte` project event and `GET .../mattes` carry: every job of the project. */
export const MatteStatusSchema = z.object({
  model: MatteModelStateSchema,
  jobs: z.array(MatteJobSchema),
});
export type MatteStatus = z.infer<typeof MatteStatusSchema>;

/** A matte file's source frames, as the manifest records them. */
export const MatteEntrySchema = z.object({
  /** The matte, relative to the project: a file directly in `mattes/`, or empty with no subject. */
  file: z
    .string()
    .regex(/^(mattes\/[^/\\]+\.mp4)?$/)
    .refine((file) => !file.includes(".."), "A matte stays in mattes/."),
  src: z.string(),
  /** The source's size and modification time when the matte was made; any change makes it stale. */
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  first: frame,
  frames: z.number().int().positive(),
  /** Source media time of frame 0 and frames per second: frame k is at `start + k / rate`. */
  start: z.number().finite(),
  rate: z.number().positive(),
  /** Frames in the source when the matte was made. */
  count: z.number().int().positive(),
  model: z.string(),
  /** False when the model found nothing to keep; no file is written. */
  subject: z.boolean(),
});
export type MatteEntry = z.infer<typeof MatteEntrySchema>;

export const MatteManifestSchema = z.object({
  version: z.literal(1),
  mattes: z.array(MatteEntrySchema),
});
export type MatteManifest = z.infer<typeof MatteManifestSchema>;

/** The source frame shown at media time `time`: the last one starting at or before it. */
export function matteFrameAt(
  grid: { start: number; rate: number },
  time: number,
) {
  return Math.max(0, Math.floor((time - grid.start) * grid.rate + 1e-6));
}
