import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createMcpServer } from "../src/server/mcp/server";
import { createLayerTextRoutes } from "../src/server/projects/layerText";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { LayerTextSnapshotSchema } from "../src/shared/layerText";
import { AGENT_HEADER } from "../src/shared/review";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { projectFixture } from "./project-fixture";

const authored = `<!doctype html><script src="assets/vendor/gsap.min.js"></script><main data-composition-id="main" data-duration="4">
  <div id='card' data-start="1" data-duration="2" data-track-index="1">
    <p id='title' class="headline">  Before &amp; after  </p>
    <p id="credit">By Ada</p>
    <p id="duplicate">First duplicate</p>
    <p id="styled">Styled <em>words</em></p>
    <p id="break">Branded<br class="marker">break</p>
    <p id="variable" data-var-text="variable">Bound value</p>
    <div data-start="0" data-duration="2"><span id="own-timing">Timed inside</span></div>
    <div data-composition-id="nested"><p id="nested-copy">Own scope</p></div>
  </div>
  <div id="other" data-start="0" data-duration="4"><p id="duplicate">Other duplicate</p></div>
</main>
<template><p id="title">Inert</p></template>`;

async function fixture() {
  const f = await projectFixture();
  f.app.route("/api/cutroom", createLayerTextRoutes(f.store, f.review));
  f.app.route("/api/cutroom", createTimelineRoutes(f.store, f.review));
  const project = await f.store.create({
    name: "Layer text",
    duration: 4,
    width: 640,
    height: 360,
  });
  const file = join(project.path, "index.html");
  await writeFile(file, authored);
  const base = `/projects/${project.id}`;
  const path = `${base}/layer-text`;
  const list = async (composition = "index.html") =>
    LayerTextSnapshotSchema.parse(
      await (
        await f.request(
          `${path}?${new URLSearchParams({ composition, clipId: "card" })}`,
        )
      ).json(),
    );
  const update = (
    expectedVersion: string,
    layerId = "title",
    composition = "index.html",
  ) =>
    f.request(path, "POST", {
      composition,
      clipId: "card",
      expectedVersion,
      layerId,
      text: "Changed",
    });
  return { ...f, project, file, base, path, list, update };
}

