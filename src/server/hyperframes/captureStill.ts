import { hdrToSdrToneMapFilter } from "@hyperframes/core";
import { extractMediaMetadata, isHdrColorSpace } from "@hyperframes/engine";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import type { Project } from "../../shared/project";
import { sourcePictures } from "../media/pictureIndex";
import { projectPath } from "../projects/path";
import { parseInput } from "../projects/routes";
import { extractSourcePicture } from "../timeline/freeze";
import { chromeSdrColourFilters } from "./videoColour";

const CapturePictureSchema = z.object({
  path: z.string().min(1).max(4096),
  ordinal: z.coerce.number().int().nonnegative(),
});

/** A capture page can read one indexed source picture without waiting for an editing proxy. */
export async function captureStill(
  project: Project,
  query: Record<string, string>,
  signal: AbortSignal,
) {
  const { path, ordinal } = parseInput(CapturePictureSchema, query);
  const file = await projectPath(project, path);
  const ffmpeg = findFfBinary("ffmpeg", { configuredMustExist: true });
  if (!ffmpeg)
    throw new HttpError(503, "FFmpeg is required to capture this picture.");
  const [source, metadata] = await Promise.all([
    sourcePictures(file, { projectDir: project.path, signal }),
    extractMediaMetadata(file),
  ]);
  if (!source || ordinal >= source.packets.length)
    throw new HttpError(422, "The source has no picture at that frame.");
  const hdr = metadata.colorSpace;
  const colour =
    hdr && isHdrColorSpace(hdr)
      ? [
          hdrToSdrToneMapFilter(hdr, {
            keyframeTransfers: hdr.colorTransfer
              ? [hdr.colorTransfer]
              : undefined,
          }),
        ]
      : chromeSdrColourFilters(metadata);
  const bytes = await extractSourcePicture(
    ffmpeg,
    source,
    ordinal,
    metadata,
    colour,
    signal,
  );
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": "image/png", "cache-control": "no-store" },
  });
}
