import { stat } from "node:fs/promises";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { z } from "zod";
import {
  FOOTAGE_PIXEL_LIMIT,
  FootageColourSchema,
} from "../../shared/pipeline";
import type { FootageColour } from "../../shared/pipeline";
import type { Project } from "../../shared/project";
import { fileFingerprint, localMediaPath, mediaKind } from "../../shared/media";
import type { MediaFileDetails } from "../../shared/media";
import { projectPath, unavailableProjectFile } from "../projects/path";
import { compositionScope, mediaSources } from "./composition";
import { localMediaInputOptions } from "../media/input";
import { makesProxy } from "../media/settings";

const ProbeSchema = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        avg_frame_rate: z.string().optional(),
        r_frame_rate: z.string().optional(),
        disposition: z
          .object({ attached_pic: z.number().optional() })
          .optional(),
        pix_fmt: z.string().optional(),
        color_primaries: z.string().optional(),
        color_space: z.string().optional(),
        color_range: z.string().optional(),
        color_transfer: z.string().optional(),
        tags: z.object({ alpha_mode: z.string().optional() }).optional(),
      }),
    )
    .default([]),
  format: z.object({ duration: z.coerce.number().optional() }).default({}),
});
interface Probe {
  /** Length in seconds, or null when the file reports none. */
  seconds: number | null;
  /** The file was read and holds no audio stream. */
  silent: boolean;
  rate?: number;
  /** The first moving picture stream, leaving out cover art. */
  picture: { width: number; height: number; fps: number | null } | null;
  footageRefusal?: string;
  colour?: FootageColour;
}

/**
 * Probes by path, for one version of the file (size, times and inode), so each version is probed
 * once and callers asking at the same time share one ffprobe. Files ffprobe cannot read are kept
 * as null. A probe that times out or fails is dropped and asked again; nothing is kept while
 * ffprobe is missing, so those files are measured once it is available. An entry is a few hundred
 * bytes, so the cache holds every file of a large project.
 */
const probes = new Map<
  string,
  { version: string; result: Promise<Probe | null> }
>();
const PROBE_CACHE_SIZE = 4096;
/** ffprobe reads only headers; a file that takes longer is on a stalled disk or malformed. */
const PROBE_TIMEOUT_MS = 15_000;

async function probe(ffprobe: string, path: string): Promise<Probe | null> {
  const child = Bun.spawn(
    [
      ffprobe,
      "-v",
      "error",
      ...localMediaInputOptions,
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,pix_fmt,color_primaries,color_space,color_transfer,color_range:stream_tags=alpha_mode:stream_disposition=attached_pic",
      "-of",
      "json",
      path,
    ],
    { stdout: "pipe", stderr: "ignore", timeout: PROBE_TIMEOUT_MS },
  );
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (child.signalCode !== null)
    throw new Error(
      `ffprobe did not finish reading ${path} within ${PROBE_TIMEOUT_MS / 1000} s.`,
    );
  if (code !== 0) return null;
  const { streams, format } = ProbeSchema.parse(JSON.parse(output));
  const seconds = format.duration;
  const video = streams.find((stream) => stream.codec_type === "video");
  const alpha =
    /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(video?.pix_fmt ?? "") ||
    video?.tags?.alpha_mode === "1";
  const hdr =
    video?.color_transfer === "smpte2084" ||
    video?.color_transfer === "arib-std-b67";
  let footageRefusal: string | undefined;
  if (alpha) footageRefusal = "its source has alpha";
  else if (hdr) footageRefusal = "its source is HDR";
  else if (
    video?.width &&
    video.height &&
    video.width * video.height > FOOTAGE_PIXEL_LIMIT &&
    !makesProxy({ codec: video.codec_name ?? "unknown", alpha, hdr })
  )
    footageRefusal = `its source is ${video.width} × ${video.height}, above the pipeline's 1080p limit`;

  const primaries = FootageColourSchema.shape.primaries.safeParse(
    video?.color_primaries,
  );
  const transfer = FootageColourSchema.shape.transfer.safeParse(
    video?.color_transfer,
  );
  const matrix = FootageColourSchema.shape.matrix.safeParse(video?.color_space);
  const range = video?.color_range;
  const picture = streams.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  const [num, den] = (picture?.avg_frame_rate ?? "").split("/").map(Number);
  // Versions count source frames, so keep the stream's exact rate.
  const rate = [picture?.avg_frame_rate, picture?.r_frame_rate]
    .map((value) => {
      const [num, den] = value?.split("/").map(Number) ?? [];
      return (num ?? 0) / (den ?? 0);
    })
    .find((value) => Number.isFinite(value) && value > 0);
  return {
    rate,
    picture:
      picture?.width && picture.height
        ? {
            width: picture.width,
            height: picture.height,
            fps: num && den ? Math.round((num / den) * 1000) / 1000 : null,
          }
        : null,
    colour: video && {
      primaries: primaries.data,
      transfer: transfer.data,
      matrix: matrix.data,
      fullRange: range === "pc" ? true : range === "tv" ? false : undefined,
    },
    seconds:
      seconds !== undefined && Number.isFinite(seconds) && seconds > 0
        ? seconds
        : null,
    silent: !streams.some((stream) => stream.codec_type === "audio"),
    footageRefusal,
  };
}

