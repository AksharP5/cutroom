import type { Segmenter } from "../../src/server/matte/protocol.ts";

/** A model that runs out of memory on its first frame, as ONNX reports it. */
export async function createSegmenter(): Promise<Segmenter> {
  return {
    size: 32,
    async segment() {
      throw new Error("std::bad_alloc: failed to allocate 1638400 bytes");
    },
    close: async () => {},
  };
}
