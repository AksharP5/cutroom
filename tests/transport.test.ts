import { expect, test } from "bun:test";
import { transition, velocity } from "../src/client/edit/transport";
import type {
  TransportEvent,
  TransportState,
} from "../src/client/edit/transport";

const forward: TransportEvent = {
  type: "shuttle",
  dir: "forward",
  fast: false,
};
const reverse: TransportEvent = {
  type: "shuttle",
  dir: "reverse",
  fast: false,
};
const run = (
  events: TransportEvent[],
  from: TransportState = { kind: "stopped" },
) => events.reduce(transition, from);

test("L plays, and each repeat doubles the speed up to 8x", () => {
  const speeds = [1, 2, 3, 4, 5].map((presses) =>
    velocity(run(Array(presses).fill(forward))),
  );
  expect(speeds).toEqual([1, 2, 4, 8, 8]);
  expect(run([forward])).toEqual({ kind: "playing" });
});

test("J mirrors L in reverse, starting at 1x", () => {
  expect(run([reverse])).toEqual({ kind: "shuttle", dir: "reverse", speed: 1 });
  expect(velocity(run([reverse, reverse, reverse]))).toBe(-4);
});

test("the opposite direction drops to 1x that way", () => {
  expect(run([forward, forward, forward, reverse])).toEqual({
    kind: "shuttle",
    dir: "reverse",
    speed: 1,
  });
  expect(run([reverse, reverse, forward])).toEqual({ kind: "playing" });
});

test("Shift starts a shuttle at 4x and keeps doubling from there", () => {
  const fast: TransportEvent = { type: "shuttle", dir: "forward", fast: true };
  expect(run([fast])).toEqual({ kind: "shuttle", dir: "forward", speed: 4 });
  expect(velocity(run([fast, forward]))).toBe(8);
  expect(velocity(run([forward, fast]))).toBe(4);
  expect(velocity(run([{ type: "shuttle", dir: "reverse", fast: true }]))).toBe(
    -4,
  );
});

test("K stops from any motion; Space toggles between stopped and playing", () => {
  expect(run([forward, forward, { type: "stop" }])).toEqual({
    kind: "stopped",
  });
  expect(run([{ type: "toggle" }])).toEqual({ kind: "playing" });
  expect(run([reverse, reverse, { type: "toggle" }])).toEqual({
    kind: "stopped",
  });
});

test("scrubbing holds until release, which stops", () => {
  const scrubbing = run([forward, { type: "scrub" }]);
  expect(scrubbing).toEqual({ kind: "scrubbing" });
  expect(velocity(scrubbing)).toBe(0);
  expect(transition(scrubbing, { type: "release" })).toEqual({
    kind: "stopped",
  });
  expect(transition({ kind: "playing" }, { type: "release" })).toEqual({
    kind: "playing",
  });
});
