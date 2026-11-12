import { isAudioKind } from "../../../shared/timeline/schema";
import type { SaveNote } from "../NoteLayer";
import { animationReview } from "../feedback";
import type { Clip, Fps } from "../../../shared/timeline/schema";
import { useContext, useEffect, useRef, useState } from "react";
import { CaretRight, SidebarSimple, Warning, X } from "@phosphor-icons/react";
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import { MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import { clipFades } from "../../../shared/timeline/mix";
import { z } from "zod";
import { toFrames, toSeconds } from "../../../shared/timeline/apply";
import { api, json } from "../../api";
import { EditorToolsContext } from "../../editor/EditorTools";
import { trackRows } from "../../timeline/math";
import { showToast, useWorkspace } from "../../workspace";
import { editTimeline, loadTimeline, useTimeline } from "../timeline";
import { formatTimecode } from "../../../shared/timeline/timecode";
import { inspectorSubject, timingCommands } from "./fields";
import type { TimingField } from "./fields";
import { ValueField } from "./ValueField";
import { TextField } from "./TextField";
import { groupedChanges, pendingEdit, shownChanges } from "./changes";
import { transport } from "../transport";
import {
  useAnimationWindows,
  previewPosition,
  observePosition,
  usePositionWarning,
  useTextWarning,
  cancelPositionPreview,
  commitPositionPreview,
  usePictureMove,
} from "../preview";

export function InspectorToggle() {
  const open = useWorkspace((state) => state.inspector);
  return (
    <button
      className="edit-icon"
      aria-label="Inspector"
      aria-controls="clip-inspector"
      aria-pressed={open}
      onClick={() => useWorkspace.setState({ inspector: !open })}
    >
      <SidebarSimple size={16} weight={open ? "fill" : "regular"} />
    </button>
  );
}

/** Follows a move made on the picture, so only these two fields render while it lasts. */
function PositionFields({
  projectId,
  clip,
  fps,
  disabled,
}: {
  projectId: string;
  clip: Clip;
  fps: Fps;
  disabled: boolean | undefined;
}) {
  const move = usePictureMove((state) => state.move);
  const shown = move?.clipId === clip.id ? move : clip;
  return (["x", "y"] as const).map((axis) => (
    <ValueField
      key={`${clip.id}:${axis}`}
      label={`Position ${axis.toUpperCase()}`}
      value={shown[axis] ?? 0}
      unit="pixels"
      min={-Infinity}
      fps={fps}
      disabled={disabled}
      onPreview={(value) =>
        previewPosition(
          clip.id,
          axis === "x" ? value : (clip.x ?? 0),
          axis === "y" ? value : (clip.y ?? 0),
        )
      }
      onCancel={() => cancelPositionPreview(clip.id, clip.x ?? 0, clip.y ?? 0)}
      onCommit={async (value) => {
        await commitPositionPreview(() =>
          editTimeline(projectId, "Edit position", () => [
            { type: "setClip", clipId: clip.id, [axis]: value },
          ]),
        );
      }}
    />
  ));
}

export function Inspector({
  projectId,
  onSaveNote,
}: {
  projectId: string;
  onSaveNote: SaveNote;
}) {
  const animation = useAnimationWindows((state) => state.report);
  const [savingAnimation, setSavingAnimation] = useState(false);
  const mode = useContext(EditorToolsContext)?.mode;
  const open = useWorkspace((state) => state.inspector);
  const view = useTimeline((state) => state.view);
  const selection = useTimeline((state) => state.selection);
  const root = useRef<HTMLElement>(null);
  const [changesOpen, setChangesOpen] = useState(
    () => sessionStorage.getItem("cutroom.inspector.changes") === "true",
  );
  const [audioOpen, setAudioOpen] = useState(true);
  const [transformOpen, setTransformOpen] = useState(
    () =>
      window.innerHeight >=
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--breakpoint-short",
        ),
      ),
  );
  const [compositeOpen, setCompositeOpen] = useState(true);
  const [textOpen, setTextOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  // Closing the project cancels a pending reload, like the timeline's own read.
  const closing = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    closing.current = controller;
    return () => controller.abort();
  }, [projectId]);
  const [timingOpen, setTimingOpen] = useState(true);
  useEffect(() => {
    // Timeline presses prevent the browser's usual blur. Commit before they change selection.
    const blur = (event: PointerEvent) => {
      const active = document.activeElement;
      if (
        (active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement) &&
        root.current?.contains(active) &&
        active !== event.target
      )
        active.blur();
    };
    document.addEventListener("pointerdown", blur, true);
    return () => document.removeEventListener("pointerdown", blur, true);
  }, []);
  useEffect(() => setExpanded(false), [selection.anchor]);
  useEffect(() => {
    if (mode !== "draw" && mode !== "comment") return;
    const width = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--breakpoint-drawer",
      ),
    );
    const query = matchMedia(`(width < ${width}px)`);
    const close = () => {
      if (query.matches) useWorkspace.setState({ inspector: false });
    };
    close();
    query.addEventListener("change", close);
    return () => query.removeEventListener("change", close);
  }, [mode]);
  const timeline = view?.timeline;
  const subject = timeline ? inspectorSubject(timeline, selection) : null;
  const clip = subject?.clip;
  const animatedClip = animation?.timeline.clips.find(
    (item) => item.id === clip?.id,
  );
  const outsideAnimation =
    animatedClip && animation
      ? animation.windows[animatedClip.id]?.find(
          (window) =>
            window.start <
              toSeconds(animatedClip.start, animation.timeline.fps) - 0.002 ||
            window.end >
              toSeconds(
                animatedClip.start + animatedClip.duration,
                animation.timeline.fps,
              ) +
                0.002,
        )
      : undefined;
  const warning = usePositionWarning((state) => state.warning);
  useEffect(() => {
    observePosition(
      clip && !isAudioKind(clip.kind) ? clip.id : null,
      clip?.sourceRestrictions?.text ? null : (clip?.text ?? null),
    );
  }, [projectId, clip?.id, clip?.text, clip?.sourceRestrictions?.text]);
  useEffect(() => () => observePosition(null), [projectId]);
  const textWarning = useTextWarning((state) => state.warning);
  const textWarningFrame =
    textWarning &&
    textWarning.clipId === clip?.id &&
    textWarning.text === clip?.text &&
    timeline
      ? Math.floor(
          (textWarning.time * timeline.fps.num) / timeline.fps.den + 1e-6,
        )
      : null;
  const positionWarning = warning?.clipId === clip?.id ? warning : null;
  const warningFrame =
    positionWarning && timeline
      ? Math.floor(
          (positionWarning.time * timeline.fps.num) / timeline.fps.den + 1e-6,
        )
      : null;
  const name =
    clip &&
    (clip.label?.trim() ||
      clip.src?.split("/").at(-1) ||
      clip.id
        .replaceAll(/[-_]+/g, " ")
        .replace(/^./, (letter) => letter.toUpperCase()));
  const edits = groupedChanges(
    view?.clipEdits?.filter((edit) =>
      subject?.members.some((member) => member.id === edit.clipId),
    ) ?? [],
    `${name} (${clip?.kind === "video" && subject?.audio.length ? "picture and sound" : "linked clips"})`,
  );
  const shown = shownChanges(edits, expanded);
  const accept = async (edit: (typeof edits)[number]) => {
    setAccepting(edit.id);
    const { signal } = closing.current;
    try {
      for (const member of edit.members.filter(pendingEdit))
        await api(
          `/projects/${projectId}/review/changes/accept`,
          z.object({ ok: z.boolean() }),
          json("POST", { editId: member.id }),
        );
      await loadTimeline(projectId, signal);
    } catch (error) {
      if (!signal.aborted)
        showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setAccepting(null);
    }
  };
  const track =
    timeline &&
    clip &&
    trackRows(timeline.tracks, {
      video: 0,
      audio: 0,
      seam: 0,
      divider: 0,
    }).rows.find((row) => row.track.index === clip.track);
  const timing = (field: TimingField, value: number | null) => {
    if (!clip || !timeline || value === null) return;
    void editTimeline(projectId, "Edit timing", (current) =>
      timingCommands(current, clip.id, field, value),
    );
  };
  return (
    <aside
      ref={root}
      id="clip-inspector"
      className="clip-inspector"
      aria-label="Inspector"
      data-open={open}
      inert={!open}
    >
      <header>
        <strong>Inspector</strong>
        <button
          aria-label="Close inspector"
          onClick={() => useWorkspace.setState({ inspector: false })}
        >
          <X size={14} />
        </button>
      </header>
      {selection.ids.size > 1 && !subject ? (
        <p className="inspector-empty">{selection.ids.size} clips selected</p>
      ) : !clip || !timeline ? (
        <p className="inspector-empty">Select a clip to inspect it.</p>
      ) : (
        <div className="inspector-content">
          <div className="inspector-clip" data-kind={clip.kind}>
            <strong title={name || undefined}>{name}</strong>
            <span>
              {clip.kind === "element"
                ? "Text"
                : clip.kind[0]!.toUpperCase() + clip.kind.slice(1)}{" "}
              on {track?.id} ·{" "}
              <time>{formatTimecode(clip.start, timeline.fps)}</time>
            </span>
          </div>
          {clip.text !== null && (
            <details
              open={textOpen}
              onToggle={(event) => setTextOpen(event.currentTarget.open)}
              className="inspector-section"
            >
              <summary>
                <CaretRight size={10} aria-hidden />
                Text
              </summary>
              <TextField
                key={clip.id}
                value={clip.text}
                disabled={track?.track.locked}
                reason={clip.sourceRestrictions?.text}
                onCommit={(text) => {
                  void editTimeline(projectId, "Edit text", () => [
                    { type: "setClip", clipId: clip.id, text },
                  ]);
                }}
              />
              {textWarningFrame !== null && timeline && (
                <p className="inspector-warning" role="status">
                  <Warning size={14} aria-hidden />
                  <span>
                    This clip's script replaces its text at{" "}
                    {formatTimecode(textWarningFrame, timeline.fps)}.
                  </span>
                </p>
              )}
            </details>
          )}
          {!isAudioKind(clip.kind) && (
            <details
              open={transformOpen}
              onToggle={(event) => setTransformOpen(event.currentTarget.open)}
              className="inspector-section"
            >
              <summary>
                <CaretRight size={10} aria-hidden />
                Transform
              </summary>
              <PositionFields
                projectId={projectId}
                clip={clip}
                fps={timeline.fps}
                disabled={track?.track.locked}
              />
              {warningFrame !== null && (
                <p className="inspector-warning" role="status">
                  <Warning size={14} aria-hidden />
                  <span>
                    This clip's animation overrides Position at{" "}
                    <button
                      type="button"
                      title="Seek to this frame"
                      onClick={() => transport.seek(warningFrame)}
                    >
                      {formatTimecode(warningFrame, timeline.fps)}
                    </button>
                    .
                  </span>
                </p>
              )}
              <button
                type="button"
                aria-label="Reset position"
                disabled={
                  (clip.x === null && clip.y === null) || track?.track.locked
                }
                onClick={() => {
                  void editTimeline(projectId, "Reset position", () => [
                    { type: "setClip", clipId: clip.id, x: null, y: null },
                  ]);
                }}
              >
                Reset
              </button>
            </details>
          )}
          {!isAudioKind(clip.kind) && (
            <details
              open={compositeOpen}
              onToggle={(event) => setCompositeOpen(event.currentTarget.open)}
              className="inspector-section"
            >
              <summary>
                <CaretRight size={10} aria-hidden />
                Composite
              </summary>
              <ValueField
                key={clip.id}
                label="Opacity"
                allowAuto
                max={1}
                value={clip.opacity}
                unit="percent"
                fps={timeline.fps}
                onCommit={(opacity) => {
                  void editTimeline(projectId, "Edit opacity", () => [
                    { type: "setClip", clipId: clip.id, opacity },
                  ]);
                }}
              />
            </details>
          )}
          {subject?.audio.map((audio) => {
            const fades = clipFades(audio);
            const locked = timeline.tracks.find(
              (track) => track.index === audio.track,
            )?.locked;
            return (
              <details
                key={audio.id}
                open={audioOpen}
                onToggle={(event) => setAudioOpen(event.currentTarget.open)}
                className="inspector-section inspector-audio"
              >
                <summary>
                  <CaretRight size={10} aria-hidden />
                  Audio
                  {subject.audio.length > 1 && ` · ${audio.label || audio.id}`}
                </summary>
                <ValueField
                  key={`${audio.id}:gain`}
                  label="Gain"
                  value={audio.volume ?? 1}
                  unit="gain"
                  max={MAX_AUDIO_GAIN}
                  fps={timeline.fps}
                  disabled={locked}
                  onCommit={(volume) => {
                    void editTimeline(projectId, "Edit gain", () => [
                      { type: "setClip", clipId: audio.id, volume },
                    ]);
                  }}
                />
                {(["fadeIn", "fadeOut"] as const).map((field) => (
                  <ValueField
                    key={`${audio.id}:${field}`}
                    label={field === "fadeIn" ? "Fade in" : "Fade out"}
                    value={audio[field]}
                    unit="timecode"
                    fps={timeline.fps}
                    disabled={locked}
                    hint={
                      fades[field] !== audio[field]
                        ? `Effective ${formatTimecode(Math.round(fades[field]), timeline.fps)} (scaled to fit)`
                        : undefined
                    }
                    onCommit={(value) => {
                      if (value === null) return;
                      void editTimeline(projectId, "Edit fade", () => [
                        { type: "setClip", clipId: audio.id, [field]: value },
                      ]);
                    }}
                  />
                ))}
                {audio.automation && (
                  <button
                    className="inspector-clear-automation"
                    disabled={locked}
                    title="Remove this clip's HyperFrames automation, including baked volume ramps"
                    onClick={() => {
                      void editTimeline(
                        projectId,
                        "Clear clip automation",
                        () => [
                          {
                            type: "setClip",
                            clipId: audio.id,
                            automation: null,
                          },
                        ],
                      );
                    }}
                  >
                    Clear automation
                  </button>
                )}
              </details>
            );
          })}
          <details
            className="inspector-section inspector-timing"
            open={timingOpen}
            onToggle={(event) => setTimingOpen(event.currentTarget.open)}
          >
            <summary>
              <CaretRight size={10} aria-hidden />
              Timing
            </summary>
            {outsideAnimation && animatedClip && animation && (
              <p className="inspector-warning" role="status">
                <Warning size={14} aria-hidden />
                <span>
                  Animation plays at{" "}
                  {formatTimecode(
                    toFrames(outsideAnimation.start, animation.timeline.fps),
                    animation.timeline.fps,
                  )}
                  , outside this clip.{" "}
                  <button
                    type="button"
                    disabled={savingAnimation}
                    onClick={() => {
                      const { draft, body } = animationReview(
                        animatedClip,
                        outsideAnimation.start,
                        animation.timeline.fps,
                      );
                      setSavingAnimation(true);
                      void onSaveNote(draft, body)
                        .catch((error: unknown) =>
                          showToast(
                            error instanceof Error
                              ? error.message
                              : String(error),
                          ),
                        )
                        .finally(() => setSavingAnimation(false));
                    }}
                  >
                    Ask agent
                  </button>
                </span>
              </p>
            )}
            <ValueField
              key={`${clip.id}:start`}
              label="Start"
              value={clip.start}
              unit="timecode"
              fps={timeline.fps}
              onCommit={(value) => timing("start", value)}
            />
            <ValueField
              key={`${clip.id}:duration`}
              label="Duration"
              value={clip.duration}
              unit="timecode"
              fps={timeline.fps}
              onCommit={(value) => timing("duration", value)}
            />
            {clip.src !== null && clip.mediaStart !== null && (
              <>
                <ValueField
                  key={`${clip.id}:speed`}
                  label="Speed"
                  value={clip.playbackRate}
                  unit="percent"
                  min={MIN_PLAYBACK_RATE}
                  max={MAX_PLAYBACK_RATE}
                  fps={timeline.fps}
                  onCommit={(value) => timing("speed", value)}
                />
                <ValueField
                  key={`${clip.id}:sourceIn`}
                  label="Source in"
                  value={toFrames(clip.mediaStart, timeline.fps)}
                  unit="timecode"
                  fps={timeline.fps}
                  onCommit={(value) => timing("sourceIn", value)}
                />
              </>
            )}
          </details>
          <details
            open={changesOpen}
            onToggle={(event) => {
              const { open } = event.currentTarget;
              sessionStorage.setItem("cutroom.inspector.changes", String(open));
              setChangesOpen(open);
            }}
            className="inspector-section inspector-history"
          >
            <summary>
              <CaretRight size={10} aria-hidden />
              Changes <span className="inspector-count">{edits.length}</span>
            </summary>
            <ol className="inspector-changes">
              {shown.map((edit) => (
                <li key={edit.id} data-by={edit.by}>
                  <span
                    title={[
                      edit.label,
                      edit.at &&
                        new Date(edit.at).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    {edit.label
                      .split(/(\d{2}:\d{2}:\d{2}:\d{2}|\d+(?:\.\d+)?%?)/g)
                      .map((part, index) =>
                        index % 2 ? (
                          <span className="inspector-number" key={index}>
                            {part}
                          </span>
                        ) : (
                          part
                        ),
                      )}
                  </span>
                  {edit.by === "human" ? (
                    <small>You</small>
                  ) : !pendingEdit(edit) ? (
                    <small>
                      {edit.accepted
                        ? "Accepted"
                        : edit.resolution === "owner"
                          ? "Edited by you"
                          : "Source changed"}
                    </small>
                  ) : (
                    <button
                      disabled={accepting !== null}
                      onClick={() => void accept(edit)}
                    >
                      Accept
                    </button>
                  )}
                </li>
              ))}
            </ol>
            {(expanded || shown.length < edits.length) && (
              <button
                className="inspector-show-all"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "Show less" : `Show all (${edits.length})`}
              </button>
            )}
            {!edits.length && (
              <p className="inspector-empty">No recent changes.</p>
            )}
          </details>
        </div>
      )}
    </aside>
  );
}
