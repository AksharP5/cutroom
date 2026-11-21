import { expect, test } from "bun:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { exportClipWindow } from "@hyperframes/core";
import {
  add,
  attrMicros,
  decode,
  decodeLocal,
  encode,
  firstFrame,
  fraction,
  frames,
  micros,
  pictureAt,
  place,
  resolvePiece,
  sampleOf,
  sourceAt,
  sourceSampleOffset,
  subtract,
  type Composition,
  type Curve,
  type ExactTime,
  type PlacedMedia,
} from "../src/shared/timeline/piece.ts";
import type { Fps } from "../src/shared/timeline/schema.ts";

const full = process.env.PIECE_FULL === "1";
const fps = (num: number, den = 1): Fps => ({ num, den });
const ntsc = fps(30_000, 1001);
const film = fps(24_000, 1001);
const thirty = fps(30);
const twentyFive = fps(25);
const ramp = {
  target: "rate",
  points: [
    { t: 0, v: 0.5 },
    { t: 4, v: 2 },
  ],
};
const rates = [
  film,
  ntsc,
  fps(60_000, 1001),
  fps(120_000, 1001),
  fps(24),
  twentyFive,
  thirty,
  fps(48),
  fps(50),
  fps(60),
  fps(120),
  fps(128),
  fps(240),
  fps(15, 2),
  fps(1000, 7),
  fps(12345, 678),
  fps(7, 3),
  fps(199, 13),
];

const media = {
  id: "clip",
  kind: "media",
  src: "source.mp4",
  start: { us: 0n },
  durationUs: 100_000_000n,
  stored: { mediaStart: 0 },
  curve: 1,
} satisfies Composition["elements"][number];

function placedMedia(root: Composition): PlacedMedia {
  const [only] = place(root);
  if (only?.kind !== "media") throw new Error("Expected a media piece.");
  return only;
}

test("audio boundaries round half up, including exact halves and negative offsets", () => {
  for (const [rate, samples] of [
    [ntsc, [1602n, 3203n, 4805n, 6406n, 8008n]],
    [fps(60_000, 1001), [801n, 1602n, 2402n, 3203n, 4004n]],
    [film, [2002n, 4004n, 6006n, 8008n, 10010n]],
    [fps(256), [188n, 375n, 563n]],
  ] as const) {
    expect(
      samples.map((_, index) => sampleOf(frames(index + 1, rate))),
    ).toEqual([...samples]);
  }
  expect(sampleOf(frames(-1, fps(256)))).toBe(-187n);
  expect(sampleOf(micros(10427))).toBe(500n);
  expect(sampleOf(micros(10448))).toBe(502n);
});

test("authored times snap on their own grid and keep off-grid starts", () => {
  expect(attrMicros("3.3666670000000003")).toBe(3366667n);
  expect(decodeLocal(attrMicros("0.99998"), thirty)).toEqual({ n: 1n, d: 1n });
  expect(decodeLocal(attrMicros("0.041718"), film)).toEqual({
    n: 1001n,
    d: 24000n,
  });
  const offGrid = decodeLocal(attrMicros("1.0123"), thirty);
  expect(offGrid).toEqual({ n: 10123n, d: 10000n });
  expect(firstFrame(offGrid, thirty)).toBe(31n);
  expect(sampleOf(offGrid)).toBe(48590n);

  // Output snapping has no 1 µs minimum and does not alter the audio edge.
  expect(decodeLocal(501n, fps(2000))).toEqual({ n: 1n, d: 2000n });
  expect(firstFrame(micros(501), fps(2000))).toBe(2n);
  expect(decodeLocal(40040n, twentyFive)).toEqual({ n: 1n, d: 25n });
  expect(firstFrame(micros(40040), twentyFive)).toBe(1n);
  expect(firstFrame(micros(40041), twentyFive)).toBe(2n);
});

test("six-decimal frame spellings and separate lengths read back on the same grid", () => {
  for (const rate of rates.slice(0, 14)) {
    const written = (frame: number) =>
      attrMicros(((frame * rate.den) / rate.num).toFixed(6));
    const length = decodeLocal(written(37), rate);
    const fade = decodeLocal(written(12), rate);
    const halfway = written(0.5);
    strictEqual(
      decodeLocal(halfway, rate).n * 1_000_000n,
      halfway * decodeLocal(halfway, rate).d,
    );
    for (let frame = 0; frame <= 200_000; frame += frame < 5_000 ? 1 : 997) {
      const start = decodeLocal(written(frame), rate);
      const end = add(start, length);
      const split = add(start, fade);
      strictEqual(
        start.n * BigInt(rate.num),
        BigInt(frame * rate.den) * start.d,
      );
      strictEqual(
        end.n * BigInt(rate.num),
        BigInt((frame + 37) * rate.den) * end.d,
      );

      // These rates and frame counts are small enough to round their integer sample ratios directly.
      const expectedSample = (n: number) =>
        BigInt(Math.round((n * rate.den * 48_000) / rate.num));
      strictEqual(
        sampleOf(split) - sampleOf(start),
        expectedSample(frame + 12) - expectedSample(frame),
      );
      strictEqual(
        sampleOf(end) - sampleOf(split),
        expectedSample(frame + 37) - expectedSample(frame + 12),
      );
    }
  }
});

