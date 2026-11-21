import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const readSample = (sourceIndex: number) => 6000 + (sourceIndex % 8191);
const ntsc = [30_000, 1001] as const;
const seconds = (frame: number) => (frame * 1001) / 30_000;
const audio = (id: string, start: string, timing: string, inPoint: string) =>
  `<audio id="${id}" src="source.wav" data-start="${start}" ${timing} data-media-start="${inPoint}"></audio>`;

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const [code, error] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(error);
}

async function mixed(
  dir: string,
  name: string,
  fps: readonly [number, number],
  totalFrames: number,
  html: string,
  marks?: readonly [number, number],
) {
  await writeFile(
    join(dir, `${name}.html`),
    `<main data-composition-id="main" data-fps="${fps.join("/")}">${html}</main>`,
  );
  await command([
    "node",
    "--experimental-strip-types",
    join(import.meta.dir, "fixtures", "sample-grid-mix.ts"),
    dir,
    name,
    ...[...fps, totalFrames, ...(marks ?? [])].map(String),
  ]);
  const pcmPath = marks
    ? join(dir, name, "cutroom-range-audio.wav")
    : join(dir, name, "plan", "work", "audio-source.wav");
  const pcm = await readFile(pcmPath);
  const data = pcm.indexOf("data", 12);
  const count = pcm.readUInt32LE(data + 4) / 8;
  return Int16Array.from(
    { length: count },
    (_, i) =>
      // The 16-bit input is converted losslessly to the mixer's stereo float WAV.
      pcm.readFloatLE(data + 8 + i * 8) * 32768,
  );
}

function expectSource(
  pcm: Int16Array,
  from: number,
  end: number,
  offset: number,
) {
  const firstMismatch = pcm
    .subarray(from, end)
    .findIndex((value, i) => value !== readSample(from + i + offset));
  expect(
    firstMismatch < 0
      ? null
      : {
          output: from + firstMismatch,
          actual: pcm[from + firstMismatch],
          source: from + firstMismatch + offset,
        },
  ).toBeNull();
}

