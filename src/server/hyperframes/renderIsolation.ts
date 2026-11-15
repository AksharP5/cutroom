import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { MEDIA_TRASH } from "../../shared/media.ts";
import { previewPolicy } from "./isolation.ts";
import type { RenderJob } from "@hyperframes/producer";
import type { Fps } from "../../shared/timeline/schema.ts";
import type { ExportOptions } from "../../shared/export.ts";
import type { AudioStage } from "./directExport.ts";

let rangeProgress: ((job: RenderJob) => void) | undefined;
let audioStage: AudioStage | undefined;

/** The producer hands over its audio stage as it loads, so a direct export mixes sound the same way. */
export function provideAudioStage(stage: AudioStage) {
  audioStage = stage;
}
export const directAudioStage = () => {
  if (!audioStage)
    throw new Error(
      "The HyperFrames audio stage did not load. Export was refused.",
    );
  return audioStage;
};
let reportedAt = 0;
let reportedCode: RenderJob["stageProgress"];

/** Native chunks have structured progress but no public callback option. */
export function publishRangeProgress(job: RenderJob) {
  if (!rangeProgress) return;
  const now = Date.now();
  const stage = job.stageProgress;
  if (
    stage?.code === reportedCode?.code &&
    stage?.done !== stage?.total &&
    now - reportedAt < 250
  )
    return;
  reportedAt = now;
  reportedCode = stage;
  rangeProgress(job);
}

function replaceOnce(
  source: string,
  before: string,
  after: string,
  file: string,
) {
  if (source.split(before).length !== 2)
    throw new Error(
      `Cutroom's render isolation no longer matches ${file}. Review the HyperFrames upgrade before exporting.`,
    );
  return source.replace(before, after);
}

