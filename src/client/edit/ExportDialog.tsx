import { MixLoudness } from "./MixLoudness";
import { useEffect, useRef, useState } from "react";
import {
  compositionExportName,
  defaultExportRange,
  exportFormatDetails,
  exportFormats,
  exportFps,
  exportQualities,
  exportRates,
  exportSize,
  exportSizes,
  ExportOptionsSchema,
  ExportDestinationSchema,
  exportRange,
  exportFilename,
} from "../../shared/export";
import type {
  ExportDestination,
  ExportFormat,
  ExportQuality,
  ExportSize,
} from "../../shared/export";
import { api } from "../api";
import { Modal } from "../components/Modal";
import { SelectMenu } from "../components/SelectMenu";
import { hint, useKeymap } from "../keymap";
import { useWorkspace } from "../workspace";
import {
  cancelExport,
  exportActive,
  exportGpuAvailable,
  exportProject,
  observeExports,
  useExport,
} from "./export";
import type { ExportJob } from "./export";
import { formatTimecode } from "../../shared/timeline/timecode";
import { TimecodeText } from "../components/TimecodeText";
import { useTimeline } from "./timeline";
import { captureFrame } from "./capture";
import { RendersList, formatBytes } from "./RendersList";
import "./export.css";

const formatNames: Record<ExportFormat, string> = {
  mp4: "MP4",
  mov: "MOV",
  webm: "WebM",
  gif: "GIF",
};
const sizeNames: Record<ExportSize, string> = {
  project: "Project",
  "1080p": "1080p",
  "4k": "4K",
};
type RateChoice = "project" | `${(typeof exportRates)[number]}`;
const rateLabel = (fps: { num: number; den: number }) =>
  `${Number((fps.num / fps.den).toFixed(3))} fps`;

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

