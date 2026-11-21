import { stat } from "node:fs/promises";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { z } from "zod";
import {
  FOOTAGE_PIXEL_LIMIT,
  FootageColourSchema,
} from "../../shared/pipeline";
import type { FootageColour } from "../../shared/pipeline";
import type { Project } from "../../shared/project";
import { fileFingerprint, localMediaPath } from "../../shared/media";
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
  footageRefusal?: string;
  colour?: FootageColour;
}

/**
 * Probe results keyed by path, modification time, and size, so each file version is probed once,
 * including files ffprobe cannot read (null). Nothing is kept while ffprobe is missing, so those
 * files are measured once it is available.
 */
const probes = new Map<string, { version: string; result: Probe | null }>();

async function probe(ffprobe: string, path: string): Promise<Probe | null> {
  const child = Bun.spawn(
    [
      ffprobe,
      "-v",
      "error",
      ...localMediaInputOptions,
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,color_primaries,color_space,color_transfer,color_range:stream_tags=alpha_mode",
      "-of",
      "json",
      path,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
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
  return {
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

export interface MediaFacts {
  /** Source lengths in seconds, by `src`. */
  lengths: Map<string, number>;
  /** Every `src` that was read and holds no audio stream. */
  silent: Set<string>;
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
    footageRefusals: new Map(),
    footageColours: new Map(),
  };
  await Promise.all(
    [...new Set(sources)].map(async (src) => {
      const relative = localMediaPath(composition, src);
      if (relative === null) return;
      const path = await projectPath(project, relative).catch(() => null);
      if (path === null) return;
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return;
      const version = fileFingerprint(path, info);
      let cached = probes.get(path);
      if (cached?.version !== version) {
        if (!ffprobe) return;
        cached = { version, result: await probe(ffprobe, path) };
        probes.delete(path);
        probes.set(path, cached);
        if (probes.size > 256) probes.delete(probes.keys().next().value!);
      }
      const result = cached.result;
      if (!result) return;
      if (result.seconds) facts.lengths.set(src, result.seconds);
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
    mediaSources(html, compositionScope(composition)),
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
