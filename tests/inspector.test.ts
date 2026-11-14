import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyAll } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  TimelineViewSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import { parseComposition } from "../src/server/timeline/composition";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import {
  formatField,
  parseField,
  timingCommands,
  inspectorSubject,
  stepField,
} from "../src/client/edit/inspector/fields";
import { reviewRows, shownChanges } from "../src/client/edit/inspector/changes";
import { editLabel } from "../src/shared/timeline/labels";
import { projectFixture } from "./project-fixture";

const fps = { num: 30000, den: 1001 };

test("an unaccepted mark written by #30 survives the new opacity projection and can be accepted", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Legacy" });
  const path = `/projects/${project.id}`;
  try {
    const source =
      '<main data-composition-id="main" data-fps="30" data-duration="1"><div id="title" data-start="0" data-duration="1" data-track-index="0">Hello</div></main>';
    await writeFile(join(project.path, "index.html"), source);
    await mkdir(join(project.path, ".cutroom"), { recursive: true });
    await writeFile(
      join(project.path, ".cutroom/review.json"),
      JSON.stringify({
        schemaVersion: 1,
        items: [],
        changes: [
          {
            composition: "index.html",
            clipId: "title",
            noteIds: [],
            // Captured with main 35eb9fd's projection and clipVersions for the source above.
            signature:
              "51000bfd544b6823c290264faa7d4bdfa09bbd642e80b75fc51491d2d30dea73",
          },
        ],
      }),
    );
    const read = async () =>
      TimelineViewSchema.parse(
        await (await fixture.request(`${path}/timeline`)).json(),
      );
    const view = await read();
    expect(view.agentChanges).toEqual(["title"]);
    expect(view.clipEdits).toHaveLength(1);
    expect(view.clipEdits![0]).toMatchObject({
      by: "agent",
      accepted: false,
      clipId: "title",
    });
    expect(
      (
        await fixture.request(`${path}/review/changes/accept`, "POST", {
          editId: view.clipEdits![0]!.id,
        })
      ).status,
    ).toBe(200);
    expect((await read()).agentChanges).toEqual([]);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      source,
    );
  } finally {
    await fixture.close();
  }
});

test("inspector fields parse timecode, frames, seconds and percentages without accepting trailing junk", () => {
  expect(parseField("00:01:02:03", "timecode", fps)).toBe(1863);
  expect(parseField("1204", "timecode", fps)).toBe(364);
  expect(parseField("45f", "timecode", fps)).toBe(45);
  expect(parseField("1.001s", "timecode", fps)).toBe(30);
  expect(parseField("150 %", "percent", fps)).toBe(1.5);
  for (const input of ["", "NaN", "12px", "-1f", "1:23", "00:00:01:01junk"])
    expect(() => parseField(input, "timecode", fps)).toThrow();
  for (const input of ["Infinity", "5%junk", "-10%"])
    expect(() => parseField(input, "percent", fps)).toThrow();
});

test("a percentage shows every digit the engine keeps", () => {
  const opacity = parseField("12.3456%", "percent", fps);
  expect(formatField(opacity, "percent", fps)).toBe("12.3456%");
});

test("inspector timing uses normal move and trim, changes linked source timing, and refuses overlaps and exhausted media", () => {
  const html = `<main data-composition-id="main" data-fps="30" data-duration="6">
    <video id="picture" data-start="0" data-duration="2" data-track-index="0" data-link="pair"></video>
    <audio id="voice" data-start="0" data-duration="2" data-track-index="1" data-link="pair"></audio>
    <div id="next" data-start="3" data-duration="2" data-track-index="0"></div>
  </main>`;
  const timeline = parseComposition(html, emptyTimelineSettings()).timeline;
  const apply = (field: Parameters<typeof timingCommands>[2], value: number) =>
    applyAll(
      timeline,
      timingCommands(timeline, "picture", field, value).map((command) =>
        CommandSchema.parse(command),
      ),
    );
  expect(
    apply("start", 15)
      .clips.filter((clip) => clip.link)
      .map((clip) => clip.start),
  ).toEqual([15, 15]);
  expect(
    apply("duration", 45)
      .clips.filter((clip) => clip.link)
      .map((clip) => clip.duration),
  ).toEqual([45, 45]);
  expect(
    apply("speed", 1.5)
      .clips.filter((clip) => clip.link)
      .map((clip) => clip.playbackRate),
  ).toEqual([1.5, 1.5]);
  expect(
    apply("sourceIn", 30)
      .clips.filter((clip) => clip.link)
      .map((clip) => clip.mediaStart),
  ).toEqual([1, 1]);
  const splitEdit = {
    ...timeline,
    clips: timeline.clips.map((clip) =>
      clip.id === "voice" ? { ...clip, start: 15, mediaStart: 0.5 } : clip,
    ),
  };
  const retimed = applyAll(splitEdit, [
    CommandSchema.parse({
      type: "setTiming",
      clipId: "picture",
      playbackRate: 2,
      mediaStart: 1,
    }),
  ]);
  expect(retimed.clips.find((clip) => clip.id === "voice")?.mediaStart).toBe(2);
  expect(() => apply("start", 60)).toThrow("overlap");
  const bounded = {
    ...timeline,
    clips: timeline.clips.map((clip) =>
      clip.link ? { ...clip, sourceDuration: 2 } : clip,
    ),
  };
  expect(() =>
    applyAll(bounded, [
      CommandSchema.parse({
        type: "setTiming",
        clipId: "picture",
        playbackRate: 2,
      }),
    ]),
  ).toThrow("end of its source");
});

