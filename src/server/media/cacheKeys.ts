import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { fileFingerprint } from "../../shared/media.ts";
import { proxySamplesFile } from "./pieces.ts";
import type { MediaKind } from "./protocol.ts";

/** Where each kind's entries live in a project, a folder per key. */
export function mediaCacheFolder(kind: MediaKind) {
  if (kind === "probe") return ".cutroom/cache/probes";
  // Browsing a folder can make a probe and thumbnail per video. Neither uses the proxy budget.
  if (kind === "thumbnail") return ".cutroom/cache/thumbnails";
  return ".cutroom/cache";
}

export const mediaArtifacts = {
  probe: "probe.json",
  peaks: "peaks.bin",
  filmstrip: "filmstrip.json",
  frame: "frame.jpg",
  thumbnail: "frame.jpg",
  scrub: "scrub.mp4",
  proxy: "proxy.mp4",
  pieces: "pieces.json",
  ramp: "ramp.wav",
  pcm: "audio.pcm",
} satisfies Record<MediaKind, string>;

/** Each kind's recipe; a new one keys new cache entries. */
const recipe = {
  probe: "media-v11",
  peaks: "media-v6",
  filmstrip: "media-v6",
  frame: "media-v6",
  thumbnail: "media-v1",
  scrub: "media-v7",
  proxy: "media-v8",
  pieces: "media-v12",
  ramp: "ramp-run-v2",
  pcm: "pcm-v1",
} satisfies Record<MediaKind, string>;

/** A file's media identity: its real path and every time it changed, so a rewrite misses. */
export function mediaFingerprint(path: string, info: BigIntStats) {
  return `${fileFingerprint(path, { size: Number(info.size), mtimeMs: Number(info.mtimeNs) / 1e6 })}\0${info.mtimeNs}\0${info.ctimeNs}\0${info.ino}\0${info.dev}`;
}

/** `variant` tells apart the entries one file has of a kind: a frame number or a ramp run. */
export function mediaCacheKey(
  kind: MediaKind,
  identity: string,
  variant: string | number = "",
) {
  return createHash("sha256")
    .update(`${recipe[kind]}\0${kind}\0${identity}\0${variant}`)
    .digest("hex");
}

export const pictureIndexArtifact = "picture-index.json";

export function pictureRevision(path: string, info: BigIntStats) {
  return [path, info.size, info.mtimeNs, info.ctimeNs, info.dev, info.ino].join(
    "\0",
  );
}

export function pictureIndexKey(revision: string) {
  return createHash("sha256")
    .update(`picture-index-v2\0${revision}`)
    .digest("hex");
}

/**
 * The entries that let a byte-identical copy of a video play at once: its probe, piece plan,
 * editing proxy and picture index. Each depends on nothing but the file.
 */
export const playbackCaches = [
  "probe",
  "pieces",
  "proxy",
  "picture-index",
] as const satisfies (MediaKind | "picture-index")[];

/**
 * Where the file at `path` keeps its `cache` entry: `folder/key`, relative to the project, and
 * the files that make it complete. Each of those files is written whole and renamed into place.
 */
export function playbackCacheEntry(
  cache: (typeof playbackCaches)[number],
  path: string,
  info: BigIntStats,
) {
  if (cache === "picture-index")
    return {
      folder: ".cutroom/cache",
      key: pictureIndexKey(pictureRevision(path, info)),
      files: [pictureIndexArtifact],
    };
  return {
    folder: mediaCacheFolder(cache),
    key: mediaCacheKey(cache, mediaFingerprint(path, info)),
    files:
      cache === "pieces"
        ? [mediaArtifacts.pieces, proxySamplesFile]
        : [mediaArtifacts[cache]],
  };
}
