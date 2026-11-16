import { expect, test } from "bun:test";
import { parseAudioFxChain } from "@hyperframes/core/audio-fx";
import { applyAll, canonicalTimeline } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  parseComposition,
  patchComposition,
  settingsOf,
  timelineContent,
} from "../src/server/timeline/composition";
import { compactFxNode, mixLoudnessFx } from "../src/shared/timeline/fx";
import { duckPoints, normalizedGain } from "../src/server/timeline/audio";
import { countingIds } from "./clip-ids";

const mediaLengths = new Map([["voice.wav", 20]]);
const page = (body: string) =>
  `<!doctype html>\n<html><head></head>\n<body><main id="main" data-composition-id="main" data-duration="12" data-fps="30">\n${body}\n</main></body></html>\n`;
const voice = (attributes = "") =>
  page(
    `<audio id="voice" src="voice.wav" data-start="0" data-duration="10" data-track-index="0"${attributes}></audio>`,
  );

function edit(html: string, commands: CommandInput[]) {
  const parsed = parseComposition(html, emptyTimelineSettings(), {
    mediaLengths,
  });
  const timeline = canonicalTimeline(
    applyAll(
      parsed.timeline,
      commands.map((command) => CommandSchema.parse(command)),
      { newId: countingIds },
    ),
  );
  const output = patchComposition(parsed, timeline, new Map());
  const read = parseComposition(output, settingsOf(timeline), {
    mediaLengths,
  }).timeline;
  // What was written reads back as exactly the timeline the engine produced.
  expect(timelineContent(read)).toEqual(timelineContent(timeline));
  return { output, read };
}
const chainOf = (html: string, id: string) =>
  parseAudioFxChain(
    new RegExp(`<[^>]*id="${id}"[^>]*data-fx-chain="([^"]*)"`)
      .exec(html)![1]!
      .replaceAll("&quot;", '"'),
  );

test("a preset and an effect land as one chain in signal order, and an id bypasses an effect without touching its settings", () => {
  const { output, read } = edit(voice(), [
    {
      type: "setClip",
      clipId: "voice",
      fx: [
        { preset: "rumble-cut" },
        { type: "limiter", params: { limit: -6 } },
      ],
    },
  ]);
  expect(read.clips[0]!.fx.map(compactFxNode)).toEqual([
    {
      id: "n1",
      type: "highpass",
      label: "Cut Rumble",
      preset: "rumble-cut",
      params: { frequency: 100 },
    },
    { id: "n2", type: "limiter", params: { limit: -6 } },
  ]);
  expect(chainOf(output, "voice").nodes.map((node) => node.type)).toEqual([
    "highpass",
    "limiter",
  ]);
  const bypassed = edit(output, [
    {
      type: "setClip",
      clipId: "voice",
      fx: [
        { id: "n1", type: "highpass" },
        { id: "n2", type: "limiter", enabled: false },
      ],
    },
  ]);
  expect(bypassed.read.clips[0]!.fx.map(compactFxNode)).toEqual([
    {
      id: "n1",
      type: "highpass",
      label: "Cut Rumble",
      preset: "rumble-cut",
      params: { frequency: 100 },
    },
    { id: "n2", type: "limiter", enabled: false, params: { limit: -6 } },
  ]);
  expect(chainOf(bypassed.output, "voice").nodes[1]!.enabled).toBe(false);
  // An empty chain removes the attribute.
  expect(
    edit(bypassed.output, [{ type: "setClip", clipId: "voice", fx: [] }])
      .output,
  ).not.toContain("data-fx-chain");
});

test("effect settings are typed: out-of-range numbers, unknown parameters, choices and effects are refused before they reach the chain", () => {
  for (const fx of [
    [{ type: "limiter", params: { limit: 6 } }],
    [{ type: "limiter", params: { ceiling: -1 } }],
    [{ type: "highpass", params: { poles: "3" } }],
    [{ type: "highpass", params: { frequency: "80" } }],
    [{ type: "eval" }],
    [{ preset: "nope" }],
    [{ type: "gain", id: 'n1" onload="x' }],
  ])
    expect(
      CommandSchema.safeParse({ type: "setClip", clipId: "voice", fx }).success,
    ).toBe(false);
});

test("editing a carved bed keeps the carve's marks on its nodes, and a clip without sound has no effects to set", () => {
  const carved = JSON.stringify({
    version: 1,
    nodes: [
      {
        type: "peaking",
        id: "n1",
        fromCarve: true,
        params: { frequency: 1000, gain: -6, q: 2 },
      },
    ],
  }).replaceAll('"', "&quot;");
  const { output } = edit(voice(` data-fx-chain="${carved}"`), [
    {
      type: "setClip",
      clipId: "voice",
      fx: [{ id: "n1", type: "peaking" }, { type: "compressor" }],
    },
  ]);
  expect(chainOf(output, "voice").nodes).toMatchObject([
    { id: "n1", fromCarve: true, params: { gain: -6 } },
    { id: "n2", type: "compressor" },
  ]);
  expect(() =>
    edit(
      page(
        `<video id="shot" src="voice.wav" muted data-has-audio="false" data-start="0" data-duration="2" data-track-index="0"></video>`,
      ),
      [{ type: "setClip", clipId: "shot", fx: [{ type: "gain" }] }],
    ),
  ).toThrow("has no sound to process");
});