test("static opacity preserves other CSS, reads back exactly, and takes one undo step; timing refuses unsupported clips", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Inspector" });
  const path = `/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
  try {
    const file = join(project.path, "index.html");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        'id="headline"',
        'id="headline" style="color: red; background-image: url(\'a;b.svg\'); opacity: 25% !important"',
      ),
    );
    const before = await read();
    expect(
      before.timeline.clips.find((clip) => clip.id === "headline")?.opacity,
    ).toBe(0.25);
    const response = await fixture.request(`${path}/commands`, "POST", {
      expectedRevision: before.revision,
      label: "Set opacity",
      commands: [{ type: "setClip", clipId: "headline", opacity: 0.6 }],
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const edited = TimelineViewSchema.parse(await response.json());
    expect((await read()).timeline).toEqual(edited.timeline);
    expect(
      edited.timeline.clips.find((clip) => clip.id === "headline")?.opacity,
    ).toBe(0.6);
    expect(await readFile(file, "utf8")).toContain("a;b.svg");
    await fixture.request(`${path}/history/undo`, "POST");
    expect((await read()).timeline).toEqual(before.timeline);
    const invalid = await fixture.request(`${path}/commands`, "POST", {
      expectedRevision: (await read()).revision,
      commands: [{ type: "setTiming", clipId: "headline", playbackRate: 2 }],
    });
    expect(invalid.status).toBe(422);
  } finally {
    await fixture.close();
  }
});

test("the Changes ledger credits owner and agent, accepts one edit at a time and preserves other clips' marks", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Ledger" });
  const path = `/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
  const edit = async (clipId: string, label: string, agent: boolean) => {
    const response = await fixture.app.request(`/api/cutroom${path}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(agent && { "x-cutroom-agent": "external" }),
      },
      body: JSON.stringify({
        expectedRevision: (await read()).revision,
        label,
        commands: [{ type: "setClip", clipId, label }],
      }),
    });
    expect(response.status).toBe(200);
    return TimelineViewSchema.parse(await response.json());
  };
  try {
    await edit("headline", "Owner title", false);
    await edit("headline", "Agent title", true);
    await edit("headline", "Agent second edit", true);
    const view = await edit("caption", "Agent caption", true);
    expect(view.clipEdits?.map((edit) => edit.by)).toEqual([
      "human",
      "agent",
      "agent",
      "agent",
    ]);
    const pending = view.clipEdits!.filter(
      (edit) => edit.clipId === "headline" && !edit.accepted,
    );
    await fixture.request(`${path}/review/changes/accept`, "POST", {
      editId: pending[0]!.id,
    });
    expect((await read()).agentChanges).toContain("headline");
    await fixture.request(`${path}/review/changes/accept`, "POST", {
      editId: pending[1]!.id,
    });
    // A second surface accepting the same change (stale view) succeeds without an error.
    expect(
      (
        await fixture.request(`${path}/review/changes/accept`, "POST", {
          editId: pending[0]!.id,
        })
      ).status,
    ).toBe(200);
    const accepted = await read();
    expect(accepted.agentChanges).toEqual(["caption"]);
    expect(
      accepted
        .clipEdits!.filter((edit) => edit.clipId === "headline")
        .every((edit) => edit.accepted),
    ).toBe(true);
    await edit("caption", "Getting started", false);
    expect((await read()).agentChanges).toEqual([]);
    expect(
      (await read()).clipEdits!.find((edit) => edit.label === "Agent caption"),
    ).toMatchObject({ accepted: false, resolution: "source" });
    await fixture.request(`${path}/history/undo`, "POST");
    expect((await read()).agentChanges).toEqual(["caption"]);
    expect(
      (await read()).clipEdits!.find((edit) => edit.label === "Agent caption"),
    ).toMatchObject({ accepted: false });
    expect(
      (await read()).clipEdits!.find((edit) => edit.label === "Agent caption")
        ?.resolution,
    ).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

test("undo hides owner and agent rows; redo restores the same pending edit without accepting it", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Undo ledger" });
  const path = `/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
  try {
    for (const agent of [false, true]) {
      const before = await read();
      const response = await fixture.app.request(
        `/api/cutroom${path}/commands`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(agent && { "x-cutroom-agent": "external" }),
          },
          body: JSON.stringify({
            expectedRevision: before.revision,
            label: "Set opacity to 30%",
            commands: [{ type: "setClip", clipId: "headline", opacity: 0.3 }],
          }),
        },
      );
      expect(response.status).toBe(200);
      const edited = await read();
      const row = edited.clipEdits!.at(-1)!;
      expect(row.historyId).toBeTruthy();
      await fixture.request(`${path}/history/undo`, "POST");
      const undone = await read();
      expect(undone.clipEdits?.some((edit) => edit.id === row.id)).toBe(false);
      expect(
        undone.timeline.clips.find((clip) => clip.id === "headline")?.opacity,
      ).toBe(null);
      if (agent)
        expect(
          (
            await fixture.request(`${path}/review/changes/accept`, "POST", {
              editId: row.id,
            })
          ).status,
        ).toBe(409);
      await fixture.request(`${path}/history/redo`, "POST");
      expect((await read()).clipEdits!.at(-1)).toEqual(row);
      if (agent) {
        expect(row.accepted).toBe(false);
        expect(row.resolution).toBeUndefined();
        expect((await read()).agentChanges).toEqual(["headline"]);
        await fixture.request(`${path}/review/changes/accept`, "POST", {
          editId: row.id,
        });
        expect((await read()).clipEdits!.at(-1)?.accepted).toBe(true);
        expect((await read()).agentChanges).toEqual([]);
      }
      await fixture.request(`${path}/history/undo`, "POST");
    }
  } finally {
    await fixture.close();
  }
});

