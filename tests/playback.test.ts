import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { toFrames } from "../src/shared/timeline/apply";
import type { Fps } from "../src/shared/timeline/schema";
import { transport, useTransport } from "../src/client/edit/transport";
import type { RuntimePlayer } from "../src/client/edit/transport";

// The playback loop runs on animation frames; these tests drive them by hand.
let callbacks: FrameRequestCallback[] = [];
let now = 0;
let clock: Mock<() => number>;
beforeEach(() => {
  callbacks = [];
  now = 0;
  globalThis.requestAnimationFrame = (callback) => callbacks.push(callback);
  globalThis.cancelAnimationFrame = () => {
    callbacks = [];
  };
  clock = spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  transport.attach(null);
  clock.mockRestore();
  Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
});

/** A runtime whose clock moves only when told, and stops by itself at its length. */
function runtime(length: number) {
  let time = 0;
  let playing = false;
  const seeks: number[] = [];
  const player: RuntimePlayer = {
    play: () => {
      playing = time < length;
    },
    pause: () => {
      playing = false;
    },
    seek: (seconds) => {
      time = seconds;
      seeks.push(seconds);
    },
    time: () => time,
    clock: () => ({
      source: "cutroom-preview",
      type: "clock",
      time,
      at: performance.timeOrigin + now,
    }),
    playing: () => playing,
    setMuted: () => {},
  };
  return {
    player,
    seeks,
    /** Advances wall time and the runtime's clock, then runs one animation frame. */
    elapse(seconds: number) {
      now += seconds * 1000;
      if (playing) {
        time = Math.min(length, time + seconds);
        playing = time < length;
      }
      const due = callbacks;
      callbacks = [];
      for (const callback of due) callback(now);
    },
  };
}

function open(fps: Fps, seconds: number, length = seconds) {
  const fake = runtime(length);
  useTransport.setState({ loop: false });
  transport.setTimeline({
    fps,
    duration: toFrames(seconds, fps),
    tracks: [],
    clips: [],
    markers: [],
    range: { in: null, out: null },
  });
  transport.attach(fake.player);
  transport.seek(0);
  return fake;
}
const state = () => useTransport.getState();
const thirty = { num: 30, den: 1 };

test("1x follows the runtime's clock, and stopping lands exactly on the frame it reached", () => {
  const { elapse, seeks } = open(thirty, 4);
  transport.dispatch({ type: "shuttle", dir: "forward", fast: false });
  elapse(1);
  expect(state().frame).toBe(30);
  elapse(0.0244);
  transport.dispatch({ type: "stop" });
  expect(state()).toMatchObject({ state: { kind: "stopped" }, frame: 30 });
  expect(seeks.at(-1)).toBe(1);
});

test("playback stops on the last frame, or starts over with loop on", () => {
  const { elapse } = open(thirty, 2);
  transport.dispatch({ type: "toggle" });
  elapse(1.5);
  elapse(1);
  elapse(0.02);
  expect(state()).toMatchObject({ state: { kind: "stopped" }, frame: 59 });

  transport.toggleLoop();
  transport.dispatch({ type: "toggle" });
  expect(state().frame).toBe(0);
  elapse(2.5);
  elapse(0.02);
  expect(state()).toMatchObject({ state: { kind: "playing" }, frame: 0 });
});

test("at 23.976 and 29.97 the runtime stopping at its end ends playback, or loops", () => {
  for (const fps of [
    { num: 24000, den: 1001 },
    { num: 30000, den: 1001 },
  ]) {
    const last = toFrames(8, fps) - 1;
    const { elapse } = open(fps, 8);
    transport.dispatch({ type: "toggle" });
    elapse(9);
    elapse(0.02);
    expect(state()).toMatchObject({ state: { kind: "stopped" }, frame: last });

    transport.toggleLoop();
    transport.seek(last - 2);
    transport.dispatch({ type: "toggle" });
    elapse(1);
    elapse(0.02);
    expect(state().state).toEqual({ kind: "playing" });
    expect(state().frame).toBeLessThan(last);
  }
});

test("reverse steps the runtime frame by frame and stops at the first frame", () => {
  const { elapse, seeks } = open(thirty, 4);
  transport.seek(60);
  transport.dispatch({ type: "shuttle", dir: "reverse", fast: false });
  transport.dispatch({ type: "shuttle", dir: "reverse", fast: false });
  elapse(0.5);
  expect(state().frame).toBe(30);
  expect(seeks.at(-1)).toBe(1);
  elapse(1.5);
  expect(state()).toMatchObject({ state: { kind: "stopped" }, frame: 0 });
});

test("a looped shuttle wraps inside the in and out range", () => {
  const { elapse } = open(thirty, 4);
  useTransport.setState({ loop: true, range: { in: 30, out: 60 } });
  transport.dispatch({ type: "shuttle", dir: "forward", fast: false });
  transport.dispatch({ type: "shuttle", dir: "forward", fast: false });
  expect(state().frame).toBe(30);
  elapse(0.25);
  expect(state().frame).toBe(45);
  elapse(0.25);
  expect(state().frame).toBe(30);
});
