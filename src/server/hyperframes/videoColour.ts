import type { VideoMetadata } from "@hyperframes/engine";
import {
  chromeColourGuess,
  usesPreviewColourMatrix,
} from "../../shared/videoColour.ts";

type SdrSource = Pick<
  VideoMetadata,
  | "height"
  | "videoCodec"
  | "colorSpace"
  | "colorRange"
  | "hasAlpha"
  | "alphaPlaneDecoded"
>;

/** Codecs whose alpha HyperFrames decodes from a sidecar plane, unless a probe found none. */
const sidecarAlphaCodecs = new Set(["vp8", "vp9"]);
/** Transfers Chrome draws unchanged, as sRGB. */
const srgbTransfers = new Set([
  "",
  "unknown",
  "bt709",
  "smpte170m",
  "iec61966-2-1",
]);
/** Tags FFmpeg's colorspace filter converts from, as ffprobe names them. */
const matrices = new Set([
  "bt709",
  "fcc",
  "bt470bg",
  "smpte170m",
  "smpte240m",
  "bt2020nc",
]);
const primaries = new Set([
  "bt709",
  "bt470m",
  "bt470bg",
  "smpte170m",
  "smpte240m",
  "film",
  "bt2020",
]);
const transfers = new Set([
  ...srgbTransfers,
  "bt470m",
  "bt470bg",
  "smpte240m",
  "linear",
]);

const tagged = (value: string | undefined) =>
  value && value !== "unknown" ? value : undefined;

export { chromeColourGuess };

/**
 * FFmpeg filters that give extracted SDR frames the colours Chrome draws for the same video.
 * Chrome fills each untagged field with its BT.601 or BT.709 guess, then converts the gamut and
 * transfer to sRGB. HyperFrames copies only the matrix guess, so BT.601 footage, including every
 * untagged SD H.264 file, exported more saturated than the editor showed it.
 */
export function chromeSdrColourFilters(metadata: SdrSource) {
  const guess = chromeColourGuess(metadata.height, metadata.videoCodec);
  const taggedMatrix = tagged(metadata.colorSpace?.colorSpace);
  const matrix = taggedMatrix ?? guess;
  const primary = tagged(metadata.colorSpace?.colorPrimaries) ?? guess;
  const transfer = metadata.colorSpace?.colorTransfer ?? "";
  const drawnAsIs = primary === "bt709" && srgbTransfers.has(transfer);
  // FFmpeg's colorspace filter drops alpha, so transparent footage keeps the plain passthrough.
  const mayHaveAlpha =
    metadata.hasAlpha ||
    (sidecarAlphaCodecs.has(metadata.videoCodec) &&
      metadata.alphaPlaneDecoded !== false);
  const convertible =
    !mayHaveAlpha &&
    matrices.has(matrix) &&
    primaries.has(primary) &&
    transfers.has(transfer);
  if (drawnAsIs || !convertible)
    return taggedMatrix ? [] : [`setparams=colorspace=${matrix}`];
  const range = metadata.colorRange === "pc" ? "pc" : "tv";
  const sourceTransfer = srgbTransfers.has(transfer) ? "srgb" : transfer;
  return [
    `colorspace=ispace=${matrix}:iprimaries=${primary}:itrc=${sourceTransfer}:irange=${range}:space=bt709:primaries=bt709:trc=srgb:range=tv`,
  ];
}

/** Match the footage compositor for the SDR footage it converts directly. */
export function previewSdrColourFilters(metadata: SdrSource) {
  const guess = chromeColourGuess(metadata.height, metadata.videoCodec);
  const primaries = tagged(metadata.colorSpace?.colorPrimaries) ?? guess;
  const transfer = tagged(metadata.colorSpace?.colorTransfer) ?? guess;
  if (!usesPreviewColourMatrix(primaries, transfer))
    return chromeSdrColourFilters(metadata);
  return tagged(metadata.colorSpace?.colorSpace)
    ? []
    : [`setparams=colorspace=${guess}`];
}
