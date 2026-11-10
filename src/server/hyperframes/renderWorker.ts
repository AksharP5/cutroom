import { z } from "zod";
import { registerRenderIsolation } from "./renderIsolation.ts";
import { ExportRangeSchema } from "../../shared/export.ts";
import type { RenderJob } from "@hyperframes/producer";
import { FpsSchema } from "../../shared/timeline/schema.ts";

const Input = z.object({
  projectDir: z.string(),
  outputPath: z.string(),
  options: z.looseObject({ fps: FpsSchema }),
  sources: z.record(z.string(), z.string()).default({}),
  range: ExportRangeSchema.nullish(),
});
const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
process.once("SIGINT", () => abort.abort());
const send = (event: unknown) =>
  process.stdout.write(`CUTROOM_RENDER:${JSON.stringify(event)}\n`);
const progress = (job: RenderJob) => {
  send({
    type: "progress",
    progress: job.progress,
    stage: job.currentStage,
    stageProgress: job.stageProgress,
  });
};

try {
  process.stdin.setEncoding("utf8");
  let body = "";
  for await (const chunk of process.stdin)
    body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const input = Input.parse(JSON.parse(body));
  const verifyIsolation = registerRenderIsolation(input.sources, {
    range: input.range ? input.options.fps : undefined,
    progress,
  });
  const {
    createConsoleLogger,
    createRenderJob,
    executeRenderJob,
    parseRenderRequest,
    renderConfigFromRequest,
    renderSpan,
    resolveConfig,
  } = await import("@hyperframes/producer");
  verifyIsolation();
  const request = parseRenderRequest({
    version: 1,
    projectDir: input.projectDir,
    outputPath: input.outputPath,
    options: { ...input.options, engineConfig: resolveConfig() },
  });
  const logger = createConsoleLogger("warn");
  let audioLoweredDb: number | undefined;
  if (input.range) {
    const options = request.options;
    const { num, den } = options.fps;
    send({ type: "progress", progress: 0, stage: "Preparing selected frames" });
    await renderSpan(
      request.projectDir,
      {
        // The version-checked local adapter supplies the exact request fps to
        // the native planner, whose public distributed type is integer-only.
        fps: 30,
        width: 1920,
        height: 1080,
        format: "mp4",
        quality: options.quality,
        crf: options.crf,
        bitrate: options.videoBitrate,
        maxBitrate: options.maxBitrate,
        bufferSize: options.bufferSize,
        keyframeIntervalSeconds: options.keyframeIntervalSeconds,
        outputResolution: options.outputResolution,
        outputResolutionAspectAgnostic: options.outputResolutionAspectAgnostic,
        entryFile: options.entryFile,
        variables: options.variables,
        pageMotionBlur: options.pageMotionBlur,
        engineConfig: options.engineConfig,
        logger,
        abortSignal: abort.signal,
        maxParallelChunks: 1,
      },
      {
        startSeconds: (input.range.start * den) / num,
        endSeconds: (input.range.end * den) / num,
      },
      request.outputPath,
    );
  } else {
    const job = createRenderJob(renderConfigFromRequest(request, { logger }));
    await executeRenderJob(
      job,
      request.projectDir,
      request.outputPath,
      progress,
      abort.signal,
    );
    audioLoweredDb = job.audioLoweredDb;
  }
  send({ type: "complete", audioLoweredDb });
} catch (error) {
  send({
    type: "error",
    cancelled: abort.signal.aborted,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
