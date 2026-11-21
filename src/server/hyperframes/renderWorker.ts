import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodedUrlPath } from "@hyperframes/parsers/asset-paths";
import { z } from "zod";
import {
  directAudioStage,
  registerRenderIsolation,
  spliceSourceParts,
} from "./renderIsolation.ts";
import { adjustmentSources } from "./adjustmentCapture.ts";
import { projectPath } from "../projects/path.ts";
import { DirectPlanSchema } from "./directSchema.ts";
import type { VideoEncoder } from "./directExport.ts";
import {
  ExportFormatSchema,
  ExportRangeSchema,
  GifLoopSchema,
} from "../../shared/export.ts";
import type { RenderJob } from "@hyperframes/producer";
import { FpsSchema } from "../../shared/timeline/schema.ts";
import { ExportStageError } from "./renderFailure.ts";

const Input = z.object({
  projectDir: z.string(),
  outputPath: z.string(),
  options: z.looseObject({
    fps: FpsSchema,
    format: ExportFormatSchema,
    entryFile: z.string().optional(),
  }),
  sources: z.record(z.string(), z.string()).default({}),
  range: ExportRangeSchema.nullish(),
  scopedMedia: z.boolean().default(false),
  scratchDir: z.string(),
  /** Frames drawn wholly from the sources encode with NVENC, which the server's probe found working. */
  gpu: z.boolean(),
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
  const entryPath = join(
    input.projectDir,
    input.options.entryFile ?? "index.html",
  );
  const entry =
    input.direct?.html ??
    input.sources[entryPath] ??
    (await readFile(entryPath, "utf8").catch(() => ""));
  const seen = new Set([entryPath]);
  const needsAdjustment = async (html: string): Promise<boolean> => {
    const { graded, scenes } = adjustmentSources(html);
    if (graded) return true;
    for (const src of scenes) {
      if (src.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(src)) continue;
      // Mounted composition paths resolve from the project root in the producer.
      const local = [decodedUrlPath(src), src].map((path) =>
        path.replace(/^(?:\.?[\\/])+/, ""),
      );
      for (const path of new Set(local)) {
        const file = await projectPath({ path: input.projectDir }, path).catch(
          () => null,
        );
        if (!file || seen.has(file)) continue;
        seen.add(file);
        const source =
          input.sources[join(input.projectDir, path)] ??
          (await readFile(file, "utf8").catch(() => ""));
        if (await needsAdjustment(source)) return true;
      }
    }
    return false;
  };
  const adjustment = await needsAdjustment(entry);
  const capture = input.direct?.plan.segments.filter(
    (segment) => segment.kind === "capture",
  );
  // A whole export that captures some frames runs as a marked export of every frame, so the
  // browser draws only its runs and the span joins them with the frames drawn from the sources.
  const range =
    input.range ?? (capture?.length ? input.direct?.plan.frames : undefined);
  const verifyIsolation = registerRenderIsolation(
    input.sources,
    {
      range: range ? { fps: input.options.fps, frames: range } : undefined,
      progress,
      scratchDir: input.scratchDir,
      projectDir: input.projectDir,
      scopedMedia: input.scopedMedia,
    },
    adjustment,
  );
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
  const { encodeSourceParts, exportDirect, prepareDirectExport } =
    await import("./directExport.ts");
  verifyIsolation();
  const engineConfig = resolveConfig(
    adjustment
      ? {
          forceScreenshot: true,
          useDrawElement: false,
        }
      : undefined,
  );
  // Exports run one at a time, so no render is reading the shared frame cache while it shrinks.
  if (engineConfig.extractCacheDir)
    gcExtractionCache(engineConfig.extractCacheDir, {
      maxBytes: engineConfig.extractCacheMaxBytes,
      minAgeMs: 0,
    });
  // A GIF is made from a ProRes 4444 render, which keeps its alpha. HyperFrames' own GIF builds
  // its palette from frame differences, which turns a title that appears and stays black.
  const { gifLoop, ...options } = input.options;
  const gif = options.format === "gif";
  const request = parseRenderRequest({
    version: 1,
    projectDir: input.projectDir,
    outputPath: gif ? join(input.scratchDir, "gif.mov") : input.outputPath,
    options: { ...options, ...(gif && { format: "mov" }), engineConfig },
  });
  const entryFile = request.options.entryFile ?? "index.html";
  if (request.options.variables) {
    // Its compiler import must see the render isolation hooks registered above.
    const { rebaseImageOverrides } = await import("./imageVariables.ts");
    request.options.variables = rebaseImageOverrides(
      input.projectDir,
      entryFile,
      request.options.variables,
    );
  }
  const logger = createConsoleLogger("warn");
  let audioLoweredDb: number | undefined;
  let encoder: VideoEncoder | undefined;
  const direct =
    input.direct &&
    (await prepareDirectExport(
      input.direct.plan,
      input.projectDir,
      entryFile,
      join(input.scratchDir, "direct"),
    ));
  if (direct && "reason" in direct) {
    if (input.direct?.captureRefusal)
      throw new Error(input.direct.captureRefusal);
    console.warn(`Exporting with frame capture: ${direct.reason}.`);
  }
  const pieces = direct && "pieces" in direct ? direct.pieces : undefined;
  const encoding = input.direct &&
    pieces && {
      plan: input.direct.plan,
      pieces,
      html: input.direct.html,
      workDir: join(input.scratchDir, "direct"),
      fps: request.options.fps,
      quality: request.options.quality,
      crf: request.options.crf,
      bitrate: request.options.videoBitrate,
      maxBitrate: request.options.maxBitrate,
      bufferSize: request.options.bufferSize,
      gpu: input.gpu,
      engineConfig,
      signal: abort.signal,
    };
  if (encoding && !capture?.length) {
    const { collectRenderMedia } = await import("@hyperframes/producer");
    ({ audioLoweredDb, encoder } = await exportDirect({
      ...encoding,
      projectDir: request.projectDir,
      outputPath: request.outputPath,
      audioStage: directAudioStage(),
      collectAudio: (html) => collectRenderMedia(html).audios,
      progress: (event) => send({ type: "progress", ...event }),
    }));
  } else if (range) {
    // Source frames encode while the span plans and captures; its progress stands for both.
    // They join HyperFrames' libx264 parts, so they use libx264 too.
    if (encoding && capture)
      spliceSourceParts(
        capture,
        encodeSourceParts({ ...encoding, gpu: false, onFrames: () => {} }).then(
          ({ parts }) => parts,
          (error: unknown) => {
            throw new ExportStageError("encode", error);
          },
        ),
      );
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
        format: input.options.format === "gif" ? "mov" : input.options.format,
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
        startSeconds: (range.start * den) / num,
        endSeconds: (range.end * den) / num,
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
  if (gif) {
    send({
      type: "progress",
      progress: 99,
      stage: "Encoding GIF",
      stageProgress: { code: "encode" },
    });
    const { encodeGif } = await import("./gif.ts");
    await encodeGif({
      videoPath: request.outputPath,
      outputPath: input.outputPath,
      fps: request.options.fps,
      loop: GifLoopSchema.default(0).parse(gifLoop),
      signal: abort.signal,
    });
  }
  send({
    type: "complete",
    audioLoweredDb,
    renderer: !encoding ? "capture" : capture?.length ? "mixed" : "direct",
    // HyperFrames chooses frame capture's encoder.
    encoder: encoding ? (encoder ?? "libx264") : undefined,
  });
} catch (error) {
  send({
    type: "error",
    cancelled: abort.signal.aborted,
    message: error instanceof Error ? error.message : String(error),
    stage: error instanceof ExportStageError ? error.stage : undefined,
  });
  process.exitCode = 1;
}