test("Changes shows five recent rows, always includes older pending work, and expands in date order", () => {
  const edits = Array.from({ length: 15 }, (_, index) => ({
    id: String(index),
    clipId: "title",
    composition: "index.html",
    label: "Set opacity",
    by: "human" as const,
    at: "",
    accepted: true,
  }));
  expect(shownChanges(edits, false).map((edit) => edit.id)).toEqual([
    "14",
    "13",
    "12",
    "11",
    "10",
  ]);
  const pending = { ...edits[0]!, by: "agent" as const, accepted: false };
  const withPending = [pending, ...edits.slice(1)];
  expect(shownChanges(withPending, false).map((edit) => edit.id)).toEqual([
    "14",
    "13",
    "12",
    "11",
    "0",
  ]);
  expect(shownChanges(withPending, true)).toEqual(withPending.toReversed());
  const allPending = edits.map((edit) => ({
    ...edit,
    by: "agent" as const,
    accepted: false,
  }));
  expect(shownChanges(allPending, false)).toHaveLength(15);
});

test("away from its clip, an edit label names the clip and says how far it changed", () => {
  const timeline = parseComposition(
    '<main data-composition-id="main" data-fps="30" data-duration="6"><img id="still" class="clip" src="media/still.png" data-start="2" data-duration="2" data-track-index="0"><video id="shot" class="clip" src="media/shot.mp4" data-start="0" data-duration="2" data-track-index="1"></video></main>',
    emptyTimelineSettings(),
  ).timeline;
  const label = (command: unknown) =>
    editLabel([CommandSchema.parse(command)], timeline, "Edit", "done");
  expect(label({ type: "trim", clipId: "still", edge: "end", to: 150 })).toBe(
    "Extended still.png by 1 s",
  );
  expect(
    label({
      type: "trim",
      clipId: "still",
      edge: "start",
      to: 72,
      ripple: true,
    }),
  ).toBe("Shortened still.png by 12 frames at its start, with ripple");
  expect(label({ type: "move", clipIds: ["shot"], by: 15 })).toBe(
    "Moved shot.mp4 15 frames right",
  );
  expect(
    label({ type: "remove", clipIds: ["shot", "still"], ripple: true }),
  ).toBe("Ripple deleted shot.mp4 and still.png");
  expect(label({ type: "setClip", clipId: "still", opacity: 0.5 })).toBe(
    "Set opacity to 50% for still.png",
  );
  expect(
    reviewRows(
      [
        "Extended still.png by 1 s",
        "Edited index.html composition",
        "Edited index.html composition",
      ].map((label, index) => ({
        id: `edit-${index}`,
        clipId: null,
        composition: "index.html",
        label,
        at: "2026-01-01T00:00:00.000Z",
        by: "agent" as const,
        accepted: false,
      })),
    ).map((row) => [row.label, row.count]),
  ).toEqual([
    ["Extended still.png by 1 s", 1],
    ["Edited index.html composition", 2],
  ]);
});

