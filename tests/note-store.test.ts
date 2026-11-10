import { expect, test } from "bun:test";
import {
  saveNoteInOrder,
  trackNoteCapture,
  waitForNoteCaptures,
} from "../src/client/edit/noteStore";

test("chat waits for every capture in its own project and a failed capture releases the wait", async () => {
  const project = crypto.randomUUID();
  const otherProject = crypto.randomUUID();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const other = Promise.withResolvers<void>();
  trackNoteCapture(project, first.promise);
  trackNoteCapture(project, second.promise);
  trackNoteCapture(otherProject, other.promise);
  let finished = false;
  const waiting = waitForNoteCaptures(project).then(() => {
    finished = true;
  });
  try {
    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    second.reject(new Error("Capture failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(true);
    await waiting;
  } finally {
    first.resolve();
    second.resolve();
    other.resolve();
  }
});

test("a capture timeout lets chat continue without forgetting a capture still running", async () => {
  const project = crypto.randomUUID();
  const capture = Promise.withResolvers<void>();
  trackNoteCapture(project, capture.promise);
  await waitForNoteCaptures(project, 1);
  let finished = false;
  const waiting = waitForNoteCaptures(project).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(finished).toBe(false);
  capture.resolve();
  await waiting;
  expect(finished).toBe(true);
});

test("a failed save reaches its caller, allows the next note, and never holds another project", async () => {
  const project = crypto.randomUUID();
  const otherProject = crypto.randomUUID();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const first = saveNoteInOrder(project, async () => {
    calls.push("first");
    await held;
    throw new Error("Not saved");
  });
  const next = saveNoteInOrder(project, async () => {
    calls.push("next");
    return "next-id";
  });
  const other = saveNoteInOrder(otherProject, async () => {
    calls.push("other");
    return "other-id";
  });
  expect(await other).toBe("other-id");
  expect(calls).toEqual(["first", "other"]);
  release();
  await expect(first).rejects.toThrow("Not saved");
  expect(await next).toBe("next-id");
  expect(calls).toEqual(["first", "other", "next"]);
});