test.skipIf(!Bun.which("node") || !Bun.which("ffmpeg"))(
  "the 48 kHz mix reads consecutive source samples through adjacent cuts, authored placement and marks",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "sample-grid-mix-"));
    try {
      const raw = Buffer.alloc(192_000 * 4);
      for (let i = 0; i < 192_000; i++) {
        raw.writeInt16LE(readSample(i), i * 4);
        raw.writeInt16LE(readSample(i), i * 4 + 2);
      }
      await writeFile(join(dir, "source.raw"), raw);
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        join(dir, "source.raw"),
        join(dir, "source.wav"),
      ]);

      const scene =
        audio("head", "0.041667", 'data-duration="0.041667"', "0") +
        audio("tail", "head", 'data-duration="0.041667"', "0.041667");
      await writeFile(
        join(dir, "scene.html"),
        `<template><main data-composition-id="scene" data-fps="24">${scene}</main></template>`,
      );

      // S1/S1b: 29.97 owns 1601.6 samples per frame. A source line at
      // 5, 10 or 15 µs moves by 0.24, 0.48 or 0.72 samples as a whole.
      const edges = [0, 1, 2, 3, 4, 5, 75, 105];
      for (const [micros, offset] of [
        [0, 0],
        [5, 0],
        [10, 0],
        [15, 1],
      ] as const) {
        const at = (frame: number) =>
          (seconds(frame) + micros / 1e6).toFixed(6);
        const split = edges
          .slice(0, -1)
          .map((frame, i) =>
            audio(
              `part-${i}`,
              seconds(frame).toFixed(6),
              `data-duration="${seconds(edges[i + 1]! - frame).toFixed(6)}"`,
              at(frame),
            ),
          )
          .join("");
        const whole = audio("whole", "0", 'data-duration="3.503500"', at(0));
        const full = await mixed(dir, `split-${micros}`, ntsc, 105, split);
        expect(full.length).toBe(168_168);
        expectSource(full, 0, full.length, offset);
        const uncut = await mixed(dir, `whole-${micros}`, ntsc, 105, whole);
        expect(full).toEqual(uncut);
        if (micros === 10) {
          // S5: [59, 90) at 29.97 is [94494, 144144), with an adjacent cut at 120120.
          const marked = await mixed(dir, "marked", ntsc, 105, split, [59, 90]);
          expect(marked.subarray(94_494, 144_144)).toEqual(
            full.subarray(94_494, 144_144),
          );
        }
      }

      // S5 also covers an actual four-second shift before the cut at frame 180.
      const late =
        audio("head", "5.005", 'data-duration="1.001"', "0") +
        audio("tail", "6.006", 'data-duration="1.001"', "1.001");
      const lateWhole = await mixed(dir, "late-whole", ntsc, 210, late);
      const lateMarked = await mixed(
        dir,
        "late-marked",
        ntsc,
        210,
        late,
        [165, 190],
      );
      expect(lateMarked.length).toBe(336_336 - 192_000);
      expect(lateMarked).toEqual(lateWhole.subarray(192_000));

      // S1c: These are the authored fields before and after the frame-grid trim.
      const before = await mixed(
        dir,
        "off-grid",
        [30, 1],
        36,
        audio("clip", "1.012300", 'data-end="1.1"', "0.016685"),
      );
      const after = await mixed(
        dir,
        "trimmed",
        [30, 1],
        36,
        audio("clip", "1.033333", 'data-end="1.1"', "0.037718"),
      );
      expect(after[49_599]).toBe(0);
      expect(after[49_600]).toBe(readSample(1810));
      expectSource(before, 49_600, 52_800, -47_790);
      expect(after.subarray(49_600)).toEqual(before.subarray(49_600));

      // 24 fps inside 25 fps: rounding the first absolute edge to whole µs
      // would start the first mount a sample late and the second a sample early.
      for (const [start, first] of [
        ["0.010427", 2500],
        ["0.010448", 2502],
      ] as const) {
        const nested = await mixed(
          dir,
          `nested-${first}`,
          [25, 1],
          5,
          `<div data-composition-id="scene" data-composition-file="scene.html" data-start="${start}">${scene}</div>`,
        );
        expect(nested[first - 1]).toBe(0);
        expectSource(nested, first, first + 4000, -first);
        expect(nested[first + 4000]).toBe(0);
      }

      // S9: a video may hold its last picture after its sound ends.
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=s=64x48:r=30:d=2",
        "-i",
        join(dir, "source.wav"),
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-c:a",
        "pcm_s16le",
        join(dir, "held.mov"),
      ]);
      const held = await mixed(
        dir,
        "held",
        [30, 1],
        90,
        '<video id="held" src="held.mov" data-has-audio="true" data-start="0" data-duration="3"></video>',
      );
      expect(held.length).toBe(144_000);
      expectSource(held, 0, 96_000, 0);
      expect(held.subarray(96_000).every((sample) => sample === 0)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!Bun.which("node") || !Bun.which("ffmpeg"))(
  "S1 AAC audio-only through-cuts match the decoded source at zero sample lag",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "aac-cuts-"));
    try {
      const raw = Buffer.alloc(192_000 * 4);
      let seed = 1729;
      for (let i = 0; i < 192_000; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const sample = (seed >>> 20) - 2048;
        raw.writeInt16LE(sample, i * 4);
        raw.writeInt16LE(sample, i * 4 + 2);
      }
      await writeFile(join(dir, "source.raw"), raw);
      await writeFile(join(dir, "scene.html"), "");
      const m4a = join(dir, "source.m4a");
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        join(dir, "source.raw"),
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        m4a,
      ]);
      const decodedPath = join(dir, "decoded.raw");
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-i",
        m4a,
        "-f",
        "s16le",
        decodedPath,
      ]);
      const decoded = await readFile(decodedPath);
      const sourceOffset = 2626;
      const edges = [0, 1, 2, 3, 4, 5, 30, 45];
      const clip = (from: number, to: number) =>
        audio(
          "part-" + from,
          seconds(from).toFixed(6),
          `data-duration="${seconds(to - from).toFixed(6)}"`,
          (seconds(from) + sourceOffset / 48000).toFixed(6),
        ).replace("source.wav", "source.m4a");
      const split = await mixed(
        dir,
        "aac-split",
        ntsc,
        45,
        edges
          .slice(0, -1)
          .map((from, i) => clip(from, edges[i + 1]!))
          .join(""),
      );
      const whole = await mixed(dir, "aac-whole", ntsc, 45, clip(0, 45));
      for (const frame of edges.slice(0, -1)) {
        const at = Math.round(frame * 1601.6) + 160;
        for (const pcm of [whole, split]) {
          let best = -Infinity;
          let bestLag = 0;
          for (let lag = -2048; lag <= 2048; lag++) {
            let dot = 0;
            for (let i = at; i < at + 512; i++)
              dot +=
                pcm[i]! * decoded.readInt16LE((i + sourceOffset + lag) * 4);
            if (dot > best) {
              best = dot;
              bestLag = lag;
            }
          }
          expect(bestLag).toBe(0);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