test("a 24 fps scene in a 25 fps root keeps the fractional microsecond across both sample ties", () => {
  for (const [hostStart, edge, sample, rounded, wrong] of [
    [10427n, { n: 156281n, d: 3000000n }, 2500n, 52094n, 2501n],
    [10448n, { n: 19543n, d: 375000n }, 2502n, 52114n, 2501n],
  ] as const) {
    const placed = placedMedia({
      fps: twentyFive,
      elements: [
        {
          id: "scene",
          kind: "host",
          start: { us: hostStart },
          child: {
            fps: fps(24),
            elements: [{ ...media, start: { us: 41667n } }],
          },
        },
      ],
    });
    const piece = resolvePiece(placed, twentyFive);
    expect(piece.local.start).toEqual({ n: 1n, d: 24n });
    expect(piece.edge.start).toEqual(edge);
    expect(piece.samples.start).toBe(sample);
    expect(piece.frames.start).toBe(2n);
    expect(sampleOf(micros(rounded))).toBe(wrong);
  }

  const placed = placedMedia({
    fps: ntsc,
    elements: [
      {
        id: "scene",
        kind: "host",
        start: { us: 0n },
        child: { fps: thirty, elements: [{ ...media, start: { us: 33333n } }] },
      },
    ],
  });
  const piece = resolvePiece(placed, ntsc);
  expect(piece.frames.start).toBe(1n);
  expect(piece.samples.start).toBe(1600n);
  expect(sampleOf(frames(1, ntsc))).toBe(1602n);
});

test("regridding a 1× piece keeps its exact source line and sample offset", () => {
  const offGrid = {
    ...media,
    start: { us: 1012300n },
    stored: { mediaStart: 16685 },
  };
  const original = resolvePiece(
    placedMedia({ fps: thirty, elements: [offGrid] }),
    thirty,
  );
  const map = { c: 30, tau: 0, zero: 4385 };
  expect(decode(offGrid.stored, 1, original.local.start, thirty)).toEqual(map);
  const stored = encode(map, 1, frames(31, thirty), thirty);
  expect(stored).toEqual({ mediaStart: 37718 });
  const regridded = resolvePiece(
    placedMedia({
      fps: thirty,
      elements: [{ ...offGrid, start: { us: 1033333n }, stored }],
    }),
    thirty,
  );
  expect(decode(stored, 1, regridded.local.start, thirty)).toEqual(map);
  expect(sourceSampleOffset(original)).toBe(-47790n);
  expect(sourceSampleOffset(regridded)).toBe(-47790n);
  expect(49600n + (sourceSampleOffset(regridded) ?? 0n)).toBe(1810n);
});

test("a fractional-sample in-point keeps the same 1× offset across a through-edit", () => {
  const map = decode({ mediaStart: 10 }, 1, frames(0, ntsc), ntsc);
  const samples = [1602n, 3203n, 4805n, 6406n, 8008n];
  for (const [index, sample] of samples.entries()) {
    const frame = index + 1;
    const stored = encode(map, 1, frames(frame, ntsc), ntsc);
    const us = attrMicros(((frame * 1001) / 30000).toFixed(6));
    const clip = placedMedia({
      fps: ntsc,
      elements: [{ ...media, start: { us }, stored }],
    });
    const tail = resolvePiece(clip, ntsc);
    expect(tail.samples.start).toBe(sample);
    expect(sourceSampleOffset(tail)).toBe(0n);
  }
});

test("unwritable in-points settle once, including a frame-and-a-half tie", () => {
  const offGrid = micros(48);
  const map = decode({ mediaStart: 17237 }, 1.03125, offGrid, thirty);
  expect(map).toEqual({ c: 0, tau: 0, zero: 17186 });
  expect(encode(map, 1.03125, offGrid, thirty)).toEqual({ mediaStart: 17236 });
  const stored = encode(map, 1.03125, frames(1, thirty), thirty);
  expect(stored).toEqual({ mediaStart: 51561 });
  for (const start of [frames(1, thirty), frames(7, thirty)])
    expect(
      decode(encode(map, 1.03125, start, thirty), 1.03125, start, thirty),
    ).toEqual(map);

  const initial = frames(0, thirty);
  const halfFrame = decode({ mediaStart: 50000 }, 1, initial, thirty);
  expect(halfFrame).toEqual({ c: -2, tau: 0, zero: -16666 });
  expect(encode(halfFrame, 1, initial, thirty)).toEqual({ mediaStart: 50001 });
  for (let frame = 1; frame <= 5; frame++) {
    const start = frames(frame, thirty);
    expect(
      decode(encode(halfFrame, 1, start, thirty), 1, start, thirty),
    ).toEqual(halfFrame);
  }
  expect(() => decode(media.stored, 0.1, initial, fps(40_000))).toThrow(
    RangeError,
  );
});

