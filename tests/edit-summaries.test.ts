import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { AGENT_HEADER } from "../src/shared/review";
import {
  CommandSchema,
  EDIT_SUMMARY_HEADER,
  TimelineViewSchema,
} from "../src/shared/timeline/schema";
import { editLabel } from "../src/shared/timeline/labels";
import type { CommandInput } from "../src/shared/timeline/schema";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";

async function setup(name = "Card") {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Edit summaries" });
  await writeFile(
    `${project.path}/index.html`,
    `<main data-composition-id="main" data-fps="30" data-duration="2"><div id="card" class="clip" data-label="${name}" data-start="0" data-duration="2">Card</div></main>`,
  );
  const base = `/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.request(`${base}/timeline`)).json(),
    );
  return {
    ...fixture,
    project,
    read,
    send: async (commands: CommandInput[], label?: string) =>
      fixture.app.request(`/api/cutroom${base}/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [AGENT_HEADER]: "external",
        },
        body: JSON.stringify({
          expectedRevision: (await read()).revision,
          commands,
          label,
        }),
      }),
  };
}

test("a supplementary clip name at the summary boundary saves and returns HTTP 200", async () => {
  const name = `${"a".repeat(110)}\u{1f680}`;
  const f = await setup(name);
  try {
    const response = await f.send([
      { type: "trim", clipId: "card", edge: "end", to: 90 },
    ]);
    expect(response.status, await response.clone().text()).toBe(200);
    const summary = decodeURIComponent(
      response.headers.get(EDIT_SUMMARY_HEADER)!,
    );
    expect(summary).toBe(`Extended ${name}`);
    expect((await f.read()).timeline.clips[0]).toMatchObject({
      label: name,
      duration: 90,
    });
  } finally {
    await f.close();
  }
});

test("an unencodable agent label is refused before committing its edit", async () => {
  const f = await setup();
  try {
    const before = await f.read();
    const response = await f.send(
      [{ type: "trim", clipId: "card", edge: "end", to: 90 }],
      "bad \ud800 label",
    );
    expect(response.status).toBe(500);
    expect(await f.read()).toEqual(before);
    expect((await f.store.history(f.project)).list()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("batch summaries use the state immediately before each command", async () => {
  const f = await setup();
  try {
    const response = await f.send([
      { type: "move", clipIds: ["card"], by: 30, mode: "place" },
      { type: "trim", clipId: "card", edge: "end", to: 75 },
      { type: "setClip", clipId: "card", label: "New name" },
      { type: "move", clipIds: ["card"], by: 1 },
    ]);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(decodeURIComponent(response.headers.get(EDIT_SUMMARY_HEADER)!)).toBe(
      "Moved Card 30 frames right; Shortened Card by 15 frames; Renamed to New name for Card; Moved New name 1 frame right",
    );
    expect((await f.read()).timeline.clips[0]).toMatchObject({
      start: 31,
      duration: 45,
      label: "New name",
    });
  } finally {
    await f.close();
  }
});

test("an agent label stays attributed beside the factual outcome while acceptance is pending", async () => {
  const f = await setup();
  try {
    const response = await f.send(
      [{ type: "trim", clipId: "card", edge: "end", to: 90 }],
      "Accepted by owner",
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(decodeURIComponent(response.headers.get(EDIT_SUMMARY_HEADER)!)).toBe(
      'Extended Card by 1 s; Agent label: "Accepted by owner"',
    );
    const view = await f.read();
    expect(view.clipEdits?.find((edit) => edit.clipId === null)).toMatchObject({
      label: 'Extended Card by 1 s; Agent label: "Accepted by owner"',
      accepted: false,
    });
    expect((await f.store.history(f.project)).list().at(-1)?.label).toBe(
      'Trimmed end to 00:00:03:00; Agent label: "Accepted by owner"',
    );
    const refused = await f.send(
      [{ type: "trim", clipId: "card", edge: "end", to: 120 }],
      "x".repeat(121),
    );
    expect(refused.status).toBe(400);
    expect((await f.read()).revision).toBe(view.revision);
  } finally {
    await f.close();
  }
});

test("generated Unicode labels fit the command request's existing 120-character limit", async () => {
  const f = await setup();
  try {
    const name = "\u{1f680}".repeat(60);
    const command = CommandSchema.parse({
      type: "setClip",
      clipId: "card",
      label: name,
    });
    const label = editLabel(
      [command],
      (await f.read()).timeline,
      "Edited timeline",
    );
    const response = await f.send([command], label);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(label).toBe(`Renamed to ${name}`);
    expect((await f.read()).timeline.clips[0]?.label).toBe(name);
  } finally {
    await f.close();
  }
});
