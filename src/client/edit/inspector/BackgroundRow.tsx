import { usePipeline } from "../../pipeline/setting";
import { isRamped } from "../../../shared/matte";
import { useEffect, useState } from "react";
import { CircleHalf } from "@phosphor-icons/react";
import { DEFAULT_BACKGROUND } from "../../../shared/timeline/background";
import type { Background } from "../../../shared/timeline/background";
import { GradeSlider } from "./ColorSection";
import type { Clip } from "../../../shared/timeline/schema";
import { matteModelSize } from "../../../shared/matte";
import { TimecodeText } from "../../components/TimecodeText";
import { editTimeline } from "../timeline";
import {
  cancelMatteModel,
  downloadMatteModel,
  retryMatte,
  stopMatte,
  useClipMatte,
  useMatteView,
  useMattes,
} from "../mattes";

const percent = (progress: number) => `${Math.floor(progress * 100)}%`;
const elapsed = (seconds: number) =>
  [3600, 60, 1]
    .map((unit, index) =>
      String(
        index ? Math.floor(seconds / unit) % 60 : Math.floor(seconds / unit),
      ).padStart(2, "0"),
    )
    .join(":");

/** Turns a background off: Stop and Cancel both leave the clip as it was. */
export const keepBackground = (projectId: string, clips: readonly Clip[]) =>
  editTimeline(projectId, "Keep background", () =>
    clips.map((clip) => ({
      type: "setClip" as const,
      clipId: clip.id,
      background: null,
    })),
  );

export const removeBackground = (projectId: string, clips: readonly Clip[]) =>
  editTimeline(projectId, "Remove background", () =>
    clips.map((clip) => ({
      type: "setClip" as const,
      clipId: clip.id,
      background: { mode: "remove" as const },
    })),
  );

