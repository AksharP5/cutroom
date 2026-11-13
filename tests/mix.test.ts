import { fadeGain } from "@hyperframes/core/audio-fade";
import { expect, test } from "bun:test";
import { parseAutomation } from "@hyperframes/core/audio-automation";
import { audioDbToGain, MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAudioElements,
  processCompositionAudio,
} from "@hyperframes/engine";
import { TimelineError, applyAll } from "../src/shared/timeline/apply";
import { clipFades } from "../src/shared/timeline/mix";
import {
  envelopeAt,
  envelopeHeight,
  fadePath,
  gainFromDrag,
  gainLevel,
  waveformScale,
} from "../src/client/timeline/mix";
import { emptyMeter, meterSample } from "../src/client/timeline/meters";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import { countingIds } from "./clip-ids";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  parseComposition,
  patchComposition,
  settingsOf,
} from "../src/server/timeline/composition";
import { withPreviewBridge } from "../src/server/hyperframes/previewBridge";

const html = `<main data-composition-id="main" data-duration="10" data-fps="30000/1001"><audio id="music" src="music.wav" data-start="0" data-duration="10"></audio><video id="voice" src="voice.mp4" data-start="0" data-duration="10" data-track-index="1"></video></main>`;

test("clearing a split's automation removes its baked ramp with exact HTML readback", () => {
  const split = edited(
    html.replace(
      'data-duration="10"></audio>',
      'data-duration="10" data-fade-out="4"></audio>',
    ),
    [{ type: "split", clipIds: ["music"], at: 240 }],
  );
  const clip = split.timeline.clips.find((clip) => clip.id === "music")!;
  expect(clip.automation).toBeTruthy();
  const cleared = edited(split.html, [
    { type: "setClip", clipId: clip.id, automation: null },
  ]);
  expect(cleared.timeline.clips.find((item) => item.id === clip.id)).toEqual({
    ...clip,
    automation: null,
  });
  expect(
    CommandSchema.safeParse({
      type: "setClip",
      clipId: clip.id,
      automation: "{}",
    }).success,
  ).toBe(false);
});

test("a gain drag leaves the line under the pointer, lands on unity, and recovers from silence", () => {
  const plain = { dy: 0, fine: false, body: 25, lane: 1, fade: 1 };
  const at = (db: number) => audioDbToGain(db);
  // The line is drawn at gainLevel, so the gain a drag leaves must draw it where the pointer went.
  for (const body of [13, 25, 61, 101])
    for (const start of [6, 0, -7, -24])
      for (const dy of [-9, -2, 1, 4, 11]) {
        const from = gainLevel(at(start), body);
        const to = gainLevel(
          gainFromDrag({ ...plain, from: at(start), dy, body }),
          body,
        );
        const pointer = Math.max(0, Math.min(body, (from * body) / 100 + dy));
        expect(Math.abs((to * body) / 100 - pointer)).toBeLessThanOrEqual(0.51);
      }
  // Between unity and -6 dB a pixel is 1 dB at every height, and just over that above unity on
  // a default row.
  for (const body of [13, 25, 61])
    expect(gainFromDrag({ ...plain, from: 1, dy: 1, body })).toBeCloseTo(
      at(-1),
      10,
    );
  expect(gainFromDrag({ ...plain, from: 1, dy: -1 })).toBeCloseTo(at(1.3), 10);
  // From -6 to -24 dB, where a music bed sits, a pixel is 2.25 dB on a default row, about 6.6 dB
  // on a compact one and three quarters of a dB on a tall one.
  expect(gainFromDrag({ ...plain, from: at(-9), dy: 2 })).toBeCloseTo(
    at(-13.5),
    10,
  );
  expect(gainFromDrag({ ...plain, from: at(-12), dy: 4 })).toBeCloseTo(
    at(-21),
    10,
  );
  expect(gainFromDrag({ ...plain, from: at(-6), dy: 1, body: 13 })).toBeCloseTo(
    at(-12.6),
    10,
  );
  expect(gainFromDrag({ ...plain, from: at(-6), dy: 4, body: 61 })).toBeCloseTo(
    at(-9),
    10,
  );
  // The line at unity and from -6 dB down stays clear of where a hand takes a clip: the middle
  // of its body, and the middle of its box 5.5 px above that. The grab band is 1.5 px each way.
  for (const body of [9, 13, 25, 61, 181]) {
    const pixels = (db: number) => (gainLevel(at(db), body) * body) / 100;
    for (const middle of [body / 2, body / 2 - 5.5]) {
      expect(Math.abs(pixels(0) - middle)).toBeGreaterThanOrEqual(2.5);
      for (const db of [-6, -12, -18, -24])
        expect(Math.abs(pixels(db) - middle)).toBeGreaterThanOrEqual(2.5);
    }
  }
  // From -3.3 dB the pixel nearest unity is unity itself, and the one before it is not.
  expect(gainFromDrag({ ...plain, from: at(-3.3), dy: -3 })).toBe(1);
  expect(gainFromDrag({ ...plain, from: at(-3.3), dy: -2 })).toBeCloseTo(
    at(-1.3),
    10,
  );
  // A clip already inside that pixel is never pulled against the drag.
  expect(gainFromDrag({ ...plain, from: at(-0.2), dy: 0.2 })).toBeLessThan(
    at(-0.2),
  );
  // Shift is a tenth of a dB per pixel at every height.
  for (const body of [13, 101])
    expect(
      gainFromDrag({ ...plain, from: at(-6), dy: 5, fine: true, body }),
    ).toBeCloseTo(at(-6.5), 10);
  expect(gainFromDrag({ ...plain, from: 1, dy: 25 })).toBe(0);
  expect(gainFromDrag({ ...plain, from: 1, dy: -25 })).toBe(MAX_AUDIO_GAIN);
  expect(gainFromDrag({ ...plain, from: 0, dy: -2 })).toBeCloseTo(
    at(-22.9),
    10,
  );
  // A press that returns to where it began leaves an off-grid gain as it was.
  expect(gainFromDrag({ ...plain, from: at(-6.37) })).toBe(at(-6.37));
});

