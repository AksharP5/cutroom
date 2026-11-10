import { stat } from "node:fs/promises";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { z } from "zod";
import type { Project } from "../../shared/project";
import { localMediaPath } from "../projects/media";
import { projectPath } from "../projects/store";

const ProbeSchema = z.object({
  streams: z.array(z.object({ codec_type: z.string().optional() })).default([]),
  format: z.object({ duration: z.coerce.number().optional() }).default({}),
});
interface Probe {
  /** Length in seconds, or null when the file reports none. */
  seconds: number | null;
  /** The file was read and holds no audio stream. */
  silent: boolean;
}

/**
 * Probe results keyed by path, modification time, and size, so each file version is probed once,
 * including files ffprobe cannot read (null). Nothing is kept while ffprobe is missing, so those
 * files are measured once it is available.
 */
const probes = new Map<string, Probe | null>();

async function probe(ffprobe: string, path: string): Promise<Probe | null> {
  const child = Bun.spawn(
    [
      ffprobe,
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type",
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
  return {
    seconds:
      seconds !== undefined && Number.isFinite(seconds) && seconds > 0
        ? seconds
        : null,
    silent: !streams.some((stream) => stream.codec_type === "audio"),
  };
}

export interface MediaFacts {
  /** Source lengths in seconds, by `src`. */
  lengths: Map<string, number>;
  /** Every `src` that was read and holds no audio stream. */
  silent: Set<string>;
}

/** What ffprobe reports for the given `src` values; files that are missing or unreadable are left out. */
export async function mediaFacts(
  project: Project,
  composition: string,
  sources: Iterable<string>,
): Promise<MediaFacts> {
  const ffprobe = findFfBinary("ffprobe", { configuredMustExist: true });
  const facts: MediaFacts = { lengths: new Map(), silent: new Set() };
  await Promise.all(
    [...new Set(sources)].map(async (src) => {
      const relative = localMediaPath(composition, src);
      if (relative === null) return;
      const path = await projectPath(project, relative).catch(() => null);
      if (path === null) return;
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return;
      const key = `${path}\0${info.mtimeMs}\0${info.size}`;
      if (!probes.has(key)) {
        if (!ffprobe) return;
        probes.set(key, await probe(ffprobe, path));
      }
      const result = probes.get(key);
      if (!result) return;
      if (result.seconds) facts.lengths.set(src, result.seconds);
      if (result.silent) facts.silent.add(src);
    }),
  );
  return facts;
}
