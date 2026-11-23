import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { PREVIEW_BUNDLE_OPTIONS } from "@hyperframes/studio-server";
import { localMediaPath } from "../../shared/media";
import type { Project } from "../../shared/project";
import { placedMedia } from "../../shared/timeline/placedMedia";
import { documentRampRuns, runId } from "../../shared/timeline/rampRuns";
import type { RampRun } from "../../shared/timeline/rampRuns";
import type { MediaService } from "../media/service";

/**
 * Before an export: the ramp audio runs its document plays, built by the media service the
 * viewer shares and pinned until the export ends. Runs are named by `runId`, which the render
 * worker derives again from the compiled document. A run that cannot be made is left out, and
 * the worker makes it itself the same way.
 */
export async function prepareRampExport(options: {
  project: Project;
  composition: string;
  media: Pick<MediaService, "rampRun" | "rampRunFile" | "rampPins">;
  signal: AbortSignal;
  onWait: (progress: number) => void;
}) {
  const { project, composition, media, signal } = options;
  const html = await bundleToSingleHtml(project.path, {
    ...PREVIEW_BUNDLE_OPTIONS,
    entryFile: composition,
  });
  if (!html.includes("data-automation")) return null;
  const wanted = new Map<string, { path: string; run: RampRun }>();
  for (const slice of documentRampRuns(placedMedia(html)).values()) {
    const path = slice && localMediaPath(composition, slice.src);
    if (path) wanted.set(runId(slice.src, slice.run), { path, run: slice.run });
  }
  if (!wanted.size) return null;
  const pins = media.rampPins();
  const runs: Record<string, string> = {};
  let ready = 0;
  const aborted = new Promise<never>((_, reject) =>
    signal.addEventListener(
      "abort",
      () => reject(new Error("The export was cancelled.")),
      { once: true },
    ),
  );
  aborted.catch(() => {});
  try {
    options.onWait(0);
    await Promise.race([
      aborted,
      Promise.all(
        Array.from(wanted, async ([id, { path, run }]) => {
          const result = await media
            .rampRun(project, path, run, pins)
            .catch((error: unknown) => {
              console.warn(`Could not prepare ramp audio for ${path}:`, error);
              return null;
            });
          if (result && (result.available || (await result.pending)))
            runs[id] = await media.rampRunFile(project, result.key);
          options.onWait(++ready / wanted.size);
        }),
      ),
    ]);
  } catch (error) {
    pins.release();
    throw error;
  }
  return { runs, release: () => pins.release() };
}
