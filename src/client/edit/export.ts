import { z } from "zod";
import { create } from "zustand";
import type { Fps } from "../../shared/timeline/schema";
import { ExportStageSchema, exportRange } from "../../shared/export";
import type { ExportOptions, ExportQuality } from "../../shared/export";
import { useWorkspace } from "../workspace";
import { trackRows } from "../timeline/math";
import { afterTimelineEdits, useTimeline } from "./timeline";
import { sampleExportRate } from "./exportEstimate";
import type { ExportRate } from "./exportEstimate";

const ProgressSchema = z.object({
  progress: z.number().min(0).max(100),
  status: z.enum(["rendering", "complete", "failed", "cancelled"]),
  stage: z.string().optional(),
  stageProgress: ExportStageSchema.optional(),
  error: z.string().nullish(),
  audioLoweredDb: z.number().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export interface ExportJob {
  projectId: string;
  name: string;
  jobId: string | null;
  outputPath: string;
  fps: Fps;
  size: { width: number; height: number } | null;
  frames: { start: number; end: number };
  quality: ExportQuality;
  status:
    | "starting"
    | "rendering"
    | "cancelling"
    | "complete"
    | "failed"
    | "cancelled";
  progress: number;
  stage: string;
  rate: ExportRate | null;
  error: string;
  startedAt: number;
  finishedAt: number | null;
  notice: string;
  sizeBytes: number | null;
}

export const useExport = create(() => ({
  job: null as ExportJob | null,
  controlError: "",
}));
export const exportActive = (job: ExportJob | null) =>
  job !== null && ["starting", "rendering", "cancelling"].includes(job.status);

async function renderApi<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
) {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}) },
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(value);
    throw new Error(
      error.success ? error.data.error : `Request failed (${response.status}).`,
    );
  }
  return schema.parse(value);
}

const updateJob = (change: Partial<ExportJob>) =>
  useExport.setState(({ job }) => ({ job: job && { ...job, ...change } }));

function follow(jobId: string) {
  return new Promise<void>((resolve) => {
    const events = new EventSource(
      `/api/render/${encodeURIComponent(jobId)}/progress`,
    );
    events.addEventListener("progress", (event) => {
      const parsed = ProgressSchema.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) {
        useExport.setState({
          controlError: "The renderer sent invalid progress.",
        });
        return;
      }
      const state = parsed.data;
      const cancelling = useExport.getState().job?.status === "cancelling";
      updateJob({
        progress: state.progress,
        status:
          state.status === "rendering" && cancelling
            ? "cancelling"
            : state.status,
        stage: state.stage ?? "Rendering",
        rate: sampleExportRate(
          useExport.getState().job?.rate ?? null,
          state.stageProgress,
          Date.now(),
        ),
        error: state.error ?? "",
        finishedAt: state.status === "rendering" ? null : Date.now(),
        sizeBytes: state.sizeBytes ?? null,
        ...(state.audioLoweredDb === undefined
          ? {}
          : {
              notice: [
                useExport.getState().job?.notice,
                `Audio lowered ${state.audioLoweredDb.toFixed(1)} dB to prevent clipping.`,
              ]
                .filter(Boolean)
                .join(" "),
            }),
      });
      useExport.setState({ controlError: "" });
      if (state.status === "rendering") return;
      events.close();
      resolve();
    });
    // EventSource reconnects to the same job. A lost connection is not a failed render.
    events.onerror = () =>
      useExport.setState({
        controlError: "Connection lost. Reconnecting to the export.",
      });
  });
}

/** Starts the existing Studio job after all edits already shown have settled. */
export async function exportProject(
  projectId: string,
  name: string,
  options: ExportOptions,
  quality: ExportQuality,
  choice: "timeline" | "marks",
) {
  if (exportActive(useExport.getState().job)) return;
  const timeline = useTimeline.getState().view?.timeline;
  if (!timeline) return;
  const frames = exportRange(timeline, choice);
  useExport.setState({
    controlError: "",
    job: {
      projectId,
      name,
      jobId: null,
      outputPath: `${options.directory}/${options.filename}`,
      fps: timeline.fps,
      size: (() => {
        const size = useWorkspace.getState().composition;
        return size?.width && size.height
          ? { width: size.width, height: size.height }
          : null;
      })(),
      frames,
      quality,
      status: "starting",
      progress: 0,
      stage: "Waiting for edits",
      rate: null,
      error: "",
      startedAt: Date.now(),
      finishedAt: null,
      notice: "",
      sizeBytes: null,
    },
  });
  useWorkspace.setState({ exporting: true });
  try {
    const jobId = await afterTimelineEdits(projectId, async () => {
      const current = useTimeline.getState().view?.timeline;
      if (!current) throw new Error("The timeline is unavailable.");
      const range = exportRange(current, choice);
      const { rows } = trackRows(current.tracks, {
        video: 0,
        audio: 0,
        seam: 0,
        divider: 0,
      });
      const solo = rows.filter(({ track }) => track.solo).map(({ id }) => id);
      const muted = rows.filter(({ track }) => track.muted).map(({ id }) => id);
      updateJob({
        frames: range,
        fps: current.fps,
        notice: [
          solo.length
            ? `${solo.join(", ")} soloed, other audio tracks are silent.`
            : "",
          muted.length ? `${muted.join(", ")} muted.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
      const ffmpeg = await renderApi(
        "/environment/ffmpeg",
        z.object({
          ok: z.boolean(),
          title: z.string().optional(),
          hint: z.string().optional(),
        }),
      );
      if (!ffmpeg.ok)
        throw new Error(
          [ffmpeg.title, ffmpeg.hint].filter(Boolean).join(". ") ||
            "FFmpeg is missing.",
        );
      const started = await renderApi(
        `/projects/${encodeURIComponent(projectId)}/render`,
        z.object({ jobId: z.string(), outputPath: z.string() }),
        {
          method: "POST",
          body: JSON.stringify({
            format: "mp4",
            quality,
            fps: `${current.fps.num}/${current.fps.den}`,
            cutroom: { ...options, range: choice === "marks" ? range : null },
          }),
        },
      );
      updateJob({
        jobId: started.jobId,
        outputPath: started.outputPath,
        status: "rendering",
        stage: "Preparing",
      });
      return started.jobId;
    });
    await follow(jobId);
  } catch (error) {
    updateJob({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: Date.now(),
    });
  } finally {
    useWorkspace.setState({ exporting: false });
  }
}

export async function cancelExport() {
  const job = useExport.getState().job;
  if (!job?.jobId || !exportActive(job) || job.status === "cancelling") return;
  updateJob({ status: "cancelling" });
  try {
    await renderApi(
      `/render/${encodeURIComponent(job.jobId)}/cancel`,
      z.object({ status: z.string() }),
      { method: "POST" },
    );
  } catch (error) {
    useExport.setState({
      controlError: error instanceof Error ? error.message : String(error),
    });
    if (useExport.getState().job?.status === "cancelling")
      updateJob({ status: "rendering" });
  }
}
