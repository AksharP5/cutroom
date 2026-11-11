import { expect, test } from "bun:test";
import { seekQueue } from "../src/client/edit/seekQueue";

test("seeks coalesce per animation frame, replace the waiting target, and restore after the in-flight seek", async () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  let finish = () => {};
  const sought: (number | null)[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const queue = seekQueue<number | null>(
    async (value) => {
      sought.push(value);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      inFlight--;
    },
    (error) => {
      throw error;
    },
    (callback) => {
      callbacks.set(++id, callback);
      return id;
    },
    (id) => {
      callbacks.delete(id);
    },
  );
  const paint = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(0);
  };
  queue.push(1);
  queue.push(2);
  queue.push(3);
  expect(callbacks.size).toBe(1);
  paint();
  expect(sought).toEqual([3]);
  for (let frame = 4; frame < 1000; frame++) queue.push(frame);
  paint();
  expect(sought).toEqual([3]);
  finish();
  await Bun.sleep(0);
  expect(callbacks.size).toBe(1);
  paint();
  expect(sought).toEqual([3, 999]);
  queue.push(1000);
  queue.push(null); // Release or Escape supersedes every waiting edge frame.
  finish();
  await Bun.sleep(0);
  paint();
  expect(sought).toEqual([3, 999, null]);
  expect(maxInFlight).toBe(1);
  finish();
  await Bun.sleep(0);
  queue.push(1001);
  queue.dispose();
  paint();
  expect(sought).toEqual([3, 999, null]);
});
