import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowCounterClockwise, Trash, X } from "@phosphor-icons/react";
import type {
  EditorMode,
  EditorPoint,
  EditorReviewDraft,
} from "../../shared/editor";
import type { ReviewItem } from "../../shared/review";
import { toFrames, toSeconds } from "../../shared/timeline/apply";
import type { Fps } from "../../shared/timeline/schema";
import { actionFor, comboOf } from "../keymap";
import { noteNumbers } from "../review";
import { formatTimecode } from "./timecode";
import {
  committable,
  noNotes,
  appendPoint,
  simplifyStroke,
  POPOVER_WIDTH,
  placePopover,
  strokePath,
  strokePin,
} from "./notes";
import type { Draft, NoteEvent } from "./notes";
import { dispatchNote, useProjectNotes } from "./noteStore";
import { useNoteVisibility } from "./noteVisibility";
import { transport, useTransport } from "./transport";

/**
 * Saves a committed note and resolves with its id. A rejection reopens the note with the error.
 */
export type SaveNote = (
  draft: EditorReviewDraft,
  body: string,
) => Promise<string>;

/** The viewer always shows the project's main composition. */
const COMPOSITION = "index.html";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A saved note as the picture shows it. */
interface Mark {
  item: ReviewItem;
  number: number;
  frame: number;
  end: number | null;
  at: EditorPoint | undefined;
}

/** A pin's bottom-left corner sits on its point and stays inside the picture at the edges. */
const pinStyle = ({ x, y }: EditorPoint): CSSProperties => ({
  left: `min(${x * 100}%, 100% - var(--size-pin-viewer))`,
  top: `max(${y * 100}%, var(--size-pin-viewer))`,
});

const Stroke = memo(function Stroke({
  points,
}: {
  points: readonly EditorPoint[];
}) {
  return <path d={strokePath(points)} />;
});

/** Every casing goes under every pencil line, so crossing strokes stay one clean yellow. */
const layers = ["casing", "pencil"] as const;

/**
 * Notes on the picture. Comment drops a pin and opens its popover; Draw adds strokes to one note
 * until it is added or discarded. Saved notes keep their pins and strokes at their frames, and a
 * pin opens its note in Review. Lies over the picture at `box`, in the stage's coordinates.
 */
