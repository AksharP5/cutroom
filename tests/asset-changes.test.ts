import { expect, test } from "bun:test";
import { fileContentVersion } from "@hyperframes/studio-server";
import { mkdir, unlink, utimes, writeFile } from "node:fs/promises";
import { clipVersions } from "../src/server/projects/changes";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";

const document = (element: string, shared = "") =>
  `<html><head>${shared}</head><body><main data-composition-id="main" data-duration="5">${element}<div id="other" data-start="0" data-duration="5">Other</div></main></body></html>`;
const image =
  '<img id="title" src="card.png" data-start="0" data-duration="5">';

async function setup(source = document(image)) {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Asset review" });
  await writeFile(`${project.path}/index.html`, source);
  await writeFile(`${project.path}/card.png`, "red");
  const read = () => fixture.review.clipChanges(project, "index.html");
  return { ...fixture, project, read };
}

test.each([
  ["src", image],
  [
    "poster",
    '<video id="title" poster="card.png" data-start="0" data-duration="5"></video>',
  ],
  [
    "srcset",
    '<img id="title" srcset="other.png 1x, card.png 2x" data-start="0" data-duration="5">',
  ],
  [
    "inline style",
    '<div id="title" style="background:url(card.png)" data-start="0" data-duration="5"></div>',
  ],
  [
    "source child",
    '<video id="title" data-start="0" data-duration="5"><source src="card.png"></video>',
  ],
  [
    "linked audio",
    '<video id="title" data-link="pair" data-start="0" data-duration="5"></video><audio id="sound" data-link="pair" src="card.png" data-start="0" data-duration="5"></audio>',
  ],
])(
  "%s fingerprints only the referencing clips, including same-size replacements",
  async (_name, element) => {
    const f = await setup(document(element));
    try {
      const before = await clipVersions(f.project, "index.html");
      await writeFile(`${f.project.path}/card.png`, "blu");
      await utimes(`${f.project.path}/card.png`, 1, 2);
      const after = await clipVersions(f.project, "index.html");
      expect(after.get("title")).not.toBe(before.get("title"));
      expect(after.get("other")).toBe(before.get("other"));
      expect(after.get(null)).toBe(before.get(null));
      if (_name === "linked audio")
        expect(after.get("sound")).not.toBe(before.get("sound"));
    } finally {
      await f.close();
    }
  },
);

test.each(["CSS", "script", "external CSS", "external script"])(
  "media referenced by %s marks one composition row",
  async (kind) => {
    const shared =
      kind === "CSS"
        ? "<style>body{background:url(card.png)}</style>"
        : kind === "script"
          ? '<script>const image="card.png";</script>'
          : kind === "external CSS"
            ? '<link rel="stylesheet" href="styles/main.css">'
            : '<script src="scripts/main.js"></script>';
    const f = await setup(
      document(
        '<div id="title" data-start="0" data-duration="5">Title</div>',
        shared,
      ),
    );
    try {
      await mkdir(`${f.project.path}/styles`);
      await mkdir(`${f.project.path}/scripts`);
      await writeFile(
        `${f.project.path}/styles/main.css`,
        "body{background:url(../card.png)}",
      );
      await writeFile(
        `${f.project.path}/scripts/main.js`,
        'const image="../card.png";',
      );
      await f.review.editAssets(f.project, "external", () =>
        writeFile(`${f.project.path}/card.png`, "blue"),
      );
      const view = await f.read();
      expect(view.agentChanges).toEqual([]);
      expect(view.clipEdits).toHaveLength(1);
      expect(view.clipEdits[0]).toMatchObject({
        clipId: null,
        by: "agent",
        accepted: false,
        resolution: undefined,
      });
    } finally {
      await f.close();
    }
  },
);

test("asset replacement, deletion, acceptance and unchanged revisions use the existing review ledger", async () => {
  const f = await setup();
  try {
    await f.review.editAssets(f.project, "external", () =>
      writeFile(`${f.project.path}/card.png`, "blue"),
    );
    expect((await f.read()).agentChanges).toEqual(["title"]);
    await f.review.acceptChanges(f.project);
    expect((await f.read()).agentChanges).toEqual([]);
    await f.review.editAssets(f.project, "external", () =>
      unlink(`${f.project.path}/card.png`),
    );
    expect((await f.read()).agentChanges).toEqual(["title"]);
    await f.review.acceptChanges(f.project);
    for (let i = 0; i < 3; i++) {
      await f.review.editComposition(f.project, "index.html", "external", () =>
        writeFile(
          `${f.project.path}/index.html`,
          document(image, `<script>const revision=${i}</script>`),
        ),
      );
      expect((await f.read()).agentChanges).toEqual([]);
    }
  } finally {
    await f.close();
  }
});

