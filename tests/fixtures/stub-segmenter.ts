import type { Segmenter } from "../../src/server/matte/protocol.ts";

/**
 * Stands in for the model in tests: a pixel is subject where its red channel is bright, so a
 * generated shape over a dark background has a known matte. A frame with no bright pixel has no
 * subject. `STUB_SEGMENTER_DELAY_MS` slows each frame, so a test can stop a job part way.
 */
export async function createSegmenter(): Promise<Segmenter> {
  const size = 32;
  const mask = new Uint8Array(size * size);
  return {
    size,
    async segment(rgb) {
      await Bun.sleep(Number(process.env.STUB_SEGMENTER_DELAY_MS ?? 0));
      let any = false;
      for (let at = 0; at < mask.length; at++) {
        mask[at] = rgb[at * 3]! > 128 ? 255 : 0;
        any ||= mask[at] === 255;
      }
      return any ? mask : null;
    },
    close: async () => {},
  };
}
