/** Chrome plays untagged VP9 and AV1 as BT.601, H.264 and VP8 as BT.709 from 720 coded lines. */
const bt601Codecs = new Set(["vp9", "av1"]);

/** The matrix and primaries Chrome assumes for an untagged video. */
export const chromeColourGuess = (height: number, codec: string) =>
  height >= 720 && !bt601Codecs.has(codec) ? "bt709" : "smpte170m";

/** The primaries and transfers the editor's footage compositor draws with matrix arithmetic. */
export function usesPreviewColourMatrix(primaries: string, transfer: string) {
  const plain = (value: string) => value === "bt709" || value === "smpte170m";
  return plain(primaries) && plain(transfer);
}
