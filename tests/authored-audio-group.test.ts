import { expect, test } from "bun:test";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { parseAudioElements } from "@hyperframes/engine";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editReply } from "../src/server/mcp/timelineReply";
import { applyAll } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
  TimelineViewSchema,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  parseComposition,
  patchComposition,
  settingsOf,
  timelineContent,
} from "../src/server/timeline/composition";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";

const source = `<main data-composition-id="main" data-duration="4"><hf-audio-group id="dialogue" data-volume='0.8' data-hidden data-fx-chain='{"version":1,"nodes":[]}' data-automation='{"version":1,"lanes":[]}'></hf-audio-group><audio id="one" src="one.wav" data-audio-group="dialogue" data-start="0" data-duration="4" data-track-index="1" data-volume="0.4"></audio><audio id="two" src="two.wav" data-audio-group="dialogue" data-start="0" data-duration="4" data-track-index="2"></audio><audio id="outside" src="three.wav" data-start="0" data-duration="4" data-track-index="3"></audio></main>`;

const routedSource = `<main data-composition-id="main" data-width="320" data-height="240" data-duration="4"><audio id="one" src="one.wav" data-start="0" data-duration="4" data-track-index="1"></audio><audio id="two" src="two.wav" data-start="0" data-duration="4" data-track-index="2"></audio></main>`;
const createGroup = {
  type: "routeAudioGroup",
  clipIds: ["one"],
  group: { label: "Dialogue", volume: 0.25 },
} satisfies CommandInput;
const groupGain = {
  type: "setAudioGroup",
  clipId: "one",
  volume: 0.5,
} satisfies CommandInput;
const offTimeline =
  '<audio id="unselected" src="voice.wav" data-duration="4" data-audio-group="dialogue"></audio>';
const scene = (id: string, body: string) =>
  `<template><main data-composition-id="${id}" data-duration="4">${body}</main></template>`;
const host = (id: string, src: string, start = 0) =>
  `<div id="${id}" data-composition-id="${id}" data-composition-src="${src}" data-start="${start}" data-duration="4" data-track-index="0"></div>`;
const entry = (body: string) =>
  `<main data-composition-id="main" data-duration="8" data-width="320" data-height="240">${body}</main>`;
const lead = `<template>${routedSource.replace('data-composition-id="main"', 'data-composition-id="lead"')}</template>`;

async function groupFixture() {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Audio group identity" });
  const api = `/projects/${project.id}`;
  const get = (composition = "index.html") =>
    fixture.request(`${api}/timeline?composition=${composition}`);
  const read = async (composition: string) =>
    TimelineViewSchema.parse(await (await get(composition)).json());
  return {
    ...fixture,
    project,
    get,
    read,
    write: (path: string, html: string) =>
      writeFile(join(project.path, path), html),
    source: (path: string) => readFile(join(project.path, path), "utf8"),
    undo: () => fixture.request(`${api}/history/undo`, "POST", {}),
    async edit(
      composition: string,
      commands: CommandInput[],
      revision?: string,
    ) {
      return fixture.request(`${api}/commands`, "POST", {
        composition,
        expectedRevision: revision ?? (await read(composition)).revision,
        commands,
      });
    },
    async mix() {
      const compiled = await bundleToSingleHtml(project.path, {
        runtime: "placeholder",
        staticGuard: false,
        inlineAssets: false,
      });
      return parseAudioElements(compiled);
    },
  };
}

test("creating a named group leaves standalone and nested authored references at unity", async () => {
  const fixture = await groupFixture();
  try {
    const html = routedSource.replace(
      "</main>",
      `${offTimeline}<div id="inline" data-composition-id="inline" data-start="0" data-duration="4">${offTimeline.replace("unselected", "inline-audio")}</div></main>`,
    );
    await fixture.write("index.html", html);
    expect(
      CommandSchema.safeParse({
        ...createGroup,
        group: { id: "dialogue", label: "Dialogue" },
      }).success,
    ).toBe(false);
    const response = await fixture.edit("index.html", [createGroup]);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const view = TimelineViewSchema.parse(body);
    const group = view.timeline.authoredAudioGroups?.[0];
    expect(group).toEqual({
      id: expect.stringMatching(/^cutroom-bus-/),
      label: "Dialogue",
      volume: 0.25,
    });
    expect(
      view.timeline.clips.find(({ id }) => id === "one")?.authoredAudioGroupId,
    ).toBe(group?.id);
    const mix = await fixture.mix();
    for (const id of ["unselected", "inline-audio"]) {
      expect(mix.find((track) => track.id === id)).toMatchObject({
        groupId: "dialogue",
        groupVolume: 1,
      });
    }
    expect((await fixture.undo()).status).toBe(200);
    expect(await fixture.source("index.html")).toBe(html);
  } finally {
    await fixture.close();
  }
});

