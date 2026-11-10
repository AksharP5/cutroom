import { expect, test } from "bun:test";
import { saveNoteInOrder } from "../src/client/edit/noteStore";

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