function JobProgress({ job }: { job: ExportJob }) {
  const [now, setNow] = useState(Date.now());
  const active = exportActive(job);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const elapsed = (job.finishedAt ?? now) - job.startedAt;
  const remaining = job.status === "rendering" ? job.estimate : null;
  return (
    <div className="export-progress">
      <div className="export-progress-label">
        <span>
          {job.status === "cancelling"
            ? "Stopping and removing partial output"
            : job.status === "complete"
              ? "Finished"
              : job.stage}
        </span>
        <span className="mono">{Math.floor(job.progress)}%</span>
      </div>
      <div
        className="export-bar"
        role="progressbar"
        aria-label="Export progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(job.progress)}
      >
        <span style={{ transform: `scaleX(${job.progress / 100})` }} />
      </div>
      <div className="export-clock">
        <span>
          Elapsed <span className="mono">{clock(elapsed)}</span>
        </span>
        {active && (
          <span>
            {remaining === null ? (
              "Estimating time left"
            ) : (
              <>
                About{" "}
                <span className="mono">{clock(remaining.milliseconds)}</span>{" "}
                for {remaining.stage}
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/** One entry point owns the dialog and shortcut; the job outlives either. */
export function ExportControl({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  const ready = useTimeline(
    (state) => state.projectId === projectId && state.view !== null,
  );
  const job = useExport((state) => state.job);
  const active = exportActive(job);
  const observedProject =
    active && job ? job.projectId : ready ? projectId : null;
  useEffect(() => {
    if (observedProject) return observeExports(observedProject);
  }, [observedProject]);
  const show = () => setOpen(true);
  const capture = () => void captureFrame(projectId);
  useKeymap({
    workspacePrimaryWorkspaceDeliver: show,
    viewStillsStillGrab: capture,
  });
  return (
    <>
      <button
        className="edit-export export-indicator"
        aria-haspopup="dialog"
        title={hint("workspacePrimaryWorkspaceDeliver")}
        onClick={show}
      >
        {active
          ? `Exporting ${Math.floor(job?.progress ?? 0)}%`
          : job?.status === "complete"
            ? "Export complete"
            : job?.status === "failed"
              ? "Export failed"
              : "Export"}
        {active && (
          <span
            className="export-indicator-bar"
            style={{ transform: `scaleX(${(job?.progress ?? 0) / 100})` }}
          />
        )}
      </button>
      {open && (
        <ExportDialog
          projectId={projectId}
          projectName={projectName}
          onCapture={capture}
          onSetup={() => useExport.setState({ job: null, controlError: "" })}
          onClose={() => {
            setOpen(false);
            if (useExport.getState().job?.status === "complete")
              useExport.setState({ job: null, controlError: "" });
          }}
        />
      )}
    </>
  );
}

function ExportDialog({
  projectId,
  projectName,
  onSetup,
  onCapture,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onSetup(): void;
  onCapture(): void;
  onClose(): void;
}) {
  const timeline = useTimeline((state) => state.view?.timeline);
  // The dialog renders the composition the editor shows, as Resolve delivers the open timeline.
  const name = compositionExportName(
    projectName,
    useTimeline((state) => state.composition),
  );
  const composition = useWorkspace((state) => state.composition);
  const job = useExport((state) => state.job);
  const controlError = useExport((state) => state.controlError);
  const [choice, setChoice] = useState<"timeline" | "marks">(
    timeline ? defaultExportRange(timeline) : "timeline",
  );
  const [quality, setQuality] = useState<ExportQuality>("standard");
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [sizeChoice, setSizeChoice] = useState<ExportSize>("project");
  const [rate, setRate] = useState<RateChoice>("project");
  const [gpu, setGpu] = useState(true);
  const [gpuAvailable, setGpuAvailable] = useState(false);
  useEffect(() => {
    let current = true;
    void exportGpuAvailable().then((available) => {
      if (current) setGpuAvailable(available);
    });
    return () => {
      current = false;
    };
  }, []);
  const baseFilename = exportFilename(name, format);
  const [filename, setFilename] = useState<string | null>(null);
  const [directory, setDirectory] = useState<string | null>(null);
  const [destination, setDestination] = useState<ExportDestination | null>(
    null,
  );
  const [destinationError, setDestinationError] = useState("");
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [loading, setLoading] = useState(true);
  const hasJob = job !== null;
  useEffect(() => {
    if (hasJob) return;
    let current = true;
    setLoading(true);
    setDestinationError("");
    const query = new URLSearchParams({ filename: baseFilename });
    if (directory !== null) query.set("directory", directory);
    void api(
      `/projects/${encodeURIComponent(projectId)}/export-defaults?${query}`,
      ExportDestinationSchema,
    )
      .then((destination) => {
        if (current) setDestination(destination);
      })
      .catch((error: unknown) => {
        if (current)
          setDestinationError(
            error instanceof Error ? error.message : String(error),
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [projectId, baseFilename, directory, hasJob]);
  const active = exportActive(job);
  const projectSize =
    composition?.width && composition.height
      ? { width: composition.width, height: composition.height }
      : null;
  // The options that fit this composition: 1080p or 4K only when they differ from its own size.
  const sizeOptions = projectSize
    ? exportSizes.flatMap((choice) => {
        const size = exportSize(choice, projectSize);
        if ("problem" in size || (choice !== "project" && !size.resolution))
          return [];
        return [
          {
            value: choice,
            label: `${sizeNames[choice]}, ${size.width} × ${size.height}`,
            size,
          },
        ];
      })
    : [];
  const outputSize =
    sizeOptions.find((option) => option.value === sizeChoice)?.size ??
    projectSize;
  const outputFps =
    timeline &&
    exportFps(
      format,
      rate === "project" ? timeline.fps : { num: Number(rate), den: 1 },
    );
  const rateOptions = timeline
    ? [
        {
          value: "project" as const,
          label: `Project, ${rateLabel(exportFps(format, timeline.fps))}`,
        },
        ...exportRates
          .filter(
            (value) =>
              value * timeline.fps.den !== timeline.fps.num &&
              exportFps(format, { num: value, den: 1 }).num === value,
          )
          .map((value) => ({
            value: `${value}` as const,
            label: rateLabel({ num: value, den: 1 }),
          })),
      ]
    : [];
  const fps = job ? job.fps : outputFps;
  const size = job ? job.size : outputSize;
  // A range that can't export is shown in the dialog, never thrown during render.
  const range = ((): {
    frames: { start: number; end: number } | null;
    problem: string;
  } => {
    if (job) return { frames: job.frames, problem: "" };
    if (!timeline) return { frames: null, problem: "" };
    try {
      return { frames: exportRange(timeline, choice), problem: "" };
    } catch (problem) {
      return {
        frames: null,
        problem: problem instanceof Error ? problem.message : String(problem),
      };
    }
  })();
  const frames = range.frames;
  // A job's range is in its own frames; the dialog's is in the composition's.
  const framesFps = job ? job.fps : (timeline?.fps ?? { num: 30, den: 1 });
  const exportButton = useRef<HTMLButtonElement>(null);
  const cannotExport = loading || !!destinationError || !timeline || !frames;
  const submit = () => {
    if (cannotExport) return;
    const parsed = ExportOptionsSchema.safeParse({
      filename: filename ?? destination?.filename,
      directory: directory ?? destination?.directory,
      range: null,
      gpu,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setError("");
    if (!outputFps) return;
    void exportProject(projectId, name, parsed.data, choice, {
      quality,
      format,
      fps: outputFps,
      size: outputSize,
      resolution: sizeOptions.find((option) => option.value === sizeChoice)
        ?.size.resolution,
    }).catch((error: unknown) =>
      setError(error instanceof Error ? error.message : String(error)),
    );
  };
  const openFile = (action: "open" | "reveal") => {
    if (!job) return;
    setFileError("");
    void window.cutroomDesktop
      ?.exportFile(job.outputPath, action)
      .catch((error: unknown) =>
        setFileError(error instanceof Error ? error.message : String(error)),
      );
  };
  return (
    <Modal title="Export" onClose={onClose} initialFocus={exportButton}>
      <div className="export-body">
        <div className="export-title">
          {job ? job.name : name}
          {/* Before an export starts, the Format menu says this. */}
          {job && (
            <span>
              {formatNames[job.format]} · {exportFormatDetails[job.format]}
            </span>
          )}
        </div>
        {!job && (
          <>
            <fieldset className="export-range">
              <legend>Range</legend>
              <label>
                <input
                  type="radio"
                  name="export-range"
                  checked={choice === "timeline"}
                  onChange={() => setChoice("timeline")}
                />
                Whole timeline
              </label>
              <label>
                <input
                  type="radio"
                  name="export-range"
                  checked={choice === "marks"}
                  disabled={
                    timeline?.range.in === null || timeline?.range.out === null
                  }
                  onChange={() => setChoice("marks")}
                />
                In to Out
              </label>
            </fieldset>
          </>
        )}
        {timeline && frames && (
          <dl className="export-summary">
            <dt>{job ? "Range" : "Frames"}</dt>
            <dd className="mono">
              <TimecodeText
                timecode={formatTimecode(frames.start, framesFps)}
              />{" "}
              →{" "}
              <TimecodeText
                timecode={formatTimecode(frames.end - 1, framesFps)}
              />
            </dd>
            <dt>Duration</dt>
            <dd className="mono">
              <TimecodeText
                timecode={formatTimecode(frames.end - frames.start, framesFps)}
              />
            </dd>
            {fps && (
              <>
                <dt>Output</dt>
                <dd className="mono">
                  {size ? `${size.width} × ${size.height} · ` : ""}
                  {rateLabel(fps)}
                </dd>
              </>
            )}
          </dl>
        )}
        {range.problem && (
          <p className="export-error" role="alert">
            {range.problem}
          </p>
        )}
        {!job ? (
          <>
            <label className="export-field">
              Format
              <SelectMenu<ExportFormat>
                label="Format"
                value={format}
                onChange={(value) => {
                  setFormat(value);
                  // A typed name keeps its words and takes the format's extension.
                  setFilename(
                    (typed) =>
                      typed?.replace(/\.(mp4|mov|webm|gif)$/i, `.${value}`) ??
                      null,
                  );
                }}
                options={exportFormats.map((value) => ({
                  value,
                  label: `${formatNames[value]} · ${exportFormatDetails[value]}`,
                }))}
              />
            </label>
            {/* ProRes and GIF have no quality setting. */}
            {(format === "mp4" || format === "webm") && (
              <label className="export-field">
                Quality
                <SelectMenu<ExportQuality>
                  label="Quality"
                  value={quality}
                  onChange={setQuality}
                  options={exportQualities.map((value) => ({
                    value,
                    label: value[0].toUpperCase() + value.slice(1),
                  }))}
                />
              </label>
            )}
            {sizeOptions.length > 1 && (
              <label className="export-field">
                Size
                <SelectMenu<ExportSize>
                  label="Size"
                  value={sizeChoice}
                  onChange={setSizeChoice}
                  options={sizeOptions}
                />
              </label>
            )}
            <label className="export-field">
              Frame rate
              <SelectMenu<RateChoice>
                label="Frame rate"
                value={
                  rateOptions.some((option) => option.value === rate)
                    ? rate
                    : "project"
                }
                onChange={setRate}
                options={rateOptions}
              />
            </label>
            {gpuAvailable && format === "mp4" && (
              <label className="export-check">
                <input
                  type="checkbox"
                  checked={gpu}
                  onChange={(event) => setGpu(event.target.checked)}
                />
                Encode on the GPU
              </label>
            )}
            <label className="export-field">
              File name
              <input
                value={filename ?? destination?.filename ?? baseFilename}
                onChange={(event) => setFilename(event.target.value)}
                required
              />
            </label>
            <label className="export-field">
              Location
              <input
                value={directory ?? destination?.directory ?? ""}
                disabled={!destination}
                onChange={(event) => setDirectory(event.target.value)}
                placeholder="Absolute folder path"
                required
              />
            </label>
            <p className="export-hint">
              Existing files are kept. A free name is suggested for this folder.
            </p>
            {destinationError && (
              <p className="export-error" role="alert">
                {destinationError}
              </p>
            )}
            <RendersList projectId={projectId} />
          </>
        ) : (
          <>
            <dl className="export-summary">
              {(job.format === "mp4" || job.format === "webm") && (
                <>
                  <dt>Quality</dt>
                  <dd className="export-quality">{job.quality}</dd>
                </>
              )}
              {job.status === "complete" && job.sizeBytes !== null && (
                <>
                  <dt>File size</dt>
                  <dd className="mono">{formatBytes(job.sizeBytes)}</dd>
                </>
              )}
            </dl>
            <p className="export-path">{job.outputPath}</p>
            {job.status === "complete" &&
              job.jobId &&
              job.projectId === projectId && (
                <MixLoudness projectId={projectId} jobId={job.jobId} />
              )}
            {active || job.status === "complete" ? (
              <JobProgress job={job} />
            ) : null}
            <div
              role={job.status === "failed" ? "alert" : "status"}
              className={
                job.status === "failed" ? "export-error" : "export-result"
              }
            >
              {job.status === "complete" ? (
                "Export complete."
              ) : job.status === "failed" ? (
                <>
                  <strong>Export failed</strong>
                  <p>{job.error}</p>
                </>
              ) : job.status === "cancelled" ? (
                "Export cancelled. Partial output removed."
              ) : (
                "You can close this dialog while the export continues."
              )}
            </div>
            {job.notice && <p className="export-hint">{job.notice}</p>}
            {controlError && (
              <p className="export-error" role="alert">
                {controlError}
              </p>
            )}
            {fileError && (
              <p className="export-error" role="alert">
                {fileError}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="export-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-actions">
        {job ? (
          active ? (
            <>
              <button
                className="secondary-button"
                disabled={!job.jobId || job.status === "cancelling"}
                onClick={() => void cancelExport()}
              >
                {job.status === "cancelling" ? "Cancelling" : "Cancel export"}
              </button>
              <button className="secondary-button" onClick={onClose}>
                Hide
              </button>
            </>
          ) : (
            <>
              <button className="secondary-button" onClick={onSetup}>
                New export
              </button>
              {job.status === "complete" && (
                <>
                  {window.cutroomDesktop && (
                    <button
                      className="secondary-button"
                      onClick={() => openFile("reveal")}
                    >
                      Reveal in folder
                    </button>
                  )}
                  {window.cutroomDesktop ? (
                    <button
                      className="primary-button"
                      onClick={() => openFile("open")}
                    >
                      Open
                    </button>
                  ) : (
                    <a
                      className="primary-button"
                      href={`/api/render/${encodeURIComponent(job.jobId ?? "")}/view`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open
                    </a>
                  )}
                </>
              )}
            </>
          )
        ) : (
          <>
            <button
              className="secondary-button export-still"
              title={hint("viewStillsStillGrab")}
              onClick={() => {
                onCapture();
                onClose();
              }}
            >
              Save frame as PNG
            </button>
            <button className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              ref={exportButton}
              autoFocus
              aria-disabled={cannotExport}
              onClick={submit}
            >
              Export {formatNames[format]}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
