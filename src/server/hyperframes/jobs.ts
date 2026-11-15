import { existsSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { freemem, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { encoderJobOptions } from "@hyperframes/studio-server/encoder-options";
import type { StudioApiAdapter } from "@hyperframes/studio-server";
import type { RenderRequestOptions } from "@hyperframes/producer";
import { browserExecutable } from "./render";
import { planCaptureBrowsers } from "./exportMemory";
import { planDirectExport } from "./directPlan";
import {
  createOwnedDirectory,
  sweepOwnedDirectories,
} from "./ownedDirectories";
import { HttpError } from "../../shared/errors";
import { createJobMachine } from "../../shared/jobs";
import type { ExportOptions } from "../../shared/export";
import { ExportStageSchema } from "../../shared/export";
import {
  estimateExportStage,
  sampleExportRate,
} from "../../shared/exportEstimate";
import type { ExportRate } from "../../shared/exportEstimate";

type RenderOptions = Parameters<StudioApiAdapter["startRender"]>[0];
type RenderState = ReturnType<StudioApiAdapter["startRender"]> & {
  projectId: string;
  name: string;
  fps: RenderOptions["fps"];
  quality: "draft" | "standard" | "high";
  range: ExportOptions["range"];
  startedAt: number;
  finishedAt: number | null;
  estimate: ReturnType<typeof estimateExportStage>;
  stageProgress?: z.infer<typeof ExportStageSchema>;
  /** How the frames were drawn: straight from the sources, or by capturing the browser. */
  renderer?: "direct" | "capture";
  sizeBytes?: number;
  cancel: () => Promise<void>;
};
const WorkerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    progress: z.number(),
    stage: z.string().optional(),
    stageProgress: ExportStageSchema.optional(),
  }),
  z.object({
    type: z.literal("complete"),
    audioLoweredDb: z.number().optional(),
    renderer: z.enum(["direct", "capture"]).optional(),
  }),
  z.object({
    type: z.literal("error"),
    cancelled: z.boolean(),
    message: z.string(),
  }),
]);

async function diagnostics(stream: ReadableStream<Uint8Array>) {
  let tail = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream)
    tail = (tail + decoder.decode(chunk, { stream: true })).slice(-8000);
  return tail;
}

/** Each export writes into a folder with this prefix beside its destination. */
export const STAGING_PREFIX = ".cutroom-render-";
/** Chromium's process-singleton socket must fit a short path, so its temporary folder stays in the system's. */
const BROWSER_TEMP_PREFIX = "cutroom-render";
/** Extracted frames and range work, which reach gigabytes, go in the configured scratch folder on disk. */
const SCRATCH_PREFIX = "render";

async function removeRenderScratch(path: string) {
  await rm(path, { recursive: true, force: true });
  // Concurrent Chromium cleanup can leave an empty root after Bun's forced rm.
  await rmdir(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  });
}

/** Files are removed only after every process that could still write them has exited. */
async function processGroupExited(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return;
      throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error(
    "The export's browser processes did not exit, so its temporary files were left in place until the next export.",
  );
}

/**
 * The plan for drawing the export straight from its sources, or undefined when any frame, setting
 * or document feature needs the browser. Logs why, so a slow export can be explained.
 */
async function directPlan(
  options: RenderOptions,
  sources: Record<string, string> | undefined,
  range: ExportOptions["range"] | undefined,
) {
  const entry = options.composition ?? "index.html";
  const unsupported = (
    [
      [options.format !== "mp4", "it is not an MP4"],
      [entry !== "index.html", "it renders a sub-composition"],
      [options.useGpu, "it encodes on the GPU"],
      [options.outputResolution, "it changes the output size"],
      [
        options.pageMotionBlur && options.pageMotionBlur !== "off",
        "it adds motion blur",
      ],
      [
        options.variables && Object.keys(options.variables).length,
        "it sets composition variables",
      ],
      [options.keyframeIntervalSeconds !== undefined, "it sets keyframes"],
      [options.hdrMode !== undefined, "it sets an HDR mode"],
    ] as const
  ).find(([applies]) => applies)?.[1];
  if (unsupported) {
    console.info(`Exporting with frame capture: ${unsupported}.`);
    return undefined;
  }
  const path = join(options.project.dir, entry);
  // Without the file there is nothing to plan; frame capture reports the missing entry itself.
  const html =
    sources?.[path] ??
    (await readFile(path, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }));
  if (html === undefined) return undefined;
  const plan = planDirectExport(html, options.fps, range ?? null);
  if ("reason" in plan) {
    console.info(`Exporting with frame capture: ${plan.reason}.`);
    return undefined;
  }
  return { plan, html };
}