test("edit labels describe the commands with past tense and the actual values", () => {
  const timeline = parseComposition(
    '<main data-composition-id="main" data-fps="30" data-duration="6"></main>',
    emptyTimelineSettings(),
  ).timeline;
  const label = (commands: unknown[]) =>
    editLabel(
      commands.map((command) => CommandSchema.parse(command)),
      timeline,
      "Edit",
    );
  expect(label([{ type: "move", clipIds: ["title"], by: 15 }])).toBe(
    "Moved 15 frames right",
  );
  expect(
    label([{ type: "move", clipIds: ["title"], by: -1, trackBy: 2 }]),
  ).toBe("Moved 1 frame left and 2 tracks up");
  expect(label([{ type: "trim", clipId: "title", edge: "end", to: 165 }])).toBe(
    "Trimmed end to 00:00:05:15",
  );
  expect(label([{ type: "setClip", clipId: "title", opacity: 0.5 }])).toBe(
    "Set opacity to 50%",
  );
  expect(label([{ type: "setClip", clipId: "title", opacity: null }])).toBe(
    "Set opacity to Auto",
  );
  expect(
    label([
      {
        type: "setTiming",
        clipId: "title",
        playbackRate: 1.5,
        mediaStart: 1.5,
      },
    ]),
  ).toBe("Set speed to 150%; Set source in to 00:00:01:15");
  expect(
    label([
      { type: "trim", clipId: "title", edge: "start", to: 15, ripple: true },
    ]),
  ).toBe("Ripple trimmed start to 00:00:00:15");
});

test("a complete linked selection is one picture subject with its audio, while unrelated and partial selections remain multiple", () => {
  const timeline = parseComposition(
    `<main data-composition-id="main" data-fps="30" data-duration="8">
    <video id="picture" muted data-link="pair" data-start="0" data-duration="8" data-track-index="0"></video>
    <audio id="sound" data-link="pair" data-start="0" data-duration="8" data-track-index="1"></audio>
    <audio id="music" data-start="0" data-duration="8" data-track-index="2"></audio>
  </main>`,
    emptyTimelineSettings(),
  ).timeline;
  for (const anchor of ["picture", "sound", null]) {
    const subject = inspectorSubject(timeline, {
      ids: new Set(["picture", "sound"]),
      anchor,
    });
    expect(subject?.clip.id).toBe("picture");
    expect(subject?.audio.map((clip) => clip.id)).toEqual(["sound"]);
  }
  expect(
    inspectorSubject(timeline, {
      ids: new Set(["picture", "sound", "music"]),
      anchor: "picture",
    }),
  ).toBeNull();
  expect(
    inspectorSubject(timeline, { ids: new Set(["sound"]), anchor: "sound" })
      ?.clip.id,
  ).toBe("sound");
  const group = {
    ...timeline,
    clips: timeline.clips.map((clip) => ({ ...clip, link: "pair" })),
  };
  expect(
    inspectorSubject(group, {
      ids: new Set(["picture", "sound"]),
      anchor: "picture",
    }),
  ).toBeNull();
  expect(
    inspectorSubject(group, {
      ids: new Set(["picture", "sound", "music"]),
      anchor: "picture",
    })?.audio,
  ).toHaveLength(2);
});

test("gain fields round-trip linear gain through signed dB, including silence and fine steps", () => {
  expect(parseField("-6 dB", "gain", fps)).toBe(10 ** (-6 / 20));
  expect(parseField("+12", "gain", fps)).toBe(10 ** (12 / 20));
  expect(parseField("-∞ dB", "gain", fps)).toBe(0);
  expect(parseField("-Infinity", "gain", fps)).toBe(0);
  expect(formatField(0, "gain", fps)).toBe("-∞ dB");
  expect(formatField(1, "gain", fps)).toBe("0.0 dB");
  for (const db of [-59.9, -6.1, 0, 6, 12]) {
    const gain = 10 ** (db / 20);
    expect(parseField(formatField(gain, "gain", fps), "gain", fps)).toBeCloseTo(
      gain,
      12,
    );
  }
  expect(formatField(stepField(1, -0.1, "gain"), "gain", fps)).toBe("-0.1 dB");
  expect(stepField(1, -61, "gain")).toBe(0);
  expect(formatField(stepField(0, 1, "gain"), "gain", fps)).toBe("-59.0 dB");
  expect(stepField(1, 20, "gain")).toBe(10 ** (12 / 20));
  // Below the -60 dB floor is silence, so stepping up from a typed -70 dB raises the level.
  const quiet = parseField("-70 dB", "gain", fps);
  expect(quiet).toBe(0);
  expect(parseField("-9999", "gain", fps)).toBe(0);
  expect(stepField(quiet, 1, "gain")).toBeGreaterThan(quiet);
  for (const input of ["NaN", "+Infinity", "6dBjunk", "1e5", "", "9999"])
    expect(() => parseField(input, "gain", fps)).toThrow();
});

