import { useContext, useEffect, useState } from "react";
import { SidebarSimple, X } from "@phosphor-icons/react";
import { z } from "zod";
import { toFrames } from "../../../shared/timeline/apply";
import { api, json } from "../../api";
import { EditorToolsContext } from "../../editor/EditorTools";
import { clipName, trackRows } from "../../timeline/math";
import { showToast, useWorkspace } from "../../workspace";
import { editTimeline, loadTimeline, useTimeline } from "../timeline";
import { formatTimecode } from "../timecode";
import { timingCommands } from "./fields";
import type { TimingField } from "./fields";
import { ValueField } from "./ValueField";

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
  const [accepting, setAccepting] = useState<string | null>(null);
  const [timingOpen, setTimingOpen] = useState(
    () =>
      window.innerHeight >=
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--breakpoint-short",
        ),
      ),
  );
  useEffect(() => {
    const height = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--breakpoint-short",
      ),
    );
    const query = matchMedia(`(height < ${height}px)`);
    const change = () => setTimingOpen(!query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
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
  const clip =
    timeline?.clips.find(
      (item) => item.id === selection.anchor && selection.ids.has(item.id),
    ) ?? timeline?.clips.find((item) => selection.ids.has(item.id));
  const edits =
    view?.clipEdits?.filter((edit) => edit.clipId === clip?.id).toReversed() ??
    [];
  const accept = async (editId: string) => {
    setAccepting(editId);
    try {
      await api(
        `/projects/${projectId}/review/changes/accept`,
        z.object({ ok: z.boolean() }),
        json("POST", { editId }),
      );
      await loadTimeline(projectId);
    } catch (error) {
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
    if (!clip || value === null) return;
    void editTimeline(
      projectId,
      `Set ${field === "sourceIn" ? "source in" : field}`,
      (current) => timingCommands(current, clip.id, field, value),
    );
  };
  return (
    <aside
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
      {!clip || !timeline ? (
        <p className="inspector-empty">Select a clip to inspect it.</p>
      ) : (
        <div className="inspector-content" key={clip.id}>
          <div className="inspector-clip" data-kind={clip.kind}>
            <strong>{clipName(clip)}</strong>
            <span>
              {clip.kind === "element"
                ? "Element"
                : clip.kind[0]!.toUpperCase() + clip.kind.slice(1)}{" "}
              on {track?.id} ·{" "}
              <time>{formatTimecode(clip.start, timeline.fps)}</time>
            </span>
          </div>
          <details open className="inspector-section">
            <summary>Changes</summary>
            <ol className="inspector-changes">
              {edits.map((edit) => (
                <li key={edit.id} data-by={edit.by}>
                  <span title={edit.at}>{edit.label}</span>
                  {edit.by === "human" ? (
                    <small>You</small>
                  ) : edit.accepted ? (
                    <small>Accepted</small>
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
            {!edits.length && (
              <p className="inspector-empty">No recent changes.</p>
            )}
          </details>
          {clip.kind !== "audio" && (
            <details open className="inspector-section">
              <summary>Composite</summary>
              <ValueField
                label="Opacity"
                allowAuto
                value={clip.opacity}
                unit="percent"
                fps={timeline.fps}
                onCommit={(opacity) => {
                  void editTimeline(projectId, "Set opacity", () => [
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
            <summary>Timing</summary>
            <ValueField
              label="Start"
              value={clip.start}
              unit="timecode"
              fps={timeline.fps}
              onCommit={(value) => timing("start", value)}
            />
            <ValueField
              label="Duration"
              value={clip.duration}
              unit="timecode"
              fps={timeline.fps}
              onCommit={(value) => timing("duration", value)}
            />
            <ValueField
              label="Speed"
              value={clip.playbackRate}
              unit="percent"
              fps={timeline.fps}
              disabled={clip.mediaStart === null}
              onCommit={(value) => timing("speed", value)}
            />
            <ValueField
              label="Source in"
              value={
                clip.mediaStart === null
                  ? 0
                  : toFrames(clip.mediaStart, timeline.fps)
              }
              unit="timecode"
              fps={timeline.fps}
              disabled={clip.mediaStart === null}
              onCommit={(value) => timing("sourceIn", value)}
            />
          </details>
        </div>
      )}
    </aside>
  );
}
