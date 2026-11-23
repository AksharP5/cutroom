import { createFileAtomically } from "@hyperframes/core/atomic-file";
import { extractMediaMetadata, isHdrColorSpace } from "@hyperframes/engine";
import type { VideoMetadata } from "@hyperframes/engine";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { HttpError } from "../../shared/errors";
import { fileFingerprint, freezeExportPath } from "../../shared/media";
import { TimelineError } from "../../shared/timeline/errors";
import { pictureAt } from "../../shared/timeline/piece";
import type { ClipOrigin } from "../../shared/timeline/apply";
import type { Project } from "../../shared/project";
import {
  chromeSdrColourFilters,
  previewSdrColourFilters,
} from "../hyperframes/videoColour";
import { ordinalDecode } from "../hyperframes/pictureSelection";
import { sourcePictures } from "../media/pictureIndex";
import type { SourcePictures } from "../media/pictureIndex";
import { localMediaInputOptions } from "../media/input";
import { isMissing, projectPath, projectStatePath } from "../projects/path";

type Frame = Extract<ClipOrigin, { freeze: unknown }>["freeze"];

export async function prepareFrozenFrames(
  project: Pick<Project, "path">,
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
      return {
        frame,
        path,
        projectDir: project.path,
        version,
        metadata,
        preview,
        exported,
        exportPath,
      };
    }),
  );
}

type FrozenFrame = Awaited<ReturnType<typeof prepareFrozenFrames>>[number];

/**
 * The still of one source picture, by its ordinal: the decode seeks to the keyframe before it on
 * presentation time and checks every picture it counts, as export's extraction does.
 */
async function extractPicture(
  ffmpeg: string,
  source: SourcePictures,
  ordinal: number,
  metadata: VideoMetadata,
  colour: string[],
  signal: AbortSignal,
  retry = false,
): Promise<Buffer> {
  const decode = ordinalDecode(source, [ordinal], 0, retry);
  const decoder =
    metadata.videoCodec === "vp9"
      ? ["-c:v", "libvpx-vp9"]
      : metadata.videoCodec === "vp8"
        ? ["-c:v", "libvpx"]
        : [];
  const filters = [
    ...decode.filters,
    ...(metadata.sampleAspectRatio
      ? ["scale=trunc(iw*sar/2)*2:ih", "setsar=1"]
      : []),
    ...colour,
    // The converted pixels are sRGB. Keep the PNG untagged so Chromium and
    // Cutroom's direct still encoder use those RGB values without another transform.
    "setparams=color_primaries=unknown:color_trc=unknown",
  ];
  const child = Bun.spawn(
    [
      ffmpeg,
      ...["-loglevel", "info", "-nostdin"],
      ...localMediaInputOptions,
      ...decoder,
      "-copyts",
      ...decode.args,
      ...["-i", source.path],
      ...["-map", `0:${source.stream}`],
      ...["-vf", filters.join(",")],
      ...["-fps_mode", "passthrough", "-frames:v", "1"],
      ...["-c:v", "png", "-f", "image2pipe", "pipe:1"],
    ],
    { stdout: "pipe", stderr: "pipe", signal },
  );
  let log = "";
  const [bytes, , code] = await Promise.all([
    new Response(child.stdout).bytes(),
    (async () => {
      for await (const chunk of child.stderr.pipeThrough(
        new TextDecoderStream(),
      )) {
        decode.read(chunk);
        log = (log + chunk).slice(-2000);
      }
    })(),
    child.exited,
  ]);
  if (code === 0 && bytes.length && decode.verified())
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // A seek that missed the picture is decoded again from the start.
  if (!retry && decode.args.length)
    return extractPicture(
      ffmpeg,
      source,
      ordinal,
      metadata,
      colour,
      signal,
      true,
    );
  throw new TimelineError(
    "unsupported",
    `Could not freeze this frame. ${
      code === 0
        ? "The source returned another picture."
        : log.trim().split("\n").at(-1) || "The source returned no picture."
    }`,
  );
}

async function frozenPictures(input: FrozenFrame) {
  const ffmpeg = findFfBinary("ffmpeg", { configuredMustExist: true });
  if (!ffmpeg)
    throw new HttpError(503, "FFmpeg is required to freeze a frame.");
  const {
    frame,
    path,
    projectDir,
    metadata,
    preview,
    exported,
    exportPath,
    version,
  } = input;
  const signal = AbortSignal.timeout(30_000);
  const source = await sourcePictures(path, { signal, projectDir });
  // The picture export shows at the frozen frame, held past the source's last.
  const ordinal = source && pictureAt(source.index, frame.time);
  if (!source || ordinal === null)
    throw new TimelineError(
      "out_of_bounds",
      "There is no video picture on that frame yet.",
    );
  const read = (colour: string[]) =>
    extractPicture(ffmpeg, source, Number(ordinal), metadata, colour, signal);
  const pictures = [{ path: frame.path, png: await read(preview) }];
  if (exportPath)
    pictures.push({ path: exportPath, png: await read(exported) });
  if (version !== fileFingerprint(path, await stat(path)))
    throw new HttpError(
      409,
      "The video changed while freezing its frame. Try again.",
    );
  return pictures;
}

/** Publish each still inside the same history window as the timeline write. */
export async function saveFrozenFrames<T>(
  project: Pick<Project, "path">,
  frames: readonly FrozenFrame[],
  save: () => Promise<T>,
  capture: (absolute: string, content: Uint8Array) => void,
) {
  const created: string[] = [];
  try {
    for (const frame of frames)
      for (const { path, png } of await frozenPictures(frame)) {
        const asset = await projectStatePath(project, path, true);
        await mkdir(dirname(asset), { recursive: true });
        try {
          createFileAtomically(asset, png);
          capture(asset, png);
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
