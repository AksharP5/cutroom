import { useEffect, useRef, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { MotionSnapshotSchema } from "../../../shared/motion";
import type {
  MotionAddFade,
  MotionChange,
  MotionSnapshot,
  MotionUpdate,
} from "../../../shared/motion";
import { clipEnd } from "../../../shared/timeline/apply";
import type { Clip, Fps } from "../../../shared/timeline/schema";
import { api, json } from "../../api";
import { SelectMenu } from "../../components/SelectMenu";
import { showToast, useWorkspace } from "../../workspace";
import {
  afterTimelineEdits,
  editCompositionSource,
  ROOT_COMPOSITION,
  useTimeline,
} from "../timeline";
import { useTransport } from "../transport";
import { openFile, useCode } from "../code/code";
import { FieldRow, ValueCell } from "./ValueField";

const EASES = [
  "none",
  "power1.in",
  "power1.out",
  "power1.inOut",
  "power2.in",
  "power2.out",
  "power2.inOut",
  "power3.in",
  "power3.out",
  "power3.inOut",
  "sine.inOut",
  "expo.out",
  "back.out(1.7)",
];

/** Authored motion is saved as source edits in the timeline's queue. */
export function MotionSection({
  projectId,
  composition,
  clip,
  revision,
  fps,
  disabled,
}: {
  projectId: string;
  composition: string;
  clip: Clip;
  revision: string;
  fps: Fps;
  disabled: boolean;
}) {
  const clipId = clip.id;
  const scene = composition !== ROOT_COMPOSITION;
  const [open, setOpen] = useState(true);
  const [loaded, setLoaded] = useState<{
    projectId: string;
    revision: string;
    renderVersion: string;
    snapshot: MotionSnapshot;
  } | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const editedVersion = useRef<string | null>(null);
  const codeBusy = useCode(
    (state) =>
      state.projectId === projectId &&
      state.file?.path === composition &&
      (state.edited || state.saving),
  );
  const path = `/projects/${encodeURIComponent(projectId)}/motion`;
  useEffect(() => {
    if (!open) return;
    const closing = new AbortController();
    setError("");
    void afterTimelineEdits(projectId, async () => {
      closing.signal.throwIfAborted();
      return api(
        `${path}?${new URLSearchParams({ composition, clipId })}`,
        MotionSnapshotSchema,
        { signal: closing.signal },
      );
    })
      .then((snapshot) => {
        if (closing.signal.aborted) return;
        const ownEdit = snapshot.version === editedVersion.current;
        editedVersion.current = null;
        // Literal edits keep source order. External source changes start fresh field identities.
        setLoaded((current) => ({
          projectId,
          revision,
          snapshot,
          renderVersion:
            current &&
            (ownEdit || current.snapshot.version === snapshot.version)
              ? current.renderVersion
              : snapshot.version,
        }));
      })
      .catch((error: unknown) => {
        if (!closing.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => closing.abort();
  }, [projectId, composition, clipId, revision, reload, open, path]);
  const snapshot =
    loaded?.projectId === projectId &&
    loaded.snapshot.clipId === clipId &&
    loaded.snapshot.composition === composition
      ? loaded.snapshot
      : null;
  const source = async () => {
    if (await openFile(composition)) useWorkspace.setState({ code: true });
  };
  const write = async (
    input:
      | Pick<MotionUpdate, "animationId" | "change">
      | Pick<MotionAddFade, "frame">,
  ) => {
    if (!snapshot || loaded?.revision !== revision || writing.current) return;
    writing.current = true;
    setSaving(true);
    try {
      await editCompositionSource(projectId, composition, async () => {
        const current = useTimeline.getState();
        if (!current.selection.ids.has(clipId))
          throw new Error("The selected clip changed. Inspect motion again.");
        const code = useCode.getState();
        if (
          code.projectId === projectId &&
          code.file?.path === composition &&
          (code.edited || code.saving)
        )
          throw new Error(
            `Save or discard changes in ${composition} before editing motion.`,
          );
        const next = await api(
          path,
          MotionSnapshotSchema,
          json("POST", {
            composition,
            clipId,
            expectedVersion: snapshot.version,
            ...input,
          }),
        );
        editedVersion.current = next.version;
        return next;
      });
    } catch (error) {
      editedVersion.current = null;
      showToast(error instanceof Error ? error.message : String(error));
      setLoaded(null);
      setReload((value) => value + 1);
    } finally {
      writing.current = false;
      setSaving(false);
    }
  };
  const commit = (animationId: string, change: MotionChange) =>
    write({ animationId, change });
  const blocked = disabled || codeBusy || !!snapshot?.reason;
  const readOnly = saving || loaded?.revision !== revision;
  const fadeAvailable = scene && snapshot?.fadeReason === null;
  // Only crossing the clip's edges changes the action, even while playing.
  const underPlayhead = useTransport(
    ({ frame }) =>
      fadeAvailable && frame >= clip.start && frame < clipEnd(clip),
  );
  if (
    !error &&
    (!snapshot || (!scene && !snapshot.animations.length && !snapshot.reason))
  )
    return null;
  return (
    <details
      className="inspector-section inspector-motion"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <CaretRight size={10} aria-hidden />
        Motion
      </summary>
      <button
        className="inspector-section-reset inspector-motion-source"
        type="button"
        title={`Open ${composition}`}
        aria-label="Open motion source"
        onClick={() => void source()}
      >
        Source
      </button>
      {codeBusy && (
        <p className="inspector-warning" role="note">
          Save or discard code changes before editing motion.
        </p>
      )}
      {error ? (
        <p className="inspector-warning" role="status">
          {error}{" "}
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        </p>
      ) : snapshot ? (
        <>
          {snapshot.reason && (
            <p className="inspector-warning" role="note">
              {snapshot.reason}
            </p>
          )}
          {snapshot.notices
            .filter((notice) => notice !== snapshot.reason)
            .map((notice) => (
              <p className="inspector-field-hint" key={notice}>
                {notice}
              </p>
            ))}
          {scene && (
            <div className="inspector-motion-actions">
              <button
                className="text-button quiet"
                type="button"
                aria-disabled={blocked || readOnly || !underPlayhead}
                title={
                  snapshot.fadeReason ??
                  (underPlayhead
                    ? "Start the fade at the playhead"
                    : "Move the playhead over the clip")
                }
                onClick={() => {
                  if (!blocked && !readOnly && underPlayhead)
                    void write({ frame: useTransport.getState().frame });
                }}
              >
                Add fade in
              </button>
              {snapshot.fadeReason &&
                snapshot.fadeReason !== snapshot.reason &&
                !snapshot.animations.length && (
                  <p className="inspector-field-hint">{snapshot.fadeReason}</p>
                )}
            </div>
          )}
          {snapshot.animations.map((animation, index) => (
            <div
              key={`${loaded?.renderVersion}:${index}`}
              className="inspector-motion-tween"
            >
              <h4>
                {animation.method} · {animation.selector}
                {snapshot.animations.length > 1 ? ` · ${index + 1}` : ""}
              </h4>
              {animation.targets.length > 1 && (
                <p className="inspector-warning" role="note">
                  Edits affect {animation.targets.join(", ")}.
                </p>
              )}
              {animation.reason && (
                <p className="inspector-warning" role="note">
                  {animation.reason}
                </p>
              )}
              {(["from", "to"] as const).map((side) =>
                Object.entries(animation[side]).map(([name, value]) => (
                  <FieldRow
                    key={`${side}:${name}`}
                    label={`${side === "from" ? "From" : "To"} ${name}`}
                    disabled={blocked || !!animation.reason}
                  >
                    <ValueCell
                      axis={name}
                      label={`Motion ${index + 1} ${side} ${name}`}
                      value={value}
                      unit="number"
                      fps={fps}
                      min={-Infinity}
                      disabled={blocked || !!animation.reason}
                      readOnly={readOnly}
                      onCommit={(value) => {
                        if (value !== null)
                          void commit(animation.id, {
                            kind: "property",
                            side,
                            name,
                            value,
                          });
                      }}
                    />
                  </FieldRow>
                )),
              )}
              {(["position", "duration"] as const).map((kind) => (
                <FieldRow
                  key={kind}
                  label={kind === "position" ? "Start" : "Duration"}
                  disabled={
                    blocked || !!animation.reason || animation[kind] === null
                  }
                >
                  {animation[kind] === null ? (
                    <span
                      className="inspector-field-hint"
                      title="Implicit, computed or absent in source"
                    >
                      Source
                    </span>
                  ) : (
                    <ValueCell
                      axis="s"
                      label={`Motion ${index + 1} ${kind}`}
                      value={animation[kind]}
                      unit="seconds"
                      fps={fps}
                      disabled={blocked || !!animation.reason}
                      readOnly={readOnly}
                      onCommit={(value) => {
                        if (value !== null)
                          void commit(animation.id, { kind, value });
                      }}
                    />
                  )}
                </FieldRow>
              ))}
              <FieldRow
                label="Ease"
                disabled={
                  blocked || !!animation.reason || animation.ease === null
                }
              >
                {animation.ease === null ? (
                  <span
                    className="inspector-field-hint"
                    title="Computed or inherited easing stays in source"
                  >
                    Source
                  </span>
                ) : (
                  <SelectMenu
                    label={`Motion ${index + 1} ease`}
                    value={animation.ease}
                    options={[...new Set([animation.ease, ...EASES])].map(
                      (value) => ({ value, label: value }),
                    )}
                    disabled={blocked || !!animation.reason}
                    readOnly={readOnly}
                    onChange={(value) =>
                      void commit(animation.id, { kind: "ease", value })
                    }
                  />
                )}
              </FieldRow>
              {!!animation.sourceOnly.length && (
                <p className="inspector-field-hint">
                  Source only: {animation.sourceOnly.join(", ")}.
                </p>
              )}
            </div>
          ))}
        </>
      ) : null}
    </details>
  );
}
