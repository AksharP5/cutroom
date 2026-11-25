import { afterAll, expect, test } from "bun:test";
import { chunksNear, createChunkCache } from "../src/client/scrubAudio/chunks";
import type { Chunk, Loaded } from "../src/client/scrubAudio/chunks";
import {
  CHUNK_SAMPLES,
  FADE,
  GRAIN,
  Player,
} from "../src/client/scrubAudio/render";
import type { Motion, Voice } from "../src/client/scrubAudio/render";
import type { Segment } from "../src/client/scrubAudio/segment";

const source = { path: "talk.wav", version: "1" };
const segment = (
  gain = 1,
  map: Segment["map"] = { kind: "line", offset: 0 },
): Segment => ({
  clipId: "a",
  source,
  samples: { start: 0, end: 10 * 48_000 },
  map,
  gain: [{ at: 0, gain }],
});
const chunk = (value: (k: number) => number) =>
  new Map([
    [
      0,
      Int16Array.from({ length: CHUNK_SAMPLES }, (_, k) =>
        Math.round(value(k)),
      ),
    ],
  ]);
/** A source whose sample `k` is `k`, so a value names the sample it came from. */
const indexed = chunk((k) => k % 32_768);
const sine = (hz: number) =>
  chunk((k) => 16_384 * Math.sin((2 * Math.PI * hz * k) / 48_000));
const voice = (chunks: Voice["chunks"], gain = 1, map?: Segment["map"]) => [
  { segment: segment(gain, map), chunks },
];

/** Plays `motion`, then each later motion at its own frame, and returns every output sample. */
function play(voices: Voice[], length: number, ...motions: Motion[]) {
  const player = new Player();
  player.setVoices(voices);
  const out = new Float32Array(length);
  let next = 0;
  let source: number | null = null;
  for (let at = 0; at < length; at += 128) {
    const frame = motions[0]!.frame + at;
    while (motions[next] && motions[next]!.frame <= frame)
      player.run(motions[next++]!);
    player.process(out.subarray(at, at + 128), frame);
    source = player.reading.source;
  }
  return { out, source };
}
/** Past the 5 ms fade in. */
const steady = (out: Float32Array) =>
  Array.from(out.subarray(2 * 128), (v) => Math.round(v * 32_768));
const largestJump = (out: Float32Array, from = 0, to = out.length) => {
  let largest = 0;
  for (let i = Math.max(1, from); i < to; i++)
    largest = Math.max(largest, Math.abs(out[i]! - out[i - 1]!));
  return largest;
};

test("1x forward reads consecutive samples and 1x reverse reads the same block backwards", () => {
  const forward = steady(
    play(voice(indexed), 384, { frame: 0, position: 1000, velocity: 1 }).out,
  );
  expect(forward).toEqual(Array.from({ length: 128 }, (_, i) => 1256 + i));
  const reverse = play(voice(indexed), 384, {
    frame: 0,
    position: 1639,
    velocity: -1,
  });
  expect(steady(reverse.out)).toEqual(forward.toReversed());
  expect(reverse.source).toBe(1256);
});

test("a clip's gain scales what it reads, in tape and in grains", () => {
  const motion = { frame: 0, position: 2000, velocity: 1 };
  expect(steady(play(voice(indexed, 0.5), 384, motion).out)).toEqual(
    Array.from({ length: 128 }, (_, i) => Math.round((2256 + i) / 2)),
  );
  // Overlapping grains sum to exactly the source on a constant input.
  const constant = chunk(() => 16_384);
  for (const velocity of [2, -4, 8]) {
    const { out } = play(voice(constant, 0.5), 12_000, {
      frame: 0,
      position: 100_000,
      velocity,
    });
    for (const value of out.subarray(FADE)) expect(value).toBeCloseTo(0.25, 5);
  }
});

test("2x and faster keep the source's pitch while moving at speed, in either direction", () => {
  const crossings = (out: Float32Array) => {
    let count = 0;
    for (let i = 1; i < out.length; i++)
      if (out[i - 1]! < 0 !== out[i]! < 0) count++;
    return count;
  };
  for (const [velocity, start] of [
    [2, 24_000],
    [-2, 200_000],
    [8, 0],
  ] as const) {
    const { out, source } = play(voice(sine(1000)), 24_000, {
      frame: 0,
      position: start,
      velocity,
    });
    // Half a second of a 1 kHz tone crosses zero about a thousand times.
    expect(crossings(out)).toBeGreaterThan(900);
    expect(crossings(out)).toBeLessThan(1100);
    // Each grain starts where the motion has reached.
    expect(Math.abs(source! - (start + 24_000 * velocity))).toBeLessThan(
      GRAIN * Math.abs(velocity),
    );
  }
  // A clip sped up to 2x still plays its source at the source's pitch under a 2x shuttle.
  const fast = play(
    voice(sine(1000), 1, { kind: "rate", start: 0, rate: 2 }),
    24_000,
    {
      frame: 0,
      position: 10_000,
      velocity: 2,
    },
  );
  expect(crossings(fast.out)).toBeGreaterThan(900);
  expect(crossings(fast.out)).toBeLessThan(1100);
});

