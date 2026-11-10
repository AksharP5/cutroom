import type { EditorPoint } from "../../shared/editor";

/** A note being made on the picture: one pin, any number of strokes, and optional words and end. */
export interface Draft {
  id: string;
  textUndo: string[];
  textRedo: string[];
  redoStrokes: EditorPoint[][];
  /** Names this draft within its project. */
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
  | { type: "stroke"; points: EditorPoint[]; frame: number; at?: EditorPoint }
  | { type: "undo" }
  | { type: "removeStroke" }
  | { type: "redo" }
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
    draft: {
      id: crypto.randomUUID(),
      key: notes.next,
      frame,
      end: null,
      at,
      strokes: [],
      body: "",
      textUndo: [],
      textRedo: [],
      redoStrokes: [],
    },
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
      const corner = event.at ?? strokePin(event.points);
      const opened = draft ? notes : open(notes, event.frame, corner);
      const current = opened.draft;
      if (!current) return notes;
      return {
        ...opened,
        draft: {
          ...current,
          strokes: [...current.strokes, event.points],
          textUndo: [],
          textRedo: [],
          redoStrokes: [],
        },
      };
    }
    case "removeStroke":
    case "undo": {
      if (!draft) return notes;
      const body = event.type === "undo" ? draft.textUndo.at(-1) : undefined;
      if (body !== undefined)
        return {
          ...notes,
          draft: {
            ...draft,
            body,
            textUndo: draft.textUndo.slice(0, -1),
            textRedo: [...draft.textRedo, draft.body],
          },
        };
      const stroke = draft.strokes.at(-1);
      return stroke
        ? {
            ...notes,
            draft: {
              ...draft,
              strokes: draft.strokes.slice(0, -1),
              redoStrokes: [...draft.redoStrokes, stroke],
            },
          }
        : notes;
    }
    case "redo": {
      if (!draft) return notes;
      const stroke = draft.redoStrokes.at(-1);
      if (stroke)
        return {
          ...notes,
          draft: {
            ...draft,
            strokes: [...draft.strokes, stroke],
            redoStrokes: draft.redoStrokes.slice(0, -1),
          },
        };
      const body = draft.textRedo.at(-1);
      return body !== undefined
        ? {
            ...notes,
            draft: {
              ...draft,
              body,
              textRedo: draft.textRedo.slice(0, -1),
              textUndo: [...draft.textUndo, draft.body],
            },
          }
        : notes;
    }
    case "write":
      return draft && draft.body !== event.body
        ? {
            ...notes,
            draft: {
              ...draft,
              body: event.body,
              textUndo: [...draft.textUndo, draft.body],
              textRedo: [],
              redoStrokes: [],
            },
          }
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
      const saving = notes.saving.filter((note) => !event.ids.has(note.id));
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

/** Keep only points at least 3 screen pixels apart before fitting the curve. */
export function appendPoint(
  points: EditorPoint[],
  point: EditorPoint,
  size: { width: number; height: number },
) {
  const last = points.at(-1);
  if (
    !last ||
    Math.hypot(
      (point.x - last.x) * size.width,
      (point.y - last.y) * size.height,
    ) >= 3
  )
    points.push(point);
}

/** Snap the first stroke's top-right bounds corner to the closest actual ink. */
export function strokePin(
  points: readonly EditorPoint[],
  size = { width: 1, height: 1 },
): EditorPoint {
  const x = Math.max(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  let nearest = points[0] ?? { x, y };
  let distance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const start = points[i]!;
    const end = points[i + 1] ?? start;
    const dx = (end.x - start.x) * size.width;
    const dy = (end.y - start.y) * size.height;
    const length = dx * dx + dy * dy;
    const along = length
      ? Math.max(
          0,
          Math.min(
            1,
            ((x - start.x) * size.width * dx +
              (y - start.y) * size.height * dy) /
              length,
          ),
        )
      : 0;
    const point = {
      x: start.x + along * (end.x - start.x),
      y: start.y + along * (end.y - start.y),
    };
    const next = Math.hypot(
      (point.x - x) * size.width,
      (point.y - y) * size.height,
    );
    if (next < distance) {
      nearest = point;
      distance = next;
    }
  }
  return nearest;
}

