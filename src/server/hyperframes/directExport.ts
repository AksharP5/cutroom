import { offsetSourceTime } from "../../shared/timeline/time.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  buildEncoderArgs,
  buildVideoLayerInput,
  concatVideoFiles,
  extractMediaMetadata,
  getEncoderPreset,
  parseMasterFxChain,
  runFfmpeg,
} from "@hyperframes/engine";
import type {
  AudioElement,
  EngineConfig,
  VideoMetadata,
} from "@hyperframes/engine";
import { alignRangeAudio, mixRangeAudio } from "./rangeAudio.ts";
import { ExportStageError } from "./renderFailure.ts";
import { projectPath } from "../projects/path.ts";
import { bakeGrade, writeBakedGrade } from "../grade/luts.ts";
import { PARALLEL_ENCODES } from "./exportMemory.ts";
import { NVENC } from "./nvenc.ts";
import type { DirectPlan, Placement, SourceSegment } from "./directSchema.ts";
import { contentRect, placeOnFrame, visibleRect } from "./directPlacement.ts";
import type { Fps } from "../../shared/timeline/schema.ts";
import type { ExportStage } from "../../shared/export.ts";

/** The planner's audio stage, which Cutroom's render isolation hands over when the producer loads. */
export type AudioStage = (input: {
  projectDir: string;
  workDir: string;
  totalFrames: number;
  fps: Fps;
  audios: AudioElement[];
  masterFxChain?: string;
  ffmpegProcessTimeout: number;
  audioGain: number;
  abortSignal: AbortSignal;
  assertNotAborted: () => void;
  keepDeliverySource: true;
}) => Promise<{
  audioOutputPath: string;
  hasAudio: boolean;
  audioLoweredDb?: number;
  deliverySourcePath?: string;
}>;

type Progress = (event: {
  progress: number;
  stage: string;
  stageProgress?: ExportStage;
}) => void;

/** A part encodes this many frames at most, so a long clip still spreads across processes. */
const PART_FRAMES = 300;
/** Inputs one FFmpeg process opens at a time; each holds a decoder. */
const PART_INPUTS = 8;

type MediaInput = {
  path: string;
  video?: Pick<VideoMetadata, "width" | "height" | "pixelFormat">;
};
/** A run with its file on disk and, when graded, the baked grade FFmpeg reads. */
type Piece = SourceSegment & MediaInput & { cube?: string };
/** An encoded run of frames, in the export's frame numbers. */
export type EncodedPart = { start: number; end: number; path: string };

/**
 * Splits the source runs into parts of at most PART_FRAMES frames and PART_INPUTS sources. A part
 * never spans a gap, which frame capture fills.
 */
function partition(pieces: Piece[], fps: Fps) {
  const parts: Piece[][] = [];
  let part: Piece[] = [];
  let frames = 0;
  for (const piece of pieces)
    for (let start = piece.start; start < piece.end;) {
      if (
        frames === PART_FRAMES ||
        part.length === PART_INPUTS ||
        (part.length && part.at(-1)!.end !== start)
      ) {
        parts.push(part);
        part = [];
        frames = 0;
      }
      const end = Math.min(piece.end, start + PART_FRAMES - frames);
      part.push({
        ...piece,
        start,
        end,
        mediaStart: offsetSourceTime(
          piece.mediaStart,
          start - piece.start,
          fps,
        ),
      });
      frames += end - start;
      start = end;
    }
  if (part.length) parts.push(part);
  return parts;
}

/**
 * Checks every source the plan uses. Returns why the browser must draw it instead: FFmpeg reads
 * only constant-rate SDR video without alpha, which `buildVideoLayerInput` reproduces exactly as
 * frame extraction samples and colours it, and only at the composition's own aspect ratio.
 */