test("track effects ride the track's bus, which processes every clip on it", () => {
  const { output, read } = edit(voice(), [
    {
      type: "setTrack",
      index: 0,
      fx: [{ type: "compressor", params: { threshold: -20, ratio: 6 } }],
    },
  ]);
  expect(read.tracks[0]!.fx.map(compactFxNode)).toEqual([
    { id: "n1", type: "compressor", params: { threshold: -20, ratio: 6 } },
  ]);
  const bus = /<hf-audio-group[^>]*>/.exec(output)![0];
  expect(bus).toContain('data-cutroom-track="0"');
  expect(chainOf(bus, bus.match(/id="([^"]*)"/)![1]!).nodes).toMatchObject([
    { type: "compressor", params: { threshold: -20, ratio: 6 } },
  ]);
  expect(output).toMatch(/<audio id="voice"[^>]*data-audio-group="/);
});

test("a duck comes down over its attack before speech, holds through short pauses, comes back over its release, and multiplies the bed's own points", () => {
  const fps = { num: 30, den: 1 };
  const bed = parseComposition(voice(), emptyTimelineSettings(), {
    mediaLengths,
  }).timeline.clips[0]!;
  const half = 10 ** (-6 / 20);
  // Speech 2-3 s and 3.4-4 s (a pause too short to come back up in), then 7-8 s.
  const points = duckPoints(
    { ...bed, automation: null },
    fps,
    [
      { start: 2, end: 3 },
      { start: 3.4, end: 4 },
      { start: 7, end: 8 },
    ],
    { depth: -6, attack: 0.5, release: 1 },
  );
  expect(points).toEqual([
    { frame: 0, gain: 1 },
    { frame: 45, gain: 1 },
    { frame: 60, gain: Math.round(half * 1e6) / 1e6 },
    { frame: 120, gain: Math.round(half * 1e6) / 1e6 },
    { frame: 150, gain: 1 },
    { frame: 195, gain: 1 },
    { frame: 210, gain: Math.round(half * 1e6) / 1e6 },
    { frame: 240, gain: Math.round(half * 1e6) / 1e6 },
    { frame: 270, gain: 1 },
    { frame: 300, gain: 1 },
  ]);
  // A bed already at half level stays half as loud under the duck.
  const lowered = duckPoints(
    {
      ...bed,
      automation: JSON.stringify({
        version: 1,
        lanes: [{ target: "volume", points: [{ t: 0, v: 0.5 }] }],
      }),
    },
    fps,
    [{ start: 2, end: 3 }],
    { depth: -6, attack: 0.5, release: 1 },
  );
  expect(lowered.find((point) => point.frame === 60)?.gain).toBeCloseTo(
    0.5 * half,
    6,
  );
  expect(lowered[0]).toEqual({ frame: 0, gain: 0.5 });
});

test("loudness is gain: a clip measured 4 LU quiet gets +4 dB, held at +12 dB, and a mix's loudness gain adds to the one it measured through", () => {
  expect(normalizedGain(-20, 1, -16)).toBeCloseTo(10 ** (4 / 20), 6);
  expect(normalizedGain(-40, 1, -16)).toBeCloseTo(10 ** (12 / 20), 6);
  const first = mixLoudnessFx([], -21.3, -16);
  expect(first).toEqual([
    {
      id: "loudness",
      type: "gain",
      label: "Loudness",
      enabled: true,
      params: { gain: 5.3 },
    },
  ]);
  // Measured again at -16.4 through that gain, the next pass adds 0.4 dB to it.
  const { read } = edit(voice(), [{ type: "setMaster", fx: first }]);
  expect(read.masterFx?.map(compactFxNode)).toEqual([
    { id: "loudness", type: "gain", label: "Loudness", params: { gain: 5.3 } },
  ]);
  expect(mixLoudnessFx(read.masterFx!, -16.4, -16).at(-1)).toMatchObject({
    params: { gain: 5.7 },
  });
});

test("the mix's effects ride the composition root, which HyperFrames plays as the master bus", () => {
  const { output, read } = edit(voice(), [
    { type: "setMaster", fx: [{ type: "limiter", params: { limit: -1 } }] },
  ]);
  expect(chainOf(output, "main").nodes).toMatchObject([
    { type: "limiter", params: { limit: -1 } },
  ]);
  expect(read.masterFx).toHaveLength(1);
  const cleared = edit(output, [{ type: "setMaster", fx: [] }]);
  expect(cleared.output).not.toContain("data-fx-chain");
  expect(cleared.read.masterFx).toBeUndefined();
});