test("changing speed or re-anchoring crosses over without a jump", () => {
  const voices = voice(sine(220));
  const settle = 24_000;
  const rows: string[] = [];
  const jumps = (from: number, to: number, shift = 0) => {
    const first = { frame: 0, position: 120_000, velocity: from };
    const switched = {
      frame: settle,
      position: 120_000 + settle * from + shift,
      velocity: to,
    };
    const { out } = play(voices, 2 * settle, first, switched);
    return {
      before: largestJump(out, FADE, settle - 128),
      switch: largestJump(out, settle - 128, settle + 2 * FADE),
      after: largestJump(out, settle + 2 * FADE),
    };
  };
  for (const [name, from, to, shift] of [
    ["1x to 2x", 1, 2, 0],
    ["2x to 4x", 2, 4, 0],
    ["4x to 8x", 4, 8, 0],
    ["2x to -1x", 2, -1, 0],
    ["-1x re-anchor by one 30 fps frame", -1, -1, 1600],
  ] as const) {
    const jump = jumps(from, to, shift);
    rows.push(
      `${name}: ${jump.switch.toFixed(4)} (steady ${jump.before.toFixed(4)} / ${jump.after.toFixed(4)})`,
    );
    expect(jump.switch).toBeLessThan(1.5 * Math.max(jump.before, jump.after));
  }
  console.log(
    `largest sample-to-sample jump at the switch, 220 Hz sine at 0.5:\n${rows.join("\n")}`,
  );
});

test("a chunk not yet held fades tape out and keeps grains silent", () => {
  // Chunk 0 held, chunk 1 not: tape at 1x runs off the end of chunk 0.
  const { out } = play(voice(sine(220)), 4096, {
    frame: 0,
    position: CHUNK_SAMPLES - 2048,
    velocity: 1,
  });
  expect(largestJump(out, FADE)).toBeLessThan(0.02);
  expect(out.subarray(2048 + 64).every((value) => value === 0)).toBe(true);
  // Grains reading into the missing chunk sound not at all rather than cut off.
  const grains = play(voice(sine(220)), 9600, {
    frame: 0,
    position: CHUNK_SAMPLES - 1000,
    velocity: 2,
  });
  expect(largestJump(grains.out, FADE)).toBeLessThan(0.02);
});

test("a frame step plays exactly that frame's samples, with 1 ms edges", () => {
  const player = new Player();
  player.setVoices(voice(indexed));
  // Frame 5 at 30 fps: output samples 8000 to 9599.
  player.blip(8000, 1600, 0);
  const out = new Float32Array(2048);
  for (let at = 0; at < out.length; at += 128)
    player.process(out.subarray(at, at + 128), at);
  const heard = Array.from(out, (value) => Math.round(value * 32_768));
  expect(heard.slice(48, 1552)).toEqual(
    Array.from({ length: 1504 }, (_, i) => 8048 + i),
  );
  // The edges ramp over 1 ms, and nothing sounds past the frame.
  expect(heard[0]).toBeLessThan(8000 / 40);
  expect(heard.slice(1600).every((value) => value === 0)).toBe(true);
  expect([player.reading.low, player.reading.high]).toEqual([8000, 9599]);
  expect(player.sounding).toBe(false);
});

/**
 * Tape at speed v moves a 220 Hz sine at 0.5 by at most 0.5 * 2π * 220 / 48000 * v a sample, and
 * a 5 ms crossover adds at most 1/240. The speed is read back from the source each block reached.
 */
function tapeBound(sources: number[]) {
  const speed = Math.max(
    ...sources.slice(1).map((at, i) => Math.abs(at - sources[i]!) / 128),
  );
  return 0.5 * ((2 * Math.PI * 220) / 48_000) * speed * 1.1 + 1 / 240;
}

