import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
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

/** The weights a download must produce, byte for byte. */
export interface WeightsFile {
  url: string;
  bytes: number;
  sha256: string;
}
export const MODEL_FILE: WeightsFile = MATTE_MODEL;

/** Digests by file version, so the 168 MB file is hashed once, not on every status read. */
const checked = new Map<string, Promise<string>>();
const digest = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

/** Whether the weights on disk are exactly the expected file. */
export async function hasWeights(
  { weights }: MatteModelPaths,
  expected: WeightsFile = MODEL_FILE,
) {
  const info = await stat(weights).catch(() => null);
  if (!info?.isFile() || info.size !== expected.bytes) return false;
  const version = `${weights}:${info.size}:${info.mtimeMs}`;
  let hashed = checked.get(version);
  if (!hashed) {
    hashed = digest(weights);
    checked.set(version, hashed);
    hashed.catch(() => checked.delete(version));
  }
  return (await hashed.catch(() => "")) === expected.sha256;
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
  expected: WeightsFile = MODEL_FILE,
) {
  await mkdir(dirname(weights), { recursive: true });
  const partial = `${weights}.${process.pid}.part`;
  const abort = new AbortController();
  const stop = () => abort.abort();
  signal.addEventListener("abort", stop);
  try {
    const response = await fetch(expected.url, {
      signal: abort.signal,
      redirect: "follow",
    });
    if (!response.ok || !response.body)
      throw new Error(`The download answered ${response.status}.`);
    const file = createWriteStream(partial);
    const hash = createHash("sha256");
    let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        // A server sending more than the model is not sending the model.
        if (received > expected.bytes) {
          abort.abort();
          throw new Error(
            `The download passed ${expected.bytes} bytes, so it was stopped.`,
          );
        }
        hash.update(chunk);
        if (!file.write(chunk))
          await new Promise<void>((done) => file.once("drain", () => done()));
        onProgress(received / expected.bytes);
      }
    } finally {
      await new Promise<void>((done) => file.end(() => done()));
    }
    if (received !== expected.bytes)
      throw new Error(
        `The download stopped at ${received} of ${expected.bytes} bytes.`,
      );
    if (hash.digest("hex") !== expected.sha256)
      throw new Error(
        "The downloaded model is not the expected file, so it was not kept.",
      );
    await rename(partial, weights);
  } finally {
    signal.removeEventListener("abort", stop);
    await rm(partial, { force: true });
  }
}
