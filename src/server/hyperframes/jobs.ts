import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { encoderJobOptions } from "@hyperframes/studio-server/encoder-options";
import type { StudioApiAdapter } from "@hyperframes/studio-server";
import type { RenderRequestOptions } from "@hyperframes/producer";
import { browserExecutable } from "./render";

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
export function createRenderWorkers() {
  const running = new Set<() => void>();
  return {
    start(options: RenderOptions): RenderState {
      let worker: ReturnType<typeof Bun.spawn> | undefined;
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        state.status = "cancelled";
        worker?.kill("SIGTERM");
      };
      const state: RenderState = {
        id: options.jobId,
        status: "rendering",
        progress: 0,
        outputPath: options.outputPath,
        cancel,
      };
      running.add(cancel);
      const started = performance.now();
      void (async () => {
        const node = Bun.which("node");
        if (!node)
          throw new Error(
            "Node.js 22.18 or newer is required for local video exports.",
          );
        await mkdir(dirname(options.outputPath), { recursive: true });
        if (cancelled) return;
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
            fileURLToPath(new URL("./renderWorker.ts", import.meta.url)),
          ],
          {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
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
        const errors = diagnostics(child.stderr);
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let remaining = "";
        let completed = false;
        let failure: string | undefined;
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
              state.progress = event.progress;
              state.stage = event.stage;
            }
            if (event.type === "error") {
              failure = event.message;
              cancelled ||= event.cancelled;
            }
            if (event.type === "complete") {
              completed = true;
              state.audioLoweredDb = event.audioLoweredDb;
            }
          }
        }
        const exitCode = await child.exited;
        const stderr = await errors;
        if (cancelled) return;
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
        state.status = "complete";
        state.progress = 100;
      })()
        .catch((error: unknown) => {
          state.status = cancelled ? "cancelled" : "failed";
          if (!cancelled)
            state.error =
              error instanceof Error ? error.message : String(error);
        })
        .finally(async () => {
          running.delete(cancel);
          if (cancelled) {
            await rm(options.outputPath, { force: true });
            await rm(
              options.outputPath.replace(/\.(mp4|webm|mov|gif)$/, ".meta.json"),
              { force: true },
            );
          }
        });
      return state;
    },
    cancelAll() {
      for (const cancel of running) cancel();
    },
  };
}
