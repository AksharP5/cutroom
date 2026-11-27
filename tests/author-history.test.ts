import { expect, test } from "bun:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileContentVersion } from "@hyperframes/studio-server";
import { openProjectHistory } from "../src/server/history/projectHistory";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { historyCandidate } from "../src/server/projects/history";
import {
  externalHistoryCredential,
  ownerWho,
} from "../src/server/projects/historyActor";
import { createProjectStore } from "../src/server/projects/store";
import { AGENT_HEADER, AGENT_NAME_HEADER } from "../src/shared/review";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import type { CommandInput } from "../src/shared/timeline/schema";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { projectFixture } from "./project-fixture";
import { addStarterClips } from "./starter-clips";

test("a newer writer owns an overlapping file even after restoring identical bytes", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Overlap" });
  await addStarterClips(project);
  const base = `/api/cutroom/projects/${project.id}`;
  const agent = externalHistoryCredential();
  const stranger = externalHistoryCredential();
  const request = (
    path: string,
    method: string,
    body?: unknown,
    credential?: string,
  ) =>
    fixture.app.request(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(credential && {
          [AGENT_HEADER]: credential,
          [AGENT_NAME_HEADER]: "Codex",
        }),
      },
      body: JSON.stringify(body),
    });
  const read = () => readFile(join(project.path, "index.html"), "utf8");
  const edit = async (text: string, credential?: string) => {
    const before = await read();
    const response = await request(
      "/source",
      "PUT",
      {
        expectedVersion: fileContentVersion(before),
        content: before.replace(/(<div id="headline"[^>]*>)[^<]*/, `$1${text}`),
      },
      credential,
    );
    expect(response.status, await response.text()).toBe(200);
  };
  try {
    const original = await read();
    await edit("Owner edit");
    const ownerBytes = await read();
    const history = await fixture.store.history(project);
    const ownerId = history.list().at(-1)!.id;
    await edit("Agent edit", agent);
    await edit("Owner edit", agent);
    expect(await read()).toBe(ownerBytes);
    const later = history
      .list()
      .slice(-2)
      .map(({ id }) => id);

    const refused = await request("/history/undo", "POST");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      conflict: { files: ["index.html"], newer: later },
    });
    expect(history.list().at(-1)?.id).toBe(later.at(-1));
    expect(
      (await request("/history/undo", "POST", { entryId: ownerId }, stranger))
        .status,
    ).toBe(409);
    expect(await read()).toBe(ownerBytes);

    for (let i = 0; i < 2; i++)
      expect((await request("/history/undo", "POST", {}, agent)).status).toBe(
        200,
      );
    expect(await read()).toBe(ownerBytes);
    const requestId = crypto.randomUUID();
    const undo = await request("/history/undo", "POST", { requestId });
    expect(undo.status).toBe(200);
    expect(await read()).toBe(original);
    expect(
      await (await request("/history/undo", "POST", { requestId })).json(),
    ).toEqual(await undo.json());

    await edit("Other session", stranger);
    expect((await request("/history/redo", "POST", {})).status).toBe(409);
    expect(await read()).toContain(">Other session</div>");
  } finally {
    await fixture.close();
  }
});

