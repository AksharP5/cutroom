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
import { applyAll } from "../src/shared/timeline/apply";
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
  expect(() =>
    applyAll(cleared, [
      CommandSchema.parse({
        type: "setClip",
        clipId: "music",
        fadeIn: 300,
        fadeOut: 1,
      }),
    ]),
  ).toThrow("Fades must fit inside the clip");
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

async function render(root: string, source: string, name: string) {
  const output = join(root, `${name}.m4a`);
  const result = await processCompositionAudio(
    parseAudioElements(source),
    root,
    join(root, name),
    output,
    8,
  );
  expect(result.success, result.error).toBe(true);
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

test("trim, Q/W, overwrite and ripple cuts keep fades inside every surviving piece and editable", () => {
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
        [[15, 45]],
        [[15, 45]],
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
      expect(clip.fadeIn + clip.fadeOut).toBeLessThanOrEqual(clip.duration);
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

test("editing overlapping authored fades writes the normalized pair that the timeline shows", () => {
  const source = faded(2, 6).replaceAll(
    'data-duration="8"',
    'data-duration="2"',
  );
  const parsed = parseComposition(source, emptyTimelineSettings());
  expect(parsed.timeline.clips[0]).toMatchObject({
    duration: 60,
    fadeIn: 15,
    fadeOut: 45,
  });
  const result = edited(source, [
    { type: "setClip", clipId: "music", fadeOut: 30 },
  ]);
  expect(result.timeline.clips[0]).toMatchObject({ fadeIn: 15, fadeOut: 30 });
  expect(parseAudioElements(result.html)[0]).toMatchObject({
    fadeIn: 0.5,
    fadeOut: 1,
  });
});

test.skipIf(!Bun.which("ffmpeg"))(
  "trim and roll out and back retain native edge fades and their rendered levels",
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
      for (const roll of [false, true]) {
        const original = roll
          ? source.replace(
              "</main>",
              '<audio id="next" src="tone.wav" data-start="8" data-duration="4" data-media-start="8" data-track-index="0" data-fade-in="2"></audio></main>',
            )
          : source;
        const shortened = edited(original, [
          { type: "trim", clipId: "music", edge: "end", to: 180 },
          ...(roll
            ? [
                {
                  type: "trim",
                  clipId: "next",
                  edge: "start",
                  to: 180,
                } as const,
              ]
            : []),
        ]);
        expect(
          shortened.timeline.clips.find((clip) => clip.id === "music"),
        ).toMatchObject({ duration: 180, fadeOut: 120, automation: null });
        const restored = edited(shortened.html, [
          ...(roll
            ? [
                {
                  type: "trim",
                  clipId: "next",
                  edge: "start",
                  to: 240,
                } as const,
              ]
            : []),
          { type: "trim", clipId: "music", edge: "end", to: 240 },
        ]);
        expect(restored.timeline).toEqual(
          parseComposition(original, emptyTimelineSettings()).timeline,
        );
        const reference = await render(
          root,
          original,
          `edge-reference-${roll}`,
        );
        for (const [name, result, times, expected] of [
          [
            "short",
            shortened,
            [1, 3, 5, 5.8],
            faded(0, 4).replaceAll('data-duration="8"', 'data-duration="6"'),
          ],
          ["back", restored, [1, 3, 5, 6.5, 7.8], original],
        ] as const) {
          const actual = await render(
            root,
            result.html,
            `edge-${roll}-${name}`,
          );
          const wanted =
            name === "back"
              ? reference
              : await render(root, expected, `edge-short-reference-${roll}`);
          for (const time of times)
            expect(
              Math.abs(
                20 * Math.log10(peak(actual, time) / peak(wanted, time)),
              ),
            ).toBeLessThan(1);
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
