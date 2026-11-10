import type { EditorPoint } from "../../shared/editor";

/** A note being made on the picture: one pin, any number of strokes, and optional words and end. */
export interface Draft {
  /** Names the note on this page until the server saves it. */
  key: number;
  frame: number;
  /** The last frame the note covers, inclusive; null for a single frame. */
  end: number | null;
  /** Where the pin sits, in picture coordinates from 0 to 1. */
  at: EditorPoint;
  strokes: EditorPoint[][];
  body: string;
  /** Why the last save failed, shown when the note reopens. */
  error?: string;
  /** The saved note's id, once the server has it. */
  id?: string;
}

/**
 * The note open on the picture, and the notes committed from it until the server's notes hold
 * them. A note whose save fails reopens as soon as no other note is open, so nothing typed or
 * drawn is lost.
 */
export interface Notes {
  draft: Draft | null;
  saving: Draft[];
  next: number;
}

export type NoteEvent =
  | { type: "pin"; at: EditorPoint; frame: number }
  | { type: "stroke"; points: EditorPoint[]; frame: number }
  | { type: "undo" }
  | { type: "write"; body: string }
  | { type: "end"; frame: number | null }
  | { type: "cancel" }
  | { type: "commit" }
  | { type: "saved"; key: number; id: string }
  | { type: "failed"; key: number; error: string }
  /** The server's notes now hold these ids. */
  | { type: "landed"; ids: ReadonlySet<string> };

export const noNotes: Notes = { draft: null, saving: [], next: 1 };

/** A comment needs words; a drawing can stand alone. */
export const committable = (draft: Draft) =>
  draft.body.trim() !== "" || draft.strokes.length > 0;

/** Closes the open note: the first failed save, if any, takes its place. */
function close(notes: Notes, saving = notes.saving): Notes {
  const failed = saving.find((note) => note.error);
  return {
    ...notes,
    draft: failed ?? null,
    saving: saving.filter((note) => note !== failed),
  };
}

function open(notes: Notes, frame: number, at: EditorPoint): Notes {
  return {
    ...notes,
    next: notes.next + 1,
    draft: { key: notes.next, frame, end: null, at, strokes: [], body: "" },
  };
}

export function notesReducer(notes: Notes, event: NoteEvent): Notes {
  const { draft } = notes;
  switch (event.type) {
    case "pin": {
      // Marking again moves the pin to the new place and frame and keeps everything else.
      if (!draft) return open(notes, event.frame, event.at);
      const end =
        draft.end !== null && draft.end > event.frame ? draft.end : null;
      return {
        ...notes,
        draft: { ...draft, at: event.at, frame: event.frame, end },
      };
    }
    case "stroke": {
      if (!event.points.length) return notes;
      // A drawing's pin sits at its first stroke's top-right corner, clear of what it marks.
      const corner = {
        x: Math.max(...event.points.map((point) => point.x)),
        y: Math.min(...event.points.map((point) => point.y)),
      };
      const opened = draft ? notes : open(notes, event.frame, corner);
      const current = opened.draft;
      if (!current) return notes;
      return {
        ...opened,
        draft: { ...current, strokes: [...current.strokes, event.points] },
      };
    }
    case "undo":
      return draft?.strokes.length
        ? { ...notes, draft: { ...draft, strokes: draft.strokes.slice(0, -1) } }
        : notes;
    case "write":
      return draft
        ? { ...notes, draft: { ...draft, body: event.body } }
        : notes;
    case "end":
      return draft && (event.frame === null || event.frame > draft.frame)
        ? { ...notes, draft: { ...draft, end: event.frame } }
        : notes;
    case "cancel":
      return draft ? close(notes) : notes;
    case "commit": {
      if (!draft || !committable(draft)) return notes;
      const { error: _error, ...saving } = draft;
      return close(notes, [...notes.saving, saving]);
    }
    case "saved":
      return {
        ...notes,
        saving: notes.saving.map((note) =>
          note.key === event.key ? { ...note, id: event.id } : note,
        ),
      };
    case "landed": {
      const saving = notes.saving.filter(
        (note) => note.id === undefined || !event.ids.has(note.id),
      );
      return saving.length === notes.saving.length
        ? notes
        : { ...notes, saving };
    }
    case "failed": {
      const saving = notes.saving.map((note) =>
        note.key === event.key ? { ...note, error: event.error } : note,
      );
      return draft ? { ...notes, saving } : close(notes, saving);
    }
  }
}

/** Whether a note made at `frame`, through `end` if set, shows at the playhead. */
export const showsAt = (
  { frame, end }: { frame: number; end: number | null },
  playhead: number,
) => playhead >= frame && playhead <= (end ?? frame);

const round = (value: number) => Math.round(value * 1e4) / 1e4;

/**
 * An SVG path through a stroke's points, smoothed with quadratic curves through their midpoints.
 * Scaled by `width` and `height`; the defaults keep picture coordinates. One point draws a dot.
 */
export function strokePath(
  points: readonly EditorPoint[],
  width = 1,
  height = 1,
) {
  const xy = points.map(
    ({ x, y }) => `${round(x * width)} ${round(y * height)}`,
  );
  const [first] = xy;
  if (!first) return "";
  const mid = (a: EditorPoint, b: EditorPoint) =>
    `${round(((a.x + b.x) / 2) * width)} ${round(((a.y + b.y) / 2) * height)}`;
  const curves = points
    .slice(1, -1)
    .map(
      (point, index) =>
        `Q${xy[index + 1]} ${mid(point, points[index + 2] ?? point)}`,
    );
  return [`M${first}`, ...curves, `L${xy.at(-1)}`].join(" ");
}

/** The note popover's width, which its side of the pin is chosen from. */
export const POPOVER_WIDTH = 280;
/** Room the popover needs below its pin before it opens above instead. */
const POPOVER_ROOM = 140;

/**
 * Which side of its pin the note popover opens on, inside a picture of `size` pixels. It prefers
 * below and to the right, and flips when the picture edge is nearer than the popover is big.
 */
export function popoverSide(
  at: EditorPoint,
  size: { width: number; height: number },
) {
  const x = at.x * size.width;
  const y = at.y * size.height;
  const right = size.width - x;
  const below = size.height - y;
  return {
    inline:
      right >= POPOVER_WIDTH || right >= x
        ? ("right" as const)
        : ("left" as const),
    block:
      below >= POPOVER_ROOM || below >= y
        ? ("below" as const)
        : ("above" as const),
  };
}
