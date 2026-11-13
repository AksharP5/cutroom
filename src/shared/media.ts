import { z } from "zod";

// Mirrors the formats the upload route validates. `.ts` transport streams are left out so
// TypeScript files in a project are never listed as video.
export const mediaKinds = [
  {
    kind: "video",
    extensions: [
      "mp4",
      "webm",
      "mov",
      "mkv",
      "avi",
      "m4v",
      "mxf",
      "mts",
      "m2ts",
    ],
  },
  {
    kind: "audio",
    extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac"],
  },
  {
    kind: "image",
    extensions: ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"],
  },
] as const;

export const mediaKind = (path: string) => {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return mediaKinds.find((item) =>
    item.extensions.some((candidate) => candidate === extension),
  );
};

/**
 * Where Remove puts a media file: an ordinary folder in the project, so the file stays
 * recoverable by hand and project history can move it back.
 */
export const MEDIA_TRASH = "trash";

/** Whether a project path is a removed file, which no panel or agent listing shows. */
export const inMediaTrash = (path: string) =>
  path === MEDIA_TRASH || path.startsWith(`${MEDIA_TRASH}/`);

const mediaPath = z
  .string()
  .min(1)
  .max(4096)
  .describe("Project-relative path of a video, audio, or image file");

export const MediaRenameSchema = z.object({
  path: mediaPath,
  name: z
    .string()
    .trim()
    .min(1, "Enter a name.")
    .max(255, "Use a shorter name.")
    .refine(
      (name) => !/[\\/:*?"<>|\u0000-\u001f]/.test(name),
      'A file name cannot contain / \\ : * ? " < > |',
    )
    .refine(
      (name) => !name.startsWith(".") && !/[. ]$/.test(name),
      "A file name cannot start with a dot or end with a dot or space.",
    )
    .describe(
      "The new file name with the same extension. The file stays in its folder",
    ),
});

export const MediaRemoveSchema = z.object({
  path: mediaPath,
  confirmUsed: z
    .boolean()
    .default(false)
    .describe(
      "Remove a file used by clips or composition CSS/scripts. Existing clips and references remain offline until the file is back",
    ),
});

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

/** Source-view length for a still image. */
export const STILL_SECONDS = 5;
export const stillMediaExtensions = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "svg",
] as const;