export function NoteLayer({
  projectId,
  stageSize,
  onNeedsRoom,
  box,
  mode,
  notes,
  onOpenNote,
  onSave,
}: {
  projectId: string;
  stageSize: { width: number; height: number };
  onNeedsRoom(): void;
  box: Box;
  mode: EditorMode;
  notes: readonly ReviewItem[];
  onOpenNote(id: string): void;
  onSave: SaveNote;
}) {
  const { draft, saving } = useProjectNotes(
    (state) => state.projects[projectId] ?? noNotes,
  );
  const dispatch = (event: NoteEvent) => dispatchNote(projectId, event);
  const fps = useTransport((state) => state.fps);
  const live = useRef<{
    pointer: number;
    frame: number;
    points: EditorPoint[];
  }>(null);
  const strokesLayer = useRef<SVGSVGElement>(null);
  const paint = useRef<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const popover = useRef<HTMLFormElement>(null);
  const [popoverSize, setPopoverSize] = useState({
    width: POPOVER_WIDTH,
    height: 112,
  });
  useLayoutEffect(() => {
    const element = popover.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setPopoverSize({
        width: POPOVER_WIDTH,
        height: element.offsetHeight,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [draft?.key]);

  const placement = draft
    ? placePopover(draft.at, draft.strokes, box, stageSize, popoverSize)
    : null;
  useLayoutEffect(() => {
    // If ink fills the picture, make room beside it instead of covering any of it.
    if (
      stageSize.width > 0 &&
      stageSize.height > 0 &&
      placement &&
      !placement.clear
    )
      onNeedsRoom();
  }, [placement?.clear, onNeedsRoom]);

  const numbers = noteNumbers(notes);
  const marks = notes.flatMap((item): Mark[] =>
    item.compositionPath === COMPOSITION &&
    item.review.status !== "withdrawn" &&
    item.review.status !== "accepted"
      ? [
          {
            item,
            number: numbers.get(item.id) ?? 0,
            frame: toFrames(item.time, fps),
            end:
              item.endTime === undefined ? null : toFrames(item.endTime, fps),
            at: item.point ?? item.strokes[0]?.points[0],
          },
        ]
      : [],
  );
  // A committed note shows as saving until the server's notes hold it, then as itself.
  const unsaved = saving.filter((note) => !numbers.has(note.id));
  useEffect(() => {
    if (unsaved.length < saving.length)
      dispatch({ type: "landed", ids: new Set(numbers.keys()) });
  });
  const shown = useNoteVisibility([
    ...marks.map((mark) => ({ ...mark, id: mark.item.id })),
    ...unsaved,
  ]);
  const visible = marks.filter((mark) => shown.has(mark.item.id));
  const pending = unsaved.filter((note) => shown.has(note.id));

  // Each new mark puts the cursor in the note, so typing never reaches the editor's shortcuts.
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, [draft?.key, draft?.at, draft?.strokes.length]);

  // Capture before the editor's window listeners, even if a ruler drag moved focus.
  useEffect(() => {
    if (!draft) return;
    const focus = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".tl-ruler"))
        field.current?.focus({ preventScroll: true });
    };
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("dialog"))
        return;
      const combo = comboOf(event);
      const inside = event.target === field.current;
      if (combo === "Esc") dispatchNote(projectId, { type: "cancel" });
      else if (combo === "Ctrl+Z" || combo === "Ctrl+Shift+Z")
        dispatchNote(projectId, { type: combo === "Ctrl+Z" ? "undo" : "redo" });
      else if (inside) return;
      else if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        const input = field.current;
        if (!input) return;
        input.focus({ preventScroll: true });
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.setRangeText(event.key, start, end, "end");
        dispatchNote(projectId, { type: "write", body: input.value });
      } else if (actionFor(event)) {
        field.current?.focus({ preventScroll: true });
      } else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerup", focus);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerup", focus);
    };
  }, [projectId, draft !== null]);

  useEffect(
    () => () => {
      if (paint.current !== null) cancelAnimationFrame(paint.current);
    },
    [],
  );

  const commit = () => {
    if (!draft || !committable(draft)) return;
    dispatch({ type: "commit" });
    void onSave(reviewDraft(draft, fps), draft.body.trim()).then(
      (id) => dispatch({ type: "saved", key: draft.key, id }),
      (error: unknown) =>
        dispatch({
          type: "failed",
          key: draft.key,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  const drawLive = () => {
    paint.current = null;
    const d = live.current ? strokePath(live.current.points) : "";
    strokesLayer.current
      ?.querySelectorAll("[data-live]")
      .forEach((path) => path.setAttribute("d", d));
  };
  const endLive = () => {
    live.current = null;
    drawLive();
  };

  const armed = mode === "draw" || mode === "comment";
  const next = notes.length + unsaved.length + 1;
  // Finished notes leave the picture; open notes keep their pin and ink.
  const lines = [
    ...visible
      .filter(({ item }) => item.review.status !== "accepted")
      .flatMap(({ item }) =>
        item.strokes.map(({ points }, index) => ({
          key: `${item.id}-${index}`,
          fading: shown.get(item.id) === "fading",
          points,
        })),
      ),
    ...[...pending, ...(draft ? [draft] : [])].flatMap((note) =>
      note.strokes.map((points, index) => ({
        key: `${note.key}-${index}`,
        fading: shown.get(note.id) === "fading",
        points,
      })),
    ),
  ];
  return (
    <div className="edit-notes" style={{ ...box }}>
      {armed && (
        <div
          className="edit-note-surface"
          data-mode={mode}
          aria-label={
            mode === "draw"
              ? "Draw on the composition"
              : "Pin a comment on the composition"
          }
          // A press on the picture keeps focus in the note, so typing stays there.
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (event.button !== 0 || live.current) return;
            transport.dispatch({ type: "stop" });
            const { frame } = useTransport.getState();
            const at = pointIn(event.currentTarget, event);
            if (mode === "comment") {
              dispatch({ type: "pin", at, frame });
              return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
            live.current = { pointer: event.pointerId, frame, points: [at] };
            drawLive();
          }}
          onPointerMove={(event) => {
            const stroke = live.current;
            if (stroke?.pointer !== event.pointerId) return;
            const moves = event.nativeEvent.getCoalescedEvents();
            for (const move of moves.length ? moves : [event.nativeEvent])
              appendPoint(
                stroke.points,
                pointIn(event.currentTarget, move),
                box,
              );
            paint.current ??= requestAnimationFrame(drawLive);
          }}
          onPointerUp={(event) => {
            const stroke = live.current;
            if (stroke?.pointer !== event.pointerId) return;
            dispatch({
              type: "stroke",
              points: simplifyStroke(stroke.points, box),
              at: strokePin(stroke.points, box),
              frame: stroke.frame,
            });
            endLive();
          }}
          onPointerCancel={endLive}
        />
      )}
      <svg
        ref={strokesLayer}
        className="edit-note-strokes"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {layers.map((layer) => (
          <g key={layer} className={`edit-note-${layer}`}>
            {lines.map((line) => (
              <g
                key={line.key}
                className="edit-note-mark"
                data-fading={line.fading || undefined}
              >
                <Stroke points={line.points} />
              </g>
            ))}
            <path data-live />
          </g>
        ))}
      </svg>
      {visible.flatMap(({ item, number, at }) =>
        at
          ? [
              <button
                key={item.id}
                type="button"
                className="note-pin edit-note-pin"
                data-status={item.review.status}
                data-fading={shown.get(item.id) === "fading" || undefined}
                style={pinStyle(at)}
                aria-label={`Note ${number}`}
                title={item.body || "Drawing"}
                onClick={() => onOpenNote(item.id)}
              >
                {number}
              </button>,
            ]
          : [],
      )}
      {pending.map((note) => (
        <span
          key={note.key}
          className="note-pin edit-note-pin"
          data-status="open"
          data-fading={shown.get(note.id) === "fading" || undefined}
          style={pinStyle(note.at)}
          title={note.error ?? "Saving"}
        >
          {notes.length + unsaved.indexOf(note) + 1}
        </span>
      ))}
      {draft && (
        <>
          <span
            className="note-pin edit-note-pin"
            data-status="draft"
            style={pinStyle(draft.at)}
            aria-hidden="true"
          >
            {next}
          </span>
          <form
            ref={popover}
            className="edit-note-popover"
            aria-label={`Note ${next}`}
            style={
              placement
                ? {
                    width: placement.width,
                    maxHeight: placement.maxHeight,
                    left: placement.left - box.left,
                    top: placement.top - box.top,
                  }
                : undefined
            }
            onSubmit={(event) => {
              event.preventDefault();
              commit();
            }}
          >
            <textarea
              ref={field}
              aria-label="What should change?"
              placeholder={
                draft.strokes.length
                  ? "What should change? (optional)"
                  : "What should change?"
              }
              value={draft.body}
              onChange={(event) =>
                dispatch({ type: "write", body: event.target.value })
              }
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.shiftKey ||
                  event.nativeEvent.isComposing
                )
                  return;
                event.preventDefault();
                commit();
              }}
            />
            {draft.error && (
              <p className="edit-note-error" role="alert">
                Not saved. {draft.error}
              </p>
            )}
            <div
              className="edit-note-foot"
              data-ranged={draft.end !== null || undefined}
            >
              <span className="edit-note-time">
                <span className="mono">{formatTimecode(draft.frame, fps)}</span>
                <NoteEnd draft={draft} fps={fps} dispatch={dispatch} />
              </span>
              <span className="edit-grow" />
              {draft.strokes.length > 0 && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Remove last stroke"
                  title="Remove last stroke (Ctrl+Z)"
                  onClick={() => dispatch({ type: "removeStroke" })}
                >
                  <ArrowCounterClockwise />
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label="Discard note"
                title="Discard note (Esc)"
                onClick={() => dispatch({ type: "cancel" })}
              >
                <Trash />
              </button>
              <button className="primary-button" disabled={!committable(draft)}>
                Add note
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

/** The note's last frame: set from the playhead, which can move while the note is open. */
function NoteEnd({
  draft,
  fps,
  dispatch,
}: {
  draft: Draft;
  fps: Fps;
  dispatch(event: NoteEvent): void;
}) {
  const playhead = useTransport((state) => state.frame);
  if (draft.end !== null)
    return (
      <button
        type="button"
        className="text-button quiet edit-note-end"
        title="Clear the end"
        onClick={() => dispatch({ type: "end", frame: null })}
      >
        <span className="mono">to {formatTimecode(draft.end, fps)}</span>
        <X size={10} />
      </button>
    );
  return (
    <button
      type="button"
      className="text-button quiet edit-note-end"
      disabled={playhead <= draft.frame}
      title={
        playhead > draft.frame
          ? `End the note at the playhead, ${formatTimecode(playhead, fps)}`
          : "Move the playhead past this frame to end the note there"
      }
      onClick={() => dispatch({ type: "end", frame: playhead })}
    >
      Set end
    </button>
  );
}

/** Where a pointer is on the picture, from 0 to 1 on each axis. */
function pointIn(
  surface: Element,
  { clientX, clientY }: { clientX: number; clientY: number },
): EditorPoint {
  const bounds = surface.getBoundingClientRect();
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return {
    x: clamp((clientX - bounds.left) / bounds.width),
    y: clamp((clientY - bounds.top) / bounds.height),
  };
}

function reviewDraft(draft: Draft, fps: Fps): EditorReviewDraft {
  return {
    id: draft.id,
    time: toSeconds(draft.frame, fps),
    ...(draft.end !== null && { endTime: toSeconds(draft.end, fps) }),
    compositionPath: COMPOSITION,
    point: draft.at,
    strokes: draft.strokes,
    elementIds: [],
  };
}