test("a ramp trimmed at an offset half-microsecond keeps its integral and pictures", () => {
  const rate = fps(128);
  const start = frames(1, rate);
  const map = { c: 0, tau: 0, zero: 0 };
  const stored = encode(map, ramp, start, rate);
  expect(stored).toEqual({ offset: 7813, mediaStart: 3963 });
  expect(decode(stored, ramp, start, rate)).toEqual(map);

  // A resolved reference can land a fraction of a microsecond before a frame.
  const beforeFrame = micros(33333);
  const referenceMap = { c: 1, tau: 0, zero: 0 };
  deepStrictEqual(encode(referenceMap, ramp, beforeFrame, thirty), {
    offset: 0,
    mediaStart: 0,
  });
  deepStrictEqual(
    decode({ mediaStart: 0 }, ramp, beforeFrame, thirty),
    referenceMap,
  );

  const grid = { origin: micros(0), rate: thirty, count: 200n };
  for (const clip of [
    { ...media, curve: ramp },
    { ...media, curve: ramp, stored, start: { us: 7813n } },
  ]) {
    const piece = resolvePiece(
      placedMedia({ fps: rate, elements: [clip] }),
      rate,
    );
    expect(sourceAt(piece, fraction(4n))).toBeCloseTo(4.328385963615077, 12);
    expect(pictureAt(grid, sourceAt(piece, fraction(2n)))).toBe(43n);
    expect(pictureAt(grid, sourceAt(piece, fraction(4n)))).toBe(129n);
  }

  const near = {
    ...media,
    curve: { target: "rate", points: [{ t: 0, v: 1 }] },
    start: { us: 41718n },
  };
  const piece = resolvePiece(
    placedMedia({ fps: film, elements: [near] }),
    film,
  );
  const sameRate = { ...grid, rate: film };
  expect(pictureAt(sameRate, sourceAt(piece, frames(1, film)))).toBe(0n);
  expect(pictureAt(sameRate, sourceAt(piece, frames(2, film)))).toBe(1n);
});

test("picture lookup handles differing rates, native PTS, hidden heads and held tails", () => {
  const piece = resolvePiece(
    placedMedia({ fps: ntsc, elements: [media] }),
    ntsc,
  );
  for (const [sourceRate, expected] of [
    [twentyFive, [0, 0, 1, 2, 3, 4, 5, 5, 6, 7]],
    [film, [0, 0, 1, 2, 3, 4, 4, 5, 6, 7, 8]],
    [fps(60_000, 1001), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]],
  ] as const) {
    const grid = { origin: micros(0), rate: sourceRate, count: 200n };
    expect(
      expected.map((_, n) => pictureAt(grid, sourceAt(piece, frames(n, ntsc)))),
    ).toEqual(expected.map(BigInt));
  }
  const vfr = {
    times: [0, 40, 50, 100, 120, 200].map((ms) => micros(ms * 1000)),
  };
  expect(
    Array.from({ length: 7 }, (_, n) => pictureAt(vfr, frames(n, thirty))),
  ).toEqual([0n, 0n, 2n, 3n, 4n, 4n, 5n]);
  expect(pictureAt(vfr, micros(39989))).toBe(0n);
  expect(pictureAt(vfr, micros(39990))).toBe(1n);
  const native = {
    times: [
      { n: 1n, d: 1n },
      { n: 1001n, d: 1000n },
    ],
  };
  expect(pictureAt(native, micros(1))).toBeNull();
  expect(pictureAt(native, micros(2))).toBe(0n);
  expect(pictureAt(native, micros(2000000))).toBe(1n);
  expect(pictureAt({ times: [] }, micros(0))).toBeNull();

  const decimal = resolvePiece(
    placedMedia({
      fps: thirty,
      elements: [{ ...media, curve: "1.0000000000000001" }],
    }),
    thirty,
  );
  expect(sourceAt(decimal, fraction(1n))).toEqual({
    n: 10000000000000001n,
    d: 10000000000000000n,
  });
  expect(sourceSampleOffset(decimal)).toBeNull();
});

