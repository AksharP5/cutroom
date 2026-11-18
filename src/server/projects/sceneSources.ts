import { posix } from "node:path";

/** The compiler uses the project root when a template opens in the entry's shell. */
export async function sceneSourceBase(
  composition: string,
  html: string,
  entry: () => Promise<string>,
) {
  if (!composition.includes("/")) return composition;
  const { extractStandaloneEntryFromIndex, isTemplateEntry } =
    await import("@hyperframes/core/compiler");
  return isTemplateEntry(html) &&
    extractStandaloneEntryFromIndex(await entry(), composition, html)
    ? "index.html"
    : composition;
}

/** data-composition-src names a file, which the compiler resolves on disk. */
export function sceneSourcePath(from: string, src: string) {
  if (/^\/|[:\\\0]/.test(src) || !/\.html?$/i.test(src)) return null;
  const path = posix.normalize(posix.join(posix.dirname(from), src));
  return path.startsWith("../") ? null : path;
}
