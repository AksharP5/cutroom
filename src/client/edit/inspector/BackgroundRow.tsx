import { useState } from "react";
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
  const choose = (mode: "keep" | "remove") => {
    if (mode === shown) return;
    if (mode === "keep") return void keepBackground(projectId, [clip]);
    if (matte && state === "failed")
      return void retryMatte(projectId, {
        src: matte.src,
        from: matte.from,
        to: matte.to,
      });
    void removeBackground(projectId, [clip]);
  };
  const stop = () => {
    if (matte && "job" in matte && matte.job)
      void stopMatte(projectId, matte.job);
    void keepBackground(projectId, [clip]);
  };
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
        </div>
      </div>
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
            <button
              type="button"
              className="text-button quiet"
              onClick={() => void keepBackground(projectId, [clip])}
            >
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
            <button type="button" className="text-button quiet" onClick={stop}>
              Stop
            </button>
          </div>
        )}
      {!needsModel && matte?.state === "running" && (
        <div className="matte-status" role="status">
          <span>Removing {percent(matte.progress)}</span>
          <TimecodeText timecode={elapsed(matte.elapsed)} />
          <button type="button" className="text-button quiet" onClick={stop}>
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