test("inserting a pickup cannot capture its authored reference in the parent mix", async () => {
  const fixture = await groupFixture();
  try {
    const parent = entry(host("lead", "lead.html"));
    const pickup = scene("pickup", offTimeline);
    await fixture.write("index.html", parent);
    await fixture.write("lead.html", lead);
    await fixture.write("pickup.html", pickup);
    expect((await fixture.edit("lead.html", [createGroup])).status).toBe(200);
    expect(
      (
        await fixture.edit("index.html", [
          {
            type: "insert",
            track: 0,
            at: 120,
            clip: { kind: "composition", src: "pickup.html", duration: 120 },
          },
        ])
      ).status,
    ).toBe(200);
    const mix = await fixture.mix();
    expect(mix.find(({ id }) => id === "one")?.groupVolume).toBe(0.25);
    expect(mix.find(({ id }) => id === "unselected")).toMatchObject({
      groupId: "dialogue",
      groupVolume: 1,
    });
    expect((await fixture.undo()).status).toBe(200);
    expect(await fixture.source("index.html")).toBe(parent);
    expect((await fixture.undo()).status).toBe(200);
    expect(await fixture.source("lead.html")).toBe(lead);
    expect(await fixture.source("pickup.html")).toBe(pickup);
  } finally {
    await fixture.close();
  }
});

