import { expect, test } from "bun:test";
import {
  noNotes,
  notesReducer,
  placePopover,
  appendPoint,
  simplifyStroke,
  strokePin,
  showsAt,
} from "../src/client/edit/notes";
import type { NoteEvent, Notes } from "../src/client/edit/notes";

const run = (...events: NoteEvent[]) =>
  events.reduce<Notes>(notesReducer, noNotes);
const circle = [
  { x: 0.2, y: 0.5 },
  { x: 0.4, y: 0.3 },
  { x: 0.3, y: 0.6 },
];
const tick = [
  { x: 0.7, y: 0.7 },
  { x: 0.8, y: 0.6 },
];

test("a drawing collects strokes, undo takes back the last one, and commit hands it to saving", () => {
  const drawn = run(
    { type: "stroke", points: circle, frame: 30 },
    { type: "stroke", points: tick, frame: 45 },
  );
  // The pin sits at the first stroke's top-right corner, at the frame it was started on.
  expect(drawn.draft).toMatchObject({
    frame: 30,
    at: { x: 0.4, y: 0.3 },
    strokes: [circle, tick],
  });

  const undone = notesReducer(drawn, { type: "undo" });
  expect(undone.draft?.strokes).toEqual([circle]);

  // A drawing needs no words.
  const committed = notesReducer(undone, { type: "commit" });
  expect(committed.draft).toBeNull();
  expect(committed.saving.map((note) => note.strokes)).toEqual([[circle]]);
});

test("a comment needs words, Esc discards it, and marking again moves the pin and keeps the words", () => {
  const pinned = run(
    { type: "pin", at: { x: 0.5, y: 0.5 }, frame: 10 },
    { type: "commit" },
  );
  expect(pinned.saving).toEqual([]);
  expect(pinned.draft).not.toBeNull();

  const moved = run(
    { type: "pin", at: { x: 0.5, y: 0.5 }, frame: 10 },
    { type: "write", body: "look in" },
    { type: "pin", at: { x: 0.1, y: 0.2 }, frame: 12 },
  );
  expect(moved.draft).toMatchObject({
    at: { x: 0.1, y: 0.2 },
    frame: 12,
    body: "look in",
  });

  expect(notesReducer(moved, { type: "cancel" }).draft).toBeNull();
});

test("an end before the note's frame is refused", () => {
  const pinned = run({ type: "pin", at: { x: 0.5, y: 0.5 }, frame: 10 });
  expect(notesReducer(pinned, { type: "end", frame: 8 }).draft?.end).toBeNull();
  const ranged = notesReducer(pinned, { type: "end", frame: 40 });
  expect(ranged.draft?.end).toBe(40);
  expect(showsAt({ frame: 10, end: 40 }, 40)).toBe(true);
  expect(showsAt({ frame: 10, end: 40 }, 41)).toBe(false);
  expect(showsAt({ frame: 10, end: null }, 11)).toBe(false);
});

test("several notes save at once, and a failed save reopens once no other note is open", () => {
  const two = run(
    { type: "pin", at: { x: 0.1, y: 0.1 }, frame: 0 },
    { type: "write", body: "first" },
    { type: "commit" },
    { type: "stroke", points: circle, frame: 5 },
    { type: "commit" },
    { type: "pin", at: { x: 0.9, y: 0.9 }, frame: 9 },
    { type: "write", body: "third, still open" },
  );
  const [first, second] = two.saving;
  if (!first || !second) throw new Error("Both notes should be saving.");

  // The first fails while the third is open: it waits, so neither is lost.
  const failed = notesReducer(two, {
    type: "failed",
    key: first.key,
    error: "Server unreachable",
  });
  expect(failed.draft?.body).toBe("third, still open");
  expect(failed.saving).toHaveLength(2);

  const reopened = notesReducer(failed, { type: "commit" });
  expect(reopened.draft).toMatchObject({
    body: "first",
    error: "Server unreachable",
  });
  expect(reopened.saving.map((note) => note.body)).toEqual([
    "",
    "third, still open",
  ]);

  // A saved note stays until the server's notes hold it.
  const saved = notesReducer(reopened, {
    type: "saved",
    key: second.key,
    id: second.id,
  });
  expect(saved.saving).toHaveLength(2);
  expect(
    notesReducer(saved, { type: "landed", ids: new Set([second.id]) }).saving,
  ).toHaveLength(1);
});

