import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAudioElements,
  parseMasterFxChain,
  processCompositionAudio,
} from "@hyperframes/engine";
import { scrubPlan } from "../src/client/scrubAudio/plan";
import { gainAt, sourcePosition } from "../src/client/scrubAudio/segment";
import type { Segment } from "../src/client/scrubAudio/segment";
import { applyAll } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import { frames, sampleOf } from "../src/shared/timeline/piece";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type {
  CommandInput,
  Fps,
  Timeline,
} from "../src/shared/timeline/schema";
import {
  applyTrackMix,
  parseComposition,
  patchComposition,
  settingsOf,
} from "../src/server/timeline/composition";
import { planFormat } from "../src/server/timeline/format";
import { countingIds } from "./clip-ids";

const mediaLengths = new Map([
  ["talk.wav", 60],
  ["tone.wav", 60],
  ["quiet.wav", 60],
]);
const versions = { "talk.wav": "1", "tone.wav": "1", "quiet.wav": "1" };
const page = (fps: string, body: string) =>
  `<main id="main" data-composition-id="main" data-duration="40" data-fps="${fps}">${body}</main>`;

/** A source whose sample `k` is `k`, so every value read names the source sample it came from. */
const indexed = Int32Array.from({ length: 60 * 48_000 }, (_, k) => k);
const heard = (segment: Segment, n: number) =>
  indexed[Math.round(sourcePosition(segment, n))]!;

function edited(
  html: string,
  commands: CommandInput[],
  settings = emptyTimelineSettings(),
) {
  const parsed = parseComposition(html, settings, { mediaLengths });
  const origins = new Map<string, ClipOrigin>();
  const timeline = applyAll(
    parsed.timeline,
    commands.map((command) => CommandSchema.parse(command)),
    { newId: countingIds, onCreate: (id, origin) => origins.set(id, origin) },
  );
  const output = patchComposition(parsed, timeline, origins);
  // The plan reads the timeline as the editor holds it after reading the saved file back.
  const read = parseComposition(output, settingsOf(timeline), { mediaLengths });
  return {
    html: output,
    timeline: read.timeline,
    settings: settingsOf(timeline),
  };
}

const plan = (timeline: Timeline) =>
  scrubPlan(timeline, { composition: "index.html", versions });
const segment = (segments: Segment[], clipId: string) =>
  segments.find((entry) => entry.clipId === clipId)!;
const sampleAt = (frame: number, fps: Fps) =>
  Number(sampleOf(frames(frame, fps)));
/** Whichever segment covers output sample `n`. */
const covering = (segments: Segment[], n: number) =>
  segments.find(({ samples }) => samples.start <= n && n < samples.end)!;

const ntsc = { num: 30_000, den: 1001 };

test("a 29.97 through-edit plays consecutive source samples across the cut", () => {
  // 37.718 ms is a fractional source sample, where per-piece rounding would slip one.
  const { timeline } = edited(
    page(
      "30000/1001",
      `<audio id="talk" src="talk.wav" data-start="0" data-duration="10" data-media-start="0.037718" data-track-index="1"></audio>`,
    ),
    [{ type: "split", clipIds: ["talk"], at: 31 }],
  );
  const segments = plan(timeline);
  const [a, b] = [segment(segments, "talk"), segment(segments, "talk-2")];
  const cut = sampleAt(31, ntsc);
  expect(a.samples.end).toBe(cut);
  expect(b.samples.start).toBe(cut);
  expect([a.map.kind, b.map.kind]).toEqual(["line", "line"]);
  const read = Array.from({ length: 20 }, (_, i) =>
    heard(covering(segments, cut - 10 + i), cut - 10 + i),
  );
  expect(read).toEqual(read.map((_, i) => read[0]! + i));
  // 0.037718 s is source sample 1810.464; output sample 0 reads the nearest whole sample.
  expect(heard(a, 0)).toBe(1810);
});

test("a 2x clip reads every second source sample", () => {
  const { timeline } = edited(
    page(
      "30",
      `<audio id="talk" src="talk.wav" data-start="0" data-duration="4" data-media-start="1" data-track-index="1"></audio>`,
    ),
    [{ type: "setTiming", clipId: "talk", playbackRate: 2 }],
  );
  const talk = segment(plan(timeline), "talk");
  expect(talk.map).toEqual({ kind: "rate", start: 48_000, rate: 2 });
  expect(Array.from({ length: 5 }, (_, i) => heard(talk, 1000 + i))).toEqual([
    50_000, 50_002, 50_004, 50_006, 50_008,
  ]);
});