test("position fields accept signed pixels and step at composition scale", () => {
  expect(parseField("-40.125 px", "pixels", fps)).toBe(-40.125);
  expect(parseField("+12", "pixels", fps)).toBe(12);
  expect(formatField(-40.125, "pixels", fps)).toBe("-40.125 px");
  expect(stepField(-40.125, 10, "pixels")).toBe(-30.125);
  for (const input of ["", "NaN", "Infinity", "40%", "4pxjunk"])
    expect(() => parseField(input, "pixels", fps)).toThrow();
});

test("position round-trips native baselines, preserves CSS and linked audio, and undoes as one step", async () => {
  const fixture = await projectFixture();
  const routes = createTimelineRoutes(fixture.store, fixture.review);
  fixture.app.route("/api/cutroom", routes);
  const project = await fixture.store.create({ name: "Position" });
  const path = `/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
  const edit = async (commands: unknown[]) =>
    fixture.request(`${path}/commands`, "POST", {
      expectedRevision: (await read()).revision,
      commands,
    });
  try {
    const file = join(project.path, "index.html");
    const source =
      '<main data-composition-id="main" data-fps="30" data-duration="2"><video id="picture" src="missing.mp4" muted data-link="pair" data-start="0" data-duration="2" data-track-index="0" data-x="12.25" style="left:30px;transform:rotate(5deg)"></video><audio id="sound" src="missing.mp4" data-link="pair" data-start="0" data-duration="2" data-track-index="1"></audio></main>';
    await writeFile(file, source);
    const before = await read();
    const response = await edit([
      { type: "setClip", clipId: "picture", x: 40.123456, y: -12.5 },
    ]);
    expect(response.status, await response.clone().text()).toBe(200);
    const moved = TimelineViewSchema.parse(await response.json());
    expect((await read()).timeline).toEqual(moved.timeline);
    expect(
      moved.timeline.clips.find((clip) => clip.id === "picture"),
    ).toMatchObject({ x: 40.123456, y: -12.5 });
    expect(moved.timeline.clips.find((clip) => clip.id === "sound")).toEqual(
      before.timeline.clips.find((clip) => clip.id === "sound"),
    );
    const html = await readFile(file, "utf8");
    expect(html).toContain('data-x="52.373456"');
    expect(html).toContain('data-hf-edit-base-x="12.25"');
    expect(html).toContain('data-hf-edit-base-y="0"');
    expect(html).toContain('style="left:30px;transform:rotate(5deg)"');
    await edit([{ type: "setClip", clipId: "picture", x: null, y: null }]);
    expect(await readFile(file, "utf8")).toBe(source);
    await fixture.request(`${path}/history/undo`, "POST");
    expect((await read()).timeline).toEqual(moved.timeline);
    await fixture.request(`${path}/history/undo`, "POST");
    expect((await read()).timeline).toEqual(before.timeline);
    expect(
      (await edit([{ type: "setClip", clipId: "sound", x: 40 }])).status,
    ).toBe(422);
  } finally {
    await fixture.close();
  }
});

test("position edits name the distance moved rather than an absolute coordinate", () => {
  const timeline = parseComposition(
    '<main data-composition-id="main" data-duration="2"><div id="title" data-start="0" data-duration="2" data-x="20" data-hf-edit-base-x="10"></div></main>',
    emptyTimelineSettings(),
  ).timeline;
  const label = (x: number | null, y?: number | null) =>
    editLabel(
      [
        CommandSchema.parse({
          type: "setClip",
          clipId: "title",
          x,
          ...(y !== undefined && { y }),
        }),
      ],
      timeline,
      "Position",
    );
  expect(label(50)).toBe("Moved 40 px right");
  expect(label(-30, -10)).toBe("Moved 40 px left; Moved 10 px up");
  expect(label(null, null)).toBe("Reset position");
});