export const POPOVER_WIDTH = 280;

/** Place the measured popover inside the stage, with 24px around the draft's ink. */
export function placePopover(
  at: EditorPoint,
  strokes: readonly (readonly EditorPoint[])[],
  picture: { left: number; top: number; width: number; height: number },
  stage: { width: number; height: number },
  popover: { width: number; height: number },
) {
  const margin = 8;
  const gap = 4;
  const width = Math.min(popover.width, stage.width - margin * 2);
  const height = Math.min(popover.height, stage.height - margin * 2);
  const pin = {
    left: Math.min(
      picture.left + at.x * picture.width,
      picture.left + picture.width - 16,
    ),
    top: Math.max(picture.top + at.y * picture.height - 16, picture.top),
  };
  const clearance = 24 + 7 / 2;
  const points = strokes.flat();
  const ink = points.length
    ? {
        left:
          picture.left +
          Math.min(...points.map((p) => p.x)) * picture.width -
          clearance,
        right:
          picture.left +
          Math.max(...points.map((p) => p.x)) * picture.width +
          clearance,
        top:
          picture.top +
          Math.min(...points.map((p) => p.y)) * picture.height -
          clearance,
        bottom:
          picture.top +
          Math.max(...points.map((p) => p.y)) * picture.height +
          clearance,
      }
    : null;
  const xs = [
    pin.left,
    pin.left + 16 + gap,
    pin.left - width - gap,
    margin,
    stage.width - width - margin,
  ];
  const ys = [
    pin.top + 16 + gap,
    pin.top - height - gap,
    margin,
    stage.height - height - margin,
  ];
  if (ink) {
    xs.push(ink.right, ink.left - width);
    ys.push(ink.bottom, ink.top - height);
  }
  const candidates = xs.flatMap((x) =>
    ys.map((y) => ({
      left: Math.max(margin, Math.min(x, stage.width - width - margin)),
      top: Math.max(margin, Math.min(y, stage.height - height - margin)),
    })),
  );
  const overlap = ({ left, top }: { left: number; top: number }) =>
    ink
      ? Math.max(
          0,
          Math.min(left + width, ink.right) - Math.max(left, ink.left),
        ) *
        Math.max(0, Math.min(top + height, ink.bottom) - Math.max(top, ink.top))
      : 0;
  const distance = ({ left, top }: { left: number; top: number }) =>
    Math.hypot(
      Math.max(left - pin.left - 16, pin.left - left - width, 0),
      Math.max(top - pin.top - 16, pin.top - top - height, 0),
    );
  candidates.sort(
    (a, b) =>
      overlap(a) - overlap(b) ||
      Math.abs(distance(a) - gap) - Math.abs(distance(b) - gap) ||
      Math.hypot(a.left - pin.left, a.top - pin.top) -
        Math.hypot(b.left - pin.left, b.top - pin.top),
  );
  const position = candidates[0]!;
  return {
    ...position,
    width,
    maxHeight: stage.height - margin * 2,
    clear: overlap(position) === 0,
  };
}

/** Remove subpixel bends after sampling so slow straight strokes do not store hundreds of points. */
export function simplifyStroke(
  points: readonly EditorPoint[],
  size: { width: number; height: number },
): EditorPoint[] {
  if (points.length < 3) return [...points];
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const dx = (last.x - first.x) * size.width;
  const dy = (last.y - first.y) * size.height;
  const length = dx * dx + dy * dy;
  let farthest = 0;
  let split = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i]!;
    const x = (point.x - first.x) * size.width;
    const y = (point.y - first.y) * size.height;
    const along = length
      ? Math.max(0, Math.min(1, (x * dx + y * dy) / length))
      : 0;
    const distance = Math.hypot(x - along * dx, y - along * dy);
    if (distance > farthest) {
      farthest = distance;
      split = i;
    }
  }
  if (farthest <= 0.75) return [first, last];
  return [
    ...simplifyStroke(points.slice(0, split + 1), size).slice(0, -1),
    ...simplifyStroke(points.slice(split), size),
  ];
}
