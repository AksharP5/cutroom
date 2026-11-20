import { expect, test } from "bun:test";
import { MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import { parseAudioElements, parseMasterFxChain } from "@hyperframes/engine";
import { agentTimeline } from "../src/server/mcp/timelineReply";
import { applyAll } from "../src/shared/timeline/apply";
import { editLabel } from "../src/shared/timeline/labels";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput, Timeline } from "../src/shared/timeline/schema";
import {
  applyTrackMix,
  parseComposition,
  patchComposition,
  settingsOf,
  timelineContent,
} from "../src/server/timeline/composition";

// Voices holds one and two (A1, A2); three plays on A3 with track mixing.
const source = `<main data-composition-id="main" data-duration="4"><hf-audio-group id="voices" data-label="Voices" data-volume="1"></hf-audio-group><audio id="one" src="one.wav" data-audio-group="voices" data-start="0" data-duration="4" data-track-index="1"></audio><audio id="two" src="two.wav" data-audio-group="voices" data-start="0" data-duration="4" data-track-index="2"></audio><audio id="three" src="three.wav" data-start="0" data-duration="4" data-track-index="3"></audio></main>`;

function edit(html: string, timeline: Timeline, commands: CommandInput[]) {
  const parsed = parseComposition(html, settingsOf(timeline));
  const after = applyAll(
    parsed.timeline,
    commands.map((command) => CommandSchema.parse(command)),
  );
  const output = patchComposition(parsed, after, new Map());
  const written = parseComposition(output, settingsOf(after));
  // What was written reads back as exactly the timeline the engine produced.
  expect(timelineContent(written.timeline)).toEqual(timelineContent(after));
  return { output, timeline: written.timeline, settings: settingsOf(after) };
}

const start = () => {
  const parsed = parseComposition(source, emptyTimelineSettings());
  return { html: source, timeline: parsed.timeline };
};

/** What the render mixes: the effective source after the saved track and bus mix. */
const rendered = (html: string, settings = emptyTimelineSettings()) =>
  parseAudioElements(applyTrackMix(parseComposition(html, settings)));

test("a bus is renamed, muted, given effects and cleared of automation by its id, each field alone", () => {
  const { html, timeline } = start();
  const named = edit(html, timeline, [
    {
      type: "setAudioGroup",
      group: "voices",
      label: "Dialogue",
      muted: true,
      fx: [{ type: "compressor" }],
    },
  ]);
  expect(named.output).toContain(
    '<hf-audio-group id="voices" data-label="Dialogue" data-volume="1" data-hidden="" data-fx-chain=',
  );
  expect(named.timeline.authoredAudioGroups).toMatchObject([
    { id: "voices", label: "Dialogue", volume: 1, muted: true },
  ]);
  expect(named.timeline.authoredAudioGroups?.[0]?.fx).toMatchObject([
    { type: "compressor" },
  ]);
  // A muted bus drops its members in the render; the track clip still plays.
  expect(rendered(named.output).map(({ id }) => id)).toEqual(["three"]);

  const automated = named.output.replace(
    "<hf-audio-group ",
    `<hf-audio-group data-automation='{"version":1,"lanes":[]}' `,
  );
  const read = parseComposition(automated, emptyTimelineSettings()).timeline;
  expect(read.authoredAudioGroups?.[0]?.automated).toBe(true);
  const cleared = edit(automated, read, [
    { type: "setAudioGroup", group: "voices", automation: null },
  ]);
  expect(cleared.output).not.toContain("data-automation");
  expect(cleared.timeline.authoredAudioGroups?.[0]).toMatchObject({
    label: "Dialogue",
    muted: true,
    automated: false,
  });
});

test("bus solo is saved like track solo: members sound and every other clip is silent in the render", () => {
  const { html, timeline } = start();
  const soloed = edit(html, timeline, [
    { type: "setAudioGroup", group: "voices", solo: true },
  ]);
  // Solo lives in cutroom.json; the source only carries what the mix hides.
  expect(soloed.settings.soloAudioGroups).toEqual(["voices"]);
  expect(soloed.output).toContain(
    'data-track-index="3" data-hidden="" data-cutroom-track-hidden=""',
  );
  expect(rendered(soloed.output, soloed.settings).map(({ id }) => id)).toEqual([
    "one",
    "two",
  ]);

  // A soloed track adds its clips; mute on a member's track still wins over the bus's solo.
  const both = edit(soloed.output, soloed.timeline, [
    { type: "setTrack", index: 3, solo: true },
    { type: "setTrack", index: 2, muted: true },
  ]);
  expect(rendered(both.output, both.settings).map(({ id }) => id)).toEqual([
    "one",
    "three",
  ]);
});

test("deleting a bus returns its members to track mixing in one step", () => {
  const { html, timeline } = start();
  const removed = edit(html, timeline, [
    { type: "setTrack", index: 1, volume: 0.5 },
    { type: "removeAudioGroup", group: "voices" },
  ]);
  expect(removed.output).not.toContain('id="voices"');
  expect(removed.timeline.authoredAudioGroups).toBeUndefined();
  const one = rendered(removed.output, removed.settings).find(
    ({ id }) => id === "one",
  );
  // Back on its track's bus, track gain reaches it again.
  expect(one?.groupVolume).toBe(0.5);
  expect(
    removed.timeline.clips.every((clip) => !clip.authoredAudioGroupId),
  ).toBe(true);
});

