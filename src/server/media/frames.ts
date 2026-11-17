import { stat } from "node:fs/promises";
import {
  extractMediaMetadata,
  videoStartOnMediaTimeline,
} from "@hyperframes/engine";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { z } from "zod";
import type { FrameGrid } from "../../shared/frames";
import { fileFingerprint } from "../../shared/media";
import { localMediaInputOptions } from "./input";

const RateSchema = z.object({
  streams: z.array(z.object({ r_frame_rate: z.string().optional() })),
});

/** FFmpeg's rate for the first video stream, which its filters snap frames to, as `num/den`. */
async function frameRate(ffprobe: string, path: string) {
  const child = Bun.spawn(
    [
      ffprobe,
      ...["-v", "error", ...localMediaInputOptions],
      ...["-select_streams", "v:0", "-show_entries", "stream=r_frame_rate"],
      ...["-of", "json", path],
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0) return null;
  const [num, den] = (
    RateSchema.parse(JSON.parse(output)).streams[0]?.r_frame_rate ?? ""
  )
    .split("/")
    .map(Number);
  const rate = num! / den!;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Grids keyed by path, modification time and size, so each file version is probed once. */
const grids = new Map<
  string,
  { version: string; grid: Promise<FrameGrid | null> }
>();

/**
 * The grid export reads a video's frames on: HyperFrames' start of the video on the media
 * timeline and FFmpeg's frame rate, from the same probes export uses. Null for variable frame
 * rate, which export reads at the file's own times, and for files without video.
 */
export async function frameGrid(path: string): Promise<FrameGrid | null> {
  const info = await stat(path);
  const version = fileFingerprint(path, info);
  const cached = grids.get(path);
  if (cached?.version === version) return cached.grid;
  const grid = (async () => {
    const ffprobe = findFfBinary("ffprobe", { configuredMustExist: true });
    if (!ffprobe) return null;
    const [metadata, rate] = await Promise.all([
      extractMediaMetadata(path),
      frameRate(ffprobe, path),
    ]);
    if (metadata.isVFR || !(metadata.fps > 0) || !rate) return null;
    const start = videoStartOnMediaTimeline(metadata);
    return { start, end: start + metadata.videoStreamDurationSeconds, rate };
  })();
  grids.delete(path);
  grids.set(path, { version, grid });
  if (grids.size > 256) grids.delete(grids.keys().next().value!);
  // A failed probe is not kept, so the next request tries again.
  grid.catch(() => {
    if (grids.get(path)?.grid === grid) grids.delete(path);
  });
  return grid;
}
