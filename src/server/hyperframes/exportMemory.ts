import { cpus } from "node:os";

const GiB = 1024 ** 3;
/** FFmpeg encodes an export runs at once, source parts or captured runs; x264 threads within each. */
export const PARALLEL_ENCODES = Math.max(
  1,
  Math.min(4, Math.floor(cpus().length / 4)),
);
/**
 * What one source-part encoder holds while frame capture runs beside it: four measured 3.0 GB
 * together at 1080p, each decoding up to four sources. Scaled by frame size, never below that.
 */
const sourceEncoderBytes = (pixels: number) =>
  0.8 * GiB * Math.max(1, pixels / (1920 * 1080));
/**
 * One capture browser. Chromium PSS was 0.72 GiB plus about 11 MB per loaded video or audio clip:
 * 0.90, 2.08 and 3.82 GiB at 16, 120 and 280 clips. A marked render defers unused videos but
 * still loads the full document. On 1,038 clips, four initializing browsers plus source encoders
 * reached 11.35 GiB with 42 clips in the capture runs. Allow for the rest of the document.
 */
const browserBytes = (mediaClips: number, outsideRange: number) =>
  (0.75 + 0.012 * mediaClips + 0.0025 * outsideRange) * GiB;
/**
 * Each further browser counts double: two browsers on 280 clips had passed 2.2 times one
 * browser's memory, and were still climbing, when they were stopped.
 */
const furtherBrowserShare = 2;
/**
 * The render worker and the encoder of the captured frames. Within 1 GB at 1080p; at 4K the encoder
 * alone peaked at 2.3 GB for libx264, 2.8 GB for VP9 and 4.0 GB for ProRes 4444 (1.05 GB at
 * 1080p), with the worker's 0.25 GB beside it. Scaled by the frame's megapixels, rounded up.
 */
const encoderBytes = (outputPixels: number, prores: boolean) =>
  Math.max(1, ((prores ? 0.55 : 0.4) * outputPixels) / 1e6) * GiB;
/** HyperFrames' captured-frame cache, which grows to 1.5 GB. */
const cacheBytes = (frames: number) => Math.min(1.5, frames / 1024) * GiB;
/** Left free for the editor, the desktop and everything else running. */
const reserveBytes = 2 * GiB;
/**
 * Below about 75 frames each, more browsers only add startup time and memory: a 150-frame range
 * took 16 s with 2, 3 or 6 browsers, and 24 s with one.
 */
const framesPerBrowser = 75;

/** How many capture browsers an export can start without exhausting memory, or why it can't start. */
export function planCaptureBrowsers({
  available,
  mediaClips,
  mediaClipsOutsideRange = 0,
  frames,
  sourcePixels = 0,
  outputPixels = 0,
  prores = false,
}: {
  available: number;
  mediaClips: number;
  mediaClipsOutsideRange?: number;
  frames: number;
  /** The frame size, when FFmpeg encodes source parts while the browsers capture. */
  sourcePixels?: number;
  /** The frame the export writes. */
  outputPixels?: number;
  /** The captured frames encode as ProRes 4444: a MOV, or the MOV a GIF is made from. */
  prores?: boolean;
}): { browsers: number } | { refusal: string } {
  const first = browserBytes(mediaClips, mediaClipsOutsideRange);
  const needed =
    reserveBytes +
    encoderBytes(outputPixels, prores) +
    cacheBytes(frames) +
    first +
    (sourcePixels ? PARALLEL_ENCODES * sourceEncoderBytes(sourcePixels) : 0);
  if (available < needed)
    return {
      refusal: `This export needs about ${(needed / GiB).toFixed(1)} GB of free memory and ${(available / GiB).toFixed(1)} GB is free. Close other apps and try again.`,
    };
  const further = Math.floor(
    (available - needed) / (first * furtherBrowserShare),
  );
  return {
    browsers: Math.max(
      1,
      Math.min(Math.ceil(frames / framesPerBrowser), 1 + further),
    ),
  };
}
