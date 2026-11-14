import { test, expect } from "bun:test";
import { previewRefresh } from "../src/client/edit/previewRefresh";

test("refreshes preserve the active operation and only the latest pending invalidation", async () => {
  const seen: number[] = [];
  const first = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  let latest = () => true;
  const queue = previewRefresh<number>(async (value, isLatest) => {
    seen.push(value);
    if (value === 1) {
      latest = isLatest;
      await first.promise;
    }
    if (value === 8) done.resolve();
  }, done.reject);
  queue.push(1);
  for (let value = 2; value <= 8; value++) queue.push(value);
  expect(seen).toEqual([1]);
  expect(latest()).toBe(false);
  first.resolve();
  await done.promise;
  expect(seen).toEqual([1, 8]);
  queue.dispose();
  queue.push(9);
  expect(seen).toEqual([1, 8]);
});

test("returning to main's reload path invalidates active work and drops its pending revision", async () => {
  const first = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const seen: number[] = [];
  let latest = () => true;
  const queue = previewRefresh<number>(async (value, isLatest) => {
    seen.push(value);
    if (value === 1) {
      latest = isLatest;
      await first.promise;
    }
    if (value === 9) done.resolve();
  }, done.reject);
  queue.push(1);
  queue.push(8);
  queue.invalidate();
  expect(latest()).toBe(false);
  queue.push(9);
  first.resolve();
  await done.promise;
  expect(seen).toEqual([1, 9]);
  queue.dispose();
});