/** Version-checked host changes, like studioPlugin. No dependency files are modified. */
export function registerRenderIsolation(
  sources: Record<string, string> = {},
  range?: {
    range:
      { fps: Fps; frames: NonNullable<ExportOptions["range"]> } | undefined;
    progress: (job: RenderJob) => void;
    scratchDir: string;
    projectDir: string;
  },
) {
  rangeProgress = range?.range ? range.progress : undefined;
  for (const [name, version] of [
    ["@hyperframes/producer", "0.9.26"],
    ["@hyperframes/engine", "0.9.26"],
    ["@puppeteer/browsers", "3.2.2"],
  ]) {
    const manifest: unknown = JSON.parse(
      readFileSync(
        new URL("../package.json", import.meta.resolve(name)),
        "utf8",
      ),
    );
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("version" in manifest) ||
      manifest.version !== version
    )
      throw new Error(
        `Cutroom's render isolation requires ${name} ${version}.`,
      );
  }
  const isolation = JSON.stringify(
    new URL("./isolation.ts", import.meta.url).href,
  );
  const projectPaths = JSON.stringify(
    new URL("../projects/path.ts", import.meta.url).href,
  );
  const httpErrors = JSON.stringify(
    new URL("../../shared/errors.ts", import.meta.url).href,
  );
  const colour = JSON.stringify(
    new URL("./videoColour.ts", import.meta.url).href,
  );
  const frameCache = JSON.stringify(
    new URL("./frameCache.ts", import.meta.url).href,
  );
  let producerLoaded = false;
  let captureLoaded = false;
  let extractorLoaded = false;
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      // Puppeteer starts each Chromium in its own session. Keeping it in the worker's
      // process group lets a stopped export take its browsers with it, even when the
      // worker is killed before Puppeteer's exit handlers can run.
      if (url.endsWith("/@puppeteer/browsers/lib/launch.js"))
        return {
          ...loaded,
          source: replaceOnce(
            String(loaded.source),
            "opts.detached ??= process.platform !== 'win32';",
            "opts.detached ??= false;",
            url,
          ),
        };
      if (
        url.endsWith(
          "/@hyperframes/engine/dist/services/videoFrameExtractor.js",
        )
      ) {
        let source = `import { chromeSdrColourFilters as cutroomColour } from ${colour};\n${String(loaded.source)}`;
        source = replaceOnce(
          source,
          "return [...chromeGuessForUntaggedMatrix(metadata), SDR_CANVAS_PASSTHROUGH_FILTER];",
          "return [...cutroomColour(metadata), SDR_CANVAS_PASSTHROUGH_FILTER];",
          url,
        );
        // Frames cached before the conversion keep their old colours otherwise.
        source = replaceOnce(
          source,
          '            work.finalFrameOnly ? "final-frame" : undefined,\n',
          '            work.finalFrameOnly ? "final-frame" : undefined,\n            ...cutroomColour(work.metadata).filter((filter) => filter.startsWith("colorspace=")),\n',
          url,
        );
        if (range?.range) {
          source = `import { frameCacheSource as cutroomFrameCacheSource } from ${frameCache};\n${source}`;
          source = replaceOnce(
            source,
            "    const cacheKeyInputs = resolvedVideos.map(({ video, videoPath }) => {\n        const stat = readKeyStat(videoPath);",
            `    const cacheKeyInputs = resolvedVideos.map(({ video, videoPath: cutroomCopy }) => {\n        const videoPath = cutroomFrameCacheSource(cutroomCopy, ${JSON.stringify(range.projectDir)});\n        const stat = readKeyStat(videoPath);`,
            url,
          );
        }
        extractorLoaded = true;
        return { ...loaded, source };
      }
      if (
        !url.endsWith("/@hyperframes/producer/dist/index.js") &&
        !url.endsWith("/@hyperframes/engine/dist/services/frameCapture.js")
      )
        return loaded;
      let source = String(loaded.source);
      if (url.endsWith("/producer/dist/index.js")) {
        source = `import { projectPath } from ${projectPaths};\nimport { HttpError } from ${httpErrors};\nimport { provideAudioStage as cutroomProvideAudioStage } from ${JSON.stringify(import.meta.url)};\nconst cutroomSources = ${JSON.stringify(sources)};\n${source}`;
        source = replaceOnce(
          source,
          "function runAudioStage(input) {",
          "cutroomProvideAudioStage(runAudioStage);\nfunction runAudioStage(input) {",
          url,
        );
        source = replaceOnce(
          source,
          "rebaseDirectEntryAssetPaths(readTextFile(htmlPath), projectDir, htmlPath)",
          "rebaseDirectEntryAssetPaths(cutroomSources[htmlPath] ?? readTextFile(htmlPath), projectDir, htmlPath)",
          url,
        );
        if (range?.range) {
          const fps = JSON.stringify(range.range.fps);
          const observer = JSON.stringify(import.meta.url);
          const audio = JSON.stringify(
            new URL("./rangeAudio.ts", import.meta.url).href,
          );
          source = `import { cp as cutroomCopyProject } from "node:fs/promises";\nimport { publishRangeProgress } from ${observer};\nimport { alignRangeAudio, mixRangeAudio as cutroomMixRangeAudio } from ${audio};\nconst cutroomRangeFps = ${fps};\nconst cutroomRange = ${JSON.stringify(range.range)};\n${source}`;
          // The planner materializes source links before its HTTP server sees
          // them. Apply the same project boundary before copying their bytes.
          source = replaceOnce(
            source,
            "  cpSync2(projectDir, compiledDir, {",
            "  await cutroomCopyProject(projectDir, compiledDir, {",
            url,
          );
          source = replaceOnce(
            source,
            "    filter: (src) => {\n      const rel = relative5(projectDir, src);",
            "    filter: async (src) => {\n      const rel = relative5(projectDir, src);",
            url,
          );
          // The editor keeps rewriting .cutroom (thumbnail scratch, view state) while an export
          // runs, and the copy fails on any entry that vanishes under it. The render reads none of it.
          source = replaceOnce(
            source,
            "      return firstSegment === void 0 || !PLAN_PROJECT_DIR_SKIP_SEGMENTS.has(firstSegment);",
            `      if (firstSegment === ${JSON.stringify(MEDIA_TRASH)} || firstSegment === ".cutroom" || (firstSegment !== void 0 && PLAN_PROJECT_DIR_SKIP_SEGMENTS.has(firstSegment))) return false;\n      await projectPath({ path: projectDir }, rel);\n      return true;`,
            url,
          );
          // The span's plan holds a copy of the project and its extracted frames.
          source = replaceOnce(
            source,
            'const workDir = mkdtempSync7(join45(tmpdir4(), "hf-render-span-"));',
            `const workDir = mkdtempSync7(join45(${JSON.stringify(range.scratchDir)}, "hf-render-span-"));`,
            url,
          );
          // The local chunk engine supports rational fps; the distributed
          // planner's numeric config otherwise freezes them as num/1.
          source = replaceOnce(
            source,
            "async function renderSpan(projectDir, config, span, outputPath) {",
            "async function renderSpan(projectDir, config, span, outputPath) {\n  config = { ...config, fps: cutroomRangeFps.num / cutroomRangeFps.den };",
            url,
          );
          source = replaceOnce(
            source,
            "    fps: input.fps,\n    quality: input.quality,",
            "    fps: cutroomRangeFps,\n    quality: input.quality,",
            url,
          );
          source = replaceOnce(
            source,
            "    fpsNum: config.fps,\n    fpsDen: 1,",
            "    fpsNum: cutroomRangeFps.num,\n    fpsDen: cutroomRangeFps.den,",
            url,
          );
          source = replaceOnce(
            source,
            "keyframeIntervalToGopSize3({ num: config.fps, den: 1 }, config.keyframeIntervalSeconds)",
            "keyframeIntervalToGopSize3(cutroomRangeFps, config.keyframeIntervalSeconds)",
            url,
          );
          // The planner mixes only the audio heard in the range, kept whole and
          // moved earlier by whole seconds. The overrides follow upstream's fields.
          source = replaceOnce(
            source,
            "function mixPlanAudio(c, compiledDir) {\n  return runAudioStage({",
            "function mixPlanAudio(c, compiledDir) {\n  return cutroomMixRangeAudio(c, cutroomRange, (cutroomStage) => runAudioStage({",
            url,
          );
          source = replaceOnce(
            source,
            "    log: c.log\n  });\n}\nasync function extractPlanVideos",
            "    log: c.log,\n    ...cutroomStage\n  }));\n}\nasync function extractPlanVideos",
            url,
          );
          // Cutroom writes the range's audio itself. Chunks muxing the plan mix
          // would cut it at composition times it no longer starts at.
          source = replaceOnce(
            source,
            "      { chunksCarryAudio: true }\n    );",
            "      { chunksCarryAudio: false }\n    );",
            url,
          );
          source = replaceOnce(
            source,
            "  job.progress = Math.max(job.progress, boundedProgress);",
            "  job.progress = Math.max(job.progress, boundedProgress);\n  publishRangeProgress(job);",
            url,
          );
          source = replaceOnce(
            source,
            "    await writeStitchedMp4(parts, outputPath);",
            `    const cutroomVideo = join45(workDir, "range.mp4");
    await writeStitchedMp4(parts, cutroomVideo);
    await alignRangeAudio({
      videoPath: cutroomVideo, audioPath: resolvePlanAudioPath(planDir), outputPath,
      fps: cutroomRangeFps, frames: { start: startFrame, end: endFrame },
      signal: config.abortSignal
    });`,
            url,
          );
        }
        source = replaceOnce(
          source,
          "const rawSubHtml = normalizeCompositionSrcs(read.text, projectDir);",
          "const rawSubHtml = normalizeCompositionSrcs(cutroomSources[filePath] ?? read.text, projectDir);",
          url,
        );
        source = replaceOnce(
          source,
          "function createFileServer(options) {",
          `function createFileServer(options) {\n  const cutroomPolicy = ${previewPolicy.toString()};`,
          url,
        );
        source = replaceOnce(
          source,
          "      const candidate = join(root, relativePath);\n      if (isPathInside(candidate, root)) file = openRegularFile(candidate);",
          `      try {
        const candidate = await projectPath({ path: root }, relativePath);
        file = openRegularFile(candidate);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) continue;
        if (error instanceof HttpError) return c.text(error.message, error.status);
        throw error;
      }`,
          url,
        );
        source = replaceOnce(
          source,
          '  app.get("/*", async (c) => {',
          `  app.use("*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", cutroomPolicy(new URL(c.req.url).origin + "/"));
    c.header("Connection-Allowlist", "(" + JSON.stringify(new URL(c.req.url).origin + "/*") + ")");
    c.header("X-DNS-Prefetch-Control", "off");
    c.header("Access-Control-Allow-Origin", "null");
    c.header("X-Content-Type-Options", "nosniff");
  });
  app.get("/*", async (c) => {`,
          url,
        );
        source = replaceOnce(
          source,
          "      const ext = extname(filePath).toLowerCase();",
          "      const ext = extname(relativePath).toLowerCase();",
          url,
        );
        // Static parsing excludes hidden media. Browser probing must not add it back to the mix.
        source = replaceOnce(
          source,
          "    mediaEls.forEach((el) => {\n      const htmlEl = el;",
          '    mediaEls.forEach((el) => {\n      const htmlEl = el;\n      if (htmlEl.closest("[data-hidden]")) return;',
          url,
        );
        producerLoaded = true;
      } else {
        source = `import { isolateCapturePage as cutroomIsolatePage } from ${isolation};\n${source}`;
        source = replaceOnce(
          source,
          "    const page = await browser.newPage();\n    onPageCreated(page);",
          "    const page = await browser.newPage();\n    onPageCreated(page);\n    await cutroomIsolatePage(page, serverUrl + '/');",
          url,
        );
        source = replaceOnce(
          source,
          "    const page = await session.browser.newPage();",
          "    const page = await session.browser.newPage();\n    await cutroomIsolatePage(page, session.serverUrl + '/');",
          url,
        );
        captureLoaded = true;
      }
      return { ...loaded, source };
    },
  });
  return () => {
    if (!producerLoaded || !captureLoaded || !extractorLoaded)
      throw new Error(
        "The HyperFrames render isolation hooks did not load. Export was refused.",
      );
  };
}
