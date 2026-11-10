import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { encoderJobOptions } from "@hyperframes/studio-server/encoder-options";
import type { StudioApiAdapter } from "@hyperframes/studio-server";
import type { RenderRequestOptions } from "@hyperframes/producer";
import { browserExecutable } from "./render";
import { HttpError } from "../../shared/errors";
import { createJobMachine } from "../../shared/jobs";

type RenderOptions = Parameters<StudioApiAdapter["startRender"]>[0];
type RenderState = ReturnType<StudioApiAdapter["startRender"]>;
const WorkerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    progress: z.number(),
    stage: z.string().optional(),
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

/** Producer runs in Node because its HTTP adapter changes globals that Bun's API server owns. */
export function createRenderWorkers(
  configuration: { workerPath?: string; stopTimeoutMs?: number } = {},
) {
  const running = new Map<() => void, Promise<void>>();
  let closing = false;
  return {
    start(options: RenderOptions): RenderState {
      if (closing) throw new HttpError(503, "The renderer is shutting down.");
      let worker: ReturnType<typeof Bun.spawn> | undefined;
      let errors: Promise<string> | undefined;
      let stopTimeout: ReturnType<typeof setTimeout> | undefined;
      const job = createJobMachine();
      job.transition({ status: "running", progress: 0 });
      let failure: string | undefined;
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
        if (job.state.status !== "running") return;
        job.transition({ status: "cancelling", progress: job.state.progress });
        stopWorker();
      };
      const state: RenderState = {
        id: options.jobId,
        get status() {
          switch (job.state.status) {
            case "done":
              return "complete";
            case "failed":
              return "failed";
            case "cancelling":
            case "cancelled":
              return "cancelled";
            default:
              return "rendering";
          }
        },
        // The upstream cancel route assigns status before calling cancel().
        set status(value) {
          if (value === "cancelled") cancel();
        },
        get progress() {
          return job.state.progress * 100;
        },
        get error() {
          return job.state.status === "failed" ? job.state.error : undefined;
        },
        outputPath: options.outputPath,
        cancel,
      };
      const started = performance.now();
      const task = (async () => {
        const node = Bun.which("node");
        if (!node)
          throw new Error(
            "Node.js 22.18 or newer is required for local video exports.",
          );
        await mkdir(dirname(options.outputPath), { recursive: true });
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
            },
          },
        );
        worker = child;
        child.stdin.write(
          JSON.stringify({
            projectDir: options.project.dir,
            outputPath: options.outputPath,
            options: config,
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
                progress: Math.max(0, Math.min(1, event.progress / 100)),
              });
              state.stage = event.stage;
            }
            if (event.type === "error") {
              failure = event.message;
              if (event.cancelled) cancel();
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
              stderr.trim() ||
              `Renderer exited with code ${exitCode}.`,
          );
        await writeFile(
          options.outputPath.replace(/\.(mp4|webm|mov|gif)$/, ".meta.json"),
          JSON.stringify({
            status: "complete",
            durationMs: Math.round(performance.now() - started),
          }),
        );
        if (isCancelling()) return;
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
            if (isCancelling() || failure) {
              await rm(options.outputPath, { force: true });
              await rm(
                options.outputPath.replace(
                  /\.(mp4|webm|mov|gif)$/,
                  ".meta.json",
                ),
                { force: true },
              );
            }
          } catch (error) {
            failure = `Render cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
          } finally {
            clearTimeout(stopTimeout);
            if (isCancelling())
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
            running.delete(cancel);
          }
        });
      running.set(cancel, task);
      return state;
    },
    async cancelAll() {
      closing = true;
      for (const cancel of running.keys()) cancel();
      await Promise.all([...running.values()]);
    },
  };
}
