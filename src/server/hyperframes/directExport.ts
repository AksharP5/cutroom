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
import type { AudioElement, EngineConfig } from "@hyperframes/engine";
import { alignRangeAudio, mixRangeAudio } from "./rangeAudio.ts";
import { projectPath } from "../projects/path.ts";
import { PARALLEL_ENCODES } from "./exportMemory.ts";
import type { DirectPlan, SourceSegment } from "./directPlan.ts";
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

type Piece = SourceSegment & { path: string };
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
        mediaStart:
          piece.mediaStart + ((start - piece.start) * fps.den) / fps.num,
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
): Promise<{ pieces: Piece[] } | { reason: string }> {
  const segments = plan.segments.filter(
    (segment): segment is SourceSegment => segment.kind === "source",
  );
  const sources = new Map<string, string | undefined>();
  for (const src of new Set(segments.map((segment) => segment.src))) {
    // The browser asks the capture server for the decoded path, which this same boundary checks.
    const path = await Promise.resolve()
      .then(() => projectPath({ path: projectDir }, decodeURIComponent(src)))
      .catch(() => undefined);
    if (!path) return { reason: `${src} is not a file in the project` };
    const metadata = await extractMediaMetadata(path);
    if (metadata.sampleAspectRatio && metadata.sampleAspectRatio !== 1)
      return { reason: `${src} has non-square pixels` };
    if (metadata.rotation) return { reason: `${src} is rotated` };
    if (metadata.width * plan.height !== metadata.height * plan.width)
      return { reason: `${src} has a different aspect ratio` };
    sources.set(src, path);
  }
  return {
    pieces: segments.map((segment) => ({
      ...segment,
      path: sources.get(segment.src)!,
    })),
  };
}

/** Encodes one part's pieces in a single FFmpeg process with the capture path's encoder. */
async function encodePart(input: {
  pieces: Piece[];
  outputPath: string;
  fps: Fps;
  width: number;
  height: number;
  encoder: Parameters<typeof buildEncoderArgs>[0];
  signal: AbortSignal;
  timeout: number;
  onFrames: (frames: number) => void;
}) {
  const { fps, width, height, pieces } = input;
  const inputs: string[] = [];
  const chains: string[] = [];
  for (const [index, piece] of pieces.entries()) {
    const frames = piece.end - piece.start;
    const layer = await buildVideoLayerInput(
      piece.path,
      piece.mediaStart,
      (frames * fps.den) / fps.num,
      fps,
      { width, height },
      "fill",
    );
    if (!layer)
      throw new Error(
        `FFmpeg cannot draw ${piece.src} from ${piece.mediaStart.toFixed(3)} s as the preview does.`,
      );
    inputs.push(...layer.inputArgs);
    chains.push(
      `[${index}:v]${[...layer.filters, `trim=end_frame=${frames}`, "setpts=PTS-STARTPTS"].join(",")}[p${index}]`,
    );
  }
  const total = pieces.reduce((sum, piece) => sum + piece.end - piece.start, 0);
  // Frames leave the layer filters in their source matrix and range, tagged as the sRGB the
  // preview draws. The capture path writes the same tagged BT.709 limited-range 4:2:0.
  const graph = `${chains.join(";")};${pieces.map((_, index) => `[p${index}]`).join("")}concat=n=${pieces.length}:v=1:a=0,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[v]`;
  const args = buildEncoderArgs(
    { ...input.encoder, lockGopForChunkConcat: true, gopSize: total },
    [
      ...inputs,
      "-filter_complex",
      graph,
      "-map",
      "[v]",
      "-frames:v",
      String(total),
    ],
    input.outputPath,
  );
  // The encoder arguments convert screenshots. These frames are converted in the graph above.
  const capture = args.indexOf("-vf");
  if (capture === -1 || args.lastIndexOf("-vf") !== capture)
    throw new Error(
      "Cutroom's direct export no longer matches HyperFrames' encoder arguments. Review the HyperFrames upgrade.",
    );
  args.splice(capture, 2);
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
  engineConfig: EngineConfig;
  signal: AbortSignal;
};

/**
 * Encodes the plan's source runs with the capture path's encoder settings, a few parts at once,
 * each one closed GOP, so they join with captured parts without re-encoding.
 */
export async function encodeSourceParts(
  input: Encoding & { onFrames: (frames: number) => void },
): Promise<EncodedPart[]> {
  const { plan, fps, signal } = input;
  const partsDir = join(input.workDir, "parts");
  await mkdir(partsDir, { recursive: true });
  const preset = getEncoderPreset(input.quality, "mp4");
  const encoder = {
    fps,
    width: plan.width,
    height: plan.height,
    codec: "h264" as const,
    preset: preset.preset,
    quality: input.crf ?? preset.quality,
    bitrate: input.crf === undefined ? input.bitrate : undefined,
    maxBitrate: input.maxBitrate,
    bufferSize: input.bufferSize,
    pixelFormat: preset.pixelFormat,
  };
  const parts = partition(input.pieces, fps).map((pieces, index) => ({
    pieces,
    start: pieces[0]!.start,
    end: pieces.at(-1)!.end,
    path: join(partsDir, `source-${String(index).padStart(4, "0")}.mp4`),
  }));
  let next = 0;
  await Promise.all(
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
            encoder,
            signal,
            timeout: input.engineConfig.ffmpegEncodeTimeout,
            onFrames: input.onFrames,
          });
        }
      },
    ),
  );
  signal.throwIfAborted();
  return parts.map(({ start, end, path }) => ({ start, end, path }));
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
  if (videoResult.status === "rejected") throw videoResult.reason;
  if (audioResult.status === "rejected") throw audioResult.reason;

  input.progress({
    progress: 96,
    stage: "Assembling",
    stageProgress: { code: "assemble" },
  });
  const stitched = join(input.workDir, "video.mp4");
  const concat = await concatVideoFiles(
    videoResult.value.map((part) => part.path),
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
  return { audioLoweredDb: audioResult.value.audioLoweredDb };
}