test("Main gain is the last gain on the master chain, after loudness, and reads back apart from the effect list", () => {
  const { html, timeline } = start();
  const main = edit(html, timeline, [
    {
      type: "setMaster",
      volume: 0.5,
      fx: [{ id: "loudness", type: "gain", params: { gain: 3 } }],
    },
  ]);
  expect(main.timeline.main).toMatchObject({
    volume: 0.5,
    fx: [{ id: "loudness" }],
  });
  expect(main.output).toContain('data-cutroom-main-gain="main"');
  const chain = JSON.parse(parseMasterFxChain(main.output)!) as {
    nodes: { id: string; params: { gain: number } }[];
  };
  expect(chain.nodes.map(({ id }) => id)).toEqual(["loudness", "main"]);
  expect(chain.nodes[1]!.params.gain).toBeCloseTo(-6.0206, 4);

  // Effects alone keep the gain; unity with no effects removes the chain.
  const fx = edit(main.output, main.timeline, [{ type: "setMaster", fx: [] }]);
  expect(fx.timeline.main).toEqual({ volume: 0.5, fx: [] });
  const unity = edit(fx.output, fx.timeline, [
    { type: "setMaster", volume: 1 },
  ]);
  expect(unity.timeline.main).toBeUndefined();
  expect(unity.output).not.toContain("data-fx-chain");
  expect(unity.output).not.toContain("data-cutroom-main-gain");
});

test("Main's +12 dB maximum survives validation in both editor and server", () => {
  const { html, timeline } = start();
  const fromEditor = CommandSchema.parse({
    type: "setMaster",
    volume: MAX_AUDIO_GAIN,
  });
  const saved = edit(html, timeline, [fromEditor]);
  expect(saved.timeline.main?.volume).toBe(MAX_AUDIO_GAIN);
  expect(JSON.parse(parseMasterFxChain(saved.output)!)).toMatchObject({
    nodes: [{ id: "main", params: { gain: 12 } }],
  });
});

test("Main gain preserves a preexisting effect with the id main", () => {
  const sourceWithFx = source.replace(
    "<main ",
    `<main data-fx-chain='{"version":1,"nodes":[{"id":"main","type":"gain","label":"Legacy trim","params":{"gain":-6}}]}' `,
  );
  const { timeline } = parseComposition(sourceWithFx, emptyTimelineSettings());
  expect(timeline.main).toMatchObject({
    volume: 1,
    fx: [{ id: "main", label: "Legacy trim", params: { gain: -6 } }],
  });
  const moved = edit(sourceWithFx, timeline, [
    { type: "setMaster", volume: 0.5 },
  ]);
  expect(moved.output).toContain('data-cutroom-main-gain="main-2"');
  expect(JSON.parse(parseMasterFxChain(moved.output)!)).toMatchObject({
    nodes: [{ id: "main" }, { id: "main-2" }],
  });
  const reset = edit(moved.output, moved.timeline, [
    { type: "setMaster", volume: 1 },
  ]);
  expect(reset.timeline.main).toEqual(timeline.main);
  expect(reset.output).not.toContain("data-cutroom-main-gain");
});

test("changing only Main gain refuses to overwrite unreadable authored effects", () => {
  const sourceWithFx = source.replace(
    "<main ",
    `<main data-fx-chain='{"version":2,"nodes":[{"id":"original","type":"compressor"}]}' `,
  );
  const { timeline } = parseComposition(sourceWithFx, emptyTimelineSettings());
  expect(() =>
    edit(sourceWithFx, timeline, [{ type: "setMaster", volume: 0.5 }]),
  ).toThrow("Unsupported chain version: 2");
  const unrelated = edit(sourceWithFx, timeline, [
    { type: "setAudioGroup", group: "voices", volume: 0.5 },
  ]);
  expect(unrelated.output).toContain(
    `data-fx-chain='{"version":2,"nodes":[{"id":"original","type":"compressor"}]}'`,
  );
});

test("agents read each bus with its member count and Main, and refuse edits they cannot make", () => {
  const { timeline } = start();
  const read = agentTimeline(
    { ...timeline, clips: timeline.clips.slice(0, 1) },
    timeline,
  );
  expect(read.authoredAudioGroups).toEqual([
    {
      id: "voices",
      label: "Voices",
      volume: 1,
      muted: false,
      solo: false,
      fx: [],
      automated: false,
      members: 2,
    },
  ]);
  // Main is left out at unity with no effects, as the timeline holds it.
  expect(read.main).toBeUndefined();
  expect(
    agentTimeline(
      applyAll(timeline, [
        CommandSchema.parse({ type: "setMaster", volume: 0.5 }),
      ]),
    ).main,
  ).toEqual({ volume: 0.5, fx: [] });
  expect(() =>
    CommandSchema.parse({
      type: "setAudioGroup",
      group: "voices",
      clipId: "one",
      volume: 1,
    }),
  ).toThrow("not both");
  expect(() =>
    applyAll(timeline, [
      CommandSchema.parse({ type: "removeAudioGroup", group: "missing" }),
    ]),
  ).toThrow("No audio group");
  const locked = {
    ...timeline,
    tracks: timeline.tracks.map((track) => ({ ...track, locked: true })),
  };
  expect(() =>
    applyAll(locked, [
      CommandSchema.parse({
        type: "setAudioGroup",
        group: "voices",
        solo: true,
      }),
    ]),
  ).toThrow("locked");
  expect(
    editLabel(
      [
        CommandSchema.parse({
          type: "setAudioGroup",
          group: "voices",
          volume: 0.5,
        }),
      ],
      timeline,
      "",
    ),
  ).toBe("Set Voices gain to -6.0 dB");
});
