import { expect, test } from "bun:test";
import { chunksNear, createChunkCache } from "../src/client/scrubAudio/chunks";
import type { Chunk, Loaded } from "../src/client/scrubAudio/chunks";
import {
  CHUNK_SAMPLES,
  GRAIN,
  renderBlock,
} from "../src/client/scrubAudio/render";
import type { Motion, Reading } from "../src/client/scrubAudio/render";
import type { Segment } from "../src/client/scrubAudio/segment";

const source = { path: "talk.wav", version: "1" };
const segment = (gain = 1, offset = 0): Segment => ({
  clipId: "a",
  source,
  samples: { start: 0, end: 10 * 48_000 },
  map: { kind: "line", offset },
  gain: [{ at: 0, gain }],
});
/** Chunk 0 of a source whose sample `k` is `k`, so a value names the sample it came from. */
const indexed = new Map([
  [0, Int16Array.from({ length: 32_768 }, (_, k) => k)],
]);

function render(
  motion: Motion,
  length: number,
  voices = [{ segment: segment(), chunks: indexed }],
) {
  const out = new Float32Array(length);
  const reading: Reading = { peak: 0, source: null };
  for (let at = 0; at < length; at += 128)
    renderBlock(
      out.subarray(at, at + 128),
      motion.frame + at,
      motion,
      voices,
      reading,
    );
  return {
    samples: Array.from(out, (value) => Math.round(value * 32768)),
    reading,
  };
}

test("1x forward reads consecutive samples and 1x reverse reads the same block backwards", () => {
  const forward = render({ frame: 0, position: 1000, velocity: 1 }, 128);
  expect(forward.samples).toEqual(
    Array.from({ length: 128 }, (_, i) => 1000 + i),
  );
  const reverse = render({ frame: 0, position: 1127, velocity: -1 }, 128);
  expect(reverse.samples).toEqual(forward.samples.toReversed());
  expect(reverse.reading.source).toBe(1000);
});

test("a clip's gain scales what it reads, and a chunk not yet held plays silence", () => {
  const motion = { frame: 0, position: 2000, velocity: 1 };
  const half = render(motion, 128, [
    { segment: segment(0.5), chunks: indexed },
  ]);
  expect(half.samples).toEqual(
    Array.from({ length: 128 }, (_, i) => Math.round((2000 + i) / 2)),
  );
  const missing = render(motion, 128, [
    { segment: segment(1, 3 * CHUNK_SAMPLES), chunks: indexed },
  ]);
  expect(missing.samples.every((value) => value === 0)).toBe(true);
});

test("2x and faster keep the source's pitch while moving at speed, in either direction", () => {
  // A 1 kHz tone: tape at 2x would double it; grains keep it.
  const tone = new Map([
    [
      0,
      Int16Array.from({ length: CHUNK_SAMPLES }, (_, k) =>
        Math.round(16_000 * Math.sin((2 * Math.PI * 1000 * k) / 48_000)),
      ),
    ],
  ]);
  const voices = [{ segment: segment(), chunks: tone }];
  const crossings = (samples: number[]) =>
    samples
      .slice(1)
      .filter(
        (value, i) =>
          Math.sign(value) !== Math.sign(samples[i]!) && value !== 0,
      ).length;
  for (const [velocity, start] of [
    [2, 24_000],
    [-2, 200_000],
    [8, 0],
  ] as const) {
    const { samples, reading } = render(
      { frame: 0, position: start, velocity },
      24_000,
      voices,
    );
    // Half a second of a 1 kHz tone crosses zero about a thousand times.
    expect(crossings(samples)).toBeGreaterThan(900);
    expect(crossings(samples)).toBeLessThan(1100);
    // Each grain starts where the motion has reached: half a second at speed covers that much more.
    expect(
      Math.abs(reading.source! - (start + 24_000 * velocity)),
    ).toBeLessThan(GRAIN * Math.abs(velocity));
  }
  const tape = render(
    { frame: 0, position: 24_000, velocity: 1 },
    24_000,
    voices,
  );
  expect(crossings(tape.samples)).toBeGreaterThan(900);
});

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
  const chunks = (...indices: number[]) =>
    indices.map((index) => ({ source, index }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  cache.want(chunks(0, 1, 2));
  await settle();
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
