import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  historyClips,
  historyProjectHtml,
} from "../scripts/bench-history-project";
import { historyCandidate } from "../src/server/projects/history";
import {
  externalHistoryCredential,
  ownerWho,
} from "../src/server/projects/historyActor";
import { readHistorySkips } from "../src/server/projects/historySkips";
import { createProjectStore } from "../src/server/projects/store";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { AGENT_HEADER, AGENT_NAME_HEADER } from "../src/shared/review";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { projectFixture } from "./project-fixture";

const titles = `<main data-composition-id="main" data-duration="8" data-fps="30" data-width="640" data-height="360">
${Array.from(
  { length: 4 },
  (_, index) =>
    `  <div id="t${index}" data-start="${index * 2}" data-duration="2" data-track-index="0">Title ${index}</div>`,
).join("\n")}
</main>`;

async function projectWithHistory(html = titles, missingDocument = false) {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Selective history" });
  const file = join(project.path, "index.html");
  await writeFile(file, html);
  if (missingDocument)
    await rm(join(project.path, "cutroom.json"), { force: true });
  const ledger = await fixture.store.history(project);
  const api = `/api/cutroom/projects/${project.id}`;
  const agent = externalHistoryCredential();
  const request = (path: string, body: unknown, credential?: string) =>
    fixture.app.request(`${api}/${path}`, {
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
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.app.request(`${api}/timeline`)).json(),
    );
  const edit = async (commands: CommandInput[], credential?: string) => {
    const response = await request(
      "commands",
      { expectedRevision: (await read()).revision, commands },
      credential,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const id = response.headers.get("x-cutroom-history-entry");
    if (!id) throw new Error("The edit did not record a history entry.");
    return id;
  };
  const step = async (
    direction: "undo" | "redo",
    body = {},
    credential?: string,
  ) => {
    const response = await request(`history/${direction}`, body, credential);
    return { status: response.status, body: await response.json() };
  };
  const clip = async (id: string) =>
    (await read()).timeline.clips.find((item) => item.id === id);
  return { fixture, project, file, ledger, agent, edit, read, step, clip };
}

const cut = { type: "remove", clipIds: ["t1"], ripple: true } as const;

test("undo and redo restore a ripple while keeping a later opacity edit on the shifted clip", async () => {
  const { fixture, agent, edit, clip, step, read } = await projectWithHistory();
  try {
    await edit([{ ...cut, clipIds: ["t1"] }]);
    await edit([{ type: "setClip", clipId: "t3", opacity: 0.4 }], agent);
    expect(await clip("t3")).toMatchObject({ start: 120, opacity: 0.4 });
    expect(await step("undo")).toMatchObject({
      status: 200,
      body: { kept: { authors: ["Codex"] } },
    });
    expect(await clip("t1")).toMatchObject({ start: 60, duration: 60 });
    expect(await clip("t3")).toMatchObject({ start: 180, opacity: 0.4 });
    expect((await read()).timeline.duration).toBe(240);
    expect(await step("redo")).toMatchObject({ status: 200 });
    expect(await clip("t1")).toBeUndefined();
    expect(await clip("t3")).toMatchObject({ start: 120, opacity: 0.4 });
    expect((await read()).timeline.duration).toBe(180);
  } finally {
    await fixture.close();
  }
});

test("owner Undo and Redo keep an agent's rename on a different track", async () => {
  const { fixture, agent, edit, read, step } = await projectWithHistory();
  const trackNames = async () =>
    (await read()).timeline.tracks.map(({ index, name }) => [index, name]);
  try {
    await edit([
      { type: "setTrack", index: 0, name: "Picture" },
      { type: "setTrack", index: 1, kind: "audio", name: "Sound" },
    ]);
    await edit([{ type: "setTrack", index: 0, name: "Interview" }]);
    await edit([{ type: "setTrack", index: 1, name: "Dialogue" }], agent);

    expect(await step("undo")).toMatchObject({ status: 200 });
    expect(await trackNames()).toEqual([
      [0, "Picture"],
      [1, "Dialogue"],
    ]);
    expect(await step("redo")).toMatchObject({ status: 200 });
    expect(await trackNames()).toEqual([
      [0, "Interview"],
      [1, "Dialogue"],
    ]);
  } finally {
    await fixture.close();
  }
});

test.each([
  { agentClip: "t1", standing: "Title 1", status: 200 },
  { agentClip: "t0", standing: "Owner", status: 409 },
])(
  "Undo after later edits return the file to the same bytes ($agentClip)",
  async ({ agentClip, standing, status }) => {
    const { fixture, file, agent, edit, step, clip } =
      await projectWithHistory();
    try {
      await edit([{ type: "setClip", clipId: "t0", text: "Owner" }]);
      const ownerBytes = await readFile(file, "utf8");
      await edit(
        [{ type: "setClip", clipId: agentClip, text: "Agent" }],
        agent,
      );
      await edit(
        [{ type: "setClip", clipId: agentClip, text: standing }],
        agent,
      );
      expect(await readFile(file, "utf8")).toBe(ownerBytes);

      expect(await step("undo")).toMatchObject({ status });
      expect((await clip("t0"))?.text).toBe(
        status === 200 ? "Title 0" : "Owner",
      );
      expect((await clip("t1"))?.text).toBe("Title 1");
    } finally {
      await fixture.close();
    }
  },
);

test("an agent cannot undo a clip the owner deliberately moved", async () => {
  const { fixture, agent, edit, clip, step } = await projectWithHistory();
  try {
    await edit(
      [
        {
          type: "insert",
          track: 2,
          at: 30,
          clip: {
            kind: "title",
            id: "agent-title",
            text: "Agent",
            duration: 30,
          },
        },
      ],
      agent,
    );
    const move = await edit([
      { type: "move", clipIds: ["agent-title"], by: 120 },
    ]);
    expect(await step("undo", {}, agent)).toMatchObject({
      status: 409,
      body: { conflict: { newer: [move] } },
    });
    expect(await clip("agent-title")).toMatchObject({ start: 150 });
    expect(await step("undo")).toMatchObject({ status: 200 });
    expect(await clip("agent-title")).toMatchObject({ start: 30 });
  } finally {
    await fixture.close();
  }
});

test("an owner can undo the insertion of a clip that slid with an agent ripple", async () => {
  const { fixture, agent, edit, clip, step } = await projectWithHistory();
  try {
    await edit([
      {
        type: "insert",
        track: 0,
        at: 300,
        clip: { kind: "title", id: "owner-title", text: "Owner", duration: 30 },
      },
    ]);
    await edit([{ ...cut, clipIds: ["t1"] }], agent);
    expect(await clip("owner-title")).toMatchObject({ start: 240 });
    expect(await step("undo")).toMatchObject({ status: 200 });
    expect(await clip("owner-title")).toBeUndefined();
    expect(await clip("t3")).toMatchObject({ start: 120 });
  } finally {
    await fixture.close();
  }
});

test("Skip advances past an outside-write conflict and persists after reopening", async () => {
  const { fixture, project, file, ledger, agent, edit, clip, step } =
    await projectWithHistory();
  try {
    const prior = await edit([{ type: "setClip", clipId: "t0", opacity: 0.7 }]);
    const blocked = await edit([
      { type: "setClip", clipId: "t1", text: "Owner" },
    ]);
    const before = (await readFile(file, "utf8")).replace(
      ">Owner<",
      ">Outside<",
    );
    await writeFile(file, before);
    await ledger.checkpoint();
    expect(await step("undo")).toMatchObject({
      status: 409,
      body: { conflict: { skipEntryId: blocked } },
    });
    expect(
      await step("undo", { entryId: blocked, skip: true }, agent),
    ).toMatchObject({ status: 409 });
    expect(await step("undo", { entryId: blocked, skip: true })).toMatchObject({
      status: 200,
      body: {
        skipped: { id: blocked, label: expect.stringContaining("Owner") },
        entry: null,
      },
    });
    expect(await readFile(file, "utf8")).toBe(before);
    expect(
      historyCandidate(
        ledger.list(),
        "undo",
        ownerWho,
        await readHistorySkips(project),
      )?.id,
    ).toBe(prior);
    await fixture.store.close();
    const reopened = await createProjectStore({
      dataDir: fixture.store.dataDir,
      projectsDir: fixture.store.projectsDir,
    });
    try {
      const history = await reopened.history(project);
      expect(
        historyCandidate(
          history.list(),
          "undo",
          ownerWho,
          await readHistorySkips(project),
        )?.id,
      ).toBe(prior);
      expect(await readFile(file, "utf8")).toBe(before);
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

/** An owner ripple at 1,038 clips, then `count` agent trims that each depend on it. */
async function rippleWithDependentTrims(count: number) {
  const history = await projectWithHistory(historyProjectHtml);
  const { project, agent, edit, read } = history;
  await writeFile(
    join(project.path, "talk.mp4"),
    "synthetic fixture with authored timing",
  );
  const original = (await read()).timeline;
  expect(original.clips.length).toBe(historyClips);
  await edit([{ type: "remove", clipIds: ["talk-3"], ripple: true }]);
  for (let index = 0; index < count; index++) {
    const clipId = `title-${index + 20}`;
    const { start } = (await read()).timeline.clips.find(
      ({ id }) => id === clipId,
    )!;
    await edit([{ type: "trim", clipId, edge: "end", to: start + 90 }], agent);
  }
  return { ...history, original };
}

/** Presses Undo, then the offered Undo all, leaving every file as it was until the confirm. */
async function undoAll(
  history: Awaited<ReturnType<typeof rippleWithDependentTrims>>,
  count: number,
) {
  const { file, ledger, step } = history;
  const standing = await readFile(file, "utf8");
  const head = ledger.list().at(-1)?.id;
  const refusal = await step("undo");
  expect(refusal.status).toBe(409);
  const group = refusal.body.conflict.undoTogether;
  expect(group.withEntries).toHaveLength(count);
  expect(await readFile(file, "utf8")).toBe(standing);
  expect(ledger.list().at(-1)?.id).toBe(head);
  expect(await step("undo", group)).toMatchObject({ status: 200 });
}

for (const count of [3, 5, 10])
  test(`Undo all ${count} dependent edits is offered and applied at 1,038 clips`, async () => {
    const history = await rippleWithDependentTrims(count);
    try {
      await undoAll(history, count);
      expect((await history.read()).timeline.clips).toEqual(
        history.original.clips,
      );
    } finally {
      await history.fixture.close();
    }
  }, 60_000);

test("three projects find and apply their groups at the same time", async () => {
  const histories = await Promise.all(
    [5, 5, 5].map((count) => rippleWithDependentTrims(count)),
  );
  try {
    await Promise.all(histories.map((history) => undoAll(history, 5)));
    for (const history of histories)
      expect((await history.read()).timeline.clips).toEqual(
        history.original.clips,
      );
  } finally {
    await Promise.all(histories.map(({ fixture }) => fixture.close()));
  }
}, 120_000);

test("selective ripple restore keeps linked picture and sound, a dissolve, and local keyframes", async () => {
  const src = `<main data-composition-id="main" data-duration="20" data-fps="30" data-width="640" data-height="360">
${Array.from({ length: 4 }, (_, index) => {
  const timing = `data-start="${index * 5}" data-duration="5" data-media-start="${1 + index * 2}" data-link="link-${index}"`;
  return `  <video id="shot-${index}" src="shot.mp4" muted ${timing} data-track-index="0"></video>
  <audio id="sound-${index}" src="shot.mp4" ${timing} data-track-index="1"></audio>`;
}).join("\n")}
</main>`;
  const { fixture, agent, edit, read, step } = await projectWithHistory(src);
  try {
    await edit([
      {
        type: "setTransition",
        from: "shot-2",
        to: "shot-3",
        transition: { duration: 10 },
      },
      {
        type: "setKeyframe",
        clipId: "shot-3",
        property: "rotation",
        frame: 20,
        value: 12,
      },
    ]);
    const original = (await read()).timeline.clips;
    const ending = original.find(({ id }) => id === "shot-3")!;
    expect(ending.transitionIn?.duration).toBe(10);
    expect(ending.keyframes?.rotation).toBeDefined();

    await edit([{ type: "remove", clipIds: ["shot-0"], ripple: true }]);
    await edit([{ type: "setClip", clipId: "shot-3", opacity: 0.4 }], agent);
    expect(await step("undo")).toMatchObject({ status: 200 });
    expect((await read()).timeline.clips).toEqual(
      original.map((item) =>
        item.id === "shot-3" ? { ...item, opacity: 0.4 } : item,
      ),
    );
  } finally {
    await fixture.close();
  }
});

test("a same-name MCP session is named separately and cannot reverse the other session", async () => {
  const { fixture, agent, edit, step } = await projectWithHistory();
  try {
    await edit(
      [{ type: "setClip", clipId: "t0", opacity: 0.3 }],
      externalHistoryCredential(),
    );
    expect(await step("undo", {}, agent)).toMatchObject({
      status: 200,
      body: {
        entry: null,
        message:
          "Nothing of yours to undo. Another Codex session made the last change.",
      },
    });
  } finally {
    await fixture.close();
  }
});

test("the first ripple in an imported project records creation of its timeline settings", async () => {
  const { fixture, project, file, ledger, edit, step } =
    await projectWithHistory(titles, true);
  try {
    const id = await edit([{ ...cut, clipIds: ["t1"] }]);
    expect(ledger.list().find((entry) => entry.id === id)).toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({ path: "index.html" }),
        expect.objectContaining({
          path: "cutroom.json",
          before: null,
          after: expect.any(String),
        }),
      ]),
    });
    expect(await step("undo")).toMatchObject({ status: 200 });
    expect(await Bun.file(join(project.path, "cutroom.json")).exists()).toBe(
      false,
    );
    expect(await readFile(file, "utf8")).toBe(titles);
    expect(await step("redo")).toMatchObject({ status: 200 });
    expect(await Bun.file(join(project.path, "cutroom.json")).exists()).toBe(
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("selective planning leaves the engine free, and an advanced owner target is refused", async () => {
  const { fixture, file, ledger, agent, edit, step } =
    await projectWithHistory();
  const blocked = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const readBlob = ledger.readBlob;
  let reads = 0;
  let pending: ReturnType<typeof step> | undefined;
  try {
    const first = await edit([{ type: "setClip", clipId: "t0", opacity: 0.6 }]);
    await edit([{ type: "setClip", clipId: "t1", text: "Agent" }], agent);
    ledger.readBlob = async (hash) => {
      if (reads++ === 0) {
        blocked.resolve();
        await proceed.promise;
      }
      return readBlob(hash);
    };
    pending = step("undo", { expectedEntryId: first });
    await blocked.promise;
    const window = await ledger.beginWindow(
      ownerWho,
      "Other tab wrote during planning",
    );
    const standing = (await readFile(file, "utf8")).replace(
      ">Title 2<",
      ">Other tab<",
    );
    await writeFile(file, standing);
    await window.close();
    proceed.resolve();
    expect(await pending).toMatchObject({
      status: 409,
      body: { code: "history-advanced" },
    });
    expect(await readFile(file, "utf8")).toBe(standing);
    expect(ledger.list().some(({ undoes }) => undoes === first)).toBe(false);
  } finally {
    proceed.resolve();
    await pending;
    ledger.readBlob = readBlob;
    await fixture.close();
  }
});
