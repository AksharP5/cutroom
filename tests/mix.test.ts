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
        const reference = await render(
          root,
          source,
          `whole-${fadeIn}-${fadeOut}-${at}-${automated}`,
        );
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
        const reference = await render(
          root,
          original,
          `edge-reference-${mode}`,
          16,
        );
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
