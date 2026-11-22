import { z } from "zod";
import { parseRateLane } from "@hyperframes/core/speed-ramp";
import { localMediaPath } from "./media.ts";
import { offsetSourceTime } from "./timeline/time.ts";
import type { Clip, Fps, Timeline } from "./timeline/schema.ts";

export { MATTES_FOLDER } from "./media.ts";

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
  /** The source's grid: frame k at `start + k / rate`. */
  start: z.number().finite(),
  rate: z.number().positive(),
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
  /** A variable-rate source, read at the grid's slots rather than one picture per frame. */
  variable: z.boolean().default(false),
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

/** What the `matte` project event and `GET .../mattes` carry: the project's jobs and mattes. */
export const MatteStatusSchema = z.object({
  model: MatteModelStateSchema,
  jobs: z.array(MatteJobSchema),
  /** Every matte whose source is unchanged since it was made. */
  mattes: z.array(MatteEntrySchema),
});
export type MatteStatus = z.infer<typeof MatteStatusSchema>;

/** The source frame shown at media time `time`: the last one starting at or before it. */
export function matteFrameAt(
  grid: { start: number; rate: number },
  time: number,
) {
  return Math.max(0, Math.floor((time - grid.start) * grid.rate + 1e-6));
}

/** What a clip with its background removed shows, and why. */
export type ClipMatte =
  | { state: "ready" }
  | { state: "no-subject" }
  | { state: "waiting" | "needs-model"; job?: string }
  | { state: "running"; progress: number; elapsed: number; job: string }
  | { state: "failed"; error: string; memory: boolean; job: string };

/**
 * The matte state of source media times `[from, to)` of `src`, the part a clip plays. Ready once
 * every frame has a matte; frames the model found empty count as made. Until then the clip shows
 * its original picture.
 */
export function clipMatte(
  status: MatteStatus,
  src: string,
  from: number,
  to: number,
): ClipMatte & { done: [number, number][] } {
  const entries = status.mattes.filter((entry) => entry.src === src);
  const jobs = status.jobs.filter((job) => job.src === src);
  const grid = entries[0] ?? jobs[0];
  if (!grid) return { state: "waiting", done: [] };
  const first = matteFrameAt(grid, from);
  // Frames past the source's last are never made: a clip playing to the end needs none.
  const end = Math.min(
    grid.count,
    Math.max(first + 1, Math.ceil((to - grid.start) * grid.rate - 1e-6)),
  );
  const made = [
    ...entries,
    ...jobs
      .filter((job) => job.done > 0)
      .map((job) => ({ first: job.first, frames: job.done, subject: true })),
  ];
  /** Made frames within `[from, to)`, in order. */
  const madeIn = (from: number, to: number) =>
    made
      .map(
        ({ first: at, frames }) =>
          [Math.max(from, at), Math.min(to, at + frames)] as [number, number],
      )
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
  const count = (spans: [number, number][], from: number) => {
    let total = 0;
    let at = from;
    for (const [a, b] of spans) {
      total += Math.max(0, b - Math.max(a, at));
      at = Math.max(at, b);
    }
    return total;
  };
  const done = madeIn(first, end);
  const covered = count(done, first);
  const overlapping = jobs.filter(
    (job) => job.first < end && job.first + job.frames > first,
  );
  const failed = overlapping.find((job) => job.status === "failed");
  if (failed)
    return {
      state: "failed",
      error: failed.error ?? "",
      memory: failed.memory === true,
      job: failed.id,
      done,
    };
  const running = overlapping.find((job) => job.status === "running");
  if (running) {
    // The clip is ready only when its jobs finish, handles and all, so progress counts them too.
    const from = Math.min(first, ...overlapping.map((job) => job.first));
    const to = Math.max(
      end,
      ...overlapping.map((job) => job.first + job.frames),
    );
    return {
      state: "running",
      progress: count(madeIn(from, to), from) / (to - from),
      elapsed: running.elapsed,
      job: running.id,
      done,
    };
  }
  const queued = overlapping.find(
    (job) => job.status === "waiting" || job.status === "needs-model",
  );
  if (queued)
    return {
      state: queued.status === "needs-model" ? "needs-model" : "waiting",
      job: queued.id,
      done,
    };
  if (covered < end - first) return { state: "waiting", done };
  const inside = entries.filter(
    (entry) => entry.first < end && entry.first + entry.frames > first,
  );
  return inside.every((entry) => !entry.subject)
    ? { state: "no-subject", done }
    : { state: "ready", done };
}

/** A speed ramp, which mattes do not follow yet: the clip keeps its original picture. */
export const isRamped = (clip: Pick<Clip, "automation">) =>
  parseRateLane(clip.automation) !== null;

/** The source media times a video clip plays, without handles; null for clips with no source. */
export function clipSourceRange(clip: Clip, fps: Fps) {
  if (clip.mediaStart === null || !clip.src || isRamped(clip)) return null;
  return {
    from: clip.mediaStart,
    to: offsetSourceTime(
      clip.mediaStart,
      clip.duration,
      fps,
      clip.playbackRate,
    ),
  };
}

/** What each clip with its background removed needs matted: what it plays and a handle each side. */
export function matteNeeds(timeline: Timeline, composition: string) {
  return timeline.clips.flatMap((clip) => {
    const range =
      clip.background && clip.enabled && clipSourceRange(clip, timeline.fps);
    const src = range && localMediaPath(composition, clip.src!);
    if (!range || !src) return [];
    return [
      {
        clip: clip.id,
        src,
        from: Math.max(0, range.from - MATTE_HANDLE_SECONDS),
        to: range.to + MATTE_HANDLE_SECONDS,
      },
    ];
  });
}
