import { expect, test } from "bun:test";
import {
  createTransport,
  transition,
  velocity,
} from "../src/client/edit/transport";
import type {
  Transport,
  TransportEvent,
  TransportState,
} from "../src/client/edit/transport";
import {
  createJog,
  idleJog,
  jogHold,
  jogPress,
  jogRelease,
} from "../src/client/edit/jog";

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

test("a shuttle's position runs between frames at its speed, from where it started", () => {
  const globals = globalThis as Record<string, unknown>;
  const stubbed = !globals.requestAnimationFrame;
  if (stubbed) {
    globals.requestAnimationFrame = () => 0;
    globals.cancelAnimationFrame = () => {};
  }
  try {
    const transport = createTransport();
    transport.setTimeline({
      fps: { num: 30, den: 1 },
      duration: 900,
      range: { in: null, out: null },
    });
    transport.seek(300);
    expect(transport.shuttlePosition(performance.now())).toBeNull();
    transport.dispatch(reverse);
    transport.dispatch(reverse);
    const at = performance.now();
    // Half a second at -2x on 30 fps is 30 frames back.
    expect(
      transport.shuttlePosition(at + 500)! - transport.shuttlePosition(at)!,
    ).toBeCloseTo(-30, 6);
    expect(transport.shuttlePosition(at)).toBeCloseTo(300, 0);
  } finally {
    if (stubbed) {
      delete globals.requestAnimationFrame;
      delete globals.cancelAnimationFrame;
    }
  }
});

test("K held with J or L plays half speed that way", () => {
  expect(
    transition({ kind: "stopped" }, { type: "slow", dir: "forward" }),
  ).toEqual({
    kind: "shuttle",
    dir: "forward",
    speed: 0.5,
  });
  expect(
    velocity(transition({ kind: "playing" }, { type: "slow", dir: "reverse" })),
  ).toBe(-0.5);
});

/** Runs presses (`+K`), releases (`-L`) and the hold timer (`hold`) through the jog, collecting what each does. */
function jogs(...inputs: string[]) {
  let jog = idleJog;
  const effects: unknown[] = [];
  const key = (name: string) =>
    name === "K" ? "stop" : name === "L" ? "forward" : "reverse";
  for (const input of inputs) {
    const [next, effect] =
      input === "hold"
        ? jogHold(jog)
        : input[0] === "+"
          ? jogPress(jog, key(input[1]!))
          : jogRelease(jog, key(input[1]!));
    jog = next;
    if (effect) effects.push(effect);
  }
  return effects;
}
const stop = { type: "stop" };
const slow = (dir: "forward" | "reverse") => ({ type: "slow", dir });
const step = (frames: 1 | -1) => ({ type: "step", frames });

test("K alone stops, and J or L alone shuttle as before", () => {
  expect(jogs("+K", "-K")).toEqual([stop]);
  expect(jogs("+L", "-L", "+L", "-L")).toEqual([
    { type: "shuttle", dir: "forward", fast: false },
    { type: "shuttle", dir: "forward", fast: false },
  ]);
});

test("with K held, a tap of J or L steps one frame and each tap steps again", () => {
  expect(jogs("+K", "+L", "-L", "+L", "-L", "+J", "-J", "-K")).toEqual([
    stop,
    step(1),
    step(1),
    step(-1),
  ]);
  // The hold timer from a released tap does nothing.
  expect(jogs("+K", "+L", "-L", "hold", "-K")).toEqual([stop, step(1)]);
});

test("with K held, holding J or L steps and then plays half speed until either key is released", () => {
  expect(jogs("+K", "+L", "hold", "-L", "-K")).toEqual([
    stop,
    step(1),
    slow("forward"),
    stop,
  ]);
  expect(jogs("+K", "+J", "hold", "-K", "-J")).toEqual([
    stop,
    step(-1),
    slow("reverse"),
    stop,
  ]);
  // Pressing K again with J still down picks half speed up again.
  expect(jogs("+K", "+J", "hold", "-K", "+K", "-J")).toEqual([
    stop,
    step(-1),
    slow("reverse"),
    stop,
    slow("reverse"),
    stop,
  ]);
});

