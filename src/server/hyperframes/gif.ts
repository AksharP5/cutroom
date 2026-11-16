import { readFile, rm, writeFile } from "node:fs/promises";
import {
  clearGifFramesBeforeNext,
  gifClearsAfterLeavingFrameInPlace,
} from "@hyperframes/core";
import { runFfmpeg } from "@hyperframes/engine";
import type { Fps } from "../../shared/timeline/schema.ts";

/**
 * A GIF from a ProRes 4444 render, with HyperFrames' GIF settings but a palette built from every
 * pixel: one palette for the whole export, keeping a transparent entry, and pixels under half
 * alpha clear. HyperFrames builds its palette from frame differences, which leaves out the colours
 * of a title that appears over transparency and stays.
 */
export async function encodeGif(input: {
  videoPath: string;
  outputPath: string;
  fps: Fps;
  loop: number;
  signal: AbortSignal;
}) {
  const rate =
    input.fps.den === 1
      ? String(input.fps.num)
      : `${input.fps.num}/${input.fps.den}`;
  const palette = `${input.videoPath}.palette.png`;
  const run = async (args: string[]) => {
    const result = await runFfmpeg(["-v", "error", "-y", ...args], {
      signal: input.signal,
    });
    if (!result.success)
      throw new Error(`GIF encoding failed: ${result.stderr.trim()}`);
  };
  const encode = (wholeFrames: boolean) =>
    run([
      "-i",
      input.videoPath,
      "-i",
      palette,
      "-lavfi",
      `fps=${rate},format=rgba [x]; [x][1:v] paletteuse=dither=sierra2_4a:alpha_threshold=128`,
      "-loop",
      String(input.loop),
      ...(wholeFrames ? ["-gifflags", "0"] : []),
      input.outputPath,
    ]);
  try {
    await run([
      "-i",
      input.videoPath,
      "-vf",
      // HyperFrames reads RGBA screenshots. ProRes frames must become RGBA first, or the palette
      // is built from a conversion that turns opaque colours black.
      `fps=${rate},format=rgba,palettegen=reserve_transparent=1`,
      palette,
    ]);
    await encode(false);
    // FFmpeg's GIF frames can leave the previous picture showing where this one is transparent.
    if (
      gifClearsAfterLeavingFrameInPlace(await readFile(input.outputPath)) !==
      false
    ) {
      await encode(true);
      const gif = await readFile(input.outputPath);
      if (!clearGifFramesBeforeNext(gif))
        throw new Error("The GIF could not be parsed to clear its frames.");
      await writeFile(input.outputPath, gif);
    }
  } finally {
    await rm(palette, { force: true });
  }
}