test.each([
  [60, 45],
  [61, 46],
])("wraps %i native pictures over 2,000 output frames", (count, cycle) => {
  const grid = { origin: micros(0), rate: ntsc, count: BigInt(count) };
  const placed = placedMedia({
    fps: ntsc,
    elements: [{ ...media, loop: true, stored: { mediaStart: 500500 } }],
  });
  const native = resolvePiece(placed, ntsc, {
    n: BigInt(1001 * count),
    d: 30000n,
  });
  const pictures = Array.from({ length: 2000 }, (_, n) =>
    pictureAt(grid, sourceAt(native, frames(n, ntsc))),
  );
  expect(pictures).toEqual(
    Array.from({ length: 2000 }, (_, n) => BigInt(15 + (n % cycle))),
  );
  if (count === 61) {
    expect(pictures.slice(45, 48)).toEqual([60n, 15n, 16n]);
    expect(pictures.slice(91, 94)).toEqual([60n, 15n, 16n]);
    const justBeforeWrap = subtract(frames(46, ntsc), micros(5));
    expect(pictureAt(grid, sourceAt(native, justBeforeWrap))).toBe(60n);
    const rounded = resolvePiece(placed, ntsc, micros(2035367));
    expect(pictureAt(grid, sourceAt(rounded, frames(46, ntsc)))).toBe(60n);
  }
  const unknown = resolvePiece(placed, ntsc);
  expect(unknown.loop?.length).toBeNull();
  expect(pictureAt(grid, sourceAt(unknown, frames(cycle + 1, ntsc)))).toBe(
    BigInt(count - 1),
  );
});

test("trimmed mounts advance ordinary clips and restart loops at the original in-point", () => {
  for (const loop of [false, true]) {
    const placed = placedMedia({
      fps: thirty,
      elements: [
        {
          id: "scene",
          kind: "host",
          start: { us: 3000000n },
          durationUs: 4000000n,
          mediaStartUs: 2000000n,
          child: {
            fps: thirty,
            elements: [{ ...media, loop, stored: { mediaStart: 500000 } }],
          },
        },
      ],
    });
    const piece = resolvePiece(placed, thirty, fraction(3n));
    expect(piece.edge).toEqual({
      start: { n: 1n, d: 1n },
      end: { n: 7n, d: 1n },
    });
    expect(piece.played.start).toEqual({ n: 3n, d: 1n });
    expect(piece.frames).toEqual({ start: 90n, end: 210n });
    expect(piece.samples).toEqual({ start: 144000n, end: 336000n });
    expect(sourceAt(piece, fraction(3n))).toEqual(
      loop ? { n: 1n, d: 2n } : { n: 5n, d: 2n },
    );
    if (loop)
      expect(sourceAt(piece, fraction(11n, 2n))).toEqual({ n: 1n, d: 2n });
  }
});

function generator(seed: number) {
  return (limit: number) => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let bits = Math.imul(seed ^ (seed >>> 15), seed | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return Math.floor((((bits ^ (bits >>> 14)) >>> 0) / 2 ** 32) * limit);
  };
}

// The generated speeds use ordinary decimal spellings, including those whose
// exact product lies a fraction below an integer.
function periodFloor(speed: number, rate: Fps) {
  const [whole, decimals = ""] = String(speed).split(".");
  const units = BigInt(whole + decimals);
  const scale = 10n ** BigInt(decimals.length);
  return Number(
    (units * 1_000_000n * BigInt(rate.den)) / (scale * BigInt(rate.num)),
  );
}

test("the source map uses the exact decimal period at its remainder boundary", () => {
  const map = { c: 590830, tau: 0, zero: 173650 };
  const speed = "8.68255";
  const start = frames(map.c + 1, twentyFive);
  expect(
    decode(encode(map, speed, start, twentyFive), speed, start, twentyFive),
  ).toEqual(map);
  expect(
    decode(
      { mediaStart: 173650 },
      "8.682549999999999",
      frames(map.c, twentyFive),
      twentyFive,
    ),
  ).toEqual({ ...map, zero: 173649 });
});

test("encode and decode require a source period of at least three microseconds", () => {
  const start = frames(0, thirty);
  const map = { c: 0, tau: 0, zero: 0 };
  const speed = "0.00008999999999999999";
  expect(() => encode(map, speed, start, thirty)).toThrow(
    "at least three microseconds",
  );
  expect(() => decode({ mediaStart: 0 }, speed, start, thirty)).toThrow(
    "at least three microseconds",
  );
  expect(
    decode(encode(map, "0.00009", start, thirty), "0.00009", start, thirty),
  ).toEqual(map);
});