test("MCP lists scoped text layers and edits exactly one element's source through shared history", async () => {
  const f = await fixture();
  const server = createMcpServer({
    fetch: (url, init) => f.app.request(url, init),
  });
  const client = new Client({ name: "layer-text-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(remote);
    await client.connect(local);
    const args = { projectId: f.project.id, clipId: "card" };
    const read = await client.callTool({
      name: "layer_text_list",
      arguments: args,
    });
    const envelope = z.object({
      structuredContent: z.object({ result: LayerTextSnapshotSchema }),
    });
    const before = envelope.parse(read).structuredContent.result;
    expect(before.layers).toEqual([
      { id: "title", text: "Before & after", reason: null },
      { id: "credit", text: "By Ada", reason: null },
      {
        id: "duplicate",
        text: "First duplicate",
        reason: expect.stringContaining("more than once"),
      },
      {
        id: "styled",
        text: "Styled words",
        reason: expect.stringContaining("markup"),
      },
      {
        id: "break",
        text: "Branded\nbreak",
        reason: expect.stringContaining("markup"),
      },
      {
        id: "variable",
        text: "Bound value",
        reason: expect.stringContaining("variable"),
      },
    ]);
    const change = {
      ...args,
      expectedVersion: before.version,
      layerId: "title",
      text: "New <edition> & draft\nTuesday",
    };
    const response = await client.callTool({
      name: "layer_text_update",
      arguments: change,
    });
    const after = envelope.parse(response).structuredContent.result;
    expect(after.layers[0]?.text).toBe(change.text);
    const changed = authored.replace(
      "Before &amp; after",
      "New &lt;edition&gt; &amp; draft<br>Tuesday",
    );
    expect(await readFile(f.file, "utf8")).toBe(changed);
    const conflict = await f.update(before.version);
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toContain("The source changed");
    expect(await readFile(f.file, "utf8")).toBe(changed);

    const history = z
      .object({
        entries: z.array(
          z.object({ label: z.string(), who: z.object({ kind: z.string() }) }),
        ),
      })
      .parse(await (await f.request(`${f.base}/history`)).json());
    expect(
      history.entries.filter(({ label }) => label === "Edit layer text"),
    ).toEqual([{ label: "Edit layer text", who: { kind: "agent" } }]);
    expect((await f.request(`${f.base}/history/undo`, "POST")).ok).toBe(true);
    expect(await readFile(f.file, "utf8")).toBe(authored);
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});

for (const opened of ["index.html", "alias.html"])
  test(`a lock saved under ${opened} is enforced through both source paths at the same version`, async () => {
    const f = await fixture();
    try {
      const live = authored.replace(
        '\n<template><p id="title">Inert</p></template>',
        "",
      );
      await writeFile(f.file, live);
      await symlink("index.html", join(f.project.path, "alias.html"));
      const before = await f.list();
      const timeline = TimelineViewSchema.parse(
        await (
          await f.request(`${f.base}/timeline?composition=${opened}`)
        ).json(),
      );
      expect(
        (
          await f.request(`${f.base}/commands`, "POST", {
            composition: opened,
            expectedRevision: timeline.revision,
            commands: [{ type: "setTrack", index: 1, locked: true }],
          })
        ).ok,
      ).toBe(true);
      const document = await f.store.document(f.project);
      expect(Object.keys(document.timelines)).toEqual([opened]);
      for (const path of ["index.html", "./alias.html"]) {
        const locked = await f.list(path);
        expect(locked).toMatchObject({
          composition: "index.html",
          locked: true,
          version: before.version,
        });
        const denied = await f.update(before.version, "title", path);
        expect(denied.status).toBe(422);
        expect(await denied.text()).toContain("locked track");
      }
      expect(await readFile(f.file, "utf8")).toBe(live);
    } finally {
      await f.close();
    }
  });

test("template scope, source-only cases and authorization cannot be bypassed by a direct write", async () => {
  const f = await fixture();
  try {
    const scene = join(f.project.path, "scene.html");
    const external = `<p id="title">Live outside template</p><template><main data-composition-id="scene"><div id="card" data-start="0" data-duration="2"><div id="title">Inside template</div></div></main></template><template><p id="title">Other template</p></template>`;
    await writeFile(scene, external);
    const listed = await f.list("scene.html");
    expect(listed.layers).toEqual([
      { id: "title", text: "Inside template", reason: null },
    ]);
    expect((await f.update(listed.version, "title", "scene.html")).ok).toBe(
      true,
    );
    expect(await readFile(scene, "utf8")).toBe(
      external.replace("Inside template", "Changed"),
    );

    const original = await f.list();
    for (const layer of [
      "duplicate",
      "styled",
      "break",
      "variable",
      "own-timing",
      "nested-copy",
    ]) {
      expect((await f.update(original.version, layer)).status).toBe(422);
    }
    const denied = await f.app.request(`/api/cutroom${f.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: "unknown-token",
      },
      body: JSON.stringify({
        clipId: "card",
        expectedVersion: original.version,
        layerId: "title",
        text: "Denied",
      }),
    });
    expect(denied.status).toBe(409);
    expect(await denied.text()).toContain("No Cutroom run is active");
    expect(await readFile(f.file, "utf8")).toBe(authored);

    const computed = `${authored}<script>const ref = "#" + "title"; document.querySelector(ref).firstChild["da" + "ta"] = "Computed";</script>`;
    await writeFile(f.file, computed);
    const snapshot = await f.list();
    expect(snapshot.layers[0]?.reason).toContain("at runtime");
    expect((await f.update(snapshot.version)).status).toBe(422);
    expect(await readFile(f.file, "utf8")).toBe(computed);
  } finally {
    await f.close();
  }
});

test("layer edits refuse spacing that a text replacement would change", async () => {
  const f = await fixture();
  try {
    const spaced = authored.replace("Before &amp; after", "A    B");
    const scene = `<html><head><link rel="stylesheet" href="spacing.css"></head><body><template><main data-composition-id="scene"><div id="card" data-start="0" data-duration="2"><span id="title">A    B</span></div></main></template></body></html>`;
    await writeFile(
      join(f.project.path, "spacing.css"),
      "#title{white-space:pre}",
    );
    for (const [path, content] of [
      [
        "index.html",
        spaced.replace("id='card'", "id='card' style='white-space:pre'"),
      ],
      [
        "index.html",
        spaced.replace("<main", "<style>#title{white-space:pre}</style><main"),
      ],
      [
        "index.html",
        spaced.replace(
          "id='card'",
          "id='card' style='white-space-collapse:preserve'",
        ),
      ],
      [
        "index.html",
        spaced.replace("<main", '<style>@import "spacing.css";</style><main'),
      ],
      ["index.html", authored.replace("Before &amp; after", "&#32;A B&#32;")],
      ["scene.html", scene],
    ] as const) {
      const file = join(f.project.path, path);
      await writeFile(file, content);
      const snapshot = await f.list(path);
      expect(
        snapshot.layers.find(({ id }) => id === "title")?.reason,
      ).toContain("spacing");
      const refused = await f.update(snapshot.version, "title", path);
      expect(refused.status).toBe(422);
      expect(await readFile(file, "utf8")).toBe(content);
    }
  } finally {
    await f.close();
  }
});

test("replacing the vendor script makes the composition source-only without changing its HTML version", async () => {
  const f = await fixture();
  try {
    const before = await f.list();
    expect(before.layers[0]?.reason).toBeNull();
    await writeFile(
      join(f.project.path, "assets/vendor/gsap.min.js"),
      "document.querySelector('#title').firstChild.data = 'Computed';",
    );
    const after = await f.list();
    expect(after.version).toBe(before.version);
    expect(after.layers[0]?.reason).toContain("at runtime");
    expect((await f.update(before.version)).status).toBe(422);
    expect(await readFile(f.file, "utf8")).toBe(authored);
  } finally {
    await f.close();
  }
});