test("L held first and then K plays half speed forward at once", () => {
  expect(jogs("+L", "+K", "-K", "-L")).toEqual([
    { type: "shuttle", dir: "forward", fast: false },
    slow("forward"),
    stop,
  ]);
  expect(jogs("+L", "+K", "-L", "-K")).toEqual([
    { type: "shuttle", dir: "forward", fast: false },
    slow("forward"),
    stop,
  ]);
});

test("the jog counts only keys that are down: a menu's Play then K just stops", () => {
  const events: unknown[] = [];
  const player = {
    dispatch: (event: unknown) => events.push(event),
    step: (frames: number) => events.push({ type: "step", frames }),
  } as unknown as Transport;
  const jog = createJog(() => player);
  jog.press("forward");
  jog.keyDown("stop");
  jog.press("stop");
  jog.release("stop");
  expect(events).toEqual([
    { type: "shuttle", dir: "forward", fast: false },
    stop,
  ]);
  // Keys that are down do count: K held, then L tapped.
  jog.keyDown("stop");
  jog.press("stop");
  jog.keyDown("forward");
  jog.press("forward");
  jog.release("forward");
  jog.release("stop");
  expect(events.slice(2)).toEqual([stop, step(1)]);
});

test("/ plays from the pre-roll to the post-roll once and returns the playhead; K stops it there", () => {
  const globals = globalThis as Record<string, unknown>;
  const saved = [globals.requestAnimationFrame, globals.cancelAnimationFrame];
  let next: FrameRequestCallback | undefined;
  globals.requestAnimationFrame = (callback: FrameRequestCallback) => {
    next = callback;
    return 1;
  };
  globals.cancelAnimationFrame = () => {};
  let seconds = 0;
  let playing = true;
  const tickAt = (at: number) => {
    seconds = at;
    next?.(0);
  };
  try {
    const transport = createTransport();
    transport.setTimeline({
      fps: { num: 30, den: 1 },
      duration: 900,
      range: { in: null, out: null },
    });
    transport.attach({
      play() {},
      pause() {},
      seek: (at) => (seconds = at),
      time: () => seconds,
      clock: () => null,
      playing: () => playing,
      setMuted() {},
    });
    transport.seek(300);
    transport.playAround(240, 360);
    expect(transport.use.getState()).toMatchObject({
      frame: 240,
      state: { kind: "playing" },
    });
    tickAt(11);
    expect(transport.use.getState().frame).toBe(330);
    tickAt(12);
    expect(transport.use.getState()).toMatchObject({
      frame: 300,
      state: { kind: "stopped" },
    });

    transport.playAround(240, 360);
    tickAt(9);
    transport.dispatch({ type: "stop" });
    expect(transport.use.getState()).toMatchObject({
      frame: 270,
      state: { kind: "stopped" },
    });

    // / again mid-pass plays the same pass from its start, not one around the moving playhead,
    // and still returns to where the first press began.
    transport.seek(300);
    transport.playAround(240, 360);
    tickAt(11);
    transport.playAround(270, 390);
    expect(transport.use.getState().frame).toBe(240);
    tickAt(12);
    expect(transport.use.getState()).toMatchObject({
      frame: 300,
      state: { kind: "stopped" },
    });

    // With Loop on, the pass repeats until stopped.
    transport.use.setState({ loop: true });
    transport.playAround(240, 360);
    tickAt(12);
    expect(transport.use.getState()).toMatchObject({
      frame: 240,
      state: { kind: "playing" },
    });

    transport.use.setState({ loop: false });
    transport.seek(420);
    transport.playAround(240, 360);
    transport.setTimeline({
      fps: { num: 30, den: 1 },
      duration: 345,
      range: { in: null, out: null },
    });
    playing = false;
    tickAt(344 / 30);
    expect(transport.use.getState()).toMatchObject({
      frame: 344,
      state: { kind: "stopped" },
    });
  } finally {
    [globals.requestAnimationFrame, globals.cancelAnimationFrame] = saved;
  }
});