/** A project file's cached probe and its size in bytes; null when it is missing or not a file. */
async function probeFile(
  project: Project,
  relative: string,
  ffprobe: string | undefined,
) {
  const path = await projectPath(project, relative).catch(() => null);
  if (path === null) return null;
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  // Inode and change time catch a same-size replacement that kept the old modification time.
  const version = `${fileFingerprint(path, info)}:${info.ino}:${info.ctimeMs}`;
  let cached = probes.get(path);
  if (cached?.version !== version) {
    if (!ffprobe) return { bytes: info.size, result: Promise.resolve(null) };
    const entry = { version, result: probe(ffprobe, path) };
    entry.result.catch(() => {
      if (probes.get(path) === entry) probes.delete(path);
    });
    cached = entry;
    probes.delete(path);
    probes.set(path, entry);
    if (probes.size > PROBE_CACHE_SIZE)
      probes.delete(probes.keys().next().value!);
  }
  return { bytes: info.size, result: cached.result };
}

/** Length, size, picture and sound of a project media file; null when it is missing. */
export async function mediaFileDetails(
  project: Project,
  path: string,
): Promise<MediaFileDetails | null> {
  const ffprobe = findFfBinary("ffprobe", { configuredMustExist: true });
  const probed = await probeFile(project, path, ffprobe);
  if (!probed) return null;
  const { bytes } = probed;
  // A file ffprobe stalls on or cannot read still has its size.
  const result = await probed.result.catch((error: unknown) => {
    console.warn("Could not probe media:", error);
    return null;
  });
  const still = mediaKind(path)?.kind === "image";
  return {
    bytes,
    ...(!still && result?.seconds && { duration: result.seconds }),
    ...(result?.picture && {
      width: result.picture.width,
      height: result.picture.height,
    }),
    ...(!still && result?.picture?.fps && { fps: result.picture.fps }),
    ...(!still && result && { audio: !result.silent }),
  };
}

export interface MediaFacts {
  /** Source lengths in seconds, by `src`. */
  lengths: Map<string, number>;
  /** Every `src` that was read and holds no audio stream. */
  silent: Set<string>;
  rates: Map<string, number>;
  files: Set<string>;
  footageRefusals: Map<string, string>;
  footageColours: Map<string, FootageColour>;
}

/** What ffprobe reports for the given `src` values; files that are missing or unreadable are left out. */
export async function mediaFacts(
  project: Project,
  composition: string,
  sources: Iterable<string>,
): Promise<MediaFacts> {
  const ffprobe = findFfBinary("ffprobe", { configuredMustExist: true });
  const facts: MediaFacts = {
    lengths: new Map(),
    silent: new Set(),
    rates: new Map(),
    files: new Set(),
    footageRefusals: new Map(),
    footageColours: new Map(),
  };
  await Promise.all(
    [...new Set(sources)].map(async (src) => {
      const relative = localMediaPath(composition, src);
      if (relative === null) return;
      const probed = await probeFile(project, relative, ffprobe);
      if (probed) facts.files.add(src);
      // The timeline still opens; this file's length and sound stay unknown until a later read.
      const result = await probed?.result.catch((error: unknown) => {
        console.warn("Could not probe media:", error);
        return null;
      });
      if (!result) return;
      if (result.seconds) facts.lengths.set(src, result.seconds);
      if (result.rate) facts.rates.set(src, result.rate);
      if (result.silent) facts.silent.add(src);
      if (result.colour) facts.footageColours.set(src, result.colour);
      if (result.footageRefusal)
        facts.footageRefusals.set(src, result.footageRefusal);
    }),
  );
  return facts;
}

/** The same source discovery and probe mapping used to build the timeline. */
export function compositionMediaFacts(
  project: Project,
  composition: string,
  html: string,
) {
  return mediaFacts(
    project,
    composition,
    mediaSources(html, compositionScope(composition), { versions: true }),
  );
}

/** Named local sources that would otherwise reach the renderer without a file. */
export async function missingMediaPaths(
  project: Project,
  composition: string,
  sources: Iterable<string>,
) {
  const files = new Map<string, Promise<boolean>>();
  const exists = (path: string) => {
    const cached = files.get(path);
    if (cached) return cached;
    const checking = projectPath(project, path)
      .then(async (absolute) => (await stat(absolute)).isFile())
      .catch((error: unknown) => {
        if (unavailableProjectFile(error)) return false;
        throw error;
      });
    files.set(path, checking);
    return checking;
  };
  const missing = await Promise.all(
    [...new Set(sources)].map(async (src) => {
      const path = localMediaPath(composition, src);
      if (
        !path ||
        path === "." ||
        path.startsWith("../") ||
        path.includes("\0")
      )
        return null;
      if (await exists(path)) return null;
      // Like the preview, a bare scene URL may name a file at the project root.
      if (
        composition.includes("/") &&
        !src.startsWith("../") &&
        !src.startsWith("/")
      ) {
        const root = localMediaPath("index.html", src);
        if (root && root !== path && (await exists(root))) return null;
      }
      return path;
    }),
  );
  return [...new Set(missing.filter((path) => path !== null))].sort();
}
