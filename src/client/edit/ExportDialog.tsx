import { useEffect, useState } from "react";
import { ProjectSchema } from "../../shared/project";
import {
  defaultExportRange,
  exportQualities,
  ExportOptionsSchema,
  ExportQualitySchema,
  exportRange,
} from "../../shared/export";
import type { ExportQuality } from "../../shared/export";
import { api } from "../api";
import { Modal } from "../components/Modal";
import { hint, useKeymap } from "../keymap";
import { useWorkspace } from "../workspace";
import { cancelExport, exportActive, exportProject, useExport } from "./export";
import type { ExportJob } from "./export";
import { estimateExportStage } from "./exportEstimate";
import { formatTimecode } from "./timecode";
import { useTimeline } from "./timeline";
import "./export.css";

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
  const remaining =
    job.status === "rendering" ? estimateExportStage(job.rate, now) : null;
  return (
    <div className="export-progress">
      <div className="export-progress-label">
        <span>
          {job.status === "cancelling"
            ? "Stopping and removing partial output"
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
  const job = useExport((state) => state.job);
  const active = exportActive(job);
  const show = () => setOpen(true);
  useKeymap({ workspacePrimaryWorkspaceDeliver: show });
  return (
    <>
      <button
        className="edit-export export-indicator"
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
          onSetup={() => useExport.setState({ job: null, controlError: "" })}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ExportDialog({
  projectId,
  projectName,
  onSetup,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onSetup(): void;
  onClose(): void;
}) {
  const timeline = useTimeline((state) => state.view?.timeline);
  const composition = useWorkspace((state) => state.composition);
  const job = useExport((state) => state.job);
  const controlError = useExport((state) => state.controlError);
  const [choice, setChoice] = useState<"timeline" | "marks">(
    timeline ? defaultExportRange(timeline) : "timeline",
  );
  const [quality, setQuality] = useState<ExportQuality>("standard");
  const [filename, setFilename] = useState(
    `${projectName.replace(/[/\\\x00-\x1f]/g, "-")}.mp4`,
  );
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    void api(`/projects/${encodeURIComponent(projectId)}`, ProjectSchema)
      .then((project) => {
        if (current) setDirectory(`${project.path}/.cutroom/renders`);
      })
      .catch((error: unknown) => {
        if (current)
          setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [projectId]);
  const showingJob = job;
  const active = exportActive(job);
  const fps = showingJob ? job.fps : timeline?.fps;
  const size = showingJob ? job.size : composition;
  const frames = showingJob
    ? job.frames
    : timeline &&
        (choice === "timeline" ||
          (timeline.range.in !== null && timeline.range.out !== null))
      ? exportRange(timeline, choice)
      : null;
  const submit = () => {
    const parsed = ExportOptionsSchema.safeParse({
      filename,
      directory,
      range: null,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setError("");
    void exportProject(
      projectId,
      projectName,
      parsed.data,
      quality,
      choice,
    ).catch((error: unknown) =>
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
    <Modal title="Export" onClose={onClose}>
      <div className="export-body">
        <div className="export-title">
          {showingJob ? job.name : projectName}
          <span>MP4 · H.264 / AAC</span>
        </div>
        {!showingJob && (
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
        {fps && frames && (
          <dl className="export-summary">
            <dt>{showingJob ? "Range" : "Frames"}</dt>
            <dd className="mono">
              {formatTimecode(frames.start, fps)} →{" "}
              {formatTimecode(frames.end - 1, fps)}
            </dd>
            <dt>Duration</dt>
            <dd className="mono">
              {formatTimecode(frames.end - frames.start, fps)}
            </dd>
            <>
              <dt>Project</dt>
              <dd className="mono">
                {size?.width && size.height
                  ? `${size.width} × ${size.height} · `
                  : ""}
                {Number((fps.num / fps.den).toFixed(3))} fps
              </dd>
            </>
          </dl>
        )}
        {!showingJob ? (
          <>
            <label className="export-field">
              Quality
              <select
                aria-label="Quality"
                value={quality}
                onChange={(event) =>
                  setQuality(ExportQualitySchema.parse(event.target.value))
                }
              >
                {exportQualities.map((value) => (
                  <option key={value} value={value}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="export-field">
              File name
              <input
                value={filename}
                onChange={(event) => setFilename(event.target.value)}
                required
              />
            </label>
            <label className="export-field">
              Location
              <input
                value={directory}
                disabled={loading}
                onChange={(event) => setDirectory(event.target.value)}
                placeholder="Absolute folder path"
                required
              />
            </label>
            <p className="export-hint">
              Existing files are kept. Choose a new name for each export.
            </p>
          </>
        ) : (
          <>
            <dl className="export-summary">
              <dt>Quality</dt>
              <dd className="export-quality">{job.quality}</dd>
            </dl>
            <p className="export-path">{job.outputPath}</p>
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
        {showingJob ? (
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
            <button className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={loading || !timeline || !frames}
              onClick={submit}
            >
              Export MP4
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