test(
  "seeded maps survive re-encodes, moves, foreign values and slips across 18 frame rates",
  () => {
    const next = generator(20261120);
    const fixed = [
      1,
      1.03125,
      0.1,
      0.25,
      0.5,
      0.75,
      1.5,
      2,
      3.3333333,
      4,
      10,
      Math.SQRT2,
      Math.PI / 3,
      0.999,
      1.001,
    ];
    for (const rate of rates) {
      for (let index = 0; index < (full ? 166_667 : 360); index++) {
        const speed =
          index % 3 === 0
            ? 0.1 + next(990000) / 100000
            : fixed[next(fixed.length)];
        const curve =
          index % 2 === 0
            ? speed
            : {
                target: "rate",
                points: Array.from({ length: 2 + next(5) }, (_, point) => ({
                  t: point * 4,
                  v: 0.1 + next(990) / 100,
                  curve: (next(201) - 100) / 100,
                })),
              };
        const width =
          periodFloor(typeof curve === "number" ? curve : 1, rate) - 1;
        const first = -Math.floor(width / 2);
        const remainder =
          index % 5 === 0
            ? first + (next(2) ? next(3) : width - 1 - next(3))
            : first + next(width);
        const map = {
          c: next(1_300_001) - 1000,
          tau: typeof curve === "number" ? 0 : remainder,
          zero: typeof curve === "number" ? remainder : next(3_600_000_000),
        };
        const anchor = frames(next(1_300_001), rate);
        const offGrid = micros(next(10_800_000_001));
        const other = add(
          add(frames(next(100_000), rates[next(rates.length)]), anchor),
          offGrid,
        );
        const starts = [anchor, offGrid, other];
        if (full) {
          starts.push(
            frames(next(1_300_001), rate),
            micros(next(10_800_000_001)),
            frames(next(1_300_001), rate),
          );
          if (index % 2 === 0)
            starts.push(add(other, micros(next(10_800_000_001))));
        }
        for (const [startIndex, start] of starts.entries()) {
          const stored = encode(map, curve, start, rate);
          deepStrictEqual(decode(stored, curve, start, rate), map);
          if (full && startIndex >= (index % 2 === 0 ? 1 : 2)) continue;
          const by = next(10001) - 5000;
          deepStrictEqual(
            encode(
              { ...map, c: map.c + by },
              curve,
              add(start, frames(by, rate)),
              rate,
            ),
            stored,
          );
        }

        const foreign = {
          mediaStart: next(3_600_000_001),
          ...(typeof curve === "number"
            ? {}
            : { offset: next(620_000_001) - 20_000_000 }),
        };
        const settled = decode(foreign, curve, other, rate);
        const stored = encode(settled, curve, other, rate);
        deepStrictEqual(decode(stored, curve, other, rate), settled);
        deepStrictEqual(
          decode(encode(settled, curve, anchor, rate), curve, anchor, rate),
          settled,
        );
        strictEqual(
          Math.abs((stored.offset ?? 0) - (foreign.offset ?? 0)) <= 1,
          true,
        );
        strictEqual(
          Math.abs(stored.mediaStart - foreign.mediaStart) <= 1,
          true,
        );

        if (typeof curve === "number") {
          const before = encode(map, curve, offGrid, rate).mediaStart;
          const slip = next(60_000_001) - 30_000_000;
          const after = decode(
            { mediaStart: before + slip },
            curve,
            offGrid,
            rate,
          );
          strictEqual(
            Math.abs(
              encode(after, curve, offGrid, rate).mediaStart - (before + slip),
            ) <= 1,
            true,
          );
          const lineDelta =
            after.zero -
            map.zero +
            (curve * (map.c - after.c) * rate.den * 1e6) / rate.num;
          strictEqual(Math.abs(lineDelta - slip) <= 2, true);
          deepStrictEqual(
            decode(encode(after, curve, anchor, rate), curve, anchor, rate),
            after,
          );
        }
      }
    }
  },
  full ? 600_000 : 5_000,
);