test("a loop at 2x restarts at its source In point", () => {
  const { timeline } = parseComposition(
    page(
      "30",
      '<audio id="talk" src="talk.wav" data-start="1" data-duration="4" data-media-start="0.6" data-playback-rate="2" data-track-index="1" loop></audio>',
    ),
    emptyTimelineSettings(),
    { mediaLengths: new Map([["talk.wav", 2]]) },
  );
  const talk = segment(plan(timeline), "talk");
  // From 0.6 to 2 seconds of source takes 0.7 seconds at 2x.
  expect(
    [48_000, 81_599, 81_600, 81_601, 115_200].map((n) => heard(talk, n)),
  ).toEqual([28_800, 95_998, 28_800, 28_802, 28_800]);
});

test("a muted track and a track soloed out give zero gain", () => {
  const html = page(
    "30",
    [
      `<audio id="one" src="talk.wav" data-start="0" data-duration="4" data-track-index="1"></audio>`,
      `<audio id="two" src="talk.wav" data-start="0" data-duration="4" data-track-index="2"></audio>`,
    ].join(""),
  );
  const levels = (timeline: Timeline) =>
    plan(timeline).map(({ clipId, gain }) => [clipId, gainAt(gain, 48_000)]);
  expect(levels(edited(html, []).timeline)).toEqual([
    ["one", 1],
    ["two", 1],
  ]);
  expect(
    levels(
      edited(html, [{ type: "setTrack", index: 1, muted: true }]).timeline,
    ),
  ).toEqual([
    ["one", 0],
    ["two", 1],
  ]);
  expect(
    levels(edited(html, [{ type: "setTrack", index: 2, solo: true }]).timeline),
  ).toEqual([
    ["one", 0],
    ["two", 1],
  ]);
});

test("a fade's envelope starts silent, reaches the clip's gain at its knee, and ends silent", () => {
  const { timeline } = edited(
    page(
      "30",
      `<audio id="talk" src="talk.wav" data-start="1" data-duration="4" data-track-index="1"></audio>`,
    ),
    [{ type: "setClip", clipId: "talk", volume: 0.5, fadeIn: 30, fadeOut: 15 }],
  );
  const { gain, samples } = segment(plan(timeline), "talk");
  const fps = timeline.fps;
  expect(samples).toEqual({ start: 48_000, end: 5 * 48_000 });
  expect(gainAt(gain, samples.start)).toBe(0);
  expect(gainAt(gain, sampleAt(60, fps))).toBeCloseTo(0.5, 9);
  expect(gainAt(gain, sampleAt(45, fps))).toBeCloseTo(0.25, 9);
  expect(gainAt(gain, sampleAt(135, fps))).toBeCloseTo(0.5, 9);
  expect(gainAt(gain, samples.end)).toBe(0);
});

test("linked audio in J and L cuts keeps its own window and its picture's sync", () => {
  const shots = page(
    "30",
    [
      `<video id="a" src="talk.wav" muted data-start="0" data-duration="3" data-media-start="1" data-track-index="0" data-link="la"></video>`,
      `<video id="b" src="talk.wav" muted data-start="3" data-duration="3" data-media-start="10" data-track-index="0" data-link="lb"></video>`,
      `<audio id="sa" src="talk.wav" data-start="0" data-duration="3" data-media-start="1" data-track-index="1" data-link="la"></audio>`,
      `<audio id="sb" src="talk.wav" data-start="3" data-duration="3" data-media-start="10" data-track-index="1" data-link="lb"></audio>`,
    ].join(""),
  );
  const before = plan(edited(shots, []).timeline);
  // J cut: b's sound comes in 10 frames early, over a's picture, and a's sound leaves there.
  const { timeline } = edited(shots, [
    { type: "trim", clipId: "sa", edge: "end", to: 80, linked: false },
    { type: "trim", clipId: "sb", edge: "start", to: 80, linked: false },
  ]);
  const after = plan(timeline);
  // Muted pictures do not sound.
  expect(after.map(({ clipId }) => clipId)).toEqual(["sa", "sb"]);
  const [sa, sb] = [segment(after, "sa"), segment(after, "sb")];
  expect([sa.samples.end, sb.samples.start]).toEqual([128_000, 128_000]);
  // Each keeps the source line its picture plays, so sync holds past the moved edit.
  expect(sa.map).toEqual(segment(before, "sa").map);
  expect(sb.map).toEqual(segment(before, "sb").map);
  expect(heard(sb, 128_000)).toBe(10 * 48_000 - 16_000);
  expect(heard(sb, 144_000)).toBe(10 * 48_000);
});