test("a drag inside a fade or over automation still keeps the line under the pointer", () => {
  const { timeline } = parseComposition(html, emptyTimelineSettings());
  const automation = JSON.stringify({
    version: 1,
    lanes: [
      {
        target: "volume",
        points: [
          { t: 0, v: 1 },
          { t: 10, v: 0.5 },
        ],
      },
    ],
  });
  const body = 25;
  for (const base of [
    { ...timeline.clips[0]!, duration: 300, fadeIn: 60, fadeOut: 0 },
    { ...timeline.clips[0]!, duration: 300, automation },
  ])
    for (const [time, dy] of [
      [30, -3],
      [30, 2],
      [150, 3],
    ] as const) {
      const hold = envelopeAt(base, timeline.fps, time);
      const volume = gainFromDrag({ from: 1, dy, fine: false, body, ...hold });
      const moved =
        ((envelopeHeight({ ...base, volume }, timeline.fps, time, body) -
          envelopeHeight(base, timeline.fps, time, body)) *
          body) /
        100;
      expect(Math.abs(moved - dy)).toBeLessThanOrEqual(0.51);
    }
  // Near a fade's start the line can only rise as far as +12 dB takes it.
  expect(
    gainFromDrag({
      from: 1,
      dy: -6,
      fine: false,
      body,
      ...envelopeAt(
        { ...timeline.clips[0]!, duration: 300, fadeIn: 60 },
        timeline.fps,
        6,
      ),
    }),
  ).toBe(MAX_AUDIO_GAIN);
});

test("meters latch clipping through silence and stop, reset peaks on stop and clear on restart", () => {
  const clipped = meterSample(emptyMeter, 1.1, true, 100);
  const quiet = meterSample(clipped, 0.1, true, 200);
  expect(quiet.clipped).toBe(true);
  expect(quiet.peak).toBe(1);
  const falling = meterSample(quiet, 0.1, true, 1800);
  expect(falling.peak).toBeLessThan(1);
  const stopped = meterSample(falling, 0, false, 1900);
  expect(stopped).toMatchObject({ clipped: true, peak: 0 });
  expect(meterSample(stopped, 0, true, 2000)).toMatchObject({
    clipped: false,
    peak: 0,
  });
  expect(
    meterSample({ ...quiet, clipped: false }, 0.1, true, 300).clipped,
  ).toBe(false);
});