test("watcher attributes direct media writes to the active turn, while owner uploads stay owner writes", async () => {
  const f = await setup();
  const api = createHyperframesApi(f.store, f.review);
  f.app.route("/api/editor", api);
  const base = `/api/editor/projects/${f.project.id}`;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: f.app.fetch,
  });
  const upload = async () => {
    const form = new FormData();
    form.append(
      "files",
      new File(
        [
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
            "base64",
          ),
        ],
        "card.png",
        { type: "image/png" },
      ),
    );
    return fetch(`${server.url.origin}${base}/upload`, {
      method: "POST",
      body: form,
    });
  };
  try {
    expect((await f.app.request(base)).status).toBe(200);
    const turn = await f.review.beginTurn(f.project, {
      id: "synthetic",
      kind: "message",
      token: "test",
    });
    try {
      expect(
        (await f.app.request(`${base}/files/card.png`, { method: "DELETE" }))
          .status,
      ).toBe(200);
      const owner = await upload();
      expect(owner.status, await owner.clone().text()).toBe(201);
      expect((await owner.json()).files).toEqual(["card.png"]);
      await f.review.observeAssets(f.project);
      expect((await f.read()).agentChanges).toEqual([]);
      const agent = await f.app.request(`${base}/files/card.png`, {
        method: "DELETE",
        headers: { "x-cutroom-agent": "external" },
      });
      expect(agent.status, await agent.text()).toBe(200);
      expect((await f.read()).agentChanges).toEqual(["title"]);
      await f.review.acceptChanges(f.project);
      const changed = new Promise<void>((resolve) => {
        const stop = api.subscribe(f.project.id, (change) => {
          if (
            change.path === "card.png" &&
            change.version === fileContentVersion("direct agent blue")
          ) {
            stop();
            resolve();
          }
        });
      });
      await writeFile(
        `${f.project.path}/index.html`,
        document(image, "<script>const revision=2;</script>"),
      );
      await writeFile(`${f.project.path}/card.png`, "direct agent blue");
      await changed;
      expect((await f.read()).agentChanges).toEqual(["title"]);
    } finally {
      await turn.end();
    }
    await f.review.acceptChanges(f.project);
    await writeFile(`${f.project.path}/card.png`, "owner outside a turn");
    await f.review.observeAssets(f.project);
    expect((await f.read()).agentChanges).toEqual([]);
  } finally {
    await api.dispose();
    await server.stop(true);
    await f.close();
  }
});

test("view writes under an active agent turn emit no project events, review rows, or agent marks", async () => {
  const f = await setup();
  const api = createHyperframesApi(f.store, f.review);
  f.app.route("/api/editor", api);
  f.app.route("/api/cutroom", createTimelineRoutes(f.store, f.review));
  const changes: string[] = [];
  const stop = api.subscribe(f.project.id, (change) =>
    changes.push(change.path),
  );
  try {
    expect(
      (await f.app.request(`/api/editor/projects/${f.project.id}`)).status,
    ).toBe(200);
    const before = await f.read();
    const turn = await f.review.beginTurn(f.project, {
      id: "view-test",
      kind: "message",
      token: "view-test",
    });
    try {
      expect(
        (
          await f.request(`/projects/${f.project.id}/timeline-view`, "PUT", {
            density: "compact",
            heights: { "0": 100 },
          })
        ).status,
      ).toBe(200);
      // Let the real watcher drain, then prove it still reports ordinary project files.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(changes).toEqual([]);
      const changed = new Promise<void>((resolve) => {
        const unsubscribe = api.subscribe(f.project.id, (change) => {
          if (change.path === "sentinel.txt") {
            unsubscribe();
            resolve();
          }
        });
      });
      await writeFile(`${f.project.path}/sentinel.txt`, "watcher is live");
      await changed;
      expect(changes).toEqual(["sentinel.txt"]);
      const after = await f.read();
      expect(after.agentChanges).toEqual(before.agentChanges);
      expect(after.clipEdits).toEqual(before.clipEdits);
      expect(await f.review.list(f.project)).toEqual([]);
    } finally {
      await turn.end();
    }
  } finally {
    stop();
    await api.dispose();
    await f.close();
  }
});

test("asset snapshots preserve exclusive turn admission", async () => {
  const f = await setup();
  try {
    const turns = await Promise.allSettled(
      ["first", "second"].map((id) =>
        f.review.beginTurn(f.project, { id, kind: "message", token: id }),
      ),
    );
    expect(turns.filter((turn) => turn.status === "fulfilled")).toHaveLength(1);
    expect(turns.filter((turn) => turn.status === "rejected")).toHaveLength(1);
    for (const turn of turns)
      if (turn.status === "fulfilled") await turn.value.end();
  } finally {
    await f.close();
  }
});
