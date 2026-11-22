import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MATTE_MODEL } from "../../shared/matte.ts";

/** The ONNX runtime version HyperFrames pins and installs for `remove-background`. */
const RUNTIME = "onnxruntime-node@1.21.1";

/**
 * Where HyperFrames keeps the weights and runtime, so a model the `remove-background` command
 * already fetched serves Cutroom too.
 */
export function matteModelPaths(
  cacheDir = process.env.HYPERFRAMES_CACHE_DIR
    ? resolve(process.env.HYPERFRAMES_CACHE_DIR)
    : join(homedir(), ".cache", "hyperframes"),
) {
  return {
    weights: join(
      cacheDir,
      "background-removal",
      "models",
      `${MATTE_MODEL.name}.onnx`,
    ),
    runtime: join(cacheDir, "optional", RUNTIME),
  };
}
export type MatteModelPaths = ReturnType<typeof matteModelPaths>;

export async function hasWeights({ weights }: MatteModelPaths) {
  const info = await stat(weights).catch(() => null);
  return info?.isFile() === true && info.size > 0;
}

export function hasRuntime({ runtime }: MatteModelPaths) {
  return existsSync(
    join(runtime, "node_modules", "onnxruntime-node", "package.json"),
  );
}

/**
 * Fetches the weights into a partial file and renames it into place only when it is whole, so an
 * interrupted download is never taken for the model.
 */
export async function downloadWeights(
  { weights }: MatteModelPaths,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
  url: string = MATTE_MODEL.url,
  bytes: number = MATTE_MODEL.bytes,
) {
  await mkdir(dirname(weights), { recursive: true });
  const partial = `${weights}.${process.pid}.part`;
  try {
    const response = await fetch(url, { signal, redirect: "follow" });
    if (!response.ok || !response.body)
      throw new Error(`The download answered ${response.status}.`);
    const file = createWriteStream(partial);
    let received = 0;
    try {
      for await (const chunk of response.body) {
        if (!file.write(chunk))
          await new Promise<void>((done) => file.once("drain", () => done()));
        received += chunk.byteLength;
        onProgress(Math.min(1, received / bytes));
      }
    } finally {
      await new Promise<void>((done) => file.end(() => done()));
    }
    if (received !== bytes)
      throw new Error(`The download stopped at ${received} of ${bytes} bytes.`);
    await rename(partial, weights);
  } finally {
    await rm(partial, { force: true });
  }
}