test("measured popovers stay in the stage at corners and clear ink by 24 pixels", () => {
  for (const size of [
    { width: 959, height: 337 },
    { width: 703, height: 256 },
  ]) {
    const picture = { ...size, left: 0, top: 0 };
    for (const at of [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]) {
      const placed = placePopover(at, [], picture, size, {
        width: 280,
        height: 184,
      });
      expect(placed.left).toBeGreaterThanOrEqual(8);
      expect(placed.top).toBeGreaterThanOrEqual(8);
      expect(placed.left! + placed.width).toBeLessThanOrEqual(size.width - 8);
      expect(placed.top! + 184).toBeLessThanOrEqual(size.height - 8);
    }
    const strokes = [
      [
        { x: 0.1, y: 0.5 },
        { x: 0.35, y: 0.5 },
      ],
    ];
    const placed = placePopover({ x: 0.35, y: 0.5 }, strokes, picture, size, {
      width: 280,
      height: 112,
    });
    expect(
      placed.left! >= size.width * 0.35 + 24 ||
        placed.top! + 112 <= size.height * 0.5 - 24 ||
        placed.top! >= size.height * 0.5 + 24,
    ).toBe(true);
  }
});

test("popover flips keep a 4px gap from the pin", () => {
  const picture = { left: 0, top: 0, width: 1000, height: 600 };
  for (const at of [
    { x: 0.2, y: 0.2 },
    { x: 0.9, y: 0.9 },
  ]) {
    const placed = placePopover(at, [], picture, picture, {
      width: 280,
      height: 112,
    });
    const x = Math.max(
      placed.left! - (at.x * 1000 + 16),
      at.x * 1000 - (placed.left! + 280),
      0,
    );
    const y = Math.max(
      placed.top! - at.y * 600,
      at.y * 600 - 16 - (placed.top! + 112),
      0,
    );
    expect(Math.hypot(x, y)).toBe(4);
  }
});

test("text since the last stroke undoes before strokes; redo restores the stroke and text", () => {
  let notes = run(
    { type: "stroke", points: circle, frame: 0 },
    { type: "write", body: "keep this" },
  );
  notes = notesReducer(notes, { type: "undo" });
  expect(notes.draft?.body).toBe("");
  expect(notes.draft?.strokes).toEqual([circle]);
  notes = notesReducer(notes, { type: "undo" });
  expect(notes.draft?.strokes).toEqual([]);
  notes = notesReducer(notes, { type: "redo" });
  expect(notes.draft?.strokes).toEqual([circle]);
  notes = notesReducer(notes, { type: "redo" });
  expect(notes.draft?.body).toBe("keep this");
});

test("the client id reconciles a notebook update even before the POST resolves", () => {
  const notes = run(
    { type: "stroke", points: circle, frame: 0 },
    { type: "commit" },
  );
  const saved = notes.saving[0]!;
  expect(saved.id).toMatch(/^[a-f0-9-]{36}$/);
  const landed = notesReducer(notes, {
    type: "landed",
    ids: new Set([saved.id]),
  });
  expect(landed.saving).toEqual([]);
  expect(
    notesReducer(landed, { type: "saved", key: saved.key, id: saved.id })
      .saving,
  ).toEqual([]);
});

test("a slow 400px stroke stores fewer than 80 points and keeps its ends", () => {
  const points: { x: number; y: number }[] = [];
  for (let x = 0; x <= 400; x++)
    appendPoint(points, { x: x / 800, y: 0.5 }, { width: 800, height: 450 });
  expect(points.length).toBeLessThan(140);
  const smooth = simplifyStroke(points, { width: 800, height: 450 });
  expect(smooth.length).toBeLessThan(80);
  expect(smooth[0]).toEqual(points[0]);
  expect(smooth.at(-1)).toEqual(points.at(-1));
  // The bounds corner is not necessarily ink. The pin is an actual stroke point.
  expect(
    strokePin([
      { x: 0.1, y: 0.1 },
      { x: 0.4, y: 0.4 },
    ]),
  ).toEqual({ x: 0.25, y: 0.25 });
});
