import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { MEDIA_TRASH } from "../../shared/media.ts";
import { previewPolicy } from "./isolation.ts";
import type { RenderJob } from "@hyperframes/producer";
import type { Fps } from "../../shared/timeline/schema.ts";

let rangeProgress: ((job: RenderJob) => void) | undefined;
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
  range?: { range: Fps | undefined; progress: (job: RenderJob) => void },
) {
  rangeProgress = range?.range ? range.progress : undefined;
  for (const name of ["producer", "engine"]) {
    const manifest: unknown = JSON.parse(
      readFileSync(
        new URL("../package.json", import.meta.resolve(`@hyperframes/${name}`)),
        "utf8",
      ),
    );
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("version" in manifest) ||
      manifest.version !== "0.9.26"
    )
      throw new Error(
        `Cutroom's render isolation requires @hyperframes/${name} 0.9.26.`,
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
  let producerLoaded = false;
  let captureLoaded = false;
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (
        !url.endsWith("/@hyperframes/producer/dist/index.js") &&
        !url.endsWith("/@hyperframes/engine/dist/services/frameCapture.js")
      )
        return loaded;
      let source = String(loaded.source);
      if (url.endsWith("/producer/dist/index.js")) {
        source = `import { projectPath } from ${projectPaths};\nimport { HttpError } from ${httpErrors};\nconst cutroomSources = ${JSON.stringify(sources)};\n${source}`;
        source = replaceOnce(
          source,
          "rebaseDirectEntryAssetPaths(readTextFile(htmlPath), projectDir, htmlPath)",
          "rebaseDirectEntryAssetPaths(cutroomSources[htmlPath] ?? readTextFile(htmlPath), projectDir, htmlPath)",
          url,
        );
        if (range?.range) {
          const fps = JSON.stringify(range.range);
          const observer = JSON.stringify(import.meta.url);
          const audio = JSON.stringify(
            new URL("./rangeAudio.ts", import.meta.url).href,
          );
          source = `import { cp as cutroomCopyProject } from "node:fs/promises";\nimport { publishRangeProgress } from ${observer};\nimport { alignRangeAudio } from ${audio};\nconst cutroomRangeFps = ${fps};\n${source}`;
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
          source = replaceOnce(
            source,
            "      return firstSegment === void 0 || !PLAN_PROJECT_DIR_SKIP_SEGMENTS.has(firstSegment);",
            `      if (firstSegment === ${JSON.stringify(MEDIA_TRASH)} || (firstSegment !== void 0 && PLAN_PROJECT_DIR_SKIP_SEGMENTS.has(firstSegment))) return false;\n      await projectPath({ path: projectDir }, rel);\n      return true;`,
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
      startSeconds: startFrame * cutroomRangeFps.den / cutroomRangeFps.num,
      durationSeconds: (endFrame - startFrame) * cutroomRangeFps.den / cutroomRangeFps.num,
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
    if (!producerLoaded || !captureLoaded)
      throw new Error(
        "The HyperFrames render isolation hooks did not load. Export was refused.",
      );
  };
}
