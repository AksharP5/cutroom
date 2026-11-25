import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MATTES_FOLDER, MatteManifestSchema } from "../../shared/matte";
import type { MatteEntry } from "../../shared/matte";

export const MATTE_MANIFEST = `${MATTES_FOLDER}/mattes.json`;

/** A damaged list only costs remaking mattes. The files stay on disk. */
export async function readMatteManifest(root: string) {
  try {
    const text = await readFile(join(root, MATTE_MANIFEST), "utf8");
    return MatteManifestSchema.safeParse(JSON.parse(text)).data ?? null;
  } catch {
    return null;
  }
}

export const matchesMatteSource = (
  entry: MatteEntry,
  source: { size: number; mtimeMs: number },
) => entry.size === source.size && entry.mtimeMs === source.mtimeMs;
