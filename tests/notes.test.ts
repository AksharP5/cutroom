import { expect, test } from "bun:test";
import {
  noNotes,
  notesReducer,
  popoverSide,
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
    id: "a",
  });
  expect(saved.saving).toHaveLength(2);
  expect(
    notesReducer(saved, { type: "landed", ids: new Set(["a"]) }).saving,
  ).toHaveLength(1);
});

test("the popover opens on the side of its pin that has room, at any picture size", () => {
  const nearRight = { x: 0.85, y: 0.2 };
  expect(popoverSide(nearRight, { width: 1920, height: 1080 })).toEqual({
    inline: "right",
    block: "below",
  });
  expect(popoverSide(nearRight, { width: 980, height: 551 })).toEqual({
    inline: "left",
    block: "below",
  });
  expect(popoverSide({ x: 0.1, y: 0.9 }, { width: 980, height: 551 })).toEqual({
    inline: "right",
    block: "above",
  });
});
