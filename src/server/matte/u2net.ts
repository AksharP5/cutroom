import { createRequire } from "node:module";
import { join } from "node:path";
import type { Segmenter, SegmenterOptions } from "./protocol.ts";

/** The model's square input; mattes are stored at this size and scaled where they are drawn. */
const SIZE = 320;
const PLANE = SIZE * SIZE;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
/** Below this peak probability the model saw nothing it would keep. */
const NO_SUBJECT = 0.2;

/** The part of onnxruntime-node this uses. */
interface Ort {
  InferenceSession: {
    create(
      path: string,
      options: {
        executionProviders: string[];
        graphOptimizationLevel: "all";
        intraOpNumThreads: number;
        interOpNumThreads: number;
      },
    ): Promise<Session>;
  };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
}
interface Session {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: unknown }>>;
  release(): Promise<void>;
}

/**
 * u2net_human_seg through the ONNX runtime HyperFrames installs, with the same normalisation as
 * `hyperframes remove-background`: each frame scaled by its brightest value, then ImageNet's mean
 * and deviation; the output stretched to the full 8-bit range.
 */
export async function createSegmenter({
  weights,
  runtime,
  threads,
}: SegmenterOptions): Promise<Segmenter> {
  const ort: Ort = createRequire(join(runtime, "package.json"))(
    "onnxruntime-node",
  );
  const session = await ort.InferenceSession.create(weights, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
  });
  const input = session.inputNames[0];
  const output = session.outputNames[0];
  if (!input || !output) throw new Error("The model has no input or output.");
  const tensor = new Float32Array(3 * PLANE);
  const mask = new Uint8Array(PLANE);
  return {
    size: SIZE,
    async segment(rgb) {
      let brightest = 1;
      for (const value of rgb) if (value > brightest) brightest = value;
      for (let at = 0; at < PLANE; at++)
        for (let channel = 0; channel < 3; channel++)
          tensor[channel * PLANE + at] =
            (rgb[at * 3 + channel]! / brightest - MEAN[channel]!) /
            STD[channel]!;
      const result = await session.run({
        [input]: new ort.Tensor("float32", tensor, [1, 3, SIZE, SIZE]),
      });
      const raw = result[output]?.data;
      if (!(raw instanceof Float32Array) || raw.length < PLANE)
        throw new Error("The model returned no mask.");
      let lo = Infinity;
      let hi = -Infinity;
      for (let at = 0; at < PLANE; at++) {
        lo = Math.min(lo, raw[at]!);
        hi = Math.max(hi, raw[at]!);
      }
      if (hi < NO_SUBJECT) return null;
      const range = hi - lo || 1;
      for (let at = 0; at < PLANE; at++)
        mask[at] = Math.round(((raw[at]! - lo) / range) * 255);
      return mask;
    },
    close: () => session.release(),
  };
}
