import { z } from "zod";
import { create } from "zustand";
import type { Fps } from "../../shared/timeline/schema";
import { ExportJobSchema, exportRange } from "../../shared/export";
import type { ExportOptions, ExportQuality } from "../../shared/export";
import { useWorkspace } from "../workspace";
import { trackRows } from "../timeline/math";
import { afterTimelineEdits, useTimeline } from "./timeline";
import { subscribeProjectEvents } from "../api";

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
  estimate: z.infer<typeof ExportJobSchema>["estimate"];
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

function receiveExport(job: z.infer<typeof ExportJobSchema>) {
  const current = useExport.getState().job;
  const sameJob = current?.jobId === job.jobId;
  if (current?.status === "starting") return;
  if (!sameJob && useTimeline.getState().projectId !== job.projectId) return;
  const timeline = useTimeline.getState().view?.timeline;
  const frames = sameJob
    ? current.frames
    : (job.range ?? (timeline && { start: 0, end: timeline.duration }));
  if (!frames) return;
  const size = useWorkspace.getState().composition;
  let notice = sameJob ? current.notice : "";
  if (job.audioLoweredDb !== undefined) {
    const lowered = `Audio lowered ${job.audioLoweredDb.toFixed(1)} dB to prevent clipping.`;
    if (!notice.includes(lowered))
      notice = [notice, lowered].filter(Boolean).join(" ");
  }
  useExport.setState({
    controlError: "",
    job: {
      ...job,
      status:
        sameJob && current.status === "cancelling" && job.status === "rendering"
          ? "cancelling"
          : job.status,
      size: sameJob
        ? current.size
        : size?.width && size.height
          ? { width: size.width, height: size.height }
          : null,
      frames,
      error: job.error ?? "",
      notice,
    },
  });
  useWorkspace.setState({ exporting: job.status === "rendering" });
}

/** Discover jobs created by another editor or MCP client, including on reconnect. */
export function observeExports(projectId: string) {
  const closing = new AbortController();
  const observe = (job: z.infer<typeof ExportJobSchema>) => {
    if (!closing.signal.aborted) receiveExport(job);
  };
  const stop = subscribeProjectEvents(projectId, "export", (event) => {
    const parsed = ExportJobSchema.safeParse(JSON.parse(String(event.data)));
    if (parsed.success) observe(parsed.data);
  });
  const refresh = async () => {
    const current = useExport.getState().job;
    if (
      current?.projectId === projectId &&
      current.jobId &&
      exportActive(current)
    ) {
      observe(
        await renderApi(
          `/render/${encodeURIComponent(current.jobId)}`,
          ExportJobSchema,
          { signal: closing.signal },
        ),
      );
      return;
    }
    const { jobs } = await renderApi(
      `/projects/${encodeURIComponent(projectId)}/export-jobs`,
      z.object({ jobs: z.array(ExportJobSchema) }),
      { signal: closing.signal },
    );
    jobs.forEach(observe);
  };
  const load = () =>
    void refresh().catch((error: unknown) => {
      if (!closing.signal.aborted)
        useExport.setState({
          controlError: error instanceof Error ? error.message : String(error),
        });
    });
  const stopReady = subscribeProjectEvents(projectId, "ready", load);
  load();
  return () => {
    closing.abort();
    stop();
    stopReady();
  };
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
      estimate: null,
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
    receiveExport(
      await renderApi(`/render/${encodeURIComponent(jobId)}`, ExportJobSchema),
    );
  } catch (error) {
    updateJob({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: Date.now(),
    });
  } finally {
    useWorkspace.setState({
      exporting: exportActive(useExport.getState().job),
    });
  }
}

export async function cancelExport() {
  const job = useExport.getState().job;
  if (!job?.jobId || !exportActive(job) || job.status === "cancelling") return;
  updateJob({ status: "cancelling" });
  try {
    receiveExport(
      await renderApi(
        `/render/${encodeURIComponent(job.jobId)}/cancel`,
        ExportJobSchema,
        { method: "POST" },
      ),
    );
  } catch (error) {
    useExport.setState({
      controlError: error instanceof Error ? error.message : String(error),
    });
    if (useExport.getState().job?.status === "cancelling")
      updateJob({ status: "rendering" });
  }
}
