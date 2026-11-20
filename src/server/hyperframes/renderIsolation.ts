import { readFileSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { MEDIA_TRASH } from "../../shared/media.ts";
import { previewPolicy } from "./isolation.ts";
import { PARALLEL_ENCODES } from "./exportMemory.ts";
import type { RenderJob } from "@hyperframes/producer";
import type { Fps } from "../../shared/timeline/schema.ts";
import type { ExportOptions } from "../../shared/export.ts";
import type { AudioStage, EncodedPart } from "./directExport.ts";

let rangeProgress: ((job: RenderJob) => void) | undefined;
let audioStage: AudioStage | undefined;

/** The producer hands over its audio stage as it loads, so a direct export mixes sound the same way. */
export function provideAudioStage(stage: AudioStage) {
  audioStage = stage;
}
type SpanSlice = { index: number; startFrame: number; endFrame: number };
type FrameRange = { startFrame: number; endFrame: number };
let spliced:
  | { capture: { start: number; end: number }[]; parts: Promise<EncodedPart[]> }
  | undefined;

/** Has a marked export capture only these runs, and take the frames between from `parts`. */
export function spliceSourceParts(
  capture: { start: number; end: number }[],
  parts: Promise<EncodedPart[]>,
) {
  // A failure is reported where the span awaits the parts, after its captures.
  parts.catch(() => {});
  spliced = { capture, parts };
}

/**
 * The frames one chunk capture walks when they are not contiguous. The chunk captures the
 * contiguous range from `base`, and capture index `base + k` draws composition frame `frames[k]`,
 * so one set of browsers loads the page once and seeks between runs.
 */
let listed:
  { base: number; frames: number[]; parts: EncodedPart[] } | undefined;

/** The composition frame a capture index draws. */
export function capturedFrame(index: number) {
  if (!listed) return index;
  const frame = listed.frames[index - listed.base];
  if (frame === undefined)
    throw new Error(`Capture index ${index} is outside the listed frames.`);
  return frame;
}

/** Whether the chunk being captured walks a frame list, so it encodes one part per run. */
export const capturesList = () => listed !== undefined;

type ChunkEncode = {
  job: RenderJob;
  framesDir: string;
  outputPath: string;
  videoOnlyPath: string;
  gopSize: number;
  chunkedEncodeSize: number;
  captureImageFormat?: string;
};

/**
 * `renderChunk`'s encode stage. A listed capture holds every run's frames in one folder; each run
 * becomes its own closed-GOP part, encoded exactly as a chunk of that run alone would be.
 */
export async function encodeCaptured<Input extends ChunkEncode>(
  input: Input,
  encode: (input: Input) => Promise<unknown>,
  gopFor: (frames: number) => number,
) {
  const capture = listed;
  if (!capture) return encode(input);
  const runs: { first: number; frames: number }[] = [];
  for (const [index, frame] of capture.frames.entries()) {
    const run = runs.at(-1);
    if (run && capture.frames[index - 1] === frame - 1) run.frames++;
    else runs.push({ first: index, frames: 1 });
  }
  const extension = input.captureImageFormat === "png" ? "png" : "jpg";
  const name = (index: number) =>
    `frame_${String(index).padStart(6, "0")}.${extension}`;
  const { job } = input;
  const total = capture.frames.length;
  let encoded = 0;
  const report = () => {
    job.currentStage = `Encoding frame ${encoded}/${total}`;
    job.stageProgress = { code: "encode", done: encoded, total };
    publishRangeProgress(job);
  };
  report();
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(PARALLEL_ENCODES, runs.length) },
      async () => {
        while (next < runs.length) {
          const index = next++;
          const run = runs[index]!;
          const framesDir = `${input.framesDir}-run-${index}`;
          await mkdir(framesDir);
          for (let frame = 0; frame < run.frames; frame++)
            await rename(
              join(input.framesDir, name(run.first + frame)),
              join(framesDir, name(frame)),
            );
          const path = `${input.videoOnlyPath}.run-${String(index).padStart(4, "0")}.mp4`;
          // The run's own job copy keeps the chunk's counts; progress is reported across runs here.
          await encode({
            ...input,
            job: { ...job, totalFrames: 0 },
            framesDir,
            outputPath: path,
            videoOnlyPath: path,
            gopSize: gopFor(run.frames),
            chunkedEncodeSize: run.frames,
          });
          const start = capture.frames[run.first]!;
          capture.parts.push({ start, end: start + run.frames, path });
          encoded += run.frames;
          report();
        }
      },
    ),
  );
}