/** Drags a tape over the voices with a report every 16 ms from `path`, then rests. */
function drag(voices: Voice[], path: number[], rest = 1600) {
  const player = new Player();
  player.setVoices(voices);
  const every = 768;
  const out = new Float32Array((path.length + 4) * every);
  const sources: number[] = [];
  for (let at = 0; at < out.length; at += 128) {
    const report = at / every;
    if (Number.isInteger(report) && report < path.length) {
      const previous = path[report - 1] ?? path[report]!;
      player.chase(
        {
          frame: at,
          position: path[report]!,
          velocity: report ? (path[report]! - previous) / every : 0,
          rest,
        },
        at,
      );
    }
    player.process(out.subarray(at, at + 128), at);
    sources.push(player.reading.source ?? NaN);
  }
  return { out, sources, player, end: (path.length - 1) * every };
}

test("a drag follows the pointer as tape and changes speed and direction without a jump", () => {
  // Speeding up to 3x, slowing, turning back to 2x reverse.
  const speeds = [0, 0.5, 1, 2, 3, 3, 2, 1, 0.5, -0.5, -1, -2, -2, -2];
  const path = speeds.reduce<number[]>(
    (positions, speed) => [...positions, positions.at(-1)! + speed * 768],
    [100_000],
  );
  const { out, sources, end } = drag(voice(sine(220)), path);
  expect(largestJump(out, 0, end)).toBeLessThan(tapeBound(sources));
  // Reading backwards once the pointer turns.
  // Reports 10 to 14 move backwards, six blocks each.
  const back = sources.slice(10 * 6 + 3, 14 * 6);
  expect(back).toEqual(back.toSorted((a, b) => b - a));
  expect(new Set(back).size).toBe(back.length);
});

test("a drag goes silent within a frame of the pointer resting", () => {
  const path = Array.from({ length: 10 }, (_, i) => 100_000 + i * 768);
  const { out, player, end } = drag(voice(sine(220)), path);
  expect(out.subarray(end - 768, end).some((value) => value !== 0)).toBe(true);
  // One 30 fps frame of rest, then the 5 ms fade.
  expect(
    out.subarray(end + 1600 + FADE + 128).every((value) => value === 0),
  ).toBe(true);
  expect(player.sounding).toBe(false);
});

test("a drag that jumps far crosses over to where the pointer is", () => {
  const path = [100_000, 100_768, 101_536, 200_000, 200_768, 201_536];
  const { out, sources, end } = drag(voice(sine(220)), path);
  // Crossing over, with no jump of its own: a cut would move the sine by up to its full swing.
  expect(largestJump(out, 0, end)).toBeLessThan(
    tapeBound(sources.filter((at, i) => i < 17 || i > 19)),
  );
});

