import { MixLoudness } from "./MixLoudness";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
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
  GifLoopSchema,
  exportRange,
  exportFilename,
} from "../../shared/export";
import type {
  ExportDestination,
  ExportFormat,
  ExportQuality,
  ExportSize,
  ResolveExport,
} from "../../shared/export";
import { api } from "../api";
import { Modal } from "../components/Modal";
import { SelectMenu } from "../components/SelectMenu";
import { hint, useKeymap } from "../keymap";
import { useWorkspace } from "../workspace";
import {
  cancelExport,
  exportActive,
  exportForResolve,
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
import {
  ExportVariables,
  exportVariables,
  previewDrafts,
} from "./ExportVariables";
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

/** Keep the raw filesystem failure available while explaining what to do in the form. */
function exportFailure(raw: string) {
  const code =
    /^([A-Z]+):/.exec(raw)?.[1] ??
    /This folder can't receive the export \(([A-Z]+)\)/.exec(raw)?.[1];
  if (code === "ENOSPC" || /no space left on device/i.test(raw))
    return "The disk is full. Free up space or choose another location.";
  const folder =
    /, (?:realpath|mkdir) /.test(raw) ||
    (raw.includes("mkdtemp ") && raw.includes(".cutroom-render-")) ||
    raw.startsWith("This folder can't receive the export");
  if (!folder) return raw;
  if (code === "ENOENT" || code === "ENOTDIR")
    return "This folder does not exist. Choose another location.";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS")
    return "Cutroom cannot write to this folder. Choose another location.";
  return raw;
}

function showLocationEnd(input: HTMLInputElement | null) {
  if (input?.isConnected && document.activeElement !== input)
    input.scrollLeft = input.scrollWidth;
}

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
  const [dialog, setDialog] = useState<"closed" | "open" | "hidden">("closed");
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
  const show = () => setDialog("open");
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
      {dialog !== "closed" && (
        <ExportDialog
          visible={dialog === "open"}
          projectId={projectId}
          projectName={projectName}
          onCapture={capture}
          onSetup={() => useExport.setState({ job: null, controlError: "" })}
          onClose={() => {
            const job = useExport.getState().job;
            setDialog(
              exportActive(job) || job?.status === "failed"
                ? "hidden"
                : "closed",
            );
            if (job?.status === "complete")
              useExport.setState({ job: null, controlError: "" });
          }}
        />
      )}
    </>
  );
}