test("a ramp cut in two reads the same source on both sides of the cut", () => {
  const ramp = `<audio id="talk" src="talk.wav" data-start="0" data-duration="6" data-media-start="2" data-track-index="1" data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":0.5},{"t":6,"v":2}]}]}'></audio>`;
  const html = page("30", ramp);
  const whole = segment(plan(edited(html, []).timeline), "talk");
  // Frame 90 is sample 144,000, a whole number of table steps from the start.
  const split = plan(
    edited(html, [{ type: "split", clipIds: ["talk"], at: 90 }]).timeline,
  );
  const [a, b] = [segment(split, "talk"), segment(split, "talk-2")];
  expect([whole.map.kind, a.map.kind, b.map.kind]).toEqual([
    "table",
    "table",
    "table",
  ]);
  expect(b.samples.start).toBe(144_000);
  for (const n of [0, 47_520, 143_520, 143_999, 144_000, 200_160, 287_999])
    expect(sourcePosition(covering(split, n), n)).toBeCloseTo(
      sourcePosition(whole, n),
      3,
    );
  // Starts at 2 s.
  expect(sourcePosition(whole, 0)).toBeCloseTo(96_000, 6);
});

test("changing the project frame rate keeps every sample's source (#377)", () => {
  const html = page(
    "60",
    `<audio id="talk" src="talk.wav" data-start="0.95" data-duration="3" data-media-start="1.016667" data-track-index="1"></audio>`,
  );
  const parsed = parseComposition(html, emptyTimelineSettings(), {
    mediaLengths,
  });
  const sixty = segment(plan(parsed.timeline), "talk");
  for (const fps of [
    { num: 24, den: 1 },
    { num: 30_000, den: 1001 },
  ]) {
    const regrid = planFormat(parsed, emptyTimelineSettings(), mediaLengths, {
      fps,
      width: 1920,
      height: 1080,
    });
    const after = segment(plan(regrid.timeline), "talk");
    expect(after.map).toEqual(sixty.map);
    const shared = {
      start: Math.max(sixty.samples.start, after.samples.start),
      end: Math.min(sixty.samples.end, after.samples.end),
    };
    for (const n of [shared.start, shared.start + 1601, shared.end - 1])
      expect(heard(after, n)).toBe(heard(sixty, n));
  }
});

test("a 1,000-clip dialogue timeline plans in under 10 ms", () => {
  // Cut from three recordings at 60 fps: a fade on every fifth clip, 2x on every twentieth, a
  // ramp on every hundredth, and a dissolve on every fourth cut.
  const ramp = ` data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":1},{"t":1,"v":1.5}]}]}'`;
  const body = Array.from({ length: 1000 }, (_, i) => {
    const track = 1 + (i % 3);
    const extra =
      i % 100 === 99
        ? ramp
        : i % 20 === 19
          ? ' data-playback-rate="2"'
          : i % 5 === 4
            ? ' data-fade-in="0.1" data-fade-out="0.2" data-volume="0.7"'
            : "";
    return `<audio id="c${i}" src="${["talk", "tone", "quiet"][track - 1]}.wav" data-start="${Math.floor(i / 3)}" data-duration="1" data-media-start="${1 + ((i * 0.37) % 50)}"${extra} data-track-index="${track}"></audio>`;
  }).join("");
  const cuts = Array.from({ length: 330 }, (_, k) => k * 3).flatMap((i) =>
    i % 4 === 0 && i % 100 !== 96 && i % 20 !== 16 && i % 5 !== 1
      ? [
          {
            from: `c${i}`,
            to: `c${i + 3}`,
            transition: {
              kind: "dissolve" as const,
              duration: 6,
              alignment: "center" as const,
            },
          },
        ]
      : [],
  );
  const { timeline } = edited(page("60", body), [
    { type: "setTransitions", cuts },
  ]);
  expect(timeline.clips.filter((clip) => clip.transitionOut)).toHaveLength(
    cuts.length,
  );
  plan(timeline);
  // The fastest of several runs is the build's own cost, without a busy machine's pauses.
  const fastest = Math.min(
    ...Array.from({ length: 20 }, () => {
      const started = performance.now();
      plan(timeline);
      return performance.now() - started;
    }),
  );
  console.log(`1,000-clip scrub plan: ${fastest.toFixed(2)} ms`);
  expect(plan(timeline)).toHaveLength(1000);
  expect(fastest).toBeLessThan(10);
});