/** Producer runs in Node because its HTTP adapter changes globals that Bun's API server owns. */
export function createRenderWorkers(configuration: {
  /** Holds each export's extracted frames and range work. Keep it off RAM-backed /tmp. */
  scratchDir: string;
  /** Frames extracted for one export, kept for the next. Without it they go with the export's scratch. */
  frameCache?: { dir: string; maxBytes: number };
  workerPath?: string;
  /** Draw plain footage with FFmpeg instead of the browser where the planner allows. On by default. */
  directExport?: boolean;
  sourceOverrides?: (projectId: string) => Promise<Record<string, string>>;
  /** Sizes the export's capture browsers to the memory free when it starts. */
  workload?: (
    projectId: string,
  ) => Promise<{ mediaClips: number; durationFrames: number }>;
  stopTimeoutMs?: number;
  startupTimeoutMs?: number;
  removeScratch?: (path: string) => Promise<void>;
}) {
  const jobs = new Map<string, RenderState>();
  const remove = configuration.removeScratch ?? removeRenderScratch;
  /** Scratch whose browsers outlived the cleanup wait. The next export removes it. */
  const leftovers = new Set<string>();
  // A crashed or killed server leaves its scratch behind; reclaim it when the next one starts.
  void Promise.all([
    sweepOwnedDirectories(tmpdir(), BROWSER_TEMP_PREFIX),
    sweepOwnedDirectories(configuration.scratchDir, SCRATCH_PREFIX),
  ]).catch((error: unknown) =>
    console.warn(
      "Could not remove an earlier export's temporary files:",
      error instanceof Error ? error.message : error,
    ),
  );
  // A healthy start takes seconds, even for 500 clips. HyperFrames gives a stuck capture page
  // up to about 110 seconds (a 45 s readiness wait, then 60 s without frames) before retrying it.
  const startupTimeoutMs = configuration.startupTimeoutMs ?? 150_000;
  const subscribers = new Set<(job: RenderState) => void>();
  const prune = () => {
    for (const [id, job] of jobs)
      if (job.finishedAt !== null && Date.now() - job.finishedAt > 300_000)
        jobs.delete(id);
  };
  const active = () =>
    [...jobs.values()].find((job) => job.status === "rendering");
  let closing = false;
  return {
    get(jobId: string) {
      prune();
      return jobs.get(jobId);
    },
    active,
    subscribe(listener: (job: RenderState) => void) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    start(options: RenderOptions, output?: ExportOptions): RenderState {
      if (closing) throw new HttpError(503, "The renderer is shutting down.");
      const running = active();
      if (running)
        throw new HttpError(
          409,
          `Export "${running.name}" to "${basename(running.outputPath)}" is running. Please wait for it to finish or cancel it with export_cancel using jobId "${running.id}".`,
        );
      let worker: ReturnType<typeof Bun.spawn> | undefined;
      let errors: Promise<string> | undefined;
      let stopTimeout: ReturnType<typeof setTimeout> | undefined;
      let startupTimeout: ReturnType<typeof setTimeout> | undefined;
      const job = createJobMachine();
      const useDirect = configuration.directExport !== false;
      job.transition({ status: "running", progress: 0 });
      let failure: string | undefined;
      let cleanupFailure: string | undefined;
      let task: Promise<void>;
      let rate: ExportRate | null = null;
      const outputPath = output
        ? join(output.directory, output.filename)
        : options.outputPath;
      let temporary: string | undefined;
      let scratch: string | undefined;
      let staging: string | undefined;
      /** From the moment the file is linked into place the export has happened; a late cancel can't undo it. */
      let publishing = false;
      const isCancelling = () => job.state.status === "cancelling";
      const signalWorker = (signal: NodeJS.Signals) => {
        if (!worker) return;
        try {
          if (process.platform === "win32") worker.kill(signal);
          else process.kill(-worker.pid, signal);
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            throw error;
        }
      };
      const stopWorker = () => {
        if (!worker || worker.exitCode !== null) return;
        signalWorker("SIGTERM");
        stopTimeout ??= setTimeout(() => {
          signalWorker("SIGKILL");
        }, configuration.stopTimeoutMs ?? 2000);
      };
      const cancel = () => {
        if (job.state.status === "running" && !publishing) {
          job.transition({
            status: "cancelling",
            progress: job.state.progress,
          });
          stopWorker();
        }
        return task.then(() => {
          if (cleanupFailure) throw new Error(cleanupFailure);
        });
      };
      const state: RenderState = {
        id: options.jobId,
        projectId: options.project.id,
        name: options.project.title ?? options.project.id,
        fps: options.fps,
        quality:
          options.quality === "draft" || options.quality === "high"
            ? options.quality
            : "standard",
        range: output?.range ?? null,
        startedAt: Date.now(),
        finishedAt: null,
        get estimate() {
          return job.state.status === "running"
            ? estimateExportStage(rate, Date.now())
            : null;
        },
        get status() {
          switch (job.state.status) {
            case "done":
              return "complete";
            case "failed":
              return "failed";
            case "cancelled":
              return "cancelled";
            default:
              return "rendering";
          }
        },
        // The upstream cancel route assigns status before calling cancel().
        set status(value) {
          if (value === "cancelled") void cancel().catch(() => {});
        },
        get progress() {
          return job.state.progress * 100;
        },
        get error() {
          return job.state.status === "failed" ? job.state.error : undefined;
        },
        outputPath,
        cancel,
      };
      const started = performance.now();
      task = (async () => {
        const node = Bun.which("node");
        if (!node)
          throw new Error(
            "Node.js 22.18 or newer is required for local video exports.",
          );
        await mkdir(dirname(outputPath), { recursive: true });
        // Refuse a taken name before rendering. Publishing refuses it again, so no file is replaced.
        if (existsSync(outputPath))
          throw new Error(
            `A file named "${basename(outputPath)}" is already there. Choose another name.`,
          );
        const sources = await configuration.sourceOverrides?.(
          options.project.id,
        );
        if (isCancelling()) return;
        const direct = useDirect
          ? await directPlan(options, sources, output?.range)
          : undefined;
        const workload = await configuration.workload?.(options.project.id);
        const plan =
          workload &&
          planCaptureBrowsers({
            available: freemem(),
            mediaClips: workload.mediaClips,
            frames: output?.range
              ? output.range.end - output.range.start
              : workload.durationFrames,
          });
        // A direct export needs no browser. If a source turns out to need one, the worker fails
        // with this refusal rather than starting browsers that would not fit.
        if (plan && "refusal" in plan && !direct) throw new Error(plan.refusal);
        for (const path of leftovers)
          await remove(path).then(
            () => leftovers.delete(path),
            (error: unknown) =>
              console.warn(
                "Could not remove an earlier export's temporary files:",
                error instanceof Error ? error.message : error,
              ),
          );
        // The worker's temporary files stay outside the project, which the producer copies.
        temporary = await createOwnedDirectory(tmpdir(), BROWSER_TEMP_PREFIX);
        scratch = await createOwnedDirectory(
          configuration.scratchDir,
          SCRATCH_PREFIX,
        );
        // The producer puts work and transaction folders beside the file it writes. Writing into an
        // owned folder on the destination's filesystem lets cancellation remove all of it, and the
        // finished file is linked into place without replacing anything that appeared meanwhile.
        staging = await mkdtemp(join(dirname(outputPath), STAGING_PREFIX));
        const rendered = join(staging, basename(outputPath));
        if (isCancelling()) return;
        const config: Omit<RenderRequestOptions, "engineConfig"> = {
          fps: options.fps,
          quality:
            options.quality === "draft" || options.quality === "high"
              ? options.quality
              : "standard",
          format: options.format,
          gifLoop: options.gifLoop,
          outputResolution: options.outputResolution,
          entryFile: options.composition,
          variables: options.variables,
          ...encoderJobOptions(options),
          useGpu: options.useGpu,
          pageMotionBlur: options.pageMotionBlur,
        };
        const child = Bun.spawn(
          [
            node,
            "--experimental-strip-types",
            configuration.workerPath ??
              fileURLToPath(new URL("./renderWorker.ts", import.meta.url)),
          ],
          {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            detached: process.platform !== "win32",
            env: {
              ...process.env,
              HYPERFRAMES_NO_TELEMETRY: "1",
              DO_NOT_TRACK: "1",
              ...(browserExecutable()
                ? { PRODUCER_HEADLESS_SHELL_PATH: browserExecutable() }
                : {}),
              TMPDIR: temporary,
              HYPERFRAMES_EXTRACT_CACHE_DIR:
                configuration.frameCache?.dir ?? join(scratch, "frames"),
              ...(configuration.frameCache
                ? {
                    HYPERFRAMES_EXTRACT_CACHE_MAX_MB: String(
                      configuration.frameCache.maxBytes / 1024 ** 2,
                    ),
                  }
                : {}),
              ...(plan && "browsers" in plan
                ? {
                    PRODUCER_MAX_WORKERS: String(plan.browsers),
                    // HyperFrames otherwise starts two browsers for 120 frames or more, whatever the limit.
                    PRODUCER_MIN_PARALLEL_FRAMES: String(
                      Number.MAX_SAFE_INTEGER,
                    ),
                  }
                : {}),
            },
          },
        );
        worker = child;
        child.stdin.write(
          JSON.stringify({
            projectDir: options.project.dir,
            outputPath: rendered,
            options: config,
            sources,
            range: output?.range,
            scratchDir: scratch,
            direct: direct && {
              ...direct,
              captureRefusal:
                plan && "refusal" in plan ? plan.refusal : undefined,
            },
          }),
        );
        child.stdin.end();
        errors = diagnostics(child.stderr);
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let remaining = "";
        let completed = false;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          remaining += decoder.decode(value, { stream: true });
          const lines = remaining.split("\n");
          remaining = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("CUTROOM_RENDER:")) continue;
            const event = WorkerEvent.parse(
              JSON.parse(line.slice("CUTROOM_RENDER:".length)),
            );
            if (event.type === "progress") {
              if (job.state.status !== "running") continue;
              job.transition({
                status: "running",
                progress: Math.max(
                  job.state.progress,
                  Math.min(1, event.progress / 100),
                ),
              });
              const advanced = event.stage !== state.stage;
              state.stage = event.stage;
              state.stageProgress = event.stageProgress;
              if (event.stageProgress?.code !== "start_browsers") {
                clearTimeout(startupTimeout);
                startupTimeout = undefined;
              } else if (advanced || !startupTimeout) {
                // Each startup step restarts the limit, including HyperFrames moving a stuck page to a fresh browser.
                clearTimeout(startupTimeout);
                startupTimeout = setTimeout(() => {
                  failure = `The export's browsers made no progress starting for ${Math.round(startupTimeoutMs / 1000)} seconds, so it was stopped. Try again, and close other apps if memory is low.`;
                  stopWorker();
                }, startupTimeoutMs);
              }
              rate = sampleExportRate(rate, event.stageProgress, Date.now());
            }
            // A worker stopped for a startup stall reports the abort; keep the stall as the cause.
            if (event.type === "error" && !failure) {
              failure = event.message;
              if (event.cancelled) void cancel().catch(() => {});
            }
            if (event.type === "complete") {
              completed = true;
              state.audioLoweredDb = event.audioLoweredDb;
              state.renderer = event.renderer;
            }
          }
        }
        const exitCode = await child.exited;
        const stderr = await errors;
        if (isCancelling()) return;
        if (!completed || exitCode !== 0)
          throw new Error(
            failure ||
              // Startup failures cannot send a structured event. Keep the bounded stderr tail's cause.
              stderr.trim() ||
              `Renderer exited with code ${exitCode}.`,
          );
        publishing = true;
        await link(rendered, outputPath).catch((error: unknown) => {
          const code =
            error instanceof Error && "code" in error ? String(error.code) : "";
          throw new Error(
            code === "EEXIST"
              ? `A file named "${basename(outputPath)}" appeared there during the export. Choose another name and export again.`
              : `This folder can't receive the export (${code || String(error)}). Choose another folder.`,
          );
        });
        state.sizeBytes = (await stat(outputPath)).size;
        state.stage = "Finished";
        await writeFile(
          options.outputPath.replace(/\.(mp4|webm|mov|gif)$/, ".meta.json"),
          JSON.stringify({
            status: "complete",
            durationMs: Math.round(performance.now() - started),
          }),
        );
      })()
        .catch((error: unknown) => {
          failure = error instanceof Error ? error.message : String(error);
          stopWorker();
        })
        .finally(async () => {
          try {
            await worker?.exited;
            signalWorker("SIGKILL");
            // The group includes Chromium, which writes its profile into the scratch folder.
            if (worker && process.platform !== "win32")
              await processGroupExited(worker.pid, 5000).catch(
                (error: unknown) => {
                  for (const path of [temporary, scratch, staging])
                    if (path) leftovers.add(path);
                  throw error;
                },
              );
            await errors;
            const cleanup: Promise<unknown>[] = [];
            // Cleanup touches only what this job made; the destination is the user's once linked.
            if (isCancelling() || failure)
              cleanup.push(
                rm(
                  options.outputPath.replace(
                    /\.(mp4|webm|mov|gif)$/,
                    ".meta.json",
                  ),
                  { force: true },
                ),
              );
            if (temporary) cleanup.push(remove(temporary));
            if (scratch) cleanup.push(remove(scratch));
            // A folder moved mid-export takes staging with it; say so rather than claim it was removed.
            if (staging)
              cleanup.push(
                existsSync(staging)
                  ? remove(staging)
                  : Promise.reject(
                      new Error(
                        `The export folder moved during the export, so its hidden ${basename(staging)} folder, which may hold the render, could not be removed.`,
                      ),
                    ),
              );
            const failures = (await Promise.allSettled(cleanup))
              .filter((result) => result.status === "rejected")
              .map((result) =>
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
              );
            if (failures.length) throw new Error(failures.join("\n"));
          } catch (error) {
            // Keep the render's own cause first; the cleanup problem follows it.
            cleanupFailure = [
              failure,
              error instanceof Error ? error.message : String(error),
            ]
              .filter(Boolean)
              .join(" ");
          } finally {
            clearTimeout(stopTimeout);
            clearTimeout(startupTimeout);
            if (cleanupFailure)
              job.transition({
                status: "failed",
                progress: job.state.progress,
                error: cleanupFailure,
              });
            else if (isCancelling())
              job.transition({
                status: "cancelled",
                progress: job.state.progress,
              });
            else if (failure)
              job.transition({
                status: "failed",
                progress: job.state.progress,
                error: failure,
              });
            else job.transition({ status: "done", progress: 1 });
            state.finishedAt = Date.now();
          }
        });
      prune();
      jobs.set(options.jobId, state);
      for (const listener of subscribers) listener(state);
      return state;
    },
    async cancelAll() {
      closing = true;
      const results = await Promise.allSettled(
        [...jobs.values()]
          .filter((state) => state.status === "rendering")
          .map((state) => state.cancel()),
      );
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length)
        throw new AggregateError(failures, "Render cleanup failed.");
    },
  };
}
