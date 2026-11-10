import { memo, useEffect, useReducer, useRef } from "react";
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
import { actionFor, comboOf, isTyping } from "../keymap";
import { noteNumbers } from "../review";
import { formatTimecode } from "./timecode";
import {
  committable,
  noNotes,
  notesReducer,
  POPOVER_WIDTH,
  popoverSide,
  showsAt,
  strokePath,
} from "./notes";
import type { Draft, NoteEvent } from "./notes";
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
  box,
  mode,
  notes,
  onOpenNote,
  onSave,
}: {
  box: Box;
  mode: EditorMode;
  notes: readonly ReviewItem[];
  onOpenNote(id: string): void;
  onSave: SaveNote;
}) {
  const [{ draft, saving }, dispatch] = useReducer(notesReducer, noNotes);
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

  const numbers = noteNumbers(notes);
  const marks = notes.flatMap((item): Mark[] =>
    item.compositionPath === COMPOSITION && item.review.status !== "withdrawn"
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
  const unsaved = saving.filter((note) => !note.id || !numbers.has(note.id));
  useEffect(() => {
    if (unsaved.length < saving.length)
      dispatch({ type: "landed", ids: new Set(numbers.keys()) });
  });
  // Re-renders when the notes at the playhead change, not on every frame of playback.
  const shown = useTransport((state) =>
    [...marks, ...unsaved]
      .filter((note) => showsAt(note, state.frame))
      .map((note) => ("item" in note ? note.item.id : note.key))
      .join(" "),
  ).split(" ");
  const visible = marks.filter((mark) => shown.includes(mark.item.id));
  const pending = unsaved.filter((note) => shown.includes(String(note.key)));

  // Each new mark puts the cursor in the note, so typing never reaches the editor's shortcuts.
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, [draft?.key, draft?.at, draft?.strokes.length]);

  // While a note is open, Esc discards it and undo takes back its last stroke.
  const open = draft !== null;
  const strokes = draft?.strokes.length ?? 0;
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      const inside =
        event.target instanceof Node &&
        !!popover.current?.contains(event.target);
      if (!inside && isTyping(event.target)) return;
      const combo = comboOf(event);
      const undo = inside
        ? combo === "Ctrl+Z"
        : actionFor(event) === "editUndo";
      if (combo === "Esc") dispatch({ type: "cancel" });
      else if (undo && strokes > 0) dispatch({ type: "undo" });
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open, strokes]);

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
  // Accepted notes are finished; only their pins stay.
  const lines = [
    ...visible
      .filter(({ item }) => item.review.status !== "accepted")
      .flatMap(({ item }) =>
        item.strokes.map(({ points }, index) => ({
          key: `${item.id}-${index}`,
          points,
        })),
      ),
    ...[...pending, ...(draft ? [draft] : [])].flatMap((note) =>
      note.strokes.map((points, index) => ({
        key: `${note.key}-${index}`,
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
              stroke.points.push(pointIn(event.currentTarget, move));
            paint.current ??= requestAnimationFrame(drawLive);
          }}
          onPointerUp={(event) => {
            const stroke = live.current;
            if (stroke?.pointer !== event.pointerId) return;
            dispatch({
              type: "stroke",
              points: stroke.points,
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
              <Stroke key={line.key} points={line.points} />
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
            style={popoverStyle(draft.at, box)}
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
            <div className="edit-note-foot">
              <span className="mono">{formatTimecode(draft.frame, fps)}</span>
              <NoteEnd draft={draft} fps={fps} dispatch={dispatch} />
              <span className="edit-grow" />
              {draft.strokes.length > 0 && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Remove last stroke"
                  title="Remove last stroke (Ctrl+Z)"
                  onClick={() => dispatch({ type: "undo" })}
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

/** Opens beside the pin, on the side with room, and grows from the pin's corner. */
function popoverStyle(at: EditorPoint, size: Box): CSSProperties {
  const { inline, block } = popoverSide(at, size);
  return {
    width: POPOVER_WIDTH,
    ...(inline === "right"
      ? { left: `${at.x * 100}%` }
      : { right: `${(1 - at.x) * 100}%` }),
    ...(block === "below"
      ? { top: `calc(${at.y * 100}% + var(--space-1))` }
      : {
          bottom: `calc(${(1 - at.y) * 100}% + var(--size-pin-viewer) + var(--space-1))`,
        }),
    transformOrigin: `${inline === "right" ? "left" : "right"} ${block === "below" ? "top" : "bottom"}`,
  };
}

function reviewDraft(draft: Draft, fps: Fps): EditorReviewDraft {
  return {
    time: toSeconds(draft.frame, fps),
    ...(draft.end !== null && { endTime: toSeconds(draft.end, fps) }),
    compositionPath: COMPOSITION,
    point: draft.at,
    strokes: draft.strokes,
    elementIds: [],
  };
}