test("gain and frame fades round-trip exactly through HTML and the producer's audio reader", () => {
  let parsed = parseComposition(html, emptyTimelineSettings());
  for (const volume of [
    audioDbToGain(-42.3),
    audioDbToGain(-12),
    MAX_AUDIO_GAIN,
    0,
    null,
  ]) {
    const commands: CommandInput[] = ["music", "voice"].map((clipId) => ({
      type: "setClip",
      clipId,
      volume,
      fadeIn: 1,
      fadeOut: 37,
    }));
    const next = applyAll(
      parsed.timeline,
      commands.map((command) => CommandSchema.parse(command)),
    );
    const patched = patchComposition(parsed, next, new Map());
    parsed = parseComposition(patched, settingsOf(next));
    expect(parsed.timeline).toEqual(next);
    expect(patched).toContain('data-fade-in="0.033367"');
    for (const audio of parseAudioElements(patched)) {
      expect(audio.volume).toBe(volume ?? 1);
      expect(audio.fadeIn).toBe(0.033367);
      expect(audio.fadeOut).toBe(1.234567);
    }
  }
  const cleared = applyAll(parsed.timeline, [
    CommandSchema.parse({
      type: "setClip",
      clipId: "music",
      fadeIn: 0,
      fadeOut: 0,
    }),
  ]);
  expect(
    parseComposition(
      patchComposition(parsed, cleared, new Map()),
      settingsOf(cleared),
    ).timeline,
  ).toEqual(cleared);
  const overlapping = edited(patchComposition(parsed, cleared, new Map()), [
    { type: "setClip", clipId: "music", fadeIn: 300, fadeOut: 1 },
  ]);
  expect(
    overlapping.timeline.clips.find((clip) => clip.id === "music"),
  ).toMatchObject({ fadeIn: 300, fadeOut: 1 });
});

test("preview media opts into the opaque frame's CORS audio path without changing script strings", () => {
  const source =
    '<html><head><script>const tag = "<audio>";</script></head><body><video src="voice.mp4"></video><audio crossorigin="use-credentials" src="other.wav"></audio></body></html>';
  const preview = withPreviewBridge(source);
  expect(preview).toContain('<video crossorigin="anonymous" src="voice.mp4">');
  expect(preview).toContain(
    '<audio crossorigin="use-credentials" src="other.wav">',
  );
  expect(preview).toContain('const tag = "<audio>"');
});

