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
import { compactFxNode } from "../src/shared/timeline/fx";
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
