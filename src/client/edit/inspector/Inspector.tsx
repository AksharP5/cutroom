import { useContext, useEffect, useRef, useState } from "react";
import { CaretRight, SidebarSimple, X } from "@phosphor-icons/react";
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import { MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import { clipFades } from "../../../shared/timeline/mix";
import { z } from "zod";
import { toFrames } from "../../../shared/timeline/apply";
import { api, json } from "../../api";
import { EditorToolsContext } from "../../editor/EditorTools";
import { trackRows } from "../../timeline/math";
import { showToast, useWorkspace } from "../../workspace";
import { editTimeline, loadTimeline, useTimeline } from "../timeline";
import { formatTimecode } from "../../../shared/timeline/timecode";
import { inspectorSubject, timingCommands } from "./fields";
import type { TimingField } from "./fields";
import { ValueField } from "./ValueField";
import { pendingEdit, shownChanges } from "./changes";

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

export function Inspector({ projectId }: { projectId: string }) {
  const mode = useContext(EditorToolsContext)?.mode;
  const open = useWorkspace((state) => state.inspector);
  const view = useTimeline((state) => state.view);
  const selection = useTimeline((state) => state.selection);
  const root = useRef<HTMLElement>(null);
  const [changesOpen, setChangesOpen] = useState(true);
  const [audioOpen, setAudioOpen] = useState(true);
  const [compositeOpen, setCompositeOpen] = useState(true);
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
        active instanceof HTMLInputElement &&
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
  const name =
    clip &&
    (clip.label?.trim() ||
      clip.src?.split("/").at(-1) ||
      clip.id
        .replaceAll(/[-_]+/g, " ")
        .replace(/^./, (letter) => letter.toUpperCase()));
  const edits =
    view?.clipEdits?.filter((edit) =>
      subject?.members.some((member) => member.id === edit.clipId),
    ) ?? [];
  const shown = shownChanges(edits, expanded);
  const accept = async (editId: string) => {
    setAccepting(editId);
    const { signal } = closing.current;
    try {
      await api(
        `/projects/${projectId}/review/changes/accept`,
        z.object({ ok: z.boolean() }),
        json("POST", { editId }),
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
          <details
            open={changesOpen}
            onToggle={(event) => setChangesOpen(event.currentTarget.open)}
            className="inspector-section"
          >
            <summary>
              <CaretRight size={10} aria-hidden />
              Changes
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
                      onClick={() => void accept(edit.id)}
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
          {clip.kind !== "audio" && (
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
        </div>
      )}
    </aside>
  );
}
