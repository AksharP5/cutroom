import { createFileAtomically } from "@hyperframes/core/atomic-file";
import {
  extractMediaMetadata,
  extractFinalVideoFrameTimestamp,
  isHdrColorSpace,
  videoStartOnMediaTimeline,
} from "@hyperframes/engine";
import type { VideoMetadata } from "@hyperframes/engine";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { HttpError } from "../../shared/errors";
import { frameSeek, presentationTimeTolerance } from "../../shared/frames";
import { fileFingerprint, freezeExportPath } from "../../shared/media";
import { TimelineError } from "../../shared/timeline/errors";
import type { ClipOrigin } from "../../shared/timeline/apply";
import type { Project } from "../../shared/project";
import {
  chromeSdrColourFilters,
  previewSdrColourFilters,
} from "../hyperframes/videoColour";
import { frameGrid } from "../media/frames";
import { localMediaInputOptions } from "../media/input";
import { isMissing, projectPath, projectStatePath } from "../projects/path";

type Frame = Extract<ClipOrigin, { freeze: unknown }>["freeze"];

export async function prepareFrozenFrames(
  project: Project,
  frames: readonly Frame[],
  readableMedia: ReadonlyMap<string, number>,
) {
  return Promise.all(
    frames.map(async (frame) => {
      if (!readableMedia.has(frame.src))
        throw new TimelineError(
          "unsupported",
          "This clip's local video source could not be read.",
        );
      const path = await projectPath(project, frame.media);
      const version = fileFingerprint(path, await stat(path));
      const metadata = await extractMediaMetadata(path);
      if (isHdrColorSpace(metadata.colorSpace))
        throw new TimelineError(
          "unsupported",
          "Freeze frame is available for SDR video.",
        );
      const preview = previewSdrColourFilters(metadata);
      const exported = chromeSdrColourFilters(metadata);
      const exportPath = Bun.deepEquals(preview, exported)
        ? undefined
        : freezeExportPath(frame.path);
      return { frame, path, version, metadata, preview, exported, exportPath };
    }),
  );
}

type FrozenFrame = Awaited<ReturnType<typeof prepareFrozenFrames>>[number];

async function extractFrame(
  ffmpeg: string,
  path: string,
  metadata: VideoMetadata,
  seek: number,
  timestamp: number,
  colour: string[],
  signal: AbortSignal,
) {
  // The one-frame-per-second filter keeps the last picture in slot zero.
  // Give its candidates positive timestamps so EOF in an audio tail can emit that slot
  // even if the demuxer provides no packet durations. Pictures after the seek are slot one.
  const filters = [
    "settb=AVTB",
    `setpts=if(lte(PTS*TB\\,${timestamp}+${presentationTimeTolerance})\\,min(N+1\\,999999)\\,1000000)`,
    "fps=1:round=down:eof_action=pass",
    "trim=end=1",
    ...(metadata.sampleAspectRatio
      ? ["scale=trunc(iw*sar/2)*2:ih", "setsar=1"]
      : []),
    ...colour,
    // The converted pixels are sRGB. Keep the PNG untagged so Chromium and
    // Cutroom's direct still encoder use those RGB values without another transform.
    "setparams=color_primaries=unknown:color_trc=unknown",
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
      "-copyts",
      ...(seek > (metadata.videoStreamStartSeconds ?? 0)
        ? ["-noaccurate_seek", "-seek_timestamp", "1", "-ss", seek.toFixed(6)]
        : []),
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
    { stdout: "pipe", stderr: "pipe", signal },
  );
  const [bytes, stderr, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new TimelineError(
      "unsupported",
      `Could not freeze this frame. ${stderr.trim() || "The source returned no picture."}`,
    );
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function frozenPictures(input: FrozenFrame) {
  const ffmpeg = findFfBinary("ffmpeg", { configuredMustExist: true });
  if (!ffmpeg)
    throw new HttpError(503, "FFmpeg is required to freeze a frame.");
  const { frame, path, metadata, preview, exported, exportPath, version } =
    input;
  const videoStart = videoStartOnMediaTimeline(metadata);
  if (frame.time + presentationTimeTolerance < videoStart)
    throw new TimelineError(
      "out_of_bounds",
      "There is no video picture on that frame yet.",
    );
  const grid = await frameGrid(path);
  const sample = grid ? frameSeek(grid, frame.time) : frame.time;
  const streamStart = metadata.videoStreamStartSeconds ?? 0;
  const timestamp = streamStart + sample - videoStart;
  const signal = AbortSignal.timeout(30_000);
  // Seek into the preceding GOP with absolute timestamps intact. Leave a small lead
  // so rounding in the demuxer's clock cannot skip the predecessor.
  let seek = timestamp - 0.1;
  if (seek >= streamStart + metadata.videoStreamDurationSeconds)
    seek =
      streamStart +
      (await extractFinalVideoFrameTimestamp(path, metadata, signal)) -
      0.1;
  const read = (colour: string[]) =>
    extractFrame(ffmpeg, path, metadata, seek, timestamp, colour, signal);
  let png = await read(preview);
  // An unindexed source can return no pictures after an input seek.
  if (!png.length && seek > streamStart) {
    seek = streamStart;
    png = await read(preview);
  }
  if (!png.length)
    throw new TimelineError("unsupported", "The source returned no picture.");
  const pictures = [{ path: frame.path, png }];
  if (exportPath) {
    const exportPng = await read(exported);
    if (!exportPng.length)
      throw new TimelineError(
        "unsupported",
        "The source returned no export picture.",
      );
    pictures.push({ path: exportPath, png: exportPng });
  }
  if (version !== fileFingerprint(path, await stat(path)))
    throw new HttpError(
      409,
      "The video changed while freezing its frame. Try again.",
    );
  return pictures;
}

/** Publish each still inside the same history window as the timeline write. */
export async function saveFrozenFrames<T>(
  project: Project,
  frames: readonly FrozenFrame[],
  save: () => Promise<T>,
) {
  const created: string[] = [];
  try {
    for (const frame of frames)
      for (const { path, png } of await frozenPictures(frame)) {
        const asset = await projectStatePath(project, path, true);
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
