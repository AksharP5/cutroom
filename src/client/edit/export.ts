import { z } from "zod";
import { create } from "zustand";
import type { Fps } from "../../shared/timeline/schema";
import { showToast, useWorkspace } from "../workspace";
import { trackRows } from "../timeline/math";
import { afterTimelineEdits, useTimeline } from "./timeline";

const FfmpegSchema = z.object({
  ok: z.boolean(),
  title: z.string().optional(),
  hint: z.string().optional(),
});
const StartedSchema = z.object({ jobId: z.string() });
const ProgressSchema = z.object({
  progress: z.number(),
  status: z.enum(["rendering", "complete", "failed", "cancelled"]),
  error: z.string().nullish(),
});

/** The export under way, as a share from 0 to 100; null when none is. */
export const useExport = create(() => ({
  progress: null as number | null,
  notice: "",
}));

/** Follows a render job to its end and resolves with how it ended. */
function finished(jobId: string) {
  return new Promise<z.infer<typeof ProgressSchema>>((resolve, reject) => {
    const events = new EventSource(
      `/api/render/${encodeURIComponent(jobId)}/progress`,
    );
    events.addEventListener("progress", (event) => {
      const state = ProgressSchema.parse(JSON.parse(String(event.data)));
      useExport.setState({ progress: state.progress });
      if (state.status === "rendering") return;
      events.close();
      resolve(state);
    });
    events.onerror = () => {
      events.close();
      reject(new Error("The export stopped reporting. Try it again."));
    };
  });
}

/**
 * Renders the project's root composition to MP4 with the same render job the embedded editor
 * starts, then hands the file to the browser as a download. Failures show in the header.
 */
export async function exportProject(projectId: string, name: string, fps: Fps) {
  if (useExport.getState().progress !== null) return;
  useExport.setState({ progress: 0, notice: "" });
  useWorkspace.setState({ exporting: true });
  try {
    const jobId = await afterTimelineEdits(projectId, async () => {
      const tracks = useTimeline.getState().view?.timeline.tracks ?? [];
      const { rows } = trackRows(tracks, {
        video: 0,
        audio: 0,
        seam: 0,
        divider: 0,
      });
      const solo = rows.filter(({ track }) => track.solo).map(({ id }) => id);
      const muted = rows.filter(({ track }) => track.muted).map(({ id }) => id);
      useExport.setState({
        notice: [
          solo.length
            ? `${solo.join(", ")} soloed, other audio tracks are silent.`
            : "",
          muted.length ? `${muted.join(", ")} muted.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
      const ffmpeg = FfmpegSchema.parse(
        await (await fetch("/api/environment/ffmpeg")).json(),
      );
      if (!ffmpeg.ok)
        throw new Error(
          [ffmpeg.title, ffmpeg.hint].filter(Boolean).join(". ") ||
            "FFmpeg is missing.",
        );
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/render`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            format: "mp4",
            quality: "standard",
            fps: `${fps.num}/${fps.den}`,
          }),
        },
      );
      if (!response.ok)
        throw new Error(`The export did not start (${response.status}).`);
      return StartedSchema.parse(await response.json()).jobId;
    });
    const end = await finished(jobId);
    if (end.status !== "complete")
      throw new Error(end.error || `The export ${end.status}.`);
    const link = document.createElement("a");
    const filename = `${name}.mp4`;
    link.href = `/api/render/${encodeURIComponent(jobId)}/download?${new URLSearchParams({ filename })}`;
    link.download = filename;
    link.click();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    useExport.setState({ progress: null, notice: "" });
    useWorkspace.setState({ exporting: false });
  }
}