test(
  "exhaustively re-encodes three frame periods of stored values for selected rate and curve pairs",
  () => {
    const curves: Curve[] = [1, 1.03125, 0.1, 2, 3.3333333, ramp];
    const reduced: [Fps, Curve][] = [
      [ntsc, 1],
      [thirty, 1.03125],
      [film, 0.1],
      [fps(48), 2],
      [fps(120), 3.3333333],
      [fps(128), ramp],
      [fps(240), ramp],
      [fps(60_000, 1001), 1],
    ];
    const pairs = full
      ? rates
          .slice(0, 13)
          .flatMap((rate) => curves.map((curve): [Fps, Curve] => [rate, curve]))
      : reduced;
    for (const [rate, curve] of pairs) {
      const period = (rate.den * 1_000_000) / rate.num;
      const span = Math.ceil(
        3 * period * (typeof curve === "number" ? curve : 1),
      );
      const targets = [
        ...[0, 1, 2, 3, 31, 100_003].map((frame) => frames(frame, rate)),
        ...[1, 48, 12_301, 7_200_000_123].map(micros),
        fraction(BigInt(rate.den), 2n * BigInt(rate.num)),
      ];
      // Every in-point or offset is exercised at each pair's frame and off-grid start.
      for (const start of [
        ...[0, 1, 7].map((frame) => frames(frame, rate)),
        ...[48, 12_300, 1_012_300].map(micros),
      ]) {
        for (let value = 0; value < span; value++) {
          const stored =
            typeof curve === "number"
              ? { mediaStart: value }
              : { mediaStart: 725000, offset: value };
          const map = decode(stored, curve, start, rate);
          for (const target of targets) {
            const roundTrip = decode(
              encode(map, curve, target, rate),
              curve,
              target,
              rate,
            );
            if (
              roundTrip.c !== map.c ||
              roundTrip.tau !== map.tau ||
              roundTrip.zero !== map.zero
            )
              deepStrictEqual(
                roundTrip,
                map,
                `rate ${rate.num}/${rate.den}, value ${value}`,
              );
          }
        }
      }
    }
  },
  full ? 1_800_000 : 180_000,
);

test("300 successive head trims preserve the source line at 30 and 29.97 fps", () => {
  for (const rate of [thirty, ntsc]) {
    const initial = { mediaStart: 500500 };
    const whole = decode(initial, 1, frames(0, rate), rate);
    let stored = initial;
    for (let n = 1; n <= 300; n++) {
      const line = decode(stored, 1, frames(n - 1, rate), rate);
      stored = encode(line, 1, frames(n, rate), rate);
    }
    expect(stored).toEqual(encode(whole, 1, frames(300, rate), rate));
  }
});

// All generated scene clocks divide this tick rate. The oracle adds integer
// ticks and computes samples and frames without using the resolver's fractions.
const CLOCK = 3_000_000n;
const SPEED_SCALE = 10_000_000n;
const sceneRates = [
  fps(24),
  twentyFive,
  thirty,
  film,
  ntsc,
  fps(50),
  fps(60_000, 1001),
  fps(60),
];
const speeds: ReadonlyMap<number, bigint> = new Map([
  [1, 10000000n],
  [0.5, 5000000n],
  [2, 20000000n],
  [1.03125, 10312500n],
  [1.5, 15000000n],
  [0.25, 2500000n],
  [3.3333333, 33333333n],
  [0.1, 1000000n],
  [10, 100000000n],
]);

const ticksPerFrame = (rate: Fps) =>
  (CLOCK * BigInt(rate.den)) / BigInt(rate.num);
const tickMax = (a: bigint, b: bigint) => (a > b ? a : b);
const tickMin = (a: bigint, b: bigint) => (a < b ? a : b);
const tickAbs = (a: bigint) => (a < 0n ? -a : a);
const lower = (n: bigint, d: bigint) => (n - (((n % d) + d) % d)) / d;
const nearest = (n: bigint, d: bigint) => lower(n + d / 2n, d);

function authoredTicks(us: bigint, frameTicks: bigint) {
  const at = us * 3n;
  const grid = nearest(at, frameTicks) * frameTicks;
  const slack = tickAbs(at - grid);
  return slack <= 3n || 1000n * slack <= frameTicks ? grid : at;
}

function oracleWindows(
  comp: Composition,
  ancestors: readonly {
    origin: bigint;
    end: bigint | null;
    trim: bigint | null;
  }[] = [],
  prefix = "",
) {
  const local = new Map<string, { start: bigint; end: bigint | null }>();
  const frameTicks = ticksPerFrame(comp.fps);
  const rows: {
    path: string;
    start: bigint;
    end: bigint;
    inPoint: bigint;
    actualEnd: bigint;
    shownStart: bigint;
    origin: bigint;
    fps: Fps;
    element: Composition["elements"][number];
  }[] = [];

  for (const element of comp.elements) {
    const { start, durationUs, endUs, naturalSeconds } = element;
    const ref = "ref" in start ? local.get(start.ref) : undefined;
    const offset = "us" in start ? start.us : start.offsetUs;
    const head = tickMax(
      0n,
      (ref?.end ?? ref?.start ?? 0n) + authoredTicks(offset, frameTicks),
    );
    const tail =
      durationUs !== undefined
        ? head + authoredTicks(durationUs, frameTicks)
        : endUs !== undefined
          ? authoredTicks(endUs, frameTicks)
          : naturalSeconds === undefined
            ? null
            : head +
              authoredTicks(
                BigInt(Math.round(naturalSeconds * 1e6)),
                frameTicks,
              );
    const end = tail !== null && tail > head ? tail : null;
    local.set(element.id, { start: head, end });
    const path = prefix + "/" + element.id;
    const parent = ancestors.at(-1)?.origin ?? 0n;
    if (element.kind === "host") {
      const hostOrigin = parent + head;
      const trim = authoredTicks(element.mediaStartUs ?? 0n, frameTicks);
      rows.push(
        ...oracleWindows(
          element.child,
          [
            ...ancestors,
            {
              origin: hostOrigin - trim,
              end: end === null ? null : parent + end,
              trim: trim > 0n ? hostOrigin : null,
            },
          ],
          path,
        ),
      );
      continue;
    }
    if (end === null) continue;
    const origin = element.kind === "media" && element.global ? 0n : parent;
    const startAt = origin + head;
    const played = ancestors.reduce(
      (range, host) => ({
        first:
          host.trim === null ? range.first : tickMax(range.first, host.trim),
        last: host.end === null ? range.last : tickMin(range.last, host.end),
      }),
      { first: startAt, last: origin + end },
    );
    if (played.first >= played.last) continue;
    rows.push({
      path,
      start: head,
      end,
      inPoint: startAt,
      actualEnd: played.last,
      shownStart: played.first,
      origin,
      fps: comp.fps,
      element,
    });
  }
  return rows;
}

