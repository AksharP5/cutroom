import { readdir } from "node:fs/promises";

/** Suggest only. Publishing still refuses a name taken after this directory read. */
export async function nextExportName(directory: string, filename: string) {
  const entries = await readdir(directory).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  });
  const taken = new Set(entries);
  if (!taken.has(filename)) return filename;
  const stem = filename.slice(0, -4);
  for (let number = 2; ; number++) {
    const suffix = ` ${number}.mp4`;
    const candidate = `${stem.slice(0, 200 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