/** `renderSpan`'s chunk loop: captures what the browser must draw and returns every part in frame order. */
export async function spanParts(
  slices: SpanSlice[],
  startFrame: number,
  endFrame: number,
  capture: (
    slice: SpanSlice,
    range: FrameRange,
    index: number,
  ) => Promise<string>,
) {
  const parts: { start: number; path: string }[] = [];
  for (const slice of slices) {
    const from = Math.max(slice.startFrame, startFrame);
    const to = Math.min(slice.endFrame, endFrame);
    if (to <= from) continue;
    if (!spliced) {
      parts.push({
        start: from,
        path: await capture(
          slice,
          { startFrame: from, endFrame: to },
          parts.length,
        ),
      });
      continue;
    }
    // Every run the browser draws in this slice, captured by one set of browsers.
    const frames: number[] = [];
    for (const run of spliced.capture)
      for (
        let frame = Math.max(from, run.start);
        frame < Math.min(to, run.end);
        frame++
      )
        frames.push(frame);
    if (!frames.length) continue;
    listed = { base: slice.startFrame, frames, parts: [] };
    try {
      await capture(
        slice,
        {
          startFrame: slice.startFrame,
          endFrame: slice.startFrame + frames.length,
        },
        parts.length,
      );
      parts.push(...listed.parts);
    } finally {
      listed = undefined;
    }
  }
  if (spliced) parts.push(...(await spliced.parts));
  return parts.sort((a, b) => a.start - b.start).map((part) => part.path);
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
    ["@hyperframes/core", "0.9.26"],
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
  const imageVariables = JSON.stringify(
    new URL("./imageVariables.ts", import.meta.url).href,
  );
  const transitions = JSON.stringify(
    new URL("../timeline/transitionSource.ts", import.meta.url).href,
  );
  const freezeSources = JSON.stringify(
    new URL("./freezeSources.ts", import.meta.url).href,
  );
  const frameCache = JSON.stringify(
    new URL("./frameCache.ts", import.meta.url).href,
  );
  const rampSource = JSON.stringify(
    new URL("./rampSource.ts", import.meta.url).href,
  );
  const audioClock = JSON.stringify(
    new URL("./audioClock.ts", import.meta.url).href,
  );
  const rampWindow = JSON.stringify(
    new URL("../../shared/timeline/rampWindow.ts", import.meta.url).href,
  );
  const nativeFrames = JSON.stringify(
    new URL("./nativeFrames.ts", import.meta.url).href,
  );
  const frameTimes = JSON.stringify(
    new URL("../../shared/frames.ts", import.meta.url).href,
  );
  const rampRuntime = JSON.stringify(
    new URL("./rampRuntime.ts", import.meta.url).href,
  );
  let producerLoaded = false;
  let audioMixerLoaded = false;
  let captureLoaded = false;
  let extractorLoaded = false;
  let coordinatorLoaded = !range?.range;
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url.endsWith("/@hyperframes/engine/dist/services/audioMixer.js")) {
        audioMixerLoaded = true;
        let source = replaceOnce(
          `import { AUDIO_SAMPLE_RATE, audioSampleAt, audioSamples } from ${audioClock};\nimport { resolveRampPlayback } from ${rampWindow};\n${String(loaded.source)}`,
          "    const normalizedPlaybackRate = normalizeRateSpec(playbackRate);",
          `    const normalizedPlaybackRate = normalizeRateSpec(playbackRate);
    if (typeof normalizedPlaybackRate === "object" && !options?.loop && !isHttpUrl(srcPath)) {
        const { prepareLocalRamp } = await import(${rampSource});
        const timing = options?.rampTiming ?? resolveRampPlayback({
            start: options?.timelineStart ?? 0,
            end: (options?.timelineStart ?? 0) + duration,
            mediaStart,
        }, normalizedPlaybackRate);
        const prepared = await prepareLocalRamp(srcPath, outputPath, timing, options?.rampCacheDir ?? join(outputDir, "ramp-runs"), signal, ffmpegProcessTimeout)
            .catch((error) => {
                if (signal?.aborted) throw error;
                return null;
            });
        if (prepared?.success) return prepared;
    }`,
          url,
        );
        // Round the two composition edges once. Rounding the length independently
        // can leave a gap or overlap even when both clips meet on the same sample.
        source = replaceOnce(
          source,
          `    const delayMs = Math.round(track.start * 1000);
    const trimDuration = track.end - track.start + (track.tailSeconds ?? 0);
    const filters = \`[\${index}:a]atrim=0:\${formatFilterNumber(trimDuration)},\${volumeFilter}\${buildFadeFilters(track)},adelay=\${delayMs}|\${delayMs}\`;`,
          `    const { start: delay, end: clipEnd } = audioSamples(track);
    const end = clipEnd + audioSampleAt(track.tailSeconds ?? 0);
    const filters = \`[\${index}:a]atrim=end_sample=\${end - delay},\${volumeFilter}\${buildFadeFilters(track)},adelay=\${delay}S:all=1\`;`,
          url,
        );
        source = replaceOnce(
          source,
          "            let audioSrcPath = srcPath;",
          `            const samples = audioSamples(element);
            const preparationDuration = typeof element.playbackRate === "object"
                ? element.end - element.start
                : (samples.end - samples.start) / AUDIO_SAMPLE_RATE;
            let audioSrcPath = srcPath;`,
          url,
        );
        source = replaceOnce(
          source,
          "                duration: element.end - element.start,",
          "                duration: element.end - element.start,\n                samples,",
          url,
        );
        for (const stage of ["extract", "prepare"]) {
          source = replaceOnce(
            source,
            `"${stage}", element.mediaStart, element.end - element.start, element.playbackRate, effectiveSignal, config, ${stage === "extract" ? "audioSidecarUrl" : "undefined"}, { loop: element.loop }`,
            `"${stage}", element.mediaStart, preparationDuration, element.playbackRate, effectiveSignal, config, ${stage === "extract" ? "audioSidecarUrl" : "undefined"}, { loop: element.loop, timelineStart: element.start, rampTiming: element.rampTiming, rampCacheDir: join(workDir, "ramp-runs") }`,
            url,
          );
        }
        return { ...loaded, source };
      }
      // Standalone templates keep the parent shell's styles and scripts. Its
      // render canvas, like its duration, belongs to the selected scene.
      if (url.endsWith("/@hyperframes/core/dist/compiler/standaloneEntry.js"))
        return {
          ...loaded,
          source: replaceOnce(
            String(loaded.source),
            "    replaceBodyWithRenderClone(body, renderClone);",
            `    for (const name of ["data-width", "data-height"]) {
        const pixels = Math.floor(Number(sceneRoot?.getAttribute(name)));
        if (Number.isSafeInteger(pixels) && pixels > 0)
            renderClone.setAttribute(name, String(pixels));
    }
    replaceBodyWithRenderClone(body, renderClone);`,
            url,
          ),
        };
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
        source = `import { rampMediaTimeAt, resolveRampPlayback } from ${rampWindow};\nimport { nativeFrameClock } from ${nativeFrames};\nimport { frameAtOrBefore } from ${frameTimes};\n${source}`;
        source = replaceOnce(
          source,
          "    const sampleAtOutputFps = !options.finalFrameOnly;",
          `    const nativeFrames = options.nativeFrames;
    const timestampOffset = videoStartOnMediaTimeline(metadata) - (metadata.videoStreamStartSeconds ?? 0);
    const clock = nativeFrames ? nativeFrameClock(timestampOffset) : null;
    const sampleAtOutputFps = !options.finalFrameOnly && !clock;`,
          url,
        );
        source = replaceOnce(
          source,
          "    if (options.finalFrameOnly) {\n        // Output-side seek",
          `    if (clock) {
        args.push("-loglevel", "info", "-copyts", "-noaccurate_seek",
            "-ss", formatFfmpegSeconds(Math.max(0, ffmpegSeek(startTime))),
            "-i", videoPath, "-to", formatFfmpegSeconds(startTime + duration - timestampOffset),
            "-fps_mode", "passthrough");
    }
    else if (options.finalFrameOnly) {
        // Output-side seek`,
          url,
        );
        source = replaceOnce(
          source,
          "        const filters = filtersFor(seek);",
          '        const filters = clock ? ["showinfo", ...filtersFor(seek)] : filtersFor(seek);',
          url,
        );
        source = replaceOnce(
          source,
          "            onStderr: framesWrittenReader(options.onProgress),",
          `            onStderr: clock ? clock.record : framesWrittenReader(options.onProgress),`,
          url,
        );
        source = replaceOnce(
          source,
          "    if (framePaths.size > 0 && duration > 0 && !options.finalFrameOnly && !options.frameRanges) {",
          "    if (!clock && framePaths.size > 0 && duration > 0 && !options.finalFrameOnly && !options.frameRanges) {",
          url,
        );
        source = replaceOnce(
          source,
          "        totalFrames: framePaths.size,\n        metadata,",
          "        totalFrames: framePaths.size,\n        ...(clock && { nativeTimes: clock.finish(framePaths.size) }),\n        metadata,",
          url,
        );
        source = replaceOnce(
          source,
          "    if (misses.some(({ work }) => work.finalFrameOnly))",
          "    if (misses.some(({ work }) => work.finalFrameOnly || work.nativeFrames))",
          url,
        );
        source = replaceOnce(
          source,
          "            finalFrameOnly: work.finalFrameOnly,",
          "            finalFrameOnly: work.finalFrameOnly,\n            nativeFrames: work.nativeFrames,",
          url,
        );
        source = replaceOnce(
          source,
          "    function lookupCacheFor(work) {\n        if (!cacheRootDir)",
          "    function lookupCacheFor(work) {\n        if (!cacheRootDir || work.nativeFrames)",
          url,
        );
        source = replaceOnce(
          source,
          "        if (work.finalFrameOnly ||\n            work.metadata.isVFR ||",
          "        if (work.finalFrameOnly || work.nativeFrames ||\n            work.metadata.isVFR ||",
          url,
        );
        const markedWindow = range?.range && {
          start:
            (range.range.frames.start * range.range.fps.den) /
            range.range.fps.num,
          end:
            (range.range.frames.end * range.range.fps.den) /
            range.range.fps.num,
        };
        source = replaceOnce(
          source,
          `            alignClipStartToFirstOutputFrame(video, fps);
            const initialWindow = resolveVideoExtractionWindow(video, metadata, options.timelineEnd);
            const window = await resolveFinalFrameExtractionWindow(videoPath, video, metadata, initialWindow, signal);
            const videoDuration = window.durationSeconds;
            if (videoDuration <= 0) {
                return { skipped: true };
            }
            rebaseVideoToWindow(video, window);
            const keyInput = cacheKeyInputs[index];
            const extractionMediaStart = window.extractionMediaStart ?? window.mediaStart;`,
          `            const rate = normalizeRateSpec(video.playbackRate);
            const rampTiming = !video.loop && typeof rate === "object" && !isHttpUrl(videoPath)
                ? video.rampTiming ?? resolveRampPlayback(video, rate) : null;
            const nativeFrames = rampTiming !== null;
            if (!nativeFrames) alignClipStartToFirstOutputFrame(video, fps);
            const initialWindow = resolveVideoExtractionWindow(video, metadata, options.timelineEnd);
            const window = await resolveFinalFrameExtractionWindow(videoPath, video, metadata, initialWindow, signal);
            let videoDuration = window.durationSeconds;
            let extractionMediaStart = window.extractionMediaStart ?? window.mediaStart;
            if (rampTiming) {
                const marks = ${JSON.stringify(markedWindow ?? null)};
                const first = Math.max(0, video.start);
                const last = Math.min(video.end, options.timelineEnd ?? Infinity);
                if (last <= first) return { skipped: true };
                let start = Math.max(first, marks?.start ?? first);
                let end = Math.min(last, marks?.end ?? last);
                // The plan needs a frame entry even for a clip the marked span never shows.
                if (end <= start) {
                    start = first;
                    end = Math.min(last, first + 0.001);
                }
                extractionMediaStart = Math.max(0, Math.min(rampMediaTimeAt(rampTiming, start), window.extractionMediaStart ?? Infinity));
                const sourceEnd = Math.min(resolvePlayableVideoDuration(metadata), rampMediaTimeAt(rampTiming, end));
                // Include the frame at the mapped out-point when FFmpeg rounds its duration.
                videoDuration = Math.max(0, sourceEnd - extractionMediaStart) + 0.0001;
            } else {
                rebaseVideoToWindow(video, window);
            }
            if (videoDuration <= 0) return { skipped: true };
            const keyInput = cacheKeyInputs[index];`,
          url,
        );
        source = replaceOnce(
          source,
          "            const finalFrameOnly = window.finalFrameOnly === true;",
          "            const finalFrameOnly = !nativeFrames && window.finalFrameOnly === true;",
          url,
        );
        source = replaceOnce(
          source,
          '${finalFrameOnly ? "final" : "range"}',
          '${nativeFrames ? "native" : finalFrameOnly ? "final" : "range"}',
          url,
        );
        source = replaceOnce(
          source,
          "                    extractionMediaStart,\n                    finalFrameOnly,",
          "                    extractionMediaStart,\n                    nativeFrames,\n                    rampTiming,\n                    finalFrameOnly,",
          url,
        );
        source = replaceOnce(
          source,
          "        results.push({ result: { ...outcome.result, videoId: prepared.work.video.id } });",
          `        const { video, rampTiming } = prepared.work;
        const pictureTiming = rampTiming && {
            start: rampTiming.start, end: rampTiming.end,
            mediaStart: rampTiming.mediaStart, rate: rampTiming.rate,
        };
        results.push({ result: { ...outcome.result, videoId: video.id, pictureTiming } });`,
          url,
        );
        source = replaceOnce(
          source,
          "    let sourceTime = sourceTimeAt(normalizedPlaybackRate, localTime);",
          `    if (extracted.nativeTimes && extracted.pictureTiming) {
        const mapped = rampMediaTimeAt(extracted.pictureTiming, globalTime);
        if (isVideoHiddenBeforeStreamStart(videoStartOnMediaTimeline(extracted.metadata), mapped)) return null;
        return Math.max(0, frameAtOrBefore(extracted.nativeTimes, mapped));
    }
    let sourceTime = sourceTimeAt(normalizedPlaybackRate, localTime);`,
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
        range?.range &&
        url.endsWith(
          "/@hyperframes/engine/dist/services/parallelCoordinator.js",
        )
      ) {
        let source = `import { capturedFrame as cutroomCapturedFrame } from ${JSON.stringify(import.meta.url)};\n${String(loaded.source)}`;
        // Parallel capture workers draw the listed frames too (see capturedFrame).
        for (const indent of ["            ", "        "])
          source = replaceOnce(
            source,
            `\n${indent}const time = (i * captureOptions.fps.den) / captureOptions.fps.num;`,
            `\n${indent}const time = (cutroomCapturedFrame(i) * captureOptions.fps.den) / captureOptions.fps.num;`,
            url,
          );
        coordinatorLoaded = true;
        return { ...loaded, source };
      }
      if (
        !url.endsWith("/@hyperframes/producer/dist/index.js") &&
        !url.endsWith("/@hyperframes/engine/dist/services/frameCapture.js")
      )
        return loaded;
      let source = String(loaded.source);
      if (url.endsWith("/producer/dist/index.js")) {
        source = `import { rampRuntime } from ${rampRuntime};\nimport { rampMediaTimeAt, resolveRampPlayback } from ${rampWindow};\nimport { projectPath } from ${projectPaths};\nimport { useFreezeExportSources } from ${freezeSources};\nimport { transitionSourceTimes } from ${transitions};\nimport { HttpError } from ${httpErrors};\nimport { provideAudioStage as cutroomProvideAudioStage } from ${JSON.stringify(import.meta.url)};\nimport { rebaseCompiledImageVariables } from ${imageVariables};\nconst cutroomSources = ${JSON.stringify(sources)};\n${source}`;
        source = replaceOnce(
          source,
          "return resolveVerifiedHyperframeRuntime().runtimeSource;",
          "return rampRuntime(resolveVerifiedHyperframeRuntime().runtimeSource);",
          url,
        );
        for (const [before, after] of [
          [
            "function collectRenderMedia(html) {",
            `function placeRamp(clip, absolute, authoredEnd, rampTiming) {
  const end = Number.isFinite(absolute.end) ? absolute.end : 0;
  const placed = startAtPlayed({ ...clip, start: absolute.start, end }, absolute.played);
  if (rampTiming) return { ...placed, rampTiming };
  const rate = normalizeRateSpec2(clip.playbackRate);
  const duration = authoredEnd - clip.start;
  if (clip.loop || typeof rate !== "object" || !Number.isFinite(duration)) return placed;
  return { ...placed, rampTiming: resolveRampPlayback({
    start: absolute.start,
    end: absolute.start + duration,
    mediaStart: clip.mediaStart,
  }, rate, absolute.played) };
}
function collectRenderMedia(html) {
  const videoTiming = new Map();`,
          ],
          [
            `    videos.push(
      startAtPlayed({ ...video, start: absolute.start, end: absolute.end }, absolute.played)
    );`,
            `    const placed = placeRamp(video, absolute, video.end);
    if (placed.rampTiming) videoTiming.set(video.id, placed.rampTiming);
    videos.push(placed);`,
          ],
          [
            "const placed = placeAudio(audio, windowFor(elementId));",
            "const placed = placeAudio(audio, windowFor(elementId), audio.type === 'video' ? videoTiming.get(elementId) : undefined);",
          ],
          [
            "function placeAudio(audio, window2) {",
            "function placeAudio(audio, window2, rampTiming) {",
          ],
          [
            `  const end = Number.isFinite(absolute.end) ? absolute.end : 0;
  return startAtPlayed({ ...audio, start: absolute.start, end }, absolute.played);`,
            "  return placeRamp(audio, absolute, authoredEnd, rampTiming);",
          ],
          [
            "      playbackRate: video.playbackRate,\n      loop: video.loop,",
            "      playbackRate: video.playbackRate,\n      rampTiming: video.rampTiming,\n      loop: video.loop,",
          ],
        ])
          source = replaceOnce(source, before, after, url);
        for (const [before, after] of [
          [
            "        metadata: ext.metadata,\n        ...ext.deferredRange",
            "        metadata: ext.metadata,\n        ...(ext.nativeTimes && { nativeTimes: ext.nativeTimes, pictureTiming: ext.pictureTiming }),\n        ...ext.deferredRange",
          ],
          [
            "      metadata: readVideoMetadata(entry.metadata, `${field}.metadata`),",
            `      metadata: readVideoMetadata(entry.metadata, \`${"${field}"}.metadata\`),
      ...(entry.nativeTimes && {
        nativeTimes: entry.nativeTimes.map((time) => readFiniteNumber(time, field)),
        pictureTiming: {
          start: readFiniteNumber(entry.pictureTiming.start, field),
          end: readFiniteNumber(entry.pictureTiming.end, field),
          mediaStart: readFiniteNumber(entry.pictureTiming.mediaStart, field),
          rate: readRateSpec(entry.pictureTiming.rate, field),
        },
      }),`,
          ],
          [
            "      metadata: v.metadata,\n      framePaths,",
            "      metadata: v.metadata,\n      ...(v.nativeTimes && { nativeTimes: v.nativeTimes, pictureTiming: v.pictureTiming }),\n      framePaths,",
          ],
        ])
          source = replaceOnce(source, before, after, url);
        source = replaceOnce(
          source,
          "function runAudioStage(input) {",
          "cutroomProvideAudioStage(runAudioStage);\nfunction runAudioStage(input) {",
          url,
        );
        source = replaceOnce(
          source,
          "rebaseDirectEntryAssetPaths(readTextFile(htmlPath), projectDir, htmlPath)",
          "rebaseDirectEntryAssetPaths(transitionSourceTimes(useFreezeExportSources(cutroomSources[htmlPath] ?? readTextFile(htmlPath))), projectDir, htmlPath)",
          url,
        );
        source = replaceOnce(
          source,
          '  const compiled = await compileForRender(projectDir, htmlPath, join19(workDir, "downloads"), {',
          '  const compiled = await compileForRender(projectDir, htmlPath, join19(workDir, "downloads"), {\n    cutroomEntryFile: entryFile,',
          url,
        );
        source = replaceOnce(
          source,
          "const sanitizedHtml = inlinedHtml.replace(",
          'const sanitizedHtml = rebaseCompiledImageVariables(inlinedHtml, projectDir, options.cutroomEntryFile ?? "index.html", options.variables).replace(',
          url,
        );
        if (range?.range) {
          const fps = JSON.stringify(range.range.fps);
          const observer = JSON.stringify(import.meta.url);
          const audio = JSON.stringify(
            new URL("./rangeAudio.ts", import.meta.url).href,
          );
          source = `import { cp as cutroomCopyProject } from "node:fs/promises";\nimport { renameSync as cutroomRename } from "node:fs";\nimport { publishRangeProgress, spanParts as cutroomSpanParts, capturedFrame as cutroomCapturedFrame, capturesList as cutroomCapturesList, encodeCaptured as cutroomEncodeCaptured } from ${observer};\nimport { alignRangeAudio, mixRangeAudio as cutroomMixRangeAudio } from ${audio};\nconst cutroomRangeFps = ${fps};\nconst cutroomRange = ${JSON.stringify(range.range)};\n${source}`;
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
          // A span's chunk encodes MOV and WebM as a distributed render does, with their alpha.
          source = replaceOnce(
            source,
            '  if (config.format !== "mp4") {\n    throw new RenderSpanUnsupportedError(',
            '  if (config.format !== "mp4" && config.format !== "mov" && config.format !== "webm") {\n    throw new RenderSpanUnsupportedError(',
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
          // Frames drawn from the sources are encoded beside the plan; only the rest are captured.
          source = replaceOnce(
            source,
            `    const parts = [];
    for (const slice of slices) {
      const range = {
        startFrame: Math.max(slice.startFrame, startFrame),
        endFrame: Math.min(slice.endFrame, endFrame)
      };
      if (range.endFrame <= range.startFrame) continue;
      throwIfAborted(config.abortSignal);
      const part = join45(partsDir, \`part-\${String(parts.length).padStart(4, "0")}.mp4\`);
      await renderChunk(planDir, slice.index, part, { frameRange: range });
      parts.push(part);
    }`,
            `    const parts = await cutroomSpanParts(slices, startFrame, endFrame, async (slice, range, index) => {
      throwIfAborted(config.abortSignal);
      const part = join45(partsDir, \`part-\${String(index).padStart(4, "0")}.\${config.format}\`);
      await renderChunk(planDir, slice.index, part, { frameRange: range });
      return part;
    });`,
            url,
          );
          // One chunk can capture every run: capture index k draws the k-th listed frame. Its
          // video frames are extracted and placed for those frames, and each run encodes alone.
          for (const capture of [
            "const { encodeResult } = await captureFrameToBufferPipelined2(session, i, time);",
            "await captureFrame(session, i, time);",
          ])
            source = replaceOnce(
              source,
              `      const time = absoluteIdx * job.config.fps.den / job.config.fps.num;\n      ${capture}`,
              `      const time = cutroomCapturedFrame(absoluteIdx) * job.config.fps.den / job.config.fps.num;\n      ${capture}`,
              url,
            );
          source = replaceOnce(
            source,
            "const chunkFrameNumbers = Array.from({ length: framesInChunk }, (_, i) => range.startFrame + i);",
            "const chunkFrameNumbers = Array.from({ length: framesInChunk }, (_, i) => cutroomCapturedFrame(range.startFrame + i));",
            url,
          );
          source = replaceOnce(
            source,
            "overlap.current = canEncodeWhileCapturing(encodeInput,",
            "overlap.current = !cutroomCapturesList() && canEncodeWhileCapturing(encodeInput,",
            url,
          );
          source = replaceOnce(
            source,
            "await (overlapped ? overlapped.finish() : runEncodeStage(encodeInput));",
            "await (overlapped ? overlapped.finish() : cutroomEncodeCaptured(encodeInput, runEncodeStage, (frames) => chunkGopFrames(frames, encoder.keyframeIntervalFrames)));",
            url,
          );
          // A listed capture writes its runs' parts instead of the chunk's one file.
          source = replaceOnce(
            source,
            "const sha256 = hashChunkOutput(outputChunkPath, outputKind);",
            'const sha256 = cutroomCapturesList() ? "" : hashChunkOutput(outputChunkPath, outputKind);',
            url,
          );
          source = replaceOnce(
            source,
            "    await writeStitchedMp4(parts, outputPath);",
            `    const cutroomVideo = join45(workDir, \`range.\${config.format}\`);
    if (config.format === "mp4") await writeStitchedMp4(parts, cutroomVideo);
    else if (parts.length === 1) cutroomRename(parts[0], cutroomVideo);
    else throw new Error(\`A \${config.format} range rendered \${parts.length} parts; it should render one.\`);
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
          "const rawSubHtml = normalizeCompositionSrcs(transitionSourceTimes(useFreezeExportSources(cutroomSources[filePath] ?? read.text)), projectDir);",
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
    if (
      !producerLoaded ||
      !audioMixerLoaded ||
      !captureLoaded ||
      !extractorLoaded ||
      !coordinatorLoaded
    )
      throw new Error(
        "The HyperFrames render isolation hooks did not load. Export was refused.",
      );
  };
}