export async function prepareDirectExport(
  plan: DirectPlan,
  projectDir: string,
  entryFile: string,
  workDir: string,
): Promise<{ pieces: Piece[] } | { reason: string }> {
  const segments = plan.segments.filter(
    (segment): segment is SourceSegment => segment.kind === "source",
  );
  const sources = new Map<string, MediaInput>();
  for (const { src, still } of segments) {
    if (sources.has(src)) continue;
    // The browser asks the capture server for the decoded path, which this same boundary checks.
    const path = await Promise.resolve()
      .then(() => projectPath({ path: projectDir }, decodeURIComponent(src)))
      .catch(() => undefined);
    if (!path) return { reason: `${src} is not a file in the project` };
    // The server read the still's header when it planned the export.
    if (still) {
      sources.set(src, { path });
      continue;
    }
    const metadata = await extractMediaMetadata(path);
    if (metadata.sampleAspectRatio && metadata.sampleAspectRatio !== 1)
      return { reason: `${src} has non-square pixels` };
    if (metadata.rotation) return { reason: `${src} is rotated` };
    if (metadata.width * plan.height !== metadata.height * plan.width)
      return { reason: `${src} has a different aspect ratio` };
    sources.set(src, {
      path,
      video: {
        width: metadata.width,
        height: metadata.height,
        pixelFormat: metadata.pixelFormat,
      },
    });
  }
  // One bake per distinct grade, at 65 points, written where every part's FFmpeg reads it.
  const cubes = new Map<string, string>();
  for (const { grade } of segments) {
    if (!grade) continue;
    const key = JSON.stringify(grade);
    if (cubes.has(key)) continue;
    const cube = join(workDir, "grades", `${cubes.size}.cube`);
    const baked = await bakeGrade(
      { path: projectDir },
      entryFile,
      grade,
      65,
    ).catch((error: unknown) => (error instanceof Error ? error : null));
    if (baked instanceof Error || baked === null)
      return { reason: `a grade cannot be baked (${baked?.message})` };
    await writeBakedGrade(cube, baked);
    cubes.set(key, cube);
  }
  return {
    pieces: segments.map((segment) => ({
      ...segment,
      ...sources.get(segment.src)!,
      ...(segment.grade && { cube: cubes.get(JSON.stringify(segment.grade)) }),
    })),
  };
}

/**
 * A path as a filter option inside a graph: escaped once for the option, once for the graph.
 * Only numbers, validated colours and this path reach the graph.
 */
const graphPath = (path: string) =>
  path.replace(/[\\':]/g, "\\$&").replace(/[\\'[\],;]/g, "\\$&");

/**
 * The grade, drawn as the runtime's shader draws it: on the picture decoded to 8-bit RGB, rounded
 * and with chroma interpolated as the browser decodes it (FFmpeg's default conversion reads half a
 * level darker, which a grade's contrast doubles), through the LUT baked from the grade.
 */
const gradeFilters = (cube: string | undefined) =>
  cube
    ? [
        "scale=flags=accurate_rnd+full_chroma_int",
        "format=gbrp",
        `lut3d=file=${graphPath(cube)}:interp=trilinear`,
      ]
    : [];

/** Pixels of transparent margin around a placed picture, so resampling at its edges blends to nothing. */
const MARGIN = 2;

// Normalize every input before concat. Older FFmpeg versions use the first input's
// matrix for a scale after concat, even when later inputs carry different tags.
const deliveryMatrix =
  "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd";
const deliveryFormat = "format=yuv420p";
const deliveryTags =
  "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";

/**
 * The filter graph that draws a placed picture as the browser composites it: cropped in its box,
 * scaled, rotated and moved about the frame's centre, faded by its opacity, over the page colour
 * beneath it. It works in RGB, as the browser does, and leaves tagged BT.709 limited-range frames
 * like the plain parts. Only numbers and validated colours reach the graph.
 */
