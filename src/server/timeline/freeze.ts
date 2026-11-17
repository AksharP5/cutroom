import { createFileAtomically } from "@hyperframes/core/atomic-file";
import {
  extractMediaMetadata,
  ffmpegSeekSeconds,
  isHdrColorSpace,
  videoStartOnMediaTimeline,
} from "@hyperframes/engine";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { HttpError } from "../../shared/errors";
import { frameSeek } from "../../shared/frames";
import { fileFingerprint } from "../../shared/media";
import { TimelineError } from "../../shared/timeline/errors";
import type { ClipOrigin } from "../../shared/timeline/apply";
import type { Project } from "../../shared/project";
import { previewSdrColourFilters } from "../hyperframes/videoColour";
import { frameGrid } from "../media/frames";
import { localMediaInputOptions } from "../media/input";
import { isMissing, projectPath, projectStatePath } from "../projects/path";

type Frame = Extract<ClipOrigin, { freeze: unknown }>["freeze"];

async function extractFrame(path: string, time: number) {
  const ffmpeg = findFfBinary("ffmpeg", { configuredMustExist: true });
  if (!ffmpeg)
    throw new HttpError(503, "FFmpeg is required to freeze a frame.");
  const [metadata, grid] = await Promise.all([
    extractMediaMetadata(path),
    frameGrid(path),
  ]);
  if (time + 1e-6 < videoStartOnMediaTimeline(metadata))
    throw new TimelineError(
      "out_of_bounds",
      "There is no video picture on that frame yet.",
    );
  if (isHdrColorSpace(metadata.colorSpace))
    throw new TimelineError(
      "unsupported",
      "Freeze frame is available for SDR video.",
    );
  // Keep the last decoded frame at or before the seek. An accurate input seek
  // would discard it. The preview's grid accounts for coarse container ticks.
  const seek = ffmpegSeekSeconds(metadata, grid ? frameSeek(grid, time) : time);
  const filters = [
    "fps=30:start_time=0:round=up",
    ...(metadata.sampleAspectRatio
      ? ["scale=trunc(iw*sar/2)*2:ih", "setsar=1"]
      : []),
    ...previewSdrColourFilters(metadata),
  ];
  const decoder =
    metadata.videoCodec === "vp9"
      ? ["-c:v", "libvpx-vp9"]
      : metadata.videoCodec === "vp8"
        ? ["-c:v", "libvpx"]
        : [];
  const child = Bun.spawn(
    [
      ffmpeg,
      "-v",
      "error",
      ...localMediaInputOptions,
      ...decoder,
      "-noaccurate_seek",
      "-ss",
      seek.toFixed(6),
      "-i",
      path,
      "-map",
      "0:v:0",
      "-vf",
      filters.join(","),
      "-frames:v",
      "1",
      "-c:v",
      "png",
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(30_000) },
  );
  const [bytes, stderr, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 || !bytes.length)
    throw new TimelineError(
      "unsupported",
      `Could not freeze this frame. ${stderr.trim() || "The source returned no picture."}`,
    );
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Publish each still inside the same history window as the timeline write. */
export async function saveFrozenFrames<T>(
  project: Project,
  frames: readonly Frame[],
  readableMedia: ReadonlyMap<string, number>,
  save: () => Promise<T>,
) {
  const created: string[] = [];
  try {
    for (const frame of frames) {
      if (!readableMedia.has(frame.src))
        throw new TimelineError(
          "unsupported",
          "This clip's local video source could not be read.",
        );
      const path = await projectPath(project, frame.media);
      const before = fileFingerprint(path, await stat(path));
      const png = await extractFrame(path, frame.time);
      if (before !== fileFingerprint(path, await stat(path)))
        throw new HttpError(
          409,
          "The video changed while freezing its frame. Try again.",
        );
      const asset = await projectStatePath(project, frame.path, true);
      await mkdir(dirname(asset), { recursive: true });
      try {
        createFileAtomically(asset, png);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        )
          throw new HttpError(
            409,
            "A file already exists at the freeze frame's path.",
          );
        throw error;
      }
      created.push(asset);
    }
    return await save();
  } catch (error) {
    for (const path of created)
      await unlink(path).catch((failure: unknown) => {
        if (!isMissing(failure))
          throw new AggregateError(
            [error, failure],
            "Could not roll back the freeze frame.",
          );
      });
    throw error;
  }
}
