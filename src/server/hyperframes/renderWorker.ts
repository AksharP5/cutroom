import { join } from "node:path";
import { z } from "zod";
import {
  directAudioStage,
  registerRenderIsolation,
} from "./renderIsolation.ts";
import { DirectPlanSchema } from "./directPlan.ts";
import { ExportRangeSchema } from "../../shared/export.ts";
import type { RenderJob } from "@hyperframes/producer";
import { FpsSchema } from "../../shared/timeline/schema.ts";

const Input = z.object({
  projectDir: z.string(),
  outputPath: z.string(),
  options: z.looseObject({ fps: FpsSchema }),
  sources: z.record(z.string(), z.string()).default({}),
  range: ExportRangeSchema.nullish(),
  scratchDir: z.string(),
  /** The server's plan to draw every frame from the sources. The worker still checks each source. */
  direct: z
    .object({
      plan: DirectPlanSchema,
      html: z.string(),
      /** Why frame capture would not fit in memory; a fallback fails with it instead of starting. */
      captureRefusal: z.string().optional(),
    })
    .optional(),
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
    range: input.range
      ? { fps: input.options.fps, frames: input.range }
      : undefined,
    progress,
    scratchDir: input.scratchDir,
    projectDir: input.projectDir,
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
  const { gcExtractionCache } = await import("@hyperframes/engine");
  // It imports the engine, so it loads only once the isolation hooks are registered.
  const { exportDirect, prepareDirectExport } =
    await import("./directExport.ts");
  verifyIsolation();
  const engineConfig = resolveConfig();
  // Exports run one at a time, so no render is reading the shared frame cache while it shrinks.
  if (engineConfig.extractCacheDir)
    gcExtractionCache(engineConfig.extractCacheDir, {
      maxBytes: engineConfig.extractCacheMaxBytes,
      minAgeMs: 0,
    });
  const request = parseRenderRequest({
    version: 1,
    projectDir: input.projectDir,
    outputPath: input.outputPath,
    options: { ...input.options, engineConfig },
  });
  const logger = createConsoleLogger("warn");
  let audioLoweredDb: number | undefined;
  const direct =
    input.direct &&
    (await prepareDirectExport(input.direct.plan, input.projectDir));
  if (direct && "reason" in direct) {
    if (input.direct?.captureRefusal)
      throw new Error(input.direct.captureRefusal);
    console.warn(`Exporting with frame capture: ${direct.reason}.`);
  }
  if (input.direct && direct && "pieces" in direct) {
    const { collectRenderMedia } = await import("@hyperframes/producer");
    const options = request.options;
    ({ audioLoweredDb } = await exportDirect({
      plan: input.direct.plan,
      pieces: direct.pieces,
      html: input.direct.html,
      projectDir: request.projectDir,
      outputPath: request.outputPath,
      workDir: join(input.scratchDir, "direct"),
      fps: options.fps,
      quality: options.quality,
      crf: options.crf,
      bitrate: options.videoBitrate,
      maxBitrate: options.maxBitrate,
      bufferSize: options.bufferSize,
      engineConfig,
      audioStage: directAudioStage(),
      collectAudio: (html) => collectRenderMedia(html).audios,
      signal: abort.signal,
      progress: (event) => send({ type: "progress", ...event }),
    }));
  } else if (input.range) {
    const options = request.options;
    const { num, den } = options.fps;
    send({ type: "progress", progress: 0, stage: "Preparing selected frames" });
    await renderSpan(
      request.projectDir,
      {
        // Placeholders the public type requires. The planner takes the size from
        // the composition, and the version-checked local adapter supplies the
        // exact request fps, which the public type can only express as an integer.
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
  send({
    type: "complete",
    audioLoweredDb,
    renderer: direct && "pieces" in direct ? "direct" : "capture",
  });
} catch (error) {
  send({
    type: "error",
    cancelled: abort.signal.aborted,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