test("source creation stays applied when a later composition depends on it", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Dependent scene" });
  await addStarterClips(project);
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/editor", editor);
  const base = `/projects/${project.id}`;
  const scenePath = "compositions/opening.html";
  const scene =
    '<template><div data-composition-id="opening" data-duration="2">Scene</div></template>';
  try {
    expect(
      (
        await fixture.request(`${base}/source`, "PUT", {
          path: scenePath,
          content: scene,
          expectedVersion: null,
        })
      ).status,
    ).toBe(200);
    const history = await fixture.store.history(project);
    const created = history.list().at(-1)!;
    const index = join(project.path, "index.html");
    const mounted = (await readFile(index, "utf8")).replace(
      "</main>",
      `<div data-composition-src="${scenePath}" data-start="0" data-duration="2"></div></main>`,
    );
    await writeFile(index, mounted);
    const refused = await fixture.request(`${base}/history/undo`, "POST");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      conflict: { files: ["index.html"] },
    });
    const studio = `/api/editor${base}/history`;
    for (const [path, body] of [
      ["undo", { entryId: created.id, mode: "just-this" }],
      ["undo", { entryId: created.id, mode: "keep-later-edits" }],
      ["undo", { entryId: created.id, who: { kind: "person", name: "You" } }],
      ["restore", { point: "start" }],
      ["window", { who: { kind: "person", name: "You" } }],
      ["claim", { paths: ["index.html"] }],
    ] as const) {
      const response = await fixture.app.request(`${studio}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.ok, await response.text()).toBe(false);
    }
    expect(await readFile(join(project.path, scenePath), "utf8")).toBe(scene);
    expect(await readFile(index, "utf8")).toBe(mounted);
    expect(history.list().some((entry) => entry.undoes === created.id)).toBe(
      false,
    );
  } finally {
    await editor.dispose();
    await fixture.close();
  }
});

test("undo keeps a split when a later agent edit depends on the new piece", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Dependent cut" });
  await addStarterClips(project);
  const base = `/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.request(`${base}/timeline`)).json(),
    );
  try {
    const split = await fixture.request(`${base}/commands`, "POST", {
      expectedRevision: (await read()).revision,
      commands: [{ type: "split", at: 90, clipIds: ["headline"] }],
    });
    expect(split.status, await split.clone().text()).toBe(200);
    const timeline = TimelineViewSchema.parse(await split.json());
    const piece = timeline.timeline.clips.find(
      ({ start, track }) => start === 90 && track === 1,
    )!;
    const trim = await fixture.app.request(`/api/cutroom${base}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: externalHistoryCredential(),
        [AGENT_NAME_HEADER]: "Codex",
      },
      body: JSON.stringify({
        expectedRevision: timeline.revision,
        commands: [
          { type: "setClip", clipId: piece.id, text: "Keep this piece" },
        ],
      }),
    });
    expect(trim.status, await trim.clone().text()).toBe(200);
    const before = await read();
    const refused = await fixture.request(`${base}/history/undo`, "POST");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      conflict: { newer: [trim.headers.get("x-cutroom-history-entry")] },
    });
    expect(await read()).toEqual(before);
  } finally {
    await fixture.close();
  }
});

test("an incompletely recorded edit blocks undo without advancing to an older edit", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Partial capture" });
  await addStarterClips(project);
  const base = `/projects/${project.id}`;
  const source = (path: string) =>
    fixture.request(`${base}/source`, "PUT", {
      path,
      expectedVersion: null,
      content: "<div>Keep</div>",
    });
  try {
    expect((await source("compositions/kept.html")).status).toBe(200);
    expect((await source("build/untracked.html")).status).toBe(200);
    const ledger = await fixture.store.history(project);
    const before = ledger.list();
    expect(before.at(-1)).toMatchObject({ incomplete: true, files: [] });
    const refusal = await fixture.request(`${base}/history/undo`, "POST");
    expect(refusal.status).toBe(409);
    expect(await refusal.json()).toMatchObject({
      error: expect.stringContaining(
        "History did not capture all of its file changes",
      ),
    });
    expect(ledger.list()).toEqual(before);
    expect(
      await readFile(join(project.path, "compositions/kept.html"), "utf8"),
    ).toBe("<div>Keep</div>");
    expect(
      await readFile(join(project.path, "build/untracked.html"), "utf8"),
    ).toBe("<div>Keep</div>");
  } finally {
    await fixture.close();
  }
});

test("replay refuses an outside write after candidate selection and rolls back earlier files", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Replay race" });
  await addStarterClips(project);
  const a = join(project.path, "a.css");
  const b = join(project.path, "b.css");
  await writeFile(a, "original a");
  await writeFile(b, "original b");
  let race = false;
  const history = await openProjectHistory({
    projectDir: project.path,
    historyRoot: join(fixture.directory, "standalone-history"),
    beforeReplay: async () => {
      if (race) await writeFile(b, "outside b");
    },
  });
  try {
    const who = { kind: "person", name: "You", key: "owner" } as const;
    const window = await history.beginWindow(who, "Edit two files");
    await writeFile(a, "edited a");
    await writeFile(b, "edited b");
    const entry = await window.close();
    race = true;
    await expect(
      history.revert(
        who,
        () => ({
          steps: [
            {
              id: entry!.id,
              replay: "ordinary",
              files: entry!.files.map(({ path, before, after }) => ({
                path,
                before: after,
                after: before,
              })),
            },
          ],
          blobs: new Map(),
        }),
        {},
      ),
    ).rejects.toThrow("b.css changed during history replay");
    expect(await readFile(a, "utf8")).toBe("edited a");
    expect(await readFile(b, "utf8")).toBe("outside b");
    expect(history.list().some(({ undoes }) => undoes === entry!.id)).toBe(
      false,
    );
  } finally {
    await history.close();
    await fixture.close();
  }
});

test("an interrupted replay and torn log tail recover without changing history IDs", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Restart" });
  await addStarterClips(project);
  const index = join(project.path, "index.html");
  const original = await readFile(index, "utf8");
  try {
    const ledger = await fixture.store.history(project);
    const window = await ledger.beginWindow(
      { kind: "person", name: "You" },
      "Legacy edit",
    );
    const legacy = original.replace(">Restart</div>", ">Legacy</div>");
    await writeFile(index, legacy);
    const older = (await window.close())!;
    const newer = legacy.replace(">Legacy</div>", ">New edit</div>");
    const response = await fixture.request(
      `/projects/${project.id}/source`,
      "PUT",
      {
        expectedVersion: fileContentVersion(legacy),
        content: newer,
      },
    );
    expect(response.status).toBe(200);
    const latest = ledger.list().at(-1)!;
    expect(latest.who.key).toBe("owner");
    const home = join(fixture.store.dataDir, "history", ledger.projectId);
    await fixture.store.close();
    const change = latest.files[0]!;
    await writeFile(index, legacy);
    await writeFile(
      join(home, "pending-replay.json"),
      JSON.stringify({
        id: crypto.randomUUID(),
        files: [
          { path: change.path, before: change.after, after: change.before },
        ],
      }),
    );
    await appendFile(join(home, "log.jsonl"), '{"type":"entry","entry":');
    const reopened = await createProjectStore({
      dataDir: fixture.store.dataDir,
      projectsDir: fixture.store.projectsDir,
    });
    try {
      const current = await reopened.history(project);
      expect(current.list().map(({ id }) => id)).toEqual([older.id, latest.id]);
      expect(await readFile(index, "utf8")).toBe(newer);
      const result = await current.revert(
        latest.who,
        () => ({
          steps: [
            {
              id: latest.id,
              replay: "ordinary",
              files: latest.files.map(({ path, before, after }) => ({
                path,
                before: after,
                after: before,
              })),
            },
          ],
          blobs: new Map(),
        }),
        {},
      );
      expect(result).toMatchObject({ ok: true, entry: { undoes: latest.id } });
      expect(await readFile(index, "utf8")).toBe(legacy);
      expect(historyCandidate(current.list(), "undo", ownerWho)?.id).toBe(
        older.id,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

const documentRoundTrips: {
  label: string;
  commands: CommandInput[];
  overlaps: boolean;
}[] = [
  {
    label: "leaves a track the agent renamed away and back",
    commands: [
      { type: "setTrack", index: 0, name: "Agent's track" },
      { type: "setTrack", index: 0, name: "Owner's track" },
    ],
    overlaps: true,
  },
  {
    label: "works after an unrelated track round trip",
    commands: [
      { type: "setTrack", index: 1, name: "Agent's other track" },
      { type: "setTrack", index: 1, name: "Other track" },
    ],
    overlaps: false,
  },
];

for (const { label, commands, overlaps } of documentRoundTrips) {
  test(`owner Undo ${label}`, async () => {
    const fixture = await projectFixture();
    try {
      fixture.app.route(
        "/api/cutroom",
        createTimelineRoutes(fixture.store, fixture.review),
      );
      const project = await fixture.store.create({ name: "Track ownership" });
      await addStarterClips(project);
      const base = `/api/cutroom/projects/${project.id}`;
      const agent = externalHistoryCredential();
      const edit = async (command: CommandInput, credential?: string) => {
        const { revision } = TimelineViewSchema.parse(
          await (await fixture.app.request(`${base}/timeline`)).json(),
        );
        const response = await fixture.app.request(`${base}/commands`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(credential && { [AGENT_HEADER]: credential }),
          },
          body: JSON.stringify({
            expectedRevision: revision,
            commands: [command],
          }),
        });
        expect(response.status, await response.text()).toBe(200);
      };
      const read = () => readFile(join(project.path, "cutroom.json"), "utf8");
      const undo = (credential?: string) =>
        fixture.app.request(`${base}/history/undo`, {
          method: "POST",
          ...(credential && { headers: { [AGENT_HEADER]: credential } }),
        });

      await edit({ type: "setTrack", index: 1, name: "Other track" }, agent);
      await edit({ type: "setTrack", index: 0, name: "Owner's track" });
      const ownerBytes = await read();
      for (const command of commands) await edit(command, agent);
      expect(await read()).toBe(ownerBytes);

      const result = await undo();
      expect(result.status, await result.clone().text()).toBe(
        overlaps ? 409 : 200,
      );
      if (overlaps) {
        expect(await result.json()).toMatchObject({
          conflict: { files: ["cutroom.json"] },
        });
        expect(await read()).toBe(ownerBytes);
        for (const _command of commands) {
          const theirs = await undo(agent);
          expect(theirs.status, await theirs.text()).toBe(200);
        }
        const yours = await undo();
        expect(yours.status, await yours.text()).toBe(200);
      }
      expect(await read()).not.toContain("Owner's track");
    } finally {
      await fixture.close();
    }
  });
}

test("selective undo and redo keep independent fields and markers in the same files", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Independent edits" });
  await addStarterClips(project);
  const api = `/api/cutroom/projects/${project.id}`;
  const agent = externalHistoryCredential();
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.app.request(`${api}/timeline`)).json(),
    );
  const edit = async (commands: CommandInput[], credential?: string) => {
    const response = await fixture.app.request(`${api}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential && {
          [AGENT_HEADER]: credential,
          [AGENT_NAME_HEADER]: "Codex",
        }),
      },
      body: JSON.stringify({
        expectedRevision: (await read()).revision,
        commands,
      }),
    });
    expect(response.status, await response.text()).toBe(200);
  };
  const step = async (direction: "undo" | "redo") => {
    const response = await fixture.app.request(`${api}/history/${direction}`, {
      method: "POST",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  try {
    await edit([
      { type: "setClip", clipId: "headline", opacity: 0.5 },
      {
        type: "setMarker",
        id: "owner-marker",
        frame: 30,
        name: "Owner marker",
      },
    ]);
    await edit(
      [
        { type: "setClip", clipId: "headline", text: "Agent text" },
        {
          type: "setMarker",
          id: "agent-marker",
          frame: 90,
          name: "Agent marker",
        },
      ],
      agent,
    );
    expect(await step("undo")).toMatchObject({
      kept: { count: 1, authors: ["Codex"] },
    });
    let { timeline } = await read();
    expect(timeline.clips.find(({ id }) => id === "headline")).toMatchObject({
      opacity: null,
      text: "Agent text",
    });
    expect(timeline.markers.map(({ id }) => id)).toEqual(["agent-marker"]);
    await step("redo");
    ({ timeline } = await read());
    expect(timeline.clips.find(({ id }) => id === "headline")).toMatchObject({
      opacity: 0.5,
      text: "Agent text",
    });
    expect(timeline.markers.map(({ id }) => id)).toEqual([
      "owner-marker",
      "agent-marker",
    ]);
  } finally {
    await fixture.close();
  }
});

test("Undo both keeps a later independent edit in the same file", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Minimal group" });
  await addStarterClips(project);
  const api = `/api/cutroom/projects/${project.id}`;
  const agent = externalHistoryCredential();
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.app.request(`${api}/timeline`)).json(),
    );
  const retitle = async (clipId: string, text: string, credential?: string) => {
    const response = await fixture.app.request(`${api}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential && {
          [AGENT_HEADER]: credential,
          [AGENT_NAME_HEADER]: "Codex",
        }),
      },
      body: JSON.stringify({
        expectedRevision: (await read()).revision,
        commands: [{ type: "setClip", clipId, text }],
      }),
    });
    expect(response.status, await response.text()).toBe(200);
    return response.headers.get("x-cutroom-history-entry");
  };
  const undo = (body: unknown, credential?: string) =>
    fixture.app.request(`${api}/history/undo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential && {
          [AGENT_HEADER]: credential,
          [AGENT_NAME_HEADER]: "Codex",
        }),
      },
      body: JSON.stringify(body),
    });
  try {
    const owner = await retitle("headline", "Owner's title");
    const blocker = await retitle("headline", "Agent's title", agent);
    await retitle("caption", "Independent caption", agent);
    const response = await undo({});
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result).toMatchObject({
      conflict: { undoTogether: { entryId: owner, withEntries: [blocker] } },
    });
    const suggestion = result.conflict.undoTogether;
    expect((await undo(suggestion, agent)).status).toBe(409);
    const newest = await retitle("headline", "Newer agent title", agent);
    expect((await undo(suggestion)).status).toBe(409);
    expect(
      (await read()).timeline.clips.find(({ id }) => id === "headline")?.text,
    ).toBe("Newer agent title");
    const refreshed = await (await undo({})).json();
    expect(refreshed.conflict.undoTogether).toEqual({
      entryId: owner,
      withEntries: [newest, blocker],
    });
    expect((await undo(refreshed.conflict.undoTogether)).status).toBe(200);
    const { timeline } = await read();
    expect(timeline.clips.find(({ id }) => id === "headline")?.text).toBe(
      "Minimal group",
    );
    expect(timeline.clips.find(({ id }) => id === "caption")?.text).toBe(
      "Independent caption",
    );
  } finally {
    await fixture.close();
  }
});