async function ffmpeg(args: string[]) {
  const child = Bun.spawn(["ffmpeg", "-v", "error", "-nostdin", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [bytes, error, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return new Float32Array(bytes);
}

test.skipIf(!Bun.which("ffmpeg"))(
  "the plan's gain is the gain the export mix applies",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-scrub-plan-"));
    try {
      const amplitude = 0.5;
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        `aevalsrc=${amplitude}*sin(2*PI*1000*t):s=48000:d=60:c=stereo`,
        join(root, "tone.wav"),
      ]);
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        "60",
        join(root, "quiet.wav"),
      ]);
      // Each clip sounds alone, so the mix's level at a time is one clip's gain on the tone.
      // The silent incoming clips leave only the outgoing side of each crossfade audible.
      const html = page(
        "30",
        [
          `<audio id="fades" src="tone.wav" data-start="0" data-duration="3" data-media-start="1" data-track-index="1"></audio>`,
          `<audio id="curve" src="tone.wav" data-start="4" data-duration="3" data-media-start="1" data-track-index="1"></audio>`,
          `<audio id="out" src="tone.wav" data-start="8" data-duration="3" data-media-start="1" data-track-index="2"></audio>`,
          `<audio id="in" src="quiet.wav" data-start="11" data-duration="3" data-media-start="5" data-track-index="2"></audio>`,
          `<audio id="bent" src="tone.wav" data-start="15" data-duration="3" data-media-start="1" data-track-index="3"></audio>`,
          `<audio id="next" src="quiet.wav" data-start="18" data-duration="3" data-media-start="5" data-track-index="3"></audio>`,
          `<audio id="bus" src="tone.wav" data-start="22" data-duration="2" data-media-start="1" data-track-index="4"></audio>`,
          `<audio id="muted" src="tone.wav" data-start="25" data-duration="2" data-media-start="1" data-track-index="5"></audio>`,
        ].join(""),
      );
      const {
        html: written,
        timeline,
        settings,
      } = edited(html, [
        {
          type: "setClip",
          clipId: "fades",
          volume: 0.8,
          fadeIn: 20,
          fadeOut: 40,
        },
        {
          type: "setClip",
          clipId: "curve",
          fadeIn: 30,
          fadeOut: 30,
          automation: {
            volume: [
              { frame: 0, gain: 0.2 },
              { frame: 90, gain: 1.6 },
            ],
          },
        },
        {
          type: "setTransition",
          from: "out",
          to: "in",
          transition: { duration: 30 },
        },
        {
          type: "setClip",
          clipId: "bent",
          automation: {
            volume: [
              { frame: 0, gain: 1 },
              { frame: 90, gain: 0.4 },
            ],
          },
        },
        {
          type: "setTransition",
          from: "bent",
          to: "next",
          transition: { duration: 20 },
        },
        { type: "setTrack", index: 1, volume: 0.9 },
        { type: "setTrack", index: 2, volume: 1.2 },
        { type: "setTrack", index: 5, muted: true },
        {
          type: "routeAudioGroup",
          clipIds: ["bus"],
          group: { label: "Bus", volume: 0.6 },
        },
        { type: "setMaster", volume: 0.8 },
      ]);
      const exported = applyTrackMix(
        parseComposition(written, settings, { mediaLengths }),
      );
      const output = join(root, "mix.m4a");
      const result = await processCompositionAudio(
        parseAudioElements(exported),
        root,
        join(root, "work"),
        output,
        28,
        undefined,
        { masterFxChain: parseMasterFxChain(exported) },
      );
      expect(result.success, result.error).toBe(true);
      const mix = await ffmpeg([
        "-i",
        output,
        // One channel as it is: a stereo-to-mono downmix would add both at -3 dB.
        "-af",
        "pan=mono|c0=c0",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "pipe:1",
      ]);

      const segments = plan(timeline);
      const planned = (n: number) =>
        segments
          .filter(
            ({ samples, source }) =>
              source.path === "tone.wav" &&
              samples.start <= n &&
              n < samples.end,
          )
          .reduce((sum, { gain }) => sum + gainAt(gain, n), 0);
      // Root mean square over one cycle of the tone, centred on the sample.
      const level = (n: number) => {
        const cycle = mix.subarray(n - 24, n + 24);
        const power = cycle.reduce((sum, value) => sum + value * value, 0);
        return Math.sqrt((2 * power) / cycle.length) / amplitude;
      };
      const times = [
        0.2, 0.4, 1.5, 2.2, 2.7, 2.9, 4.5, 5.5, 6.5, 8.2, 10, 10.45, 10.6, 10.8,
        11.2, 11.4, 15.5, 17.6, 17.9, 18.1, 18.2, 22.3, 23, 25.5, 26.5,
      ];
      const compared = times.map((time) => {
        const n = Math.round(time * 48_000);
        return { time, planned: planned(n), exported: level(n) };
      });
      // The segments must cover the muted clip, at zero, for this to say anything about it.
      expect(segment(segments, "muted").gain).toEqual([
        { at: 25 * 48_000, gain: 0 },
      ]);
      for (const entry of compared)
        expect(
          Math.abs(entry.planned - entry.exported),
          JSON.stringify(compared),
        ).toBeLessThan(0.01);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