test("a broken sibling mount does not block reading or editing a grouped scene", async () => {
  const fixture = await groupFixture();
  try {
    await fixture.write("index.html", entry(host("lead", "lead.html")));
    await fixture.write("lead.html", lead);
    await fixture.write(
      "broken",
      "This is a file, so reading below it fails with ENOTDIR.",
    );
    expect((await fixture.edit("lead.html", [createGroup])).status).toBe(200);
    const { revision } = await fixture.read("lead.html");
    await fixture.write(
      "index.html",
      entry(host("lead", "lead.html") + host("broken", "broken/scene.html")),
    );
    expect((await fixture.get("lead.html")).status).toBe(200);
    const response = await fixture.edit(
      "lead.html",
      [{ type: "setClip", clipId: "one", volume: 0.8 }],
      revision,
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const { timeline } = TimelineViewSchema.parse(body);
    expect(timeline.clips.find(({ id }) => id === "one")?.volume).toBe(0.8);
  } finally {
    await fixture.close();
  }
});

test("a reused template shares source edits and loads the compiler's nested scene", async () => {
  const fixture = await groupFixture();
  try {
    await mkdir(join(fixture.project.path, "scenes"));
    await fixture.write(
      "index.html",
      entry(
        host("lead", "scenes/lead.html") +
          host("lead-copy", "scenes/lead.html", 4),
      ),
    );
    await fixture.write(
      "scenes/lead.html",
      lead.replace("</main>", host("nested", "nested.html") + "</main>"),
    );
    await fixture.write(
      "nested.html",
      scene("nested", offTimeline.replace("voice.wav", "root.wav")),
    );
    await fixture.write(
      "scenes/nested.html",
      scene("nested", offTimeline.replace("voice.wav", "unused.wav")),
    );
    const response = await fixture.edit("scenes/lead.html", [createGroup]);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const { timeline } = TimelineViewSchema.parse(body);
    const id = timeline.authoredAudioGroups![0]!.id;
    expect(
      (
        await fixture.edit("scenes/lead.html", [
          { type: "routeAudioGroup", clipIds: ["two"], group: id },
          groupGain,
        ])
      ).status,
    ).toBe(200);
    const mix = await fixture.mix();
    const routed = mix.filter(
      ({ src }) => src.endsWith("one.wav") || src.endsWith("two.wav"),
    );
    expect(routed.map(({ groupVolume }) => groupVolume)).toEqual([
      0.5, 0.5, 0.5, 0.5,
    ]);
    expect(new Set(routed.map(({ groupId }) => groupId)).size).toBe(2);
    expect(
      mix
        .filter(({ src }) => src.endsWith("root.wav"))
        .map(({ groupVolume }) => groupVolume),
    ).toEqual([1, 1]);
    expect(mix.some(({ src }) => src.endsWith("unused.wav"))).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("creating an audio group and moving members writes the same bus the renderer hears", () => {
  const parsed = parseComposition(source, emptyTimelineSettings());
  const after = applyAll(parsed.timeline, [
    {
      type: "routeAudioGroup",
      clipIds: ["one", "outside"],
      group: { label: 'Lead "Vox"' },
    },
    { type: "setAudioGroup", clipId: "one", volume: 0.25 },
  ]);
  const output = patchComposition(parsed, after, new Map());
  const written = parseComposition(output, settingsOf(after));
  expect(timelineContent(written.timeline)).toEqual(timelineContent(after));
  const { id } = after.authoredAudioGroups!.find(
    ({ label }) => label === 'Lead "Vox"',
  )!;
  expect(id).toMatch(/^cutroom-bus-/);
  expect(written.timeline.authoredAudioGroups).toContainEqual({
    id,
    label: 'Lead "Vox"',
    volume: 0.25,
  });
  expect(
    parseAudioElements(output)
      .filter(({ groupId }) => groupId === id)
      .map(({ groupVolume }) => groupVolume),
  ).toEqual([0.25, 0.25]);
  expect(output).toContain(
    source.slice(source.indexOf("<hf-audio-group"), source.indexOf("<audio")),
  );
  const returned = applyAll(written.timeline, [
    { type: "routeAudioGroup", clipIds: ["outside"], group: null },
    { type: "setTrack", index: 3, volume: 0.5 },
  ]);
  const restoredMix = patchComposition(written, returned, new Map());
  expect(
    timelineContent(
      parseComposition(restoredMix, settingsOf(returned)).timeline,
    ),
  ).toEqual(timelineContent(returned));
  expect(
    parseAudioElements(restoredMix).find(({ src }) => src === "three.wav")
      ?.groupVolume,
  ).toBe(0.5);
});

test("authored group gain writes only its fader and updates every member together", () => {
  const parsed = parseComposition(source, emptyTimelineSettings());
  const command = CommandSchema.parse({
    type: "setAudioGroup",
    clipId: "one",
    volume: 0.25,
  });
  const after = applyAll(parsed.timeline, [command]);
  const output = patchComposition(parsed, after, new Map());
  expect(output).toBe(
    source.replace("data-volume='0.8'", "data-volume='0.25'"),
  );
  expect(after.authoredAudioGroups).toEqual([{ id: "dialogue", volume: 0.25 }]);
  expect(after.clips).toEqual(parsed.timeline.clips);
  const audible = output.replace(" data-hidden", "");
  expect(
    parseAudioElements(audible)
      .filter((clip) => clip.groupId === "dialogue")
      .map((clip) => clip.groupVolume),
  ).toEqual([0.25, 0.25]);
});

test("authored group edits refuse a locked member, missing group and managed track bus", () => {
  const parsed = parseComposition(source, emptyTimelineSettings());
  const locked = {
    ...parsed.timeline,
    tracks: parsed.timeline.tracks.map((track) => ({
      ...track,
      locked: track.index === 2,
    })),
  };
  expect(() =>
    applyAll(locked, [{ type: "setAudioGroup", clipId: "one", volume: 0.5 }]),
  ).toThrow("locked");
  expect(() =>
    applyAll(locked, [{ type: "setAudioGroup", clipId: "one", volume: 0.8 }]),
  ).toThrow("locked");
  for (const html of [
    source.replace('id="dialogue"', 'id="missing"'),
    source.replace('id="dialogue"', 'id="dialogue" data-cutroom-track="1"'),
  ]) {
    const timeline = parseComposition(html, emptyTimelineSettings()).timeline;
    expect(() =>
      applyAll(timeline, [
        { type: "setAudioGroup", clipId: "one", volume: 0.5 },
      ]),
    ).toThrow("no editable authored audio group");
  }
});

test("an authored group edit uses one history step and Undo restores exact source", async () => {
  const fixture = await projectFixture();
  try {
    fixture.app.route(
      "/api/cutroom",
      createTimelineRoutes(fixture.store, fixture.review),
    );
    const project = await fixture.store.create({ name: "Authored bus" });
    const path = join(project.path, "index.html");
    await writeFile(path, source);
    const api = `/projects/${project.id}`;
    const before = TimelineViewSchema.parse(
      await (await fixture.request(`${api}/timeline`)).json(),
    );
    const response = await fixture.request(`${api}/commands`, "POST", {
      expectedRevision: before.revision,
      commands: [{ type: "setAudioGroup", clipId: "one", volume: 0.25 }],
    });
    expect(response.status).toBe(200);
    const after = TimelineViewSchema.parse(await response.json());
    const { changes } = editReply(before, after, false);
    expect(changes.authoredAudioGroups).toEqual({
      changed: [{ id: "dialogue", volume: 0.25 }],
    });
    expect(changes.clips).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(
      source.replace("data-volume='0.8'", "data-volume='0.25'"),
    );
    const history = await (await fixture.request(`${api}/history`)).json();
    expect(history.entries).toHaveLength(1);
    expect(
      (await fixture.request(`${api}/history/undo`, "POST", {})).status,
    ).toBe(200);
    expect(await readFile(path, "utf8")).toBe(source);

    await writeFile(
      join(project.path, "scene.html"),
      `<main data-composition-id="scene" data-duration="4" data-width="320" data-height="240"><audio src="two.wav" data-start="0" data-duration="4" data-audio-group="dialogue"></audio></main>`,
    );
    const restored = TimelineViewSchema.parse(
      await (await fixture.request(`${api}/timeline`)).json(),
    );
    const insert: CommandInput = {
      type: "insert",
      track: 0,
      at: 0,
      clip: { kind: "composition", src: "scene.html", duration: 120 },
    };
    const change: CommandInput = {
      type: "setAudioGroup",
      clipId: "one",
      volume: 0.25,
    };
    for (const commands of [
      [insert, change],
      [change, insert],
    ]) {
      const refused = await fixture.request(`${api}/commands`, "POST", {
        expectedRevision: restored.revision,
        commands,
      });
      const responseBody = await refused.text();
      expect(refused.status, responseBody).toBe(422);
      expect(responseBody).toContain("External scenes can share audio group");
      expect(await readFile(path, "utf8")).toBe(source);
    }
  } finally {
    await fixture.close();
  }
});

test("group reads match public gain semantics and cannot edit a bus inside another clip", () => {
  const parsed = parseComposition(
    source.replace("data-volume='0.8'", "data-volume='0.5legacy'"),
    emptyTimelineSettings(),
  );
  expect(parsed.timeline.authoredAudioGroups).toEqual([
    { id: "dialogue", volume: 0.5 },
  ]);
  const nested = source
    .replace(
      "<hf-audio-group",
      '<div id="scene" data-start="0" data-duration="4"><hf-audio-group',
    )
    .replace("</hf-audio-group>", "</hf-audio-group></div>");
  const timeline = parseComposition(nested, emptyTimelineSettings()).timeline;
  expect(timeline.authoredAudioGroups).toBeUndefined();
  expect(
    timeline.clips.find((clip) => clip.id === "one")?.authoredAudioGroupId,
  ).toBe("dialogue");
  expect(() =>
    applyAll(timeline, [{ type: "setAudioGroup", clipId: "one", volume: 0.5 }]),
  ).toThrow("no editable authored audio group");
});

test("ambiguous, nested or externally referenced audio buses require source editing", () => {
  for (const [markup, reason] of [
    ['<div id="dialogue"></div>', "does not have a unique element id"],
    [
      '<div data-composition-id="nested" id="scene" data-start="0" data-duration="4" data-track-index="4"><audio id="child" src="child.wav" data-start="0" data-duration="4" data-audio-group="dialogue"></audio></div>',
      "has members outside this timeline",
    ],
    [
      '<div data-composition-id="nested" data-composition-src="scenes/nested.html" id="scene" data-start="0" data-duration="4" data-track-index="4"></div>',
      "External scenes can share audio group",
    ],
  ] as const) {
    const timeline = parseComposition(
      source.replace("</main>", `${markup}</main>`),
      emptyTimelineSettings(),
    ).timeline;
    expect(timeline.authoredAudioGroups?.[0]?.sourceRestriction).toContain(
      reason,
    );
    expect(() =>
      applyAll(timeline, [
        { type: "setAudioGroup", clipId: "one", volume: 0.5 },
      ]),
    ).toThrow(reason);
  }
  const scene = parseComposition(source, emptyTimelineSettings(), {
    scope: "sub-composition",
  }).timeline;
  expect(() =>
    applyAll(scene, [{ type: "setAudioGroup", clipId: "one", volume: 0.5 }]),
  ).toThrow("External scenes can share audio group");
});

test("authored bus support preserves managed track buses under legacy wrappers", () => {
  const wrapped = source.replace(
    /<hf-audio-group id="dialogue"[^<]*<\/hf-audio-group>/,
    '<div data-track-index="8" data-duration="4"><hf-audio-group id="dialogue" data-cutroom-track="1" data-volume="0.8"></hf-audio-group></div>',
  );
  const parsed = parseComposition(wrapped, emptyTimelineSettings());
  expect(
    parsed.timeline.clips.find(({ id }) => id === "one")?.trackGainWarning,
  ).toBeUndefined();
  expect(parsed.timeline.authoredAudioGroups).toBeUndefined();
});

test("a group gain change persists when the same batch removes its last member", () => {
  const parsed = parseComposition(source, emptyTimelineSettings());
  const after = applyAll(parsed.timeline, [
    { type: "setAudioGroup", clipId: "one", volume: 0.25 },
    CommandSchema.parse({ type: "remove", clipIds: ["one", "two"] }),
  ]);
  const output = patchComposition(parsed, after, new Map());
  const written = parseComposition(output, settingsOf(after));
  expect(timelineContent(written.timeline)).toEqual(timelineContent(after));
  expect(written.timeline.clips.map(({ id }) => id)).toEqual(["outside"]);
  expect(written.timeline.authoredAudioGroups).toEqual([
    { id: "dialogue", volume: 0.25 },
  ]);
});

test("pasting a clip keeps its group membership and uses the destination's current declaration", async () => {
  const fixture = await projectFixture();
  try {
    fixture.app.route(
      "/api/cutroom",
      createTimelineRoutes(fixture.store, fixture.review),
    );
    const project = await fixture.store.create({
      name: "Paste into an authored bus",
    });
    const api = `/projects/${project.id}`;
    const destination = (bus: string) =>
      `<template><main data-composition-id="scene" data-duration="4">${bus}</main></template>`;
    await writeFile(join(project.path, "index.html"), source);
    const withGroup = "with-group.html";
    const withoutGroup = "without-group.html";
    await writeFile(
      join(project.path, withGroup),
      destination(
        '<hf-audio-group id="dialogue" data-volume="0.6"></hf-audio-group>',
      ),
    );
    await writeFile(join(project.path, withoutGroup), destination(""));

    const read = async (composition: string) =>
      TimelineViewSchema.parse(
        await (
          await fixture.request(`${api}/timeline?composition=${composition}`)
        ).json(),
      );
    const edit = async (composition: string, commands: CommandInput[]) => {
      const response = await fixture.request(`${api}/commands`, "POST", {
        composition,
        expectedRevision: (await read(composition)).revision,
        commands,
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      return TimelineViewSchema.parse(result);
    };

    const before = await read("index.html");
    const copied = await fixture.request(`${api}/timeline/copy`, "POST", {
      clipIds: ["one"],
      expectedRevision: before.revision,
    });
    expect(copied.status).toBe(200);
    const clipboard = await copied.json();
    await edit("index.html", [
      { type: "setAudioGroup", clipId: "one", volume: 0.25 },
    ]);

    for (const [composition, volume] of [
      ["index.html", 0.25],
      [withGroup, 0.6],
      [withoutGroup, undefined],
    ] as const) {
      const after = await edit(composition, [
        { type: "paste", clipboardId: clipboard.id, at: 120 },
      ]);
      const pasted = after.timeline.clips.find(({ start }) => start === 120);
      expect(pasted?.authoredAudioGroupId).toBe("dialogue");
      const reloaded = await read(composition);
      expect(
        reloaded.timeline.authoredAudioGroups?.map(({ id, volume }) => ({
          id,
          volume,
        })),
      ).toEqual(
        volume === undefined ? undefined : [{ id: "dialogue", volume }],
      );
      const html = await readFile(join(project.path, composition), "utf8");
      const audible = html.replace(" data-hidden", "");
      expect(
        parseAudioElements(audible).find(({ id }) => id === pasted?.id)
          ?.groupVolume,
      ).toBe(volume ?? 1);
    }
  } finally {
    await fixture.close();
  }
});
