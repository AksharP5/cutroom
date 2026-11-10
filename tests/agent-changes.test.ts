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
        path: "index.html",
        expectedVersion: source.version,
        content: source.content.replace(
          'class="clip title"',
          'class="clip title" style="opacity:.8"',
        ),
      }),
    });
    expect(saved.status).toBe(200);
    expect((await read()).agentChanges).toEqual(["headline"]);
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
      content: source.content.replace("A new composition.", "Repaired"),
    });
    expect(response.status).toBe(200);
  } finally {
    await fixture.close();
  }
});
