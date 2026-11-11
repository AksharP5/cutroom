import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { encoderJobOptions } from "@hyperframes/studio-server/encoder-options";
import type { StudioApiAdapter } from "@hyperframes/studio-server";
import type { RenderRequestOptions } from "@hyperframes/producer";
import { browserExecutable } from "./render";
import { HttpError } from "../../shared/errors";
import { createJobMachine } from "../../shared/jobs";
import type { ExportOptions } from "../../shared/export";
import { ExportStageSchema } from "../../shared/export";

type RenderOptions = Parameters<StudioApiAdapter["startRender"]>[0];
type RenderState = ReturnType<StudioApiAdapter["startRender"]> & {
  stageProgress?: z.infer<typeof ExportStageSchema>;
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

async function removeRenderScratch(path: string) {
  await rm(path, { recursive: true, force: true });
  // Concurrent Chromium cleanup can leave an empty root after Bun's forced rm.
  await rmdir(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  });
}

/** Producer runs in Node because its HTTP adapter changes globals that Bun's API server owns. */
export function createRenderWorkers(
  configuration: {
    workerPath?: string;
    sourceOverrides?: (projectId: string) => Promise<Record<string, string>>;
    stopTimeoutMs?: number;
    removeScratch?: (path: string) => Promise<void>;
  } = {},
) {
  const running = new Map<string, RenderState>();
  let closing = false;
  return {
    get(jobId: string) {
      return running.get(jobId);
    },
    start(options: RenderOptions, output?: ExportOptions): RenderState {
      if (closing) throw new HttpError(503, "The renderer is shutting down.");
      let worker: ReturnType<typeof Bun.spawn> | undefined;
      let errors: Promise<string> | undefined;
      let stopTimeout: ReturnType<typeof setTimeout> | undefined;
      const job = createJobMachine();
      job.transition({ status: "running", progress: 0 });
      let failure: string | undefined;
      let cleanupFailure: string | undefined;
      let task: Promise<void>;
      const outputPath = output
        ? join(output.directory, output.filename)
        : options.outputPath;
      let temporary: string | undefined;
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
        }, configuration.stopTimeoutMs ?? 6000);
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
        // The worker's temporary files stay outside the project, which the producer copies.
        temporary = await mkdtemp(join(tmpdir(), "cutroom-render-"));
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
        const sources = await configuration.sourceOverrides?.(
          options.project.id,
        );
        if (isCancelling()) return;
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
              state.stage = event.stage;
              state.stageProgress = event.stageProgress;
            }
            if (event.type === "error") {
              failure = event.message;
              if (event.cancelled) void cancel().catch(() => {});
            }
            if (event.type === "complete") {
              completed = true;
              state.audioLoweredDb = event.audioLoweredDb;
            }
          }
        }
        const exitCode = await child.exited;
        const stderr = await errors;
        if (isCancelling()) return;
        if (!completed || exitCode !== 0)
          throw new Error(
            failure ||
              // The tail names the cause; the full log is far too long for a dialog.
              stderr.trim().split("\n").slice(-2).join("\n") ||
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
            const remove = configuration.removeScratch ?? removeRenderScratch;
            if (temporary) cleanup.push(remove(temporary));
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
            running.delete(options.jobId);
          }
        });
      running.set(options.jobId, state);
      return state;
    },
    async cancelAll() {
      closing = true;
      const results = await Promise.allSettled(
        [...running.values()].map((state) => state.cancel()),
      );
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length)
        throw new AggregateError(failures, "Render cleanup failed.");
    },
  };
}
