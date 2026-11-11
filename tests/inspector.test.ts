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
} from "../src/client/edit/inspector/fields";
import { shownChanges } from "../src/client/edit/inspector/changes";
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
    const accepted = await read();
    expect(accepted.agentChanges).toEqual(["caption"]);
    expect(
      accepted
        .clipEdits!.filter((edit) => edit.clipId === "headline")
        .every((edit) => edit.accepted),
    ).toBe(true);
    await edit("caption", "Owner caption", false);
    expect((await read()).agentChanges).toEqual([]);
    expect(
      (await read()).clipEdits!.find((edit) => edit.label === "Agent caption"),
    ).toMatchObject({ accepted: false, resolution: "owner" });
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

test.each(["external edit", "restore", "owner edit"] as const)(
  "a rename superseded by %s stays resolved after another agent edit",
  async (replacement) => {
    const fixture = await projectFixture();
    fixture.app.route(
      "/api/cutroom",
      createTimelineRoutes(fixture.store, fixture.review),
    );
    const project = await fixture.store.create({ name: "Superseded rename" });
    const path = `/projects/${project.id}`;
    const read = async () =>
      TimelineViewSchema.parse(
        await (await fixture.request(`${path}/timeline`)).json(),
      );
    const edit = async (
      label: string,
      change: { label: string } | { opacity: number },
      agent = true,
    ) => {
      const response = await fixture.app.request(
        `/api/cutroom${path}/commands`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(agent && { "x-cutroom-agent": "external" }),
          },
          body: JSON.stringify({
            expectedRevision: (await read()).revision,
            label,
            commands: [{ type: "setClip", clipId: "caption", ...change }],
          }),
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return TimelineViewSchema.parse(await response.json());
    };
    try {
      await read();
      const history = await fixture.store.history(project);
      await history.checkpoint();
      const point = history.list().at(-1)?.id ?? "start";
      const renamed = await edit("Renamed caption", { label: "Agent rename" });
      const rename = renamed.clipEdits!.at(-1)!;
      if (replacement === "restore") {
        await fixture.review
          .history(project, history, { kind: "human" })
          .restore(point, { kind: "person", name: "You" });
      } else if (replacement === "owner edit") {
        await edit("Owner rename", { label: "Owner name" }, false);
      } else {
        const file = join(project.path, "index.html");
        await writeFile(
          file,
          (await readFile(file, "utf8")).replace(
            "Agent rename",
            "External name",
          ),
        );
      }
      const resolution = replacement === "owner edit" ? "owner" : "source";
      expect(
        (await read()).clipEdits!.find((row) => row.id === rename.id),
      ).toMatchObject({ accepted: false, resolution });

      const changed = await edit("Set opacity to 40%", { opacity: 0.4 });
      const opacity = changed.clipEdits!.at(-1)!;
      expect(
        changed.clipEdits!.find((row) => row.id === rename.id),
      ).toMatchObject({ accepted: false, resolution });
      expect(opacity.resolution).toBeUndefined();
      expect(
        (
          await fixture.request(`${path}/review/changes/accept`, "POST", {
            editId: rename.id,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await fixture.request(`${path}/review/changes/accept`, "POST", {
            editId: opacity.id,
          })
        ).status,
      ).toBe(200);
      expect((await read()).agentChanges).toEqual([]);

      await fixture.request(`${path}/history/undo`, "POST");
      await fixture.request(`${path}/history/undo`, "POST");
      const undone = await read();
      expect(
        undone.timeline.clips.find((clip) => clip.id === "caption")?.label,
      ).toBe("Agent rename");
      expect(
        undone.clipEdits!.find((row) => row.id === rename.id)?.resolution,
      ).toBeUndefined();
      expect(undone.agentChanges).toEqual(["caption"]);
      await fixture.request(`${path}/history/redo`, "POST");
      expect(
        (await read()).clipEdits!.find((row) => row.id === rename.id),
      ).toMatchObject({ accepted: false, resolution });
    } finally {
      await fixture.close();
    }
  },
);

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