test(
  "generated scene trees match an independent integer clock for placement, audio and pictures",
  () => {
    const next = generator(332);
    const maxDepth = new Set<number>();
    const speedsList = [...speeds.keys()];

    function document(depth: number): Composition {
      const rate = sceneRates[next(sceneRates.length)];
      const grid = (frame: number) =>
        Math.round((frame * rate.den * 1e6) / rate.num);
      const time = (frame: number) => {
        const roll = next(100);
        if (roll < 55) return grid(frame);
        if (roll < 80) return grid(frame) + next(101) - 50;
        return next(2600000);
      };
      return {
        fps: rate,
        elements: Array.from({ length: 2 + next(4) }, (_, i) => {
          const length = grid(6 + next(75));
          const spelling = next(100);
          const timing = {
            id: String(i),
            start:
              i > 0 && next(5) === 0
                ? { ref: String(next(i)), offsetUs: BigInt(time(1) - grid(1)) }
                : { us: BigInt(time(next(26))) },
            ...(spelling < 70
              ? { durationUs: BigInt(length) }
              : spelling < 85
                ? { endUs: BigInt(time(98)) }
                : spelling < 95
                  ? { durationUs: BigInt(length), endUs: 10000000n }
                  : { naturalSeconds: length / 1e6 }),
          };
          if (depth < 3 && next(4) === 0)
            return {
              ...timing,
              kind: "host",
              mediaStartUs: BigInt(next(3) ? 0 : grid(1 + next(12))),
              child: document(depth + 1),
            };
          if (next(4) === 0)
            return { ...timing, kind: next(2) ? "image" : "text" };
          return {
            ...media,
            ...timing,
            global: next(10) === 0,
            curve: speedsList[next(speedsList.length)],
            stored: { mediaStart: next(6000000) },
          };
        }),
      };
    }

    let ties = 0;
    let count = 0;
    let roundedDiffers = 0;
    let flooredDiffers = 0;
    const indexOrigin = 63999n;
    const sourceGrid = {
      origin: { n: 21333n, d: 1_000_000n },
      rate: ntsc,
      count: 240n,
    };
    for (let i = 0; i < (full ? 400_000 : 4_000); i++) {
      // A separate tie and a mixed-rate scene occur even if the random fixture changes.
      const root =
        i === 0
          ? {
              fps: twentyFive,
              elements: [
                {
                  id: "scene",
                  kind: "host" as const,
                  start: { us: 20040n },
                  child: {
                    fps: fps(50),
                    elements: [{ ...media, start: { us: 20000n } }],
                  },
                },
                {
                  id: "off-grid",
                  kind: "host" as const,
                  start: { us: 10427n },
                  child: {
                    fps: fps(24),
                    elements: [{ ...media, start: { us: 41667n } }],
                  },
                },
              ],
            }
          : document(0);
      const expected = oracleWindows(root);
      const actual = place(root);
      deepStrictEqual(
        actual.map(({ path }) => path),
        expected.map(({ path }) => path),
      );
      const frameTicks = ticksPerFrame(root.fps);
      function checkEdge(exact: ExactTime, tick: bigint) {
        strictEqual(exact.n * CLOCK, tick * exact.d);
        const sample = nearest(tick * 48_000n, CLOCK);
        strictEqual(sampleOf(exact), sample);
        const grid = nearest(tick, frameTicks) * frameTicks;
        const distance = tickAbs(tick - grid) * 1000n;
        if (distance === frameTicks) ties++;
        const snaps = distance <= frameTicks;
        const output =
          (snaps
            ? grid
            : lower(tick + frameTicks - 1n, frameTicks) * frameTicks) /
          frameTicks;
        strictEqual(firstFrame(exact, root.fps), output);
        if (tick >= 0n) {
          const rate = root.fps.num / root.fps.den;
          const time = Number(snaps ? grid : tick) / Number(CLOCK);
          const handed = exportClipWindow(time, time, rate).start * rate;
          const close = Math.round(handed);
          const hf =
            Math.abs(handed - close) < 1e-9 ? close : Math.ceil(handed);
          strictEqual(BigInt(hf), output);
        }
        if (nearest(nearest(tick, 3n) * 48_000n, 1_000_000n) !== sample)
          roundedDiffers++;
        if (nearest(lower(tick, 3n) * 48_000n, 1_000_000n) !== sample)
          flooredDiffers++;
        return { sample, output };
      }
      for (const [j, row] of expected.entries()) {
        const placed = actual[j];
        maxDepth.add(row.path.split("/").length - 2);
        strictEqual(placed.origin.n * CLOCK, row.origin * placed.origin.d);
        checkEdge(placed.local.start, row.start);
        checkEdge(placed.local.end, row.end);
        checkEdge(placed.edge.start, row.inPoint);
        checkEdge(placed.edge.end, row.actualEnd);
        const head = checkEdge(placed.played.start, row.shownStart);
        const end = checkEdge(placed.played.end, row.actualEnd);
        if (placed.kind !== "media" || row.element.kind !== "media") continue;
        count++;
        const speed =
          typeof row.element.curve === "number"
            ? speeds.get(row.element.curve)
            : undefined;
        if (!speed) throw new Error("Expected a known decimal speed.");
        const piece = resolvePiece(placed, root.fps);
        deepStrictEqual(piece.samples, { start: head.sample, end: end.sample });
        deepStrictEqual(piece.frames, { start: head.output, end: end.output });
        const nativeFrame = ticksPerFrame(row.fps);
        const shift = BigInt(row.element.stored.mediaStart);
        const divisor = 3n * SPEED_SCALE;
        const width = lower(speed * nativeFrame, divisor) - 1n;
        const lo = -(width / 2n);
        const hi = lo + width - 1n;
        const guess = nearest(
          speed * row.start - shift * divisor,
          speed * nativeFrame,
        );
        const candidates = [guess, guess - 1n, guess + 1n].map((c) => {
          const raw =
            shift - nearest(speed * (row.start - c * nativeFrame), divisor);
          const zero = tickMin(hi, tickMax(lo, raw));
          return { c, zero, error: tickAbs(raw - zero) };
        });
        candidates.sort((a, b) => Number(a.error - b.error));
        const [{ c, zero }] = candidates;
        deepStrictEqual(
          { c: piece.c, tau: piece.tau, zero: piece.zero },
          {
            c: Number(c),
            tau: 0,
            zero: Number(zero),
          },
          row.path,
        );
        const line = { c: Number(c), tau: 0, zero: Number(zero) };
        const tail = frames(
          lower(row.start, nativeFrame) + 1n + BigInt(next(200)),
          row.fps,
        );
        deepStrictEqual(
          decode(
            encode(piece, piece.curve, tail, row.fps),
            piece.curve,
            tail,
            row.fps,
          ),
          line,
        );
        const zeroAt = row.origin + c * nativeFrame;
        const source = (at: bigint) =>
          zero * 3n * SPEED_SCALE + speed * (at - zeroAt);
        if (speed === SPEED_SCALE)
          strictEqual(
            sourceSampleOffset(piece),
            nearest(source(0n) * 48_000n, CLOCK * SPEED_SCALE),
          );
        for (const by of [0n, 1n, 2n, 7n]) {
          const frame = head.output + by;
          const at = source(frame * frameTicks);
          const ordinal = lower(
            at + (30n - indexOrigin) * SPEED_SCALE,
            100100n * SPEED_SCALE,
          );
          const picture =
            at <= (indexOrigin - 2999997n) * SPEED_SCALE
              ? null
              : tickMin(239n, tickMax(0n, ordinal));
          strictEqual(
            pictureAt(sourceGrid, sourceAt(piece, frames(frame, root.fps))),
            picture,
          );
        }
      }
    }
    expect(count).toBeGreaterThan(8000);
    expect(maxDepth).toEqual(new Set([0, 1, 2, 3]));
    expect(ties).toBeGreaterThan(0);
    expect(roundedDiffers).toBeGreaterThan(0);
    expect(flooredDiffers).toBeGreaterThan(0);
  },
  full ? 600_000 : 30_000,
);
