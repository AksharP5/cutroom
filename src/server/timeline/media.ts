import { stat } from "node:fs/promises";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import type { Project } from "../../shared/project";
import { localMediaPath } from "../projects/media";
import { projectPath } from "../projects/store";

/**
 * Probe results keyed by path, modification time, and size, so each file version is probed once,
 * including files ffprobe cannot read (null). Nothing is kept while ffprobe is missing, so those
 * files are measured once it is available.
 */
const lengths = new Map<string, number | null>();

async function probe(ffprobe: string, path: string): Promise<number | null> {
  const child = Bun.spawn(
    [
      ffprobe,
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      path,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  const seconds = Number(output.trim());
  return code === 0 && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Source lengths in seconds for the given `src` values; files that are missing or unreadable are left out. */
export async function mediaLengths(
  project: Project,
  composition: string,
  sources: Iterable<string>,
): Promise<Map<string, number>> {
  const ffprobe = findFfBinary("ffprobe", { configuredMustExist: true });
  const measured = await Promise.all(
    [...new Set(sources)].map(async (src) => {
      const relative = localMediaPath(composition, src);
      if (relative === null) return null;
      const path = await projectPath(project, relative).catch(() => null);
      if (path === null) return null;
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return null;
      const key = `${path}\0${info.mtimeMs}\0${info.size}`;
      if (!lengths.has(key)) {
        if (!ffprobe) return null;
        lengths.set(key, await probe(ffprobe, path));
      }
      const seconds = lengths.get(key);
      return seconds ? ([src, seconds] as const) : null;
    }),
  );
  return new Map(measured.filter((entry) => entry !== null));
}
