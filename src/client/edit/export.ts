import { z } from "zod";
import { create } from "zustand";
import type { Fps } from "../../shared/timeline/schema";
import {
  ExportJobSchema,
  exportRange,
  RendersSchema,
  ResolveExportSchema,
  retimeFrames,
} from "../../shared/export";
import type {
  ExportFormat,
  ExportOptions,
  ExportQuality,
} from "../../shared/export";
import { useWorkspace } from "../workspace";
import { trackRows } from "../timeline/math";
import { ROOT_COMPOSITION, afterTimelineEdits, useTimeline } from "./timeline";
import { subscribeProjectEvents } from "../api";
import type { VariableValues } from "../../shared/variables";

export interface ExportJob {
  projectId: string;
  name: string;
  jobId: string | null;
  outputPath: string;
  /** The export's own rate, which its frames count in. */
  fps: Fps;
  /** The rendered frame. */
  size: { width: number; height: number } | null;
  /** Null for a whole-timeline export of a project that is not open. */
  frames: { start: number; end: number } | null;
  quality: ExportQuality;
  format: ExportFormat;
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
  const open = useTimeline.getState();
  const timeline =
    open.projectId === job.projectId ? open.view?.timeline : undefined;
  const frames = sameJob
    ? current.frames
    : (job.range ??
      (timeline
        ? retimeFrames(
            { start: 0, end: timeline.duration },
            timeline.fps,
            job.fps,
          )
        : null));
  const size = timeline ? useWorkspace.getState().composition : null;
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
      size:
        job.size ??
        (sameJob
          ? current.size
          : size?.width && size.height
            ? { width: size.width, height: size.height }
            : null),
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
      "/export-jobs",
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

/** The project's past renders, newest first. */
export const listRenders = (projectId: string) =>
  renderApi(
    `/projects/${encodeURIComponent(projectId)}/exports`,
    RendersSchema,
  ).then(({ renders }) => renders);

/** Deletes one of the project's renders from disk. */
export const deleteRender = (projectId: string, path: string) =>
  renderApi(
    `/projects/${encodeURIComponent(projectId)}/exports`,
    z.object({ deleted: z.string() }),
    { method: "DELETE", body: JSON.stringify({ path }) },
  );

/** Whether exports drawn from their sources can encode on the GPU. */
export const exportGpuAvailable = () =>
  renderApi("/export-gpu", z.object({ available: z.boolean() })).then(
    ({ available }) => available,
    // Without an answer the dialog offers no GPU choice, and exports keep the server's default.
    () => false,
  );

/**
 * Writes a DaVinci Resolve folder of the composition the editor shows, once the edits already
 * shown have settled. Its layers render as ordinary jobs, which the dialog follows meanwhile.
 */
export function exportForResolve(
  projectId: string,
  options: {
    directory: string;
    copyMedia: boolean;
    variables: VariableValues;
  },
) {
  return afterTimelineEdits(projectId, () => {
    const composition = useTimeline.getState().view?.composition;
    return renderApi(
      `/projects/${encodeURIComponent(projectId)}/export`,
      ResolveExportSchema,
      {
        method: "POST",
        body: JSON.stringify({
          format: "resolve",
          directory: options.directory,
          copyMedia: options.copyMedia,
          ...(composition &&
            composition !== ROOT_COMPOSITION && { composition }),
          ...(Object.keys(options.variables).length && {
            variables: options.variables,
          }),
        }),
      },
    );
  });
}

/** Starts the existing Studio job after all edits already shown have settled. */
export async function exportProject(
  projectId: string,
  name: string,
  options: ExportOptions,
  choice: "timeline" | "marks",
  output: {
    quality: ExportQuality;
    format: ExportFormat;
    gifLoop?: number;
    fps: Fps;
    size: { width: number; height: number } | null;
    /** HyperFrames' size preset when the export draws at another size than the composition's. */
    resolution: string | undefined;
    /** Composition variable overrides, only those that differ from a default. */
    variables: VariableValues;
  },
) {
  if (exportActive(useExport.getState().job)) return;
  const shown = useTimeline.getState().view;
  if (!shown) return;
  const { timeline, composition } = shown;
  const frames = exportRange(timeline, choice);
  useExport.setState({
    controlError: "",
    job: {
      projectId,
      name,
      jobId: null,
      outputPath: `${options.directory}/${options.filename}`,
      fps: output.fps,
      size: output.size,
      frames: retimeFrames(frames, timeline.fps, output.fps),
      quality: output.quality,
      format: output.format,
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
      const view = useTimeline.getState().view;
      if (view?.composition !== composition)
        throw new Error("The open composition changed. Export it again.");
      const current = view.timeline;
      const range = exportRange(current, choice);
      const { rows } = trackRows(current.tracks, {
        video: 0,
        audio: 0,
        seam: 0,
        divider: 0,
      });
      const buses = current.authoredAudioGroups ?? [];
      const busName = ({ id, label }: { id: string; label?: string }) =>
        label ?? id;
      const solo = [
        ...rows.filter(({ track }) => track.solo).map(({ id }) => id),
        ...buses.filter(({ solo }) => solo).map(busName),
      ];
      const muted = [
        ...rows.filter(({ track }) => track.muted).map(({ id }) => id),
        ...buses.filter(({ muted }) => muted).map(busName),
      ];
      updateJob({
        frames: retimeFrames(range, current.fps, output.fps),
        notice: [
          solo.length
            ? `${solo.join(", ")} soloed, other audio is silent.`
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
            format: output.format,
            quality: output.quality,
            fps: `${output.fps.num}/${output.fps.den}`,
            gifLoop: output.gifLoop,
            ...(output.resolution && { resolution: output.resolution }),
            ...(composition !== ROOT_COMPOSITION && { composition }),
            ...(Object.keys(output.variables).length && {
              variables: output.variables,
            }),
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
