import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { AGENT_HEADER } from "../src/shared/review";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { createReviewService } from "../src/server/projects/review";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";

test("agent clip marks survive reload, clear on Accept or human edits, and include source changes", async () => {
  const fixture = await projectFixture();
  const { store, review, app, request } = fixture;
  app.route("/api/cutroom", createTimelineRoutes(store, review));
  const project = await store.create({ name: "Agent marks" });
  const path = `/projects/${project.id}`;
  const actor = review.agent(project, undefined);
  const read = async () =>
    TimelineViewSchema.parse(await (await request(`${path}/timeline`)).json());
  const edit = async (id: string, label: string, agent = true) => {
    const view = await read();
    const response = await app.request(`/api/cutroom${path}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(agent && { [AGENT_HEADER]: "external" }),
      },
      body: JSON.stringify({
        expectedRevision: view.revision,
        commands: [{ type: "setClip", clipId: id, label }],
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return TimelineViewSchema.parse(await response.json());
  };
  try {
    const note = await review.add(
      project,
      { body: "Rename", time: 0, compositionPath: "index.html" },
      undefined,
    );
    await review.act(project, note.id, { type: "claim" }, actor);
    expect((await edit("headline", "Opening")).agentChanges).toEqual([
      "headline",
    ]);
    expect(
      await createReviewService(store).changedClips(project, "index.html"),
    ).toEqual(["headline"]);
    await review.act(
      project,
      note.id,
      { type: "complete", note: "Renamed" },
      actor,
    );
    await review.act(project, note.id, { type: "accept" }, { kind: "human" });
    expect((await read()).agentChanges).toEqual([]);
    await edit("caption", "Agent caption");
    expect(
      (await edit("caption", "Owner caption", false)).agentChanges,
    ).toEqual([]);
    const source = await (await request(`${path}/source`)).json();
    const saved = await app.request(`/api/cutroom${path}/source`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: "external",
      },
      body: JSON.stringify({
        path: "./index.html",
        expectedVersion: source.version,
        content: source.content.replace(
          'class="clip title"',
          'class="clip title" style="opacity:.8"',
        ),
      }),
    });
    expect(saved.status).toBe(200);
    expect((await read()).agentChanges).toEqual(["headline"]);
    expect(
      await createReviewService(store).changedClips(project, "./index.html"),
    ).toEqual(["headline"]);
    const refused = await app.request(
      `/api/cutroom${path}/review/changes/accept`,
      { method: "POST", headers: { [AGENT_HEADER]: "external" } },
    );
    expect(refused.status).toBe(409);
    expect(
      (await request(`${path}/review/changes/accept`, "POST")).status,
    ).toBe(200);
    expect((await read()).agentChanges).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("unreadable review metadata does not block timeline reads or source repairs", async () => {
  const fixture = await projectFixture();
  const { store, review, app, request } = fixture;
  app.route("/api/cutroom", createTimelineRoutes(store, review));
  const project = await store.create({ name: "Repair source" });
  const path = `/projects/${project.id}`;
  try {
    await mkdir(`${project.path}/.cutroom`, { recursive: true });
    await writeFile(`${project.path}/.cutroom/review.json`, "broken");
    expect((await request(`${path}/timeline`)).status).toBe(200);
    const source = await (await request(`${path}/source`)).json();
    const response = await request(`${path}/source`, "PUT", {
      path: "index.html",
      expectedVersion: source.version,
      content: source.content.replace(
        "Drop media in, or ask your agent to start.",
        "Repaired",
      ),
    });
    expect(response.status).toBe(200);
  } finally {
    await fixture.close();
  }
});

test("two claimed notes own their individual edits, and accepting either clears only its clips", async () => {
  const fixture = await projectFixture();
  const { store, review, app, request } = fixture;
  app.route("/api/cutroom", createTimelineRoutes(store, review));
  const project = await store.create({ name: "Two claimed notes" });
  const actor = review.agent(project, undefined);
  const base = `/projects/${project.id}`;
  const notes = await Promise.all(
    ["Headline", "Caption"].map((body) =>
      review.add(
        project,
        { body, time: 0, compositionPath: "index.html" },
        undefined,
      ),
    ),
  );
  for (const note of notes)
    await review.act(project, note.id, { type: "claim" }, actor);
  const edit = async (clipId: string, noteId?: string) => {
    const { revision } = TimelineViewSchema.parse(
      await (await request(`${base}/timeline`)).json(),
    );
    return app.request(`/api/cutroom${base}/commands`, {
      method: "POST",
      headers: {
        [AGENT_HEADER]: "external",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expectedRevision: revision,
        noteId,
        commands: [{ type: "setClip", clipId, label: `Edited ${clipId}` }],
      }),
    });
  };
  try {
    expect((await edit("headline")).status).toBe(409);
    expect((await edit("headline", "not-claimed")).status).toBe(409);
    expect(await review.changedClips(project, "index.html")).toEqual([]);
    expect((await edit("headline", notes[0]!.id)).status).toBe(200);
    // Source edits use the same note attribution as timeline commands.
    const source = await (await request(`${base}/source`)).json();
    const saved = await app.request(`/api/cutroom${base}/source`, {
      method: "PUT",
      headers: {
        [AGENT_HEADER]: "external",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "index.html",
        noteId: notes[1]!.id,
        expectedVersion: source.version,
        content: source.content.replace(
          'class="clip caption"',
          'class="clip caption" style="opacity:.8"',
        ),
      }),
    });
    expect(saved.status).toBe(200);
    expect((await review.changedClips(project, "index.html")).sort()).toEqual([
      "caption",
      "headline",
    ]);
    for (const note of notes)
      await review.act(
        project,
        note.id,
        { type: "complete", note: "Changed its clip" },
        actor,
      );
    await review.act(
      project,
      notes[0]!.id,
      { type: "accept" },
      { kind: "human" },
    );
    expect(await review.changedClips(project, "index.html")).toEqual([
      "caption",
    ]);
    expect(
      await createReviewService(store).changedClips(project, "index.html"),
    ).toEqual(["caption"]);
    await review.act(
      project,
      notes[1]!.id,
      { type: "accept" },
      { kind: "human" },
    );
    expect(await review.changedClips(project, "index.html")).toEqual([]);
  } finally {
    await fixture.close();
  }
});