function ExportDialog({
  visible,
  projectId,
  projectName,
  onSetup,
  onCapture,
  onClose,
}: {
  visible: boolean;
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
  const current = useExport((state) => state.job);
  const failed = current?.status === "failed" ? current.error : "";
  const job = current?.status === "failed" ? null : current;
  const controlError = useExport((state) => state.controlError);
  const [choice, setChoice] = useState<"timeline" | "marks">(
    timeline ? defaultExportRange(timeline) : "timeline",
  );
  const [quality, setQuality] = useState<ExportQuality>("standard");
  const [target, setTarget] = useState<ExportFormat | "resolve">("mp4");
  const forResolve = target === "resolve";
  // A Resolve export links the media and renders its layers as MOV, so the file settings rest.
  const format: ExportFormat = forResolve ? "mov" : target;
  const [copyMedia, setCopyMedia] = useState(false);
  const [resolveExport, setResolveExport] = useState<
    "working" | ResolveExport | null
  >(null);
  const resolved =
    resolveExport !== null && resolveExport !== "working"
      ? resolveExport
      : null;
  const [gifLoop, setGifLoop] = useState("0");
  const [sizeChoice, setSizeChoice] = useState<ExportSize>("project");
  const [rate, setRate] = useState<RateChoice>("project");
  const [gpu, setGpu] = useState(true);
  const [variableDrafts, setVariableDrafts] = useState(previewDrafts);
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
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(
    null,
  );
  const [directory, setDirectory] = useState<string | null>(null);
  const [destination, setDestination] = useState<ExportDestination | null>(
    null,
  );
  const [destinationError, setDestinationError] = useState("");
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [loading, setLoading] = useState(true);
  const hasJob = job !== null;
  const location = useRef<HTMLInputElement>(null);
  const outputFolder = directory ?? destination?.directory ?? "";
  useLayoutEffect(() => {
    showLocationEnd(location.current);
  }, [outputFolder, hasJob, visible]);
  useEffect(() => {
    if (!visible || hasJob) return;
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
  }, [projectId, baseFilename, directory, hasJob, visible]);
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
      return {
        frames: exportRange(timeline, forResolve ? "timeline" : choice),
        problem: "",
      };
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
  const loop =
    format === "gif"
      ? GifLoopSchema.safeParse(gifLoop.trim() ? Number(gifLoop) : NaN)
      : null;
  const invalidLoop = loop?.success === false;
  const cannotExport =
    loading || !!destinationError || !timeline || !frames || invalidLoop;
  const submit = () => {
    if (cannotExport) return;
    if (forResolve) {
      const folder = directory ?? destination?.directory;
      if (!folder) return;
      let variables;
      try {
        variables = exportVariables(variableDrafts);
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : String(problem));
        return;
      }
      setError("");
      setResolveExport("working");
      void exportForResolve(projectId, {
        directory: folder,
        copyMedia,
        variables,
      }).then(setResolveExport, (problem: unknown) => {
        setResolveExport(null);
        setError(problem instanceof Error ? problem.message : String(problem));
      });
      return;
    }
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
    let variables;
    try {
      variables = exportVariables(variableDrafts);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      return;
    }
    setError("");
    if (!outputFps) return;
    setRenamed(
      filename === null && parsed.data.filename !== baseFilename
        ? { from: baseFilename, to: parsed.data.filename }
        : null,
    );
    void exportProject(projectId, name, parsed.data, choice, {
      variables,
      quality,
      format,
      gifLoop: loop?.data,
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
  const rawFailure = failed || destinationError;
  const failure = exportFailure(rawFailure);
  const destinationFailed = failure !== rawFailure;
  const savedAs =
    job?.projectId === projectId &&
    renamed &&
    job.outputPath.split(/[\\/]/).at(-1) === renamed.to
      ? `Saved as ${renamed.to} because ${renamed.from} already exists.`
      : null;
  if (!visible) return null;
  return (
    <Modal title="Export" onClose={onClose} initialFocus={exportButton}>
      <div className="export-body">
        <div className="export-title">
          {job && !resolved ? job.name : name}
          {resolved && <span>DaVinci Resolve</span>}
          {/* Before an export starts, the Format menu says this. */}
          {job && !resolved && (
            <span>
              {formatNames[job.format]} · {exportFormatDetails[job.format]}
            </span>
          )}
        </div>
        {!job && !resolveExport && !forResolve && (
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
        {timeline && frames && !resolved && (
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
        {resolved ? (
          <>
            <p className="export-path">{resolved.outputPath}</p>
            <div role="status" className="export-result">
              {resolved.gradeScript
                ? "Ready for Resolve. Follow Summary.txt to import the timeline with its grades."
                : `Ready for Resolve. Import ${resolved.timeline.split(/[\\/]/).at(-1)} with File > Import > Timeline${resolved.markers ? ", then its markers with Timeline > Import > Timeline Markers from EDL" : ""}.`}
            </div>
            {resolved.notes.map((note) => (
              <p key={note} className="export-hint">
                {note}
              </p>
            ))}
          </>
        ) : resolveExport === "working" && !job ? (
          <div role="status" className="export-result">
            Writing the Resolve folder.
          </div>
        ) : !job ? (
          <>
            <label className="export-field">
              Format
              <SelectMenu<ExportFormat | "resolve">
                label="Format"
                value={target}
                onChange={(value) => {
                  setTarget(value);
                  // A typed name keeps its words and takes the format's extension.
                  if (value !== "resolve")
                    setFilename(
                      (typed) =>
                        typed?.replace(/\.(mp4|mov|webm|gif)$/i, `.${value}`) ??
                        null,
                    );
                }}
                options={[
                  ...exportFormats.map((value) => ({
                    value,
                    label: `${formatNames[value]} · ${exportFormatDetails[value]}`,
                  })),
                  {
                    value: "resolve" as const,
                    label: "DaVinci Resolve · Timeline, layers and media",
                  },
                ]}
              />
            </label>
            {forResolve && (
              <label className="export-check">
                <input
                  type="checkbox"
                  checked={copyMedia}
                  onChange={(event) => setCopyMedia(event.target.checked)}
                />
                Copy media into the folder
              </label>
            )}
            {/* ProRes and GIF have no quality setting. */}
            {!forResolve && (format === "mp4" || format === "webm") && (
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
            {!forResolve && sizeOptions.length > 1 && (
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
            {!forResolve && (
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
            )}
            {!forResolve && format === "gif" && (
              <>
                <label className="export-field">
                  Loop count
                  <input
                    type="number"
                    min={0}
                    max={65535}
                    step={1}
                    value={gifLoop}
                    aria-invalid={invalidLoop || undefined}
                    aria-describedby="export-gif-loop-hint"
                    onChange={(event) => setGifLoop(event.target.value)}
                  />
                </label>
                <p className="export-hint" id="export-gif-loop-hint">
                  {invalidLoop
                    ? "Enter a whole number from 0 to 65535."
                    : "0 repeats forever."}
                </p>
              </>
            )}
            {!forResolve && gpuAvailable && format === "mp4" && (
              <label className="export-check">
                <input
                  type="checkbox"
                  checked={gpu}
                  onChange={(event) => setGpu(event.target.checked)}
                />
                Encode on the GPU
              </label>
            )}
            <ExportVariables
              drafts={variableDrafts}
              onChange={(id, value) =>
                setVariableDrafts((drafts) => ({ ...drafts, [id]: value }))
              }
            />
            {!forResolve && (
              <label className="export-field">
                File name
                <input
                  value={filename ?? destination?.filename ?? baseFilename}
                  onChange={(event) => setFilename(event.target.value)}
                  required
                />
              </label>
            )}
            <label className="export-field">
              Location
              <input
                ref={location}
                value={outputFolder}
                dir="ltr"
                className="export-location"
                title={outputFolder}
                onBlur={({ currentTarget }) =>
                  requestAnimationFrame(() => showLocationEnd(currentTarget))
                }
                aria-invalid={destinationFailed || undefined}
                disabled={!destination}
                onChange={(event) => {
                  if (failed) onSetup();
                  setDirectory(event.target.value);
                }}
                placeholder="Absolute folder path"
                required
              />
            </label>
            {failure && (
              <div>
                <p className="export-error" role="alert">
                  {failure}
                </p>
                {destinationFailed && (
                  <details className="export-error-details">
                    <summary>
                      <CaretRight size={10} weight="bold" />
                      Details
                    </summary>
                    <p>{rawFailure}</p>
                  </details>
                )}
              </div>
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
            <div role="status" className="export-result">
              {job.status === "complete"
                ? ["Export complete.", savedAs].filter(Boolean).join(" ")
                : job.status === "cancelled"
                  ? "Export cancelled. Partial output removed."
                  : "You can close this dialog while the export continues."}
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
        {resolved ? (
          <>
            <button
              className="secondary-button"
              onClick={() => {
                setResolveExport(null);
                onSetup();
              }}
            >
              New export
            </button>
            {window.cutroomDesktop && (
              <button
                className="secondary-button"
                onClick={() =>
                  void window.cutroomDesktop
                    ?.reveal(resolved.timeline)
                    .catch((problem: unknown) =>
                      setFileError(
                        problem instanceof Error
                          ? problem.message
                          : String(problem),
                      ),
                    )
                }
              >
                Reveal in folder
              </button>
            )}
            <button className="primary-button" onClick={onClose}>
              Done
            </button>
          </>
        ) : resolveExport === "working" && !job ? (
          <button className="secondary-button" onClick={onClose}>
            Hide
          </button>
        ) : job ? (
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
              {forResolve
                ? "Export for Resolve"
                : `Export ${formatNames[format]}`}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