function placed(
  index: number,
  fit: "contain" | "cover" | "fill",
  picture: { width: number; height: number },
  placement: Placement,
  frame: { width: number; height: number },
  rate: string,
  after: string[],
  before: string[] = [],
  grading: string[] = [],
) {
  const content = contentRect(fit, picture, frame);
  const shown = visibleRect(content, placement.crop, frame);
  if (!shown)
    throw new Error("A placed clip with nothing visible was planned.");
  const across = (content.right - content.left) / picture.width;
  const down = (content.bottom - content.top) / picture.height;
  // The picture's own pixels that show, which the planner checked are whole.
  const crop = {
    x: Math.round((shown.left - content.left) / across),
    y: Math.round((shown.top - content.top) / down),
    width: Math.round((shown.right - shown.left) / across),
    height: Math.round((shown.bottom - shown.top) / down),
  };
  // Resample once to about the size it is drawn at, so the warp below moves it by less than a pixel.
  const size = {
    width: Math.max(
      1,
      Math.round((shown.right - shown.left) * placement.scaleX),
    ),
    height: Math.max(
      1,
      Math.round((shown.bottom - shown.top) * placement.scaleY),
    ),
  };
  const canvas = {
    width: Math.max(size.width, frame.width) + 2 * MARGIN,
    height: Math.max(size.height, frame.height) + 2 * MARGIN,
  };
  const place = placeOnFrame(placement, frame);
  // Where each canvas corner lands, in output pixel indexes: pixel i is centred on i + 0.5.
  const corner = (x: number, y: number) => {
    const at = place({
      x:
        shown.left +
        ((x - MARGIN + 0.5) * (shown.right - shown.left)) / size.width,
      y:
        shown.top +
        ((y - MARGIN + 0.5) * (shown.bottom - shown.top)) / size.height,
    });
    return [at.x - 0.5 + MARGIN, at.y - 0.5 + MARGIN].map((value) =>
      value.toFixed(6),
    );
  };
  const [x0, y0] = corner(0, 0);
  const [x1, y1] = corner(canvas.width, 0);
  const [x2, y2] = corner(0, canvas.height);
  const [x3, y3] = corner(canvas.width, canvas.height);
  const beneath = (placement.beneath ?? "#000000").replace("#", "0x");
  const picturePart = [
    ...before,
    ...grading,
    "format=gbrap",
    ...(crop.x ||
    crop.y ||
    crop.width !== picture.width ||
    crop.height !== picture.height
      ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`]
      : []),
    ...(size.width !== crop.width || size.height !== crop.height
      ? [`scale=${size.width}:${size.height}:flags=bicubic`]
      : []),
    `pad=${canvas.width}:${canvas.height}:${MARGIN}:${MARGIN}:color=black@0`,
    `perspective=x0=${x0}:y0=${y0}:x1=${x1}:y1=${y1}:x2=${x2}:y2=${y2}:x3=${x3}:y3=${y3}:sense=destination`,
    `crop=${frame.width}:${frame.height}:${MARGIN}:${MARGIN}`,
    ...(placement.opacity < 1
      ? [`colorchannelmixer=aa=${placement.opacity}`]
      : []),
  ];
  return [
    `[${index}:v]${picturePart.join(",")}[q${index}]`,
    `color=c=${beneath}:s=${frame.width}x${frame.height}:r=${rate},format=gbrp[b${index}]`,
    `[b${index}][q${index}]${[
      "overlay=format=gbrp:shortest=1",
      deliveryMatrix,
      deliveryFormat,
      deliveryTags,
      ...after,
    ].join(",")}[p${index}]`,
  ].join(";");
}

export type VideoEncoder = "libx264" | "h264_nvenc";
type EncoderOptions = Parameters<typeof buildEncoderArgs>[0];

/**
 * The encoder settings for every part of one export: the capture path's libx264 preset, or
 * NVENC's equivalent tier.
 */
export function sourceEncoder(
  input: Pick<
    Encoding,
    "plan" | "fps" | "quality" | "crf" | "bitrate" | "maxBitrate" | "bufferSize"
  >,
  encoder: VideoEncoder,
): EncoderOptions {
  const preset = getEncoderPreset(input.quality, "mp4");
  const gpu = encoder === "h264_nvenc" ? NVENC[input.quality] : undefined;
  return {
    fps: input.fps,
    width: input.plan.width,
    height: input.plan.height,
    codec: "h264",
    preset: gpu?.preset ?? preset.preset,
    quality: gpu?.quality ?? input.crf ?? preset.quality,
    bitrate: input.crf === undefined ? input.bitrate : undefined,
    maxBitrate: input.maxBitrate,
    bufferSize: input.bufferSize,
    pixelFormat: preset.pixelFormat,
    useGpu: gpu !== undefined,
  };
}

/**
 * FFmpeg's arguments to encode `frames` frames from `inputArgs` (inputs, graph and map) as one
 * closed GOP, so parts join without re-encoding.
 */
export function partEncoderArgs(
  encoder: EncoderOptions,
  frames: number,
  inputArgs: string[],
  outputPath: string,
) {
  const args = buildEncoderArgs(
    { ...encoder, lockGopForChunkConcat: true, gopSize: frames },
    // HyperFrames locks the GOP for libx264 only. NVENC starts each part on an IDR frame and,
    // without B-frames, references nothing before it; one GOP keeps it free of later I-frames.
    [
      ...inputArgs,
      ...["-frames:v", String(frames)],
      ...(encoder.useGpu ? ["-g", String(frames)] : []),
    ],
    outputPath,
    encoder.useGpu ? "nvenc" : null,
  );
  // The encoder arguments convert screenshots. These frames are converted in the graph.
  const capture = args.indexOf("-vf");
  if (capture === -1 || args.lastIndexOf("-vf") !== capture)
    throw new Error(
      "Cutroom's direct export no longer matches HyperFrames' encoder arguments. Review the HyperFrames upgrade.",
    );
  args.splice(capture, 2);
  return args;
}

/** Encodes one part's pieces in a single FFmpeg process. */
async function encodePart(input: {
  pieces: Piece[];
  outputPath: string;
  fps: Fps;
  width: number;
  height: number;
  encoder: EncoderOptions;
  signal: AbortSignal;
  timeout: number;
  onFrames: (frames: number) => void;
}) {
  const { fps, width, height, pieces } = input;
  const inputs: string[] = [];
  const chains: string[] = [];
  const rate = `${fps.num}/${fps.den}`;
  for (const [index, piece] of pieces.entries()) {
    const frames = piece.end - piece.start;
    const frame = { width, height };
    if (piece.still) {
      const { still, placement } = piece;
      if (!placement || !still.width || !still.height)
        throw new Error(`${piece.src} was planned without its size.`);
      inputs.push("-framerate", rate, "-i", piece.path);
      // A still is drawn once, then held for the run.
      chains.push(
        placed(
          index,
          still.fit,
          { width: still.width, height: still.height },
          placement,
          frame,
          rate,
          [
            "trim=end_frame=1",
            `loop=loop=${frames - 1}:size=1:start=0`,
            "setpts=N/FRAME_RATE/TB",
          ],
          [],
          gradeFilters(piece.cube),
        ),
      );
      continue;
    }
    // Resizing first can make older FFmpeg versions infer a different source matrix.
    // For plain footage, do the colour conversion at source size and resize afterwards.
    const sampleSize = piece.placement ? frame : (piece.video ?? frame);
    const resize =
      sampleSize.width === width && sampleSize.height === height
        ? null
        : `scale=${width}:${height}:flags=bicubic`;
    // Keep finer chroma until after resampling. Ordinary 4:2:0 needs no intermediate.
    const format =
      resize && !/^yuvj?420p/.test(piece.video?.pixelFormat ?? "")
        ? ["format=yuv444p", resize, deliveryFormat]
        : [deliveryFormat, ...(resize ? [resize] : [])];
    const layer = await buildVideoLayerInput(
      piece.path,
      piece.mediaStart,
      (frames * fps.den) / fps.num,
      fps,
      sampleSize,
      "fill",
    );
    if (!layer)
      throw new Error(
        `FFmpeg cannot draw ${piece.src} from ${piece.mediaStart.toFixed(3)} s as the preview does.`,
      );
    inputs.push(...layer.inputArgs);
    const trim = [`trim=end_frame=${frames}`, "setpts=PTS-STARTPTS"];
    chains.push(
      piece.placement
        ? placed(
            index,
            "fill",
            frame,
            piece.placement,
            frame,
            rate,
            trim,
            layer.filters,
            gradeFilters(piece.cube),
          )
        : `[${index}:v]${[...layer.filters, ...gradeFilters(piece.cube), deliveryMatrix, ...format, deliveryTags, ...trim].join(",")}[p${index}]`,
    );
  }
  const total = pieces.reduce((sum, piece) => sum + piece.end - piece.start, 0);
  // Each piece is tagged BT.709 limited-range 4:2:0, as the capture path writes.
  const graph = `${chains.join(";")};${pieces.map((_, index) => `[p${index}]`).join("")}concat=n=${pieces.length}:v=1:a=0[v]`;
  const args = partEncoderArgs(
    input.encoder,
    total,
    [...inputs, "-filter_complex", graph, "-map", "[v]"],
    input.outputPath,
  );
  let reported = 0;
  const result = await runFfmpeg(args, {
    signal: input.signal,
    timeout: input.timeout,
    onStderr: (chunk) => {
      const counts = [...chunk.matchAll(/frame=\s*(\d+)/g)];
      const frames = Number(counts.at(-1)?.[1] ?? reported);
      if (frames > reported) {
        input.onFrames(frames - reported);
        reported = frames;
      }
    },
  });
  if (!result.success)
    throw new Error(
      `Encoding from the source failed: ${result.stderr.slice(-2000)}`,
    );
  input.onFrames(total - reported);
}

type Encoding = {
  plan: DirectPlan;
  pieces: Piece[];
  workDir: string;
  fps: Fps;
  quality: "draft" | "standard" | "high";
  crf?: number;
  bitrate?: string;
  maxBitrate?: string;
  bufferSize?: string;
  /** Encode with NVENC, which the server's probe found working. */
  gpu: boolean;
  engineConfig: EngineConfig;
  signal: AbortSignal;
};

/**
 * Encodes the plan's source runs a few parts at once, each one closed GOP, so they join with
 * each other and with captured parts without re-encoding. With `gpu`, NVENC encodes them; if any
 * part fails, libx264 encodes every part again, so an export never mixes the two encoders. A
 * chosen CRF is libx264's scale, so it always encodes with libx264.
 */
export async function encodeSourceParts(
  input: Encoding & { onFrames: (frames: number) => void },
): Promise<{ parts: EncodedPart[]; encoder: VideoEncoder }> {
  const { plan, fps } = input;
  const partsDir = join(input.workDir, "parts");
  await mkdir(partsDir, { recursive: true });
  const parts = partition(input.pieces, fps).map((pieces, index) => ({
    pieces,
    start: pieces[0]!.start,
    end: pieces.at(-1)!.end,
    path: join(partsDir, `source-${String(index).padStart(4, "0")}.mp4`),
  }));
  const encodeAll = async (encoder: VideoEncoder) => {
    const options = sourceEncoder(input, encoder);
    // The first failure stops the other parts; every FFmpeg has exited once they settle.
    const failed = new AbortController();
    const signal = AbortSignal.any([input.signal, failed.signal]);
    let next = 0;
    let encoded = 0;
    const results = await Promise.allSettled(
      Array.from(
        { length: Math.min(PARALLEL_ENCODES, parts.length) },
        async () => {
          while (next < parts.length && !signal.aborted) {
            const part = parts[next++]!;
            await encodePart({
              pieces: part.pieces,
              outputPath: part.path,
              fps,
              width: plan.width,
              height: plan.height,
              encoder: options,
              signal,
              timeout: input.engineConfig.ffmpegEncodeTimeout,
              onFrames: (frames) => {
                encoded += frames;
                input.onFrames(frames);
              },
            }).catch((error: unknown) => {
              failed.abort();
              throw error;
            });
          }
        },
      ),
    );
    input.signal.throwIfAborted();
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    return { failure, encoded };
  };
  const done = (encoder: VideoEncoder) => ({
    encoder,
    parts: parts.map(({ start, end, path }) => ({ start, end, path })),
  });
  if (input.gpu && input.crf === undefined) {
    const nvenc = await encodeAll("h264_nvenc");
    if (!nvenc.failure) return done("h264_nvenc");
    const { reason } = nvenc.failure;
    console.warn(
      "NVENC could not encode this export, so libx264 encodes it:",
      reason instanceof Error ? reason.message : reason,
    );
    input.onFrames(-nvenc.encoded);
  }
  const x264 = await encodeAll("libx264");
  if (x264.failure) throw x264.failure.reason;
  return done("libx264");
}

/** Exports a range drawn entirely from its sources, with the planner's own audio mix. */
export async function exportDirect(
  input: Encoding & {
    html: string;
    projectDir: string;
    outputPath: string;
    audioStage: AudioStage;
    collectAudio: (html: string) => AudioElement[];
    progress: Progress;
  },
) {
  const { plan, fps, signal, engineConfig } = input;
  const frames = plan.frames.end - plan.frames.start;
  let encoded = 0;
  const report = (done: number) => {
    encoded += done;
    input.progress({
      progress: 5 + (90 * encoded) / frames,
      stage: `Encoding frame ${encoded}/${frames} from the source`,
      stageProgress: { code: "encode", done: encoded, total: frames },
    });
  };
  report(0);
  const video = encodeSourceParts({ ...input, onFrames: report });
  const audioWork = join(input.workDir, "audio", "plan", "work");
  await mkdir(audioWork, { recursive: true });
  const audio = mixRangeAudio(
    {
      composition: {
        audios: input.collectAudio(input.html),
        masterFxChain: parseMasterFxChain(input.html),
      },
      totalFrames: plan.durationFrames,
      workDir: audioWork,
    },
    { fps, frames: plan.frames },
    (stage) =>
      input.audioStage({
        ...stage,
        projectDir: input.projectDir,
        workDir: audioWork,
        ffmpegProcessTimeout: engineConfig.ffmpegProcessTimeout,
        audioGain: engineConfig.audioGain,
        abortSignal: signal,
        assertNotAborted: () => signal.throwIfAborted(),
      }),
  );
  // Settle both before reading either, so a failed encode never leaves the mix running.
  const [videoResult, audioResult] = await Promise.allSettled([video, audio]);
  signal.throwIfAborted();
  if (videoResult.status === "rejected")
    throw new ExportStageError("encode", videoResult.reason);
  if (audioResult.status === "rejected")
    throw new ExportStageError("process_audio", audioResult.reason);

  input.progress({
    progress: 96,
    stage: "Assembling",
    stageProgress: { code: "assemble" },
  });
  const stitched = join(input.workDir, "video.mp4");
  const concat = await concatVideoFiles(
    videoResult.value.parts.map((part) => part.path),
    stitched,
    signal,
    engineConfig,
  );
  if (!concat.success)
    throw new Error(`Joining the encoded parts failed: ${concat.error}`);
  await alignRangeAudio({
    videoPath: stitched,
    audioPath: audioResult.value.hasAudio
      ? audioResult.value.audioOutputPath
      : null,
    outputPath: input.outputPath,
    fps,
    frames: plan.frames,
    signal,
  });
  return {
    audioLoweredDb: audioResult.value.audioLoweredDb,
    encoder: videoResult.value.encoder,
  };
}
