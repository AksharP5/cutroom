import type { Segmenter } from "../../src/server/matte/protocol.ts";
import { createSegmenter as stub } from "./stub-segmenter.ts";

/** The stub model, printing to stdout as some ONNX builds and libraries do. */
export async function createSegmenter(): Promise<Segmenter> {
  const inner = await stub();
  console.log("loading model {not json");
  return {
    ...inner,
    async segment(rgb) {
      process.stdout.write("warning: provider fallback\n");
      return inner.segment(rgb);
    },
  };
}