async function ffmpeg(args: string[]) {
  const process = Bun.spawn(["ffmpeg", "-v", "error", "-nostdin", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [bytes, error, code] = await Promise.all([
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return new Float32Array(bytes);
}

function edited(source: string, commands: CommandInput[]) {
  const parsed = parseComposition(source, emptyTimelineSettings());
  const origins = new Map<string, ClipOrigin>();
  const next = applyAll(
    parsed.timeline,
    commands.map((command) => CommandSchema.parse(command)),
    { newId: countingIds, onCreate: (id, origin) => origins.set(id, origin) },
  );
  const html = patchComposition(parsed, next, origins);
  expect(parseComposition(html, settingsOf(next)).timeline).toEqual(next);
  return { html, timeline: next };
}

async function render(
  root: string,
  source: string,
  name: string,
  duration = 8,
) {
  const output = join(root, `${name}.m4a`);
  const result = await processCompositionAudio(
    parseAudioElements(source),
    root,
    join(root, name),
    output,
    duration,
  );
  expect(result.success, `${name}: ${result.error}`).toBe(true);
  return ffmpeg([
    "-i",
    output,
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "f32le",
    "pipe:1",
  ]);
}
function peak(samples: Float32Array, time: number) {
  return samples
    .subarray(
      Math.round((time - 0.01) * 48000),
      Math.round((time + 0.01) * 48000),
    )
    .reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
}

const faded = (fadeIn: number, fadeOut: number) =>
  `<main data-composition-id="main" data-duration="8" data-fps="30"><audio id="music" src="tone.wav" data-start="0" data-duration="8" data-fade-in="${fadeIn}" data-fade-out="${fadeOut}"></audio></main>`;

test("shortening below an authored fade then restoring the edge preserves the native mix", () => {
  for (const split of [false, true]) {
    const source = split
      ? edited(faded(0, 4), [{ type: "split", clipIds: ["music"], at: 120 }])
          .html
      : faded(0, 4);
    const clipId = split ? "music-2" : "music";
    const original = parseComposition(source, emptyTimelineSettings()).timeline;
    const shortened = edited(source, [
      { type: "trim", clipId, edge: "end", to: split ? 180 : 60 },
    ]);
    expect(
      shortened.timeline.clips.find((clip) => clip.id === clipId),
    ).toMatchObject({
      duration: 60,
      fadeOut: 120,
      automation: null,
    });
    expect(
      edited(shortened.html, [{ type: "trim", clipId, edge: "end", to: 240 }])
        .timeline,
    ).toEqual(original);
  }
});

test.skipIf(!Bun.which("ffmpeg"))(
  "splitting fades preserves the rendered audio, including cuts inside either fade",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-split-audio-"));
    try {
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=220:duration=8:sample_rate=48000",
        join(root, "tone.wav"),
      ]);
      const references = new Map<string, Awaited<ReturnType<typeof render>>>();
      for (const [fadeIn, fadeOut, at, automated] of [
        [0, 4, 120],
        [2, 6, 30],
        [2, 6, 120],
        [2, 6, 180],
        [3, 7, 30],
        [2, 6, 120, true],
        [0, 4, 120, true],
      ] as const) {
        const source = faded(fadeIn, fadeOut).replace(
          "<audio ",
          automated
            ? `<audio data-automation='{"version":1,"lanes":[{"target":"volume","points":[{"t":0,"v":0.3,"curve":1},{"t":8,"v":0.9}]}]}' `
            : "<audio ",
        );
        const reference =
          references.get(source) ??
          (await render(
            root,
            source,
            `whole-${fadeIn}-${fadeOut}-${at}-${automated}`,
          ));
        references.set(source, reference);
        const split = edited(source, [
          { type: "split", clipIds: ["music"], at },
        ]);
        const actual = await render(
          root,
          split.html,
          `split-${fadeIn}-${fadeOut}-${at}-${automated}`,
        );
        const levels = [0.5, 1.5, 2, 3.95, 4.05, 5, 6.5, 7.8].map((time) => ({
          time,
          differenceDb:
            20 * Math.log10(peak(actual, time) / peak(reference, time)),
        }));
        for (const level of levels)
          expect(
            Math.abs(level.differenceDb),
            JSON.stringify({ fadeIn, fadeOut, at, levels }),
          ).toBeLessThan(1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  // Renders and decodes real audio for seven split/fade cases.
  60_000,
);

test("trim and Q/W retain authored fades while overwrite and ripple cuts preserve the source envelope", () => {
  const source = faded(2, 6).replace(
    "</main>",
    '<div id="edit" data-start="0" data-duration="8" data-track-index="1"></div></main>',
  );
  const cases: CommandInput[][] = [
    [{ type: "trim", clipId: "music", edge: "end", to: 60 }],
    [{ type: "trim", clipId: "music", edge: "start", to: 180 }],
    [{ type: "trim", clipId: "edit", edge: "start", to: 180, ripple: true }],
    [{ type: "trim", clipId: "edit", edge: "end", to: 60, ripple: true }],
    [
      {
        type: "insert",
        track: 0,
        at: 60,
        mode: "overwrite",
        clip: { kind: "audio", src: "tone.wav", duration: 120 },
      },
    ],
    [
      { type: "split", clipIds: ["edit"], at: 60 },
      { type: "split", clipIds: ["edit-2"], at: 180 },
      { type: "remove", clipIds: ["edit-2"], ripple: true },
    ],
  ];
  for (const [index, commands] of cases.entries()) {
    const result = edited(source, commands);
    const music = result.timeline.clips.filter((clip) => clip.kind === "audio");
    expect(music.length).toBeGreaterThan(0);
    expect(music.map((clip) => [clip.fadeIn, clip.fadeOut])).toEqual(
      [
        [[60, 180]],
        [[60, 180]],
        [[0, 0]],
        [[60, 0]],
        [
          [60, 0],
          [0, 0],
          [0, 0],
        ],
        [
          [60, 0],
          [0, 0],
        ],
      ][index],
    );
    for (const clip of music) {
      const fades = clipFades(clip);
      expect(fades.fadeIn + fades.fadeOut).toBeLessThanOrEqual(clip.duration);
      expect(() =>
        edited(result.html, [
          {
            type: "setClip",
            clipId: clip.id,
            fadeOut: clip.duration - clip.fadeIn,
          },
        ]),
      ).not.toThrow();
    }
  }
});

test("overlapping fades retain authored readback and use the runtime's proportional display lengths", () => {
  const source = faded(2, 6).replaceAll(
    'data-duration="8"',
    'data-duration="2"',
  );
  const parsed = parseComposition(source, emptyTimelineSettings());
  expect(parsed.timeline.clips[0]).toMatchObject({
    duration: 60,
    fadeIn: 60,
    fadeOut: 180,
  });
  expect(clipFades(parsed.timeline.clips[0]!)).toEqual({
    fadeIn: 15,
    fadeOut: 45,
  });
  expect(clipFades({ ...parsed.timeline.clips[0]!, duration: 61 })).toEqual({
    fadeIn: 15.25,
    fadeOut: 45.75,
  });
  const result = edited(source, [
    { type: "setClip", clipId: "music", fadeOut: 30 },
  ]);
  expect(result.timeline.clips[0]).toMatchObject({ fadeIn: 60, fadeOut: 30 });
  expect(parseAudioElements(result.html)[0]).toMatchObject({
    fadeIn: 2,
    fadeOut: 1,
  });
});

test.skipIf(!Bun.which("ffmpeg"))(
  "trim, roll, Q/W and split-piece shortening out and back retain native fades and rendered audio",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-edge-audio-"));
    try {
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=220:duration=16:sample_rate=48000",
        join(root, "tone.wav"),
      ]);
      const source = faded(0, 4);
      const references = new Map<string, Awaited<ReturnType<typeof render>>>();
      for (const mode of ["trim", "roll", "Q", "W", "split"] as const) {
        const original =
          mode === "roll"
            ? source.replace(
                "</main>",
                '<audio id="next" src="tone.wav" data-start="8" data-duration="4" data-media-start="8" data-track-index="0" data-fade-in="2"></audio></main>',
              )
            : mode === "split"
              ? edited(source, [{ type: "split", clipIds: ["music"], at: 120 }])
                  .html
              : mode === "Q"
                ? source
                    .replace('data-duration="8"', 'data-duration="14"')
                    .replace(
                      'data-start="0"',
                      'data-start="6" data-media-start="6"',
                    )
                : source;
        const clipId = mode === "split" ? "music-2" : "music";
        const edge = mode === "Q" ? "start" : "end";
        const ripple = mode === "Q" || mode === "W";
        const shortened = edited(original, [
          {
            type: "trim",
            clipId,
            edge,
            to: mode === "Q" ? 360 : mode === "split" ? 180 : 60,
            ripple,
          },
          ...(mode === "roll"
            ? [
                {
                  type: "trim",
                  clipId: "next",
                  edge: "start",
                  to: 60,
                } as const,
              ]
            : []),
        ]);
        expect(
          shortened.timeline.clips.find((clip) => clip.id === clipId),
        ).toMatchObject({ duration: 60, fadeOut: 120, automation: null });
        const restored = edited(shortened.html, [
          ...(mode === "roll"
            ? [
                {
                  type: "trim",
                  clipId: "next",
                  edge: "start",
                  to: 240,
                } as const,
              ]
            : []),
          { type: "trim", clipId, edge, to: mode === "Q" ? 0 : 240, ripple },
        ]);
        expect(restored.timeline).toEqual(
          parseComposition(original, emptyTimelineSettings()).timeline,
        );
        const reference =
          references.get(original) ??
          (await render(root, original, `edge-reference-${mode}`, 16));
        references.set(original, reference);
        const actual = await render(
          root,
          restored.html,
          `edge-${mode}-back`,
          16,
        );
        expect(actual, mode).toEqual(reference);
        if (mode === "trim") {
          const shortReference = await render(
            root,
            faded(0, 4).replaceAll('data-duration="8"', 'data-duration="2"'),
            "edge-short-reference",
            16,
          );
          const shortAudio = await render(
            root,
            shortened.html,
            "edge-short",
            16,
          );
          expect(shortAudio).toEqual(shortReference);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  // Renders and decodes real audio for five edge-edit modes and a shortened reference.
  60_000,
);

test("head trims keep edge fades, and extending a cut ramp reaches its original endpoint", () => {
  const head = edited(faded(2, 0), [
    { type: "trim", clipId: "music", edge: "start", to: 30 },
  ]);
  expect(head.timeline.clips[0]).toMatchObject({
    fadeIn: 60,
    automation: null,
  });
  expect(
    edited(head.html, [{ type: "trim", clipId: "music", edge: "start", to: 0 }])
      .timeline,
  ).toEqual(parseComposition(faded(2, 0), emptyTimelineSettings()).timeline);
  for (const [fadeIn, fadeOut, at] of [
    [0, 4, 180],
    [4, 0, 60],
  ] as const) {
    const split = edited(faded(fadeIn, fadeOut), [
      { type: "split", clipIds: ["music"], at },
    ]);
    const extended = edited(split.html, [
      { type: "remove", clipIds: ["music-2"] },
      { type: "trim", clipId: "music", edge: "end", to: 240 },
    ]);
    const automation = parseAutomation(extended.timeline.clips[0]!.automation!);
    expect(
      automation.lanes.find((lane) => lane.target === "volume")?.points.at(-1),
    ).toMatchObject({ t: 8, v: fadeOut ? 0 : 1 });
  }
});

test("a cut that would exceed HyperFrames' automation limit is refused, not thrown as an internal error", () => {
  // A dense ducking lane over a fade bakes more points than the native format accepts.
  const points = Array.from({ length: 200 }, (_, index) => ({
    t: (index * 8) / 200,
    v: index % 2 ? 0.4 : 0.9,
    curve: 0.5,
  }));
  const automation = JSON.stringify({
    version: 1,
    lanes: [{ target: "volume", points }],
  }).replaceAll('"', "&quot;");
  const source = `<main data-composition-id="main" data-duration="8" data-fps="30"><audio id="music" src="music.wav" data-start="0" data-duration="8" data-fade-out="4" data-automation="${automation}"></audio></main>`;
  const parsed = parseComposition(source, emptyTimelineSettings());
  let refusal: unknown;
  try {
    applyAll(
      parsed.timeline,
      [CommandSchema.parse({ type: "split", clipIds: ["music"], at: 180 })],
      { newId: countingIds },
    );
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(TimelineError);
  expect(refusal).toMatchObject({ code: "unsupported" });
});

test("a ducked clip's waveform stays a third of its unity height, and its fade still tapers to nothing", () => {
  const { timeline } = parseComposition(html, emptyTimelineSettings());
  const scale = (db: number, elapsed: number) => {
    const clip = {
      ...timeline.clips[0]!,
      duration: 300,
      fadeOut: 100,
      volume: audioDbToGain(db),
    };
    return waveformScale(
      clip,
      timeline.fps,
      elapsed,
      undefined,
      clipFades(clip),
    );
  };
  // Down to about -19 dB the wave follows the gain; a bed at -24 or -40 dB holds the floor.
  for (const db of [-6, -18])
    expect(scale(db, 0)).toBeCloseTo(Math.sqrt(audioDbToGain(db)), 10);
  for (const db of [-24, -40]) expect(scale(db, 0)).toBeCloseTo(1 / 3, 10);
  // The fade is not floored: halfway down it the wave is at the root of a half, then gone.
  expect(scale(-24, 250)).toBeCloseTo(Math.sqrt(0.5) / 3, 10);
  expect(scale(-24, 300)).toBe(0);
});

test("the drawn fade follows core's linear amplitude ramp and reaches its knee and silence", () => {
  const { timeline } = parseComposition(html, emptyTimelineSettings());
  for (const volume of [audioDbToGain(-12), 1, audioDbToGain(6)]) {
    const clip = {
      ...timeline.clips[0]!,
      duration: 300,
      fadeIn: 30,
      fadeOut: 90,
      volume,
    };
    const body = 25;
    const path = fadePath(clip, timeline.fps, body);
    const points = [...path.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map(
      (point) => [Number(point[1]), Number(point[2])] as const,
    );
    for (const elapsed of [0, 15, 30, 100, 210, 232.5, 255, 277.5, 300]) {
      const x = (elapsed / clip.duration) * 100;
      const next = points.findIndex((point) => point[0] >= x);
      const [x1, y1] = points[next]!;
      const [x0, y0] = points[Math.max(0, next - 1)]!;
      const y = x0 === x1 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
      const fraction = (100 - y) / (100 - gainLevel(volume, body));
      const fade = fadeGain(elapsed, clip.duration, clip);
      expect(fraction).toBeCloseTo(fade, 3);
      // The waveform is scaled by the same envelope the line draws, on its square-root scale.
      expect(
        waveformScale(clip, timeline.fps, elapsed, undefined, clipFades(clip)),
      ).toBeCloseTo(Math.sqrt(volume * fade), 10);
    }
    expect(points).toContainEqual([
      70,
      Number(gainLevel(volume, body).toFixed(2)),
    ]);
    expect(points.at(-1)).toEqual([100, 100]);
    expect(envelopeHeight(clip, timeline.fps, 255, body)).toBeCloseTo(
      (100 + gainLevel(volume, body)) / 2,
      6,
    );
  }
});