/** Composite's Background row: Keep or Remove, and what removing is doing. */
export function BackgroundRow({
  projectId,
  clip,
  disabled,
  offline,
}: {
  projectId: string;
  clip: Clip;
  disabled: boolean;
  offline: boolean;
}) {
  const model = useMattes((state) => state.status?.model);
  const matte = useClipMatte(clip);
  const [details, setDetails] = useState(false);
  const removed = !!clip.background;
  const state = matte?.state;
  // A failure or an empty clip shows the original picture, which is what Keep shows.
  const shown =
    removed && state !== "failed" && state !== "no-subject" ? "remove" : "keep";
  /** Keep stops the clip's job and writes Keep whenever the project still says Remove. */
  const keep = () => {
    if (matte && "job" in matte && matte.job)
      void stopMatte(projectId, matte.job);
    if (removed) void keepBackground(projectId, [clip]);
  };
  const choose = (mode: "keep" | "remove") => {
    if (mode === "keep") return keep();
    if (!removed) return void removeBackground(projectId, [clip]);
    // Remove on a failed clip tries again; an empty one has nothing to retry until it changes.
    if (matte && state === "failed")
      void retryMatte(projectId, {
        src: matte.src,
        from: matte.from,
        to: matte.to,
      });
  };
  // Only the GPU footage pipeline draws the cutout; where HyperFrames draws the clip it is uncut.
  const pipelined = usePipeline(
    (pipeline) =>
      pipeline.enabled && pipeline.active && pipeline.drawn.includes(clip.id),
  );
  const uncut =
    removed && (isRamped(clip) || (state === "ready" && !pipelined));
  const ready = removed && state === "ready";
  const showing = useMatteView((view) => view.shown === clip.id);
  // Show matte turns off when the selection moves on.
  useEffect(
    () => () => {
      if (useMatteView.getState().shown === clip.id)
        useMatteView.setState({ shown: null });
    },
    [clip.id],
  );
  const needsModel =
    removed &&
    state !== "ready" &&
    state !== "no-subject" &&
    model &&
    model.status !== "ready";
  return (
    <>
      <div
        className="inspector-field matte-row"
        title={offline ? "Media offline" : undefined}
      >
        <span className="inspector-label">Background</span>
        <div className="inspector-value">
          <div
            className="inspector-segments"
            role="radiogroup"
            aria-label="Background"
          >
            {(["keep", "remove"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={shown === mode}
                tabIndex={shown === mode ? 0 : -1}
                disabled={disabled || offline}
                onClick={() => choose(mode)}
              >
                {mode === "keep" ? "Keep" : "Remove"}
              </button>
            ))}
          </div>
          {ready && (
            <button
              type="button"
              className="icon-button"
              aria-label="Show matte"
              aria-pressed={showing}
              title="Show matte"
              onClick={() =>
                useMatteView.setState({ shown: showing ? null : clip.id })
              }
            >
              <CircleHalf size={14} weight={showing ? "fill" : "regular"} />
            </button>
          )}
        </div>
      </div>
      {ready &&
        clip.background &&
        (["shrink", "soften"] as const).map((edge) => (
          <RefineRow
            key={edge}
            projectId={projectId}
            clip={clip}
            background={clip.background!}
            edge={edge}
            disabled={disabled}
          />
        ))}
      {uncut && (
        <div className="matte-note">
          <span>
            {isRamped(clip)
              ? "Speed ramps keep their background for now."
              : "The viewer shows this clip uncut here."}
          </span>
        </div>
      )}
      {needsModel && model.status === "missing" && (
        <div className="matte-note">
          <span>Remove background needs a {matteModelSize} download.</span>
          <div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void downloadMatteModel()}
            >
              Download
            </button>
            <button type="button" className="text-button quiet" onClick={keep}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {needsModel && model.status === "downloading" && (
        <div className="matte-status" role="status">
          <span>Downloading {percent(model.progress)}</span>
          <button
            type="button"
            className="text-button quiet"
            onClick={() => void cancelMatteModel()}
          >
            Stop
          </button>
        </div>
      )}
      {needsModel &&
        (model.status === "failed" || model.status === "no-runtime") && (
          <div className="matte-note" data-error="">
            <span>{model.error}</span>
            {model.status === "failed" && (
              <div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void downloadMatteModel()}
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        )}
      {!needsModel &&
        removed &&
        (state === "waiting" || state === "needs-model") && (
          <div className="matte-status" role="status">
            <span>Waiting</span>
            <button type="button" className="text-button quiet" onClick={keep}>
              Stop
            </button>
          </div>
        )}
      {!needsModel && matte?.state === "running" && (
        <div className="matte-status" role="status">
          <span>Removing {percent(matte.progress)}</span>
          <TimecodeText timecode={elapsed(matte.elapsed)} />
          <button type="button" className="text-button quiet" onClick={keep}>
            Stop
          </button>
        </div>
      )}
      {matte?.state === "no-subject" && (
        <div className="matte-note" data-error="">
          <span>No person or subject found in this clip.</span>
        </div>
      )}
      {matte?.state === "failed" && (
        <div className="matte-note" data-error="">
          <span>
            {matte.memory
              ? "Background removal stopped. The computer ran out of memory."
              : "Background removal stopped."}
          </span>
          <div>
            <button
              type="button"
              className="text-button"
              onClick={() => choose("remove")}
            >
              Try again
            </button>
            <button
              type="button"
              className="text-button quiet"
              aria-expanded={details}
              onClick={() => setDetails(!details)}
            >
              Details
            </button>
          </div>
          {details && <pre className="matte-details">{matte.error}</pre>}
        </div>
      )}
    </>
  );
}

const EDGE_LABELS = { shrink: "Shrink", soften: "Soften" } as const;

/**
 * Shrink or Soften: drawn live while dragged, saved once on release as one undo step. A
 * double-click on the label puts it back to its default.
 */
function RefineRow({
  projectId,
  clip,
  background,
  edge,
  disabled,
}: {
  projectId: string;
  clip: Clip;
  background: Background;
  edge: keyof Background;
  disabled: boolean;
}) {
  const draft = useMatteView((view) =>
    view.draft?.clipId === clip.id ? view.draft[edge] : null,
  );
  const label = EDGE_LABELS[edge];
  const save = (value: number) =>
    void editTimeline(projectId, `Edit ${label.toLowerCase()}`, () => [
      { type: "setClip", clipId: clip.id, background: { [edge]: value } },
    ]).finally(() => {
      if (useMatteView.getState().draft?.clipId === clip.id)
        useMatteView.setState({ draft: null });
    });
  const reset = () => {
    if (background[edge] !== DEFAULT_BACKGROUND[edge])
      save(DEFAULT_BACKGROUND[edge]);
  };
  return (
    <div className="inspector-field matte-slider">
      <label title="Double-click to reset" onDoubleClick={reset}>
        {label}
      </label>
      <div className="inspector-value">
        <GradeSlider
          label={label}
          value={background[edge]}
          min={0}
          max={8}
          step={1}
          disabled={disabled}
          onPreview={(value) =>
            useMatteView.setState({
              draft: { clipId: clip.id, ...background, [edge]: value },
            })
          }
          onCommit={save}
          onReset={reset}
        />
        <output>{draft ?? background[edge]} px</output>
      </div>
    </div>
  );
}