test("the worklet fades out to idle after stop and reports its first audible block", async () => {
  const posted: unknown[] = [];
  let Processor:
    | (new () => {
        port: { onmessage: (event: { data: unknown }) => void };
        process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
      })
    | undefined;
  const globals = globalThis as Record<string, unknown>;
  globals.currentFrame = 0;
  globals.AudioWorkletProcessor = class {
    port = {
      postMessage: (message: unknown) => posted.push(message),
      onmessage: null,
    };
  };
  globals.registerProcessor = (_: string, processor: typeof Processor) =>
    (Processor = processor);
  afterAll(() => {
    for (const name of [
      "currentFrame",
      "AudioWorkletProcessor",
      "registerProcessor",
    ])
      delete globals[name];
  });
  await import("../src/client/scrubAudio/worklet");
  const worklet = new Processor!();
  const send = (data: unknown) => worklet.port.onmessage({ data });
  const block = () => {
    const out = new Float32Array(128);
    worklet.process([], [[out]]);
    globals.currentFrame = (globals.currentFrame as number) + 128;
    return out;
  };
  send({ type: "segments", segments: [segment()] });
  send({
    type: "chunk",
    source: "talk.wav\n1",
    index: 0,
    samples: sine(220).get(0),
  });
  expect(block().every((value) => value === 0)).toBe(true);
  send({ type: "run", frame: 128, position: 10_000, velocity: -1 });
  block();
  expect(posted).toContainEqual({ type: "sounded", frame: 128 });
  block();
  send({ type: "stop" });
  for (let i = 0; i < 3; i++) block();
  const quiet = block();
  expect(quiet.every((value) => value === 0)).toBe(true);
  send({ type: "probe" });
  const before = posted.at(-1) as { frames: number };
  block();
  block();
  send({ type: "probe" });
  // Idle: it renders nothing more.
  expect((posted.at(-1) as { frames: number }).frames).toBe(before.frames);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const chunks = (...indices: number[]) =>
  indices.map((index) => ({ source, index }));

test("the cache fetches what is wanted nearest first and lets go of the least recently wanted", async () => {
  const fetched: number[] = [];
  const dropped: number[] = [];
  const cache = createChunkCache({
    capBytes: 3 * 2 * CHUNK_SAMPLES,
    load: async ({ index }: Chunk): Promise<Loaded> => {
      fetched.push(index);
      return index === 9
        ? { kind: "silent" }
        : { kind: "samples", samples: new Int16Array(CHUNK_SAMPLES) };
    },
    send() {},
    drop: ({ index }) => dropped.push(index),
  });

  cache.want(chunks(0, 1, 2));
  for (let i = 0; i < 4; i++) await settle();
  cache.want(chunks(3, 1));
  await settle();
  expect(fetched).toEqual([0, 1, 2, 3]);
  // Over the cap: 0 was wanted least recently and goes first; 1 was wanted again and stays.
  expect(dropped).toEqual([0]);
  expect(cache.held()).toEqual([
    "talk.wav\n1#2",
    "talk.wav\n1#1",
    "talk.wav\n1#3",
  ]);
  // A source with no sound is asked for once.
  const mute = [{ source: { path: "room.wav", version: "1" }, index: 9 }];
  cache.want(mute);
  await settle();
  cache.want(mute);
  await settle();
  expect(fetched.filter((index) => index === 9)).toHaveLength(1);
  // More than fits: only the nearest are kept.
  cache.want(chunks(4, 5, 6, 7));
  await settle();
  expect(fetched.slice(5)).toEqual([4, 5, 6]);
  cache.close();
});

test("a source being made or failing is read one chunk at a time until it answers", async () => {
  const fetched: number[] = [];
  let answer: "pending" | "fail" | "samples" = "pending";
  const cache = createChunkCache({
    retryMs: 5,
    load: async ({ index }) => {
      fetched.push(index);
      if (answer === "fail") throw new Error("connection reset");
      return answer === "pending"
        ? { kind: "pending" }
        : { kind: "samples", samples: new Int16Array(8) };
    },
    send() {},
    drop() {},
  });
  const warn = console.warn;
  console.warn = () => {};
  cache.want(chunks(0, 1, 2));
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Only the nearest chunk is asked again while the file is being made.
  expect(new Set(fetched)).toEqual(new Set([0]));
  expect(fetched.length).toBeGreaterThan(1);
  answer = "fail";
  await new Promise((resolve) => setTimeout(resolve, 30));
  answer = "samples";
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.warn = warn;
  // A failed read is retried, and once one chunk arrives the rest follow.
  expect(cache.held().toSorted()).toEqual([
    "talk.wav\n1#0",
    "talk.wav\n1#1",
    "talk.wav\n1#2",
  ]);
  cache.close();
});

test("a read for a chunk that leaves the window is cancelled", async () => {
  const signals = new Map<number, AbortSignal>();
  const cache = createChunkCache({
    load: ({ index }, signal) => {
      signals.set(index, signal);
      return index === 0
        ? Promise.resolve({ kind: "samples", samples: new Int16Array(8) })
        : new Promise(() => {});
    },
    send() {},
    drop() {},
  });
  cache.want(chunks(0, 1, 2));
  for (let i = 0; i < 4; i++) await settle();
  cache.want(chunks(0, 2));
  expect(signals.get(1)!.aborted).toBe(true);
  expect(signals.get(2)!.aborted).toBe(false);
  cache.close();
});

test("a window across a loop asks for both ends without fetching the middle", () => {
  const end = 4 * CHUNK_SAMPLES;
  const looping = {
    ...segment(),
    samples: { start: 0, end: 2 * end },
    loop: { start: 0, length: end },
  };
  expect(chunksNear([looping], end - 240, end + 240, end)).toEqual([
    { source, index: 0 },
    { source, index: 3 },
  ]);
});

test("the chunks a window needs follow each clip's source map, nearest the playhead first", () => {
  const near = chunksNear(
    [
      {
        ...segment(),
        samples: { start: 0, end: 48_000 },
        map: { kind: "line", offset: 5 * CHUNK_SAMPLES },
      },
      {
        ...segment(),
        clipId: "b",
        samples: { start: 48_000, end: 3 * CHUNK_SAMPLES },
        map: { kind: "line", offset: 0 },
      },
    ],
    0,
    2 * CHUNK_SAMPLES,
    60_000,
  );
  expect(near.map(({ index }) => index)).toEqual([0, 1, 5]);
});
