import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Timeline } from "../../../shared/timeline/schema";
import { formatTimecode } from "../../../shared/timeline/timecode";
import { api, json } from "../../api";
import { clickSelection } from "../../timeline/selection";
import { showToast } from "../../workspace";
import { showSource } from "../source";
import { loadTimeline, useTimeline } from "../timeline";
import { transport } from "../transport";
import { pendingEdit, shownChanges } from "./changes";
import type { ChangeRow } from "./changes";

/**
 * What changed, newest first: one row per change, verb first. A row seeks to its clip and selects
 * it; agent work waiting for review keeps its Accept.
 */
export function ChangeList({
  projectId,
  timeline,
  edits,
  limit,
  times = true,
  hold,
}: {
  projectId: string;
  timeline: Timeline;
  edits: ChangeRow[];
  /** Rows shown before "Show all"; pending agent work is always shown. */
  limit: number;
  /** Each row's clip start. Left out where every row is the same clip. */
  times?: boolean;
  /**
   * Keep the rows that are showing, so nothing moves under a pointer or a field in use. Rows
   * still update in place; new ones arrive together once the hold ends.
   */
  hold: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  // Closing the project cancels a pending reload, like the timeline's own read.
  const closing = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    closing.current = controller;
    return () => controller.abort();
  }, [projectId]);
  // The rows showing when the hold began; rows still update in place from `edits`.
  const [held, setHeld] = useState<ChangeRow[] | null>(null);
  if (hold && !held) setHeld(edits);
  if (!hold && held) setHeld(null);
  const latest = new Map(edits.map((edit) => [edit.id, edit]));
  const rows =
    hold && held ? held.map((edit) => latest.get(edit.id) ?? edit) : edits;
  if (!rows.length) return null;
  const shown = shownChanges(rows, expanded, limit);
  const accept = async (edit: ChangeRow) => {
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
  const reveal = (clipId: string, frame: number) => {
    showSource(false);
    transport.seek(frame);
    useTimeline.setState(({ selection }) => ({
      selection: clickSelection(timeline, [], selection, clipId, {
        toggle: false,
        range: false,
        alone: false,
      }),
    }));
  };
  return (
    <section className="inspector-section inspector-history">
      <h3>
        Changes <span className="inspector-count">{rows.length}</span>
      </h3>
      <ol className="inspector-changes">
        {shown.map((edit) => {
          // A removed clip keeps its history, but there is nothing left to show.
          const clip = timeline.clips
            .filter((clip) =>
              edit.members.some((member) => member.clipId === clip.id),
            )
            .toSorted((a, b) => a.start - b.start)[0];
          const [verb, ...rest] = edit.label.split(" ");
          const title = [
            edit.label,
            edit.at &&
              new Date(edit.at).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }),
          ]
            .filter(Boolean)
            .join(" · ");
          const text = (
            <>
              <span className="inspector-change-text">
                <strong>{verb}</strong>{" "}
                {rest
                  .join(" ")
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
              {clip && times && (
                <time>{formatTimecode(clip.start, timeline.fps)}</time>
              )}
            </>
          );
          return (
            <li
              key={edit.id}
              data-by={edit.by}
              data-pending={pendingEdit(edit) || undefined}
            >
              {clip ? (
                <button
                  type="button"
                  className="inspector-change"
                  title={title}
                  onClick={() => reveal(clip.id, clip.start)}
                >
                  {text}
                </button>
              ) : (
                <span className="inspector-change" title={title}>
                  {text}
                </span>
              )}
              {/* Accepted agent work reads like your own: settled, nothing to say. */}
              {edit.by === "human" || edit.accepted ? null : !pendingEdit(
                  edit,
                ) ? (
                <small>
                  {edit.resolution === "owner"
                    ? "Edited by you"
                    : "Source changed"}
                </small>
              ) : (
                <button
                  className="inspector-accept"
                  disabled={accepting !== null}
                  onClick={() => void accept(edit)}
                >
                  Accept
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {(expanded || shown.length < rows.length) && (
        <button
          className="inspector-show-all"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : `Show all (${rows.length})`}
        </button>
      )}
    </section>
  );
}
