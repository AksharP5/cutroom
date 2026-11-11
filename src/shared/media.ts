/** Stat identity shared by review marks, media caches, and browser URLs. No media bytes are read. */
export function fileFingerprint(
  path: string,
  info: { size: number; mtimeMs: number },
) {
  return JSON.stringify([path, info.size, info.mtimeMs]);
}

/**
 * The project file a `src` in `sourceFile` names, relative to the project root; null for remote
 * media and malformed escapes. A `src` is always taken relative to its file's folder, leading
 * slash or not, and a path that climbs out of the project keeps its `..` for the caller to refuse.
 */
export function localMediaPath(sourceFile: string, src: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return null;
  let path: string;
  try {
    path = decodeURIComponent(src.split(/[?#]/, 1)[0]!);
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const part of [
    ...sourceFile.split("/").slice(0, -1),
    ...path.split("/"),
  ])
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  return parts.join("/") || ".";
}

export const mediaSettings = {
  peakSampleRate: 48000,
  peakBucketSamples: 96,
  mipFactor: 4,
  coarseSeconds: 4,
  tileHeight: 90,
  filmstripInterval: 2,
  columns: 10,
  tilesPerSheet: 100,
  jpegQuality: 4,
} as const;

export const peakLevels = (() => {
  const levels: number[] = [mediaSettings.peakBucketSamples];
  while (
    levels.at(-1)! / mediaSettings.peakSampleRate <
    mediaSettings.coarseSeconds
  )
    levels.push(levels.at(-1)! * mediaSettings.mipFactor);
  return Object.freeze(levels);
})();
