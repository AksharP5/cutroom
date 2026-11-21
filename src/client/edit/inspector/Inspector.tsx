import { isAudioKind } from "../../../shared/timeline/schema";
import type { Clip, Fps, Timeline } from "../../../shared/timeline/schema";
import { useContext, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import {
  ArrowCounterClockwise,
  CaretRight,
  SidebarSimple,
  Warning,
  X,
} from "@phosphor-icons/react";
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import { MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import { clearAudioAutomation, clipFades } from "../../../shared/timeline/mix";
import { z } from "zod";
import { toFrames } from "../../../shared/timeline/apply";
import { api, json } from "../../api";
import { EditorToolsContext } from "../../editor/EditorTools";
import { trackRows } from "../../timeline/math";
import {
  focusByKeyboard,
  focusPanel,
  returnPointerFocus,
  useKeymap,
} from "../../keymap";
import { showToast, useWorkspace } from "../../workspace";
import { editTimeline, loadTimeline, useTimeline } from "../timeline";
import { formatTimecode } from "../../../shared/timeline/timecode";
import { TimecodeText } from "../../components/TimecodeText";
import { combinedGainText, inspectorSubject, timingCommands } from "./fields";
import type { TimingField } from "./fields";
import { TransitionSection } from "./TransitionSection";
import { FieldRow, ValueCell, ValueField } from "./ValueField";
import { FxRack } from "./FxRack";
import { AudioGroupRouting } from "./AudioGroupRouting";
import { TextField } from "./TextField";
import { LayerTextFields } from "./LayerTextFields";
import { TitleSection } from "./TitleSection";
import { isTitle } from "../../../shared/timeline/title";
import { StyleSection } from "./StyleSection";
import { canHaveGrade } from "../../../shared/timeline/grade";
import { ColorSection } from "./ColorSection";
import {
  BindImageVariable,
  BindVariable,
  SceneVariablesSection,
} from "./VariablesSection";
import { TransformFields } from "./TransformFields";
import { MotionSection } from "./MotionSection";
import { RegionSection } from "./RegionSection";
import { valueAt } from "../../../shared/timeline/keyframes";
import {
  KeyframeButton,
  cancelKeyframeDraft,
  commitKeyframe,
  draftKeyframe,
  isKeyed,
  rounded,
  useClipFrame,
} from "./Keyframes";
import { useInspectorChanges } from "../reviewChanges";
import { SelectionSummary } from "./SelectionSummary";
import { ChangeList } from "./ChangeList";
import { TimelineOverview } from "./TimelineOverview";
import { transport } from "../transport";
import {
  previewPosition,
  observePosition,
  usePositionWarning,
  useTextWarning,
  cancelPositionPreview,
  commitPositionPreview,
  usePictureMove,
  useTextEdit,
} from "../preview";

/** A text field or text area, where typing is under way. */
const isField = (target: EventTarget | null) =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

/** A Timing field a key asks for, such as Ctrl+D for Duration, focused once the inspector shows it. */
export const useTimingEdit = create<{ field: "Duration" | "Speed" | null }>(
  () => ({ field: null }),
);

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
  const local = useClipFrame(clip);
  const keyed = isKeyed(clip, "position");
  const now = valueAt(clip, "position", local);
  const value =
    move?.clipId === clip.id ? move : { x: rounded(now.x), y: rounded(now.y) };
  return (
    <FieldRow
      label="Position"
      disabled={disabled}
      keyframe={
        <KeyframeButton
          projectId={projectId}
          clip={clip}
          property="position"
          disabled={disabled}
        />
      }
      onReset={() =>
        keyed
          ? void commitKeyframe(projectId, clip, "position", local, {
              x: 0,
              y: 0,
            })
          : void editTimeline(projectId, "Reset position", () => [
              { type: "setClip", clipId: clip.id, x: null, y: null },
            ])
      }
    >
      {(["x", "y"] as const).map((axis) => (
        <ValueCell
          key={`${clip.id}:${axis}`}
          axis={axis.toUpperCase()}
          label={`Position ${axis.toUpperCase()}`}
          value={value[axis]}
          initial={0}
          unit="pixels"
          min={-Infinity}
          fps={fps}
          disabled={disabled}
          onPreview={(value) =>
            keyed
              ? draftKeyframe(clip, "position", { ...now, [axis]: value })
              : previewPosition(
                  clip.id,
                  axis === "x" ? value : (clip.x ?? 0),
                  axis === "y" ? value : (clip.y ?? 0),
                )
          }
          onCancel={() =>
            keyed
              ? cancelKeyframeDraft(clip)
              : cancelPositionPreview(clip.id, clip.x ?? 0, clip.y ?? 0)
          }
          onCommit={async (value) => {
            if (value === null) return;
            if (keyed) {
              draftKeyframe(clip, "position", { ...now, [axis]: value });
              await commitKeyframe(projectId, clip, "position", local, {
                ...now,
                [axis]: value,
              });
              return;
            }
            await commitPositionPreview(() =>
              editTimeline(projectId, "Edit position", () => [
                { type: "setClip", clipId: clip.id, [axis]: value },
              ]),
            );
          }}
        />
      ))}
    </FieldRow>
  );
}

/** Static opacity, or the keyframe at the playhead once Opacity has keyframes. */
function OpacityField({
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
  const local = useClipFrame(clip);
  const keyed = isKeyed(clip, "opacity");
  return (
    <ValueField
      label="Opacity"
      allowAuto={!keyed}
      max={1}
      value={
        keyed ? rounded(valueAt(clip, "opacity", local), true) : clip.opacity
      }
      initial={keyed ? 1 : null}
      half
      disabled={disabled}
      keyframe={
        <KeyframeButton
          projectId={projectId}
          clip={clip}
          property="opacity"
          disabled={disabled}
        />
      }
      onReset={() =>
        keyed
          ? void commitKeyframe(projectId, clip, "opacity", local, 1)
          : void editTimeline(projectId, "Restore source opacity", () => [
              { type: "setClip", clipId: clip.id, opacity: null },
            ])
      }
      unit="percent"
      fps={fps}
      onPreview={
        keyed ? (opacity) => draftKeyframe(clip, "opacity", opacity) : undefined
      }
      onCancel={keyed ? () => cancelKeyframeDraft(clip) : undefined}
      onCommit={(opacity) => {
        if (keyed) {
          if (opacity === null) return;
          void commitKeyframe(projectId, clip, "opacity", local, opacity);
          return;
        }
        void editTimeline(projectId, "Edit opacity", () => [
          { type: "setClip", clipId: clip.id, opacity },
        ]);
      }}
    />
  );
}

function CombinedGain({
  clips,
  tracks,
}: {
  clips: readonly Clip[];
  tracks: Timeline["tracks"];
}) {
  const gains = clips
    .filter((clip) => !clip.trackGainWarning)
    .map(
      (clip) =>
        (clip.volume ?? 1) *
        tracks.find((track) => track.index === clip.track)!.volume,
    );
  const text = combinedGainText(gains);
  if (text === null) return null;
  return (
    <div
      className="inspector-cell inspector-net"
      title="Net gain: clip gain × track gain, before fades and automation. Authored audio groups are excluded."
    >
      <span aria-hidden="true">Net</span>
      <output aria-label="Combined static gain">{text}</output>
    </div>
  );
}

export function Inspector({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const mode = useContext(EditorToolsContext)?.mode;
  const open = useWorkspace((state) => state.inspector);
  const view = useTimeline((state) => state.view);
  const selection = useTimeline((state) => state.selection);
  const root = useRef<HTMLElement>(null);
  // Changes holds its rows while the inspector is in use, so the fields below never move under
  // the pointer or a field being typed in. A scrub or drag anywhere holds it until release.
  const [pointerInside, setPointerInside] = useState(false);
  const [fieldFocused, setFieldFocused] = useState(false);
  const gesture = useWorkspace((state) => state.gesture);
  const holdChanges = pointerInside || fieldFocused || gesture;
  // Its panel key opens it first. Focus waits for that render, since a closed inspector is inert.
  const [focusRequests, setFocusRequests] = useState(0);
  useKeymap({
    viewActiveWindowSelectionInspector: () => {
      useWorkspace.setState({ inspector: true });
      setFocusRequests((count) => count + 1);
    },
  });
  useEffect(() => {
    if (focusRequests) focusPanel(root.current);
  }, [focusRequests]);
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
  const [titleOpen, setTitleOpen] = useState(true);
  const [regionOpen, setRegionOpen] = useState(true);
  // Closed until opened, so a text clip's Timing stays in view; the choice then holds.
  const [styleOpen, setStyleOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
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
  const selectedSound =
    timeline?.clips.filter(
      (item) => selection.ids.has(item.id) && item.hasAudio,
    ) ?? [];
  // Several clips that are not one linked subject still share a gain field, as in Resolve.
  const sound =
    !subject && selection.ids.size > 1
      ? selectedSound.filter(
          (item) =>
            !timeline?.tracks.find((track) => track.index === item.track)
              ?.locked,
        )
      : [];
  const mixedGain = sound.some(
    (item) => (item.volume ?? 1) !== (sound[0]!.volume ?? 1),
  );
  const warning = usePositionWarning((state) => state.warning);
  useEffect(() => {
    observePosition(
      clip && !isAudioKind(clip.kind) ? clip.id : null,
      clip?.sourceRestrictions?.text ? null : (clip?.text ?? null),
      clip ?? null,
    );
  }, [
    projectId,
    clip?.id,
    clip?.text,
    clip?.sourceRestrictions?.text,
    clip?.scaleX,
    clip?.scaleY,
    clip?.rotation,
    JSON.stringify(clip?.crop),
  ]);
  useEffect(() => () => observePosition(null), [projectId]);
  const textEdit = useTextEdit((state) => state.clipId);
  useEffect(() => {
    if (!textEdit || !open) return;
    // The section opens first; its field exists on the next pass.
    if (textEdit === clip?.id && !textOpen) {
      setTextOpen(true);
      return;
    }
    useTextEdit.setState({ clipId: null });
    if (textEdit !== clip?.id) return;
    const field = root.current?.querySelector<HTMLTextAreaElement>(
      '.inspector-text textarea[aria-label="Text"]',
    );
    // A field that cannot be edited still shows its reason; there is nothing to type into.
    if (!field || field.disabled) return;
    field.focus();
    // Typing replaces the words, so retitling is double-click, type, Enter.
    field.select();
  }, [textEdit, open, clip?.id, textOpen]);
  const timingEdit = useTimingEdit((state) => state.field);
  useEffect(() => {
    if (!timingEdit || !open) return;
    if (clip && !timingOpen) {
      setTimingOpen(true);
      return;
    }
    useTimingEdit.setState({ field: null });
    const input = root.current?.querySelector(
      `.inspector-timing input[aria-label="${timingEdit}"]`,
    );
    if (input instanceof HTMLInputElement && !input.disabled)
      return focusByKeyboard(input);
    const what = timingEdit.toLowerCase();
    showToast(
      clip
        ? `This clip has no ${what} to change.`
        : `Select one clip to change its ${what}.`,
      null,
      { tone: "info", transient: true },
    );
  }, [timingEdit, open, clip?.id, timingOpen]);
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
  // A title's look is its own; the Style section is for every other visual clip.
  const titled = !!clip && isTitle(clip);
  const name =
    clip &&
    (clip.label?.trim() ||
      clip.src?.split("/").at(-1) ||
      (clip.title && clip.textPreview) ||
      clip.id
        .replaceAll(/[-_]+/g, " ")
        .replace(/^./, (letter) => letter.toUpperCase()));
  const changeClips = subject
    ? subject.members.map((member) => member.id)
    : selection.ids.size > 1
      ? [...selection.ids]
      : undefined;
  const changes =
    useInspectorChanges(
      projectId,
      open && !!timeline && selection.transition === undefined,
      changeClips,
    ) ?? [];
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
  const textField = clip?.text != null && (
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
  );
  return (
    <aside
      ref={root}
      id="clip-inspector"
      className="clip-inspector"
      aria-label="Inspector"
      data-open={open}
      inert={!open}
      onClick={returnPointerFocus}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onFocus={(event) => setFieldFocused(isField(event.target))}
      onBlur={(event) => setFieldFocused(isField(event.relatedTarget))}
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
      {timeline && selection.ids.size > 1 && !subject ? (
        <div className="inspector-content">
          <p className="inspector-empty">{selection.ids.size} clips selected</p>
          <SelectionSummary
            clips={timeline.clips.filter((clip) => selection.ids.has(clip.id))}
            fps={timeline.fps}
          />
          <ChangeList
            key={selection.anchor}
            projectId={projectId}
            timeline={timeline}
            edits={changes}
            clipIds={changeClips}
            limit={3}
            hold={holdChanges}
          />
          {sound.length > 0 && (
            <details
              open={audioOpen}
              onToggle={(event) => setAudioOpen(event.currentTarget.open)}
              className="inspector-section inspector-audio"
            >
              <summary>
                <CaretRight size={10} aria-hidden />
                Audio · {sound.length} {sound.length === 1 ? "clip" : "clips"}
              </summary>
              <AudioGroupRouting
                key={selectedSound.map(({ id }) => id).join("|")}
                projectId={projectId}
                clips={selectedSound}
                timeline={timeline}
              />
              {sound.some((clip) => clip.trackGainWarning) && (
                <p className="inspector-warning" role="note">
                  Track gain does not apply to selected clips with an authored
                  audio group.
                </p>
              )}
              <ValueField
                key={`${selection.anchor}:gain`}
                label="Gain"
                value={mixedGain ? null : (sound[0]!.volume ?? 1)}
                initial={1}
                mixed={mixedGain}
                unit="gain"
                max={MAX_AUDIO_GAIN}
                fps={timeline.fps}
                after={<CombinedGain clips={sound} tracks={timeline.tracks} />}
                onCommit={(volume) => {
                  const ids = new Set(sound.map((clip) => clip.id));
                  // One batch, so the whole selection is one undo step.
                  void editTimeline(projectId, "Edit gain", (current) =>
                    current.clips
                      .filter(
                        (clip) =>
                          ids.has(clip.id) && (clip.volume ?? 1) !== volume,
                      )
                      .map((clip) => ({
                        type: "setClip",
                        clipId: clip.id,
                        volume,
                      })),
                  );
                }}
              />
            </details>
          )}
        </div>
      ) : selection.transition !== undefined && timeline ? (
        <TransitionSection
          projectId={projectId}
          timeline={timeline}
          incoming={selection.transition}
        />
      ) : !timeline || !view ? null : !clip ? (
        <TimelineOverview
          projectId={projectId}
          name={projectName}
          view={view}
          edits={changes}
          hold={holdChanges}
        />
      ) : (
        <div className="inspector-content">
          <div className="inspector-clip" data-kind={clip.kind}>
            <strong title={name || undefined}>{name}</strong>
            <span className="inspector-clip-meta">
              <span>
                {titled
                  ? "Title"
                  : clip.adjustment
                    ? "Adjustment layer"
                    : clip.kind === "element"
                      ? "Text"
                      : clip.kind[0]!.toUpperCase() + clip.kind.slice(1)}{" "}
                on {track?.id}
              </span>
              <time>
                <TimecodeText
                  timecode={formatTimecode(clip.start, timeline.fps)}
                />
              </time>
            </span>
          </div>
          <ChangeList
            key={selection.anchor}
            projectId={projectId}
            timeline={timeline}
            edits={changes}
            clipIds={changeClips}
            limit={3}
            times={false}
            hold={holdChanges}
          />
          {clip.region && !isAudioKind(clip.kind) && (
            <RegionSection
              projectId={projectId}
              clip={clip}
              region={clip.region}
              fps={timeline.fps}
              disabled={track?.track.locked ?? false}
              open={regionOpen}
              onToggle={setRegionOpen}
            />
          )}
          {!isAudioKind(clip.kind) && !clip.adjustment && (
            <MotionSection
              key={`${projectId}:${view!.composition}:${clip.id}`}
              projectId={projectId}
              composition={view!.composition}
              clip={clip}
              revision={view!.revision}
              fps={timeline.fps}
              disabled={track?.track.locked ?? false}
            />
          )}
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
              {clip.kind === "element" && clip.sourceRestrictions?.text ? (
                <LayerTextFields
                  key={`${projectId}:${view!.composition}:${clip.id}`}
                  projectId={projectId}
                  composition={view!.composition}
                  clipId={clip.id}
                  revision={view!.revision}
                  active={open && textOpen}
                  disabled={track?.track.locked}
                  fallback={textField}
                />
              ) : (
                textField
              )}
              {textWarningFrame !== null && timeline && (
                <p className="inspector-warning" role="status">
                  <Warning size={14} aria-hidden />
                  <span>
                    {clip.variableBindings?.text
                      ? "The preview shows different words at "
                      : "This clip's script replaces its text at "}
                    {formatTimecode(textWarningFrame, timeline.fps)}.
                  </span>
                </p>
              )}
              {!track?.track.locked && (
                <BindVariable
                  projectId={projectId}
                  clip={clip}
                  name={name || clip.id}
                />
              )}
            </details>
          )}
          {titled && (
            <TitleSection
              projectId={projectId}
              clip={clip}
              fps={timeline.fps}
              fonts={timeline.fonts ?? []}
              disabled={track?.track.locked ?? false}
              open={titleOpen}
              onToggle={setTitleOpen}
            />
          )}
          {clip.kind === "composition" && clip.src && (
            <SceneVariablesSection
              key={`${projectId}:${view!.composition}:${clip.id}`}
              projectId={projectId}
              composition={view!.composition}
              clipId={clip.id}
              revision={view!.revision}
              disabled={track?.track.locked ?? false}
            />
          )}
          {clip.kind === "image" && (
            <BindImageVariable
              projectId={projectId}
              clip={clip}
              name={name || clip.id}
              disabled={track?.track.locked ?? false}
            />
          )}
          {!isAudioKind(clip.kind) && !clip.adjustment && (
            <details
              open={transformOpen}
              onToggle={(event) => setTransformOpen(event.currentTarget.open)}
              className="inspector-section"
            >
              <summary>
                <CaretRight size={10} aria-hidden />
                Transform
              </summary>
              <button
                type="button"
                className="inspector-section-reset"
                aria-label="Reset transform"
                title="Reset transform. Keyframed rows keep their keyframes. Double-click a row's label to reset just that row."
                disabled={
                  [clip.x, clip.y, clip.scaleX, clip.rotation, clip.crop].every(
                    (value) => value === null,
                  ) || track?.track.locked
                }
                onClick={() => {
                  // Keyframed rows have no static value; their keyframes stay.
                  const restricted = !!clip.sourceRestrictions?.transform;
                  void editTimeline(projectId, "Reset transform", () => [
                    {
                      type: "setClip",
                      clipId: clip.id,
                      ...(clip.x !== null || clip.y !== null
                        ? { x: null, y: null }
                        : {}),
                      ...(!restricted &&
                        clip.scaleX !== null && { scale: null }),
                      ...(!restricted &&
                        clip.rotation !== null && { rotation: null }),
                      ...(!restricted && clip.crop !== null && { crop: null }),
                    },
                  ]);
                }}
              >
                <ArrowCounterClockwise size={12} aria-hidden />
              </button>
              <PositionFields
                projectId={projectId}
                clip={clip}
                fps={timeline.fps}
                disabled={track?.track.locked}
              />
              {clip.sourceRestrictions?.transform ? (
                <p className="inspector-reason">
                  {clip.sourceRestrictions.transform}
                </p>
              ) : (
                <TransformFields
                  key={clip.id}
                  projectId={projectId}
                  clip={clip}
                  fps={timeline.fps}
                  disabled={track?.track.locked}
                />
              )}
              {warningFrame !== null && (
                <p className="inspector-warning" role="status">
                  <Warning size={14} aria-hidden />
                  <span>
                    This clip's animation overrides{" "}
                    {new Intl.ListFormat("en").format(
                      positionWarning!.properties,
                    )}{" "}
                    at{" "}
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
            </details>
          )}
          {!isAudioKind(clip.kind) && !clip.adjustment && (
            <details
              open={compositeOpen}
              onToggle={(event) => setCompositeOpen(event.currentTarget.open)}
              className="inspector-section"
            >
              <summary>
                <CaretRight size={10} aria-hidden />
                Composite
              </summary>
              <OpacityField
                key={clip.id}
                projectId={projectId}
                clip={clip}
                fps={timeline.fps}
                disabled={track?.track.locked}
              />
            </details>
          )}
          {canHaveGrade(clip.kind, clip.adjustment) && (
            <ColorSection
              projectId={projectId}
              composition={view!.composition}
              clip={clip}
              fps={timeline.fps}
              disabled={track?.track.locked ?? false}
              open={colorOpen}
              visible={open}
              onToggle={setColorOpen}
            />
          )}
          {!isAudioKind(clip.kind) && !clip.adjustment && !titled && (
            <StyleSection
              projectId={projectId}
              clip={clip}
              fps={timeline.fps}
              fonts={timeline.fonts ?? []}
              disabled={track?.track.locked ?? false}
              open={styleOpen}
              onToggle={setStyleOpen}
            />
          )}
          {subject?.audio.map((audio, index) => {
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
                {index === 0 && (
                  <AudioGroupRouting
                    key={selectedSound.map(({ id }) => id).join("|")}
                    projectId={projectId}
                    clips={selectedSound}
                    timeline={timeline}
                  />
                )}
                {audio.trackGainWarning && (
                  <p className="inspector-warning" role="note">
                    Track gain does not apply to this clip's bus.
                  </p>
                )}
                <ValueField
                  key={`${audio.id}:gain`}
                  label="Gain"
                  value={audio.volume ?? 1}
                  initial={1}
                  unit="gain"
                  max={MAX_AUDIO_GAIN}
                  fps={timeline.fps}
                  disabled={locked}
                  after={
                    <CombinedGain clips={[audio]} tracks={timeline.tracks} />
                  }
                  onReset={() =>
                    void editTimeline(projectId, "Reset gain", () => [
                      { type: "setClip", clipId: audio.id, volume: null },
                    ])
                  }
                  onCommit={(volume) => {
                    void editTimeline(projectId, "Edit gain", () => [
                      { type: "setClip", clipId: audio.id, volume },
                    ]);
                  }}
                />
                <FieldRow
                  label="Fade"
                  disabled={locked}
                  onReset={() =>
                    void editTimeline(projectId, "Reset fades", () => [
                      {
                        type: "setClip",
                        clipId: audio.id,
                        fadeIn: 0,
                        fadeOut: 0,
                      },
                    ])
                  }
                >
                  {(["fadeIn", "fadeOut"] as const).map((field) => (
                    <ValueCell
                      key={`${audio.id}:${field}`}
                      axis={field === "fadeIn" ? "In" : "Out"}
                      label={field === "fadeIn" ? "Fade in" : "Fade out"}
                      value={audio[field]}
                      initial={0}
                      unit="timecode"
                      fps={timeline.fps}
                      disabled={locked}
                      hint={
                        fades[field] !== audio[field]
                          ? `${field === "fadeIn" ? "In" : "Out"} plays as ${formatTimecode(Math.round(fades[field]), timeline.fps)} (scaled to fit)`
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
                </FieldRow>
                {audio.sourceRestrictions?.fx && (
                  <p className="inspector-warning" role="note">
                    {audio.sourceRestrictions.fx}
                  </p>
                )}
                <FxRack
                  fx={audio.fx}
                  disabled={locked || !!audio.sourceRestrictions?.fx}
                  onChange={(label, fx) =>
                    void editTimeline(projectId, label, () => [
                      { type: "setClip", clipId: audio.id, fx },
                    ])
                  }
                />
                {clearAudioAutomation(audio.automation) !==
                  audio.automation && (
                  <button
                    className="inspector-clear-automation"
                    disabled={locked}
                    title="Remove this clip's volume and effect automation"
                    onClick={() => {
                      void editTimeline(
                        projectId,
                        "Clear audio automation",
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
                    Clear audio automation
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
            <ValueField
              key={`${clip.id}:start`}
              label="Start"
              value={clip.start}
              unit="timecode"
              fps={timeline.fps}
              onCommit={(value) => timing("start", value)}
              after={
                <ValueCell
                  key={`${clip.id}:duration`}
                  axis="Dur"
                  label="Duration"
                  value={clip.duration}
                  unit="timecode"
                  fps={timeline.fps}
                  onCommit={(value) => timing("duration", value)}
                />
              }
            />
            {clip.src !== null && clip.mediaStart !== null && (
              <FieldRow label="Source" onReset={() => timing("speed", 1)}>
                <ValueCell
                  key={`${clip.id}:sourceIn`}
                  axis="In"
                  label="Source in"
                  value={toFrames(clip.mediaStart, timeline.fps)}
                  unit="timecode"
                  fps={timeline.fps}
                  onCommit={(value) => timing("sourceIn", value)}
                />
                <ValueCell
                  key={`${clip.id}:speed`}
                  axis="Speed"
                  label="Speed"
                  value={clip.playbackRate}
                  initial={1}
                  unit="percent"
                  min={MIN_PLAYBACK_RATE}
                  max={MAX_PLAYBACK_RATE}
                  fps={timeline.fps}
                  onCommit={(value) => timing("speed", value)}
                />
              </FieldRow>
            )}
          </details>
        </div>
      )}
    </aside>
  );
}
