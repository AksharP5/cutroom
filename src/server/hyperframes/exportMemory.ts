const GiB = 1024 ** 3;
/**
 * One capture browser. Every capture page loads every media element, so measured Chromium PSS
 * was 0.72 GiB plus about 11 MB per video or audio clip: 0.90, 2.08 and 3.82 GiB at 16, 120
 * and 280 clips. Rounded up.
 */
const browserBytes = (mediaClips: number) => (0.75 + 0.012 * mediaClips) * GiB;
/**
 * Each further browser counts double: two browsers on 280 clips had passed 2.2 times one
 * browser's memory, and were still climbing, when they were stopped.
 */
const furtherBrowserShare = 2;
/** The render worker and encoder, plus HyperFrames' captured-frame cache, which grows to 1.5 GB. */
const sharedBytes = (frames: number) =>
  (1 + Math.min(1.5, frames / 1024)) * GiB;
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
  frames,
}: {
  available: number;
  mediaClips: number;
  frames: number;
}): { browsers: number } | { refusal: string } {
  const first = browserBytes(mediaClips);
  const needed = reserveBytes + sharedBytes(frames) + first;
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
