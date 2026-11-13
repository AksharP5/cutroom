import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { ProjectSchema } from "../src/shared/project";
import { projectFixture } from "./project-fixture";
import { projectViews } from "../src/server/projects/view";

let fixture: Awaited<ReturnType<typeof projectFixture>>;
let project: z.infer<typeof ProjectSchema>;

const VIDEO = Buffer.alloc(4096, 7);
const at = (path: string) => join(project.path, path);
const present = (path: string) =>
  stat(at(path)).then(
    () => true,
    () => false,
  );
const post = (action: "rename" | "remove", body: unknown) =>
  fixture.request(`/projects/${project.id}/media/${action}`, "POST", body);
const step = (direction: "undo" | "redo") =>
  fixture.request(`/projects/${project.id}/history/${direction}`, "POST");
const entries = async () =>
  z
    .object({
      entries: z.array(z.object({ label: z.string(), undone: z.boolean() })),
    })
    .parse(
      await (await fixture.request(`/projects/${project.id}/history`)).json(),
    ).entries;

/** The picture and its linked sound play one file; a nested composition and the sidecar name it too. */
beforeEach(async () => {
  fixture = await projectFixture();
  project = await fixture.store.create({ name: "Media files" });
  await mkdir(at("compositions"));
  await writeFile(at("assets/my clip.mp4"), VIDEO);
  await writeFile(at("assets/unused.mp3"), Buffer.alloc(2048, 3));
  await writeFile(
    at("index.html"),
    (await readFile(at("index.html"), "utf8")).replace(
      /<main([^>]*)>[\s\S]*<\/main>/,
      `<main$1>
<video src="assets/my%20clip.mp4" muted id="picture" class="clip" data-start="0" data-duration="4" data-track-index="0" data-link="pair"></video>
<audio src="assets/my clip.mp4" id="sound" class="clip" data-start="0" data-duration="4" data-track-index="1" data-link="pair"></audio>
<video src="./assets/my clip.mp4" muted id="again" class="clip" data-start="4" data-duration="2" data-track-index="0"></video>
</main>`,
    ),
  );
  await writeFile(
    at("compositions/intro.html"),
    `<div data-composition-id="intro" data-width="1920" data-height="1080" data-duration="2"><video src="../assets/my clip.mp4" id="nested" class="clip" data-start="0" data-duration="2" data-track-index="0"></video></div>`,
  );
  // History adopts what is on disk before the first edit, as it does for an open project.
  await (await fixture.store.history(project)).checkpoint();
});
afterEach(() => fixture.close());

test("review: rename resolves references from their declaring file without changing another folder's media", async () => {
  await mkdir(at("other"));
  await writeFile(at("other/my clip.mp4"), "other video");
  const cases = {
    "assets/local.html":
      '<video src="./my%20clip.mp4?preview=1#frame"></video>',
    "assets/style.css":
      '.a{background:url("./my%20clip.mp4")} .b{background:url(../assets/my%20clip.mp4)}',
    "assets/helper.js":
      'const local = "./my clip.mp4"; const root = "assets/my clip.mp4";',
    "assets/ref.svg": '<svg><image href="my%20clip.mp4"/></svg>',
    "other/local.htm":
      '<video src="../assets/my%20clip.mp4"></video><video src="./my%20clip.mp4"></video>',
  };
  for (const [path, content] of Object.entries(cases))
    await writeFile(at(path), content);
  await (await fixture.store.history(project)).checkpoint();
  expect(
    (
      await post("rename", {
        path: "assets/my clip.mp4",
        name: "東京 clip.mp4",
      })
    ).status,
  ).toBe(200);
  expect(await readFile(at("assets/local.html"), "utf8")).toBe(
    '<video src="./%E6%9D%B1%E4%BA%AC%20clip.mp4?preview=1#frame"></video>',
  );
  expect(await readFile(at("assets/style.css"), "utf8")).toContain(
    'url("./%E6%9D%B1%E4%BA%AC%20clip.mp4")',
  );
  expect(await readFile(at("assets/helper.js"), "utf8")).toContain(
    '"./東京 clip.mp4"',
  );
  expect(await readFile(at("assets/ref.svg"), "utf8")).toContain(
    'href="%E6%9D%B1%E4%BA%AC%20clip.mp4"',
  );
  expect(await readFile(at("other/local.htm"), "utf8")).toBe(
    '<video src="../assets/%E6%9D%B1%E4%BA%AC%20clip.mp4"></video><video src="./my%20clip.mp4"></video>',
  );
  expect((await step("undo")).status).toBe(200);
  for (const [path, content] of Object.entries(cases))
    expect(await readFile(at(path), "utf8")).toBe(content);
});

test("review: an SVG can be renamed and restored with its references", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  await writeFile(at("assets/logo.svg"), svg);
  await writeFile(at("assets/logo.css"), '.logo{background:url("./logo.svg")}');
  await (await fixture.store.history(project)).checkpoint();
  expect(
    (await post("rename", { path: "assets/logo.svg", name: "brand.svg" }))
      .status,
  ).toBe(200);
  expect(await readFile(at("assets/brand.svg"), "utf8")).toBe(svg);
  expect(await readFile(at("assets/logo.css"), "utf8")).toContain(
    'url("./brand.svg")',
  );
  expect((await step("undo")).status).toBe(200);
  expect(await readFile(at("assets/logo.svg"), "utf8")).toBe(svg);
});

test("review: CSS backgrounds and composition script dependencies require removal confirmation", async () => {
  await writeFile(
    at("assets/bg.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  const entry = await readFile(at("index.html"), "utf8");
  for (const content of [
    entry.replace(
      /<main([^>]*)>[\s\S]*<\/main>/,
      '<main$1><div class="clip" id="background" data-start="0" data-duration="4" data-track-index="0" style="background-image:url(assets/bg.svg)"></div></main>',
    ),
    entry.replace(
      "</head>",
      "<style>body{background:url(assets/bg.svg)}</style></head>",
    ),
    entry.replace("</head>", '<script src="assets/helper.js"></script></head>'),
    entry.replace(
      "</head>",
      '<link rel="stylesheet" href="assets/style.css"></head>',
    ),
  ]) {
    await writeFile(at("assets/helper.js"), 'const picture = "./bg.svg";');
    await writeFile(at("assets/style.css"), 'body{background:url("./bg.svg")}');
    await writeFile(at("index.html"), content);
    await (await fixture.store.history(project)).checkpoint();
    const response = await post("remove", { path: "assets/bg.svg" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ uses: 1 });
    expect(await present("assets/bg.svg")).toBe(true);
  }
});

test("review: saved source marks follow rename, undo and redo outside history", async () => {
  const from = "assets/my clip.mp4";
  const to = "assets/talk.mp4";
  const identity = { size: VIDEO.length, duration: 6 };
  const marks = { in: 1, out: 3 };
  await projectViews.saveSource(project, from, { ...marks, identity });
  expect((await post("rename", { path: from, name: "talk.mp4" })).status).toBe(
    200,
  );
  expect(await projectViews.readSource(project, to, identity)).toEqual(marks);
  expect(await projectViews.readSource(project, from, identity)).toEqual({
    in: null,
    out: null,
  });
  expect((await step("undo")).status).toBe(200);
  expect(await projectViews.readSource(project, from, identity)).toEqual(marks);
  expect((await step("redo")).status).toBe(200);
  expect(await projectViews.readSource(project, to, identity)).toEqual(marks);
  expect(
    JSON.parse(await readFile(at(".cutroom/view.json"), "utf8")),
  ).toMatchObject({ sources: { [to]: { ...marks, identity } } });
  expect((await post("remove", { path: to, confirmUsed: true })).status).toBe(
    200,
  );
  expect((await step("undo")).status).toBe(200);
  expect(await projectViews.readSource(project, to, identity)).toEqual(marks);
});

test("a rename moves the file and every source reference in one undo step", async () => {
  // Files a broad rewrite must never reach: agent instructions and native settings.
  const instructions = "Use assets/my clip.mp4 for the opening.";
  const settings = '{"permissions":{"allow":["Read(assets/my clip.mp4)"]}}';
  await writeFile(at("CLAUDE.md"), instructions);
  await mkdir(at(".claude"));
  await writeFile(at(".claude/settings.local.json"), settings);
  await (await fixture.store.history(project)).checkpoint();
  const before = await readFile(at("index.html"), "utf8");
  const steps = (await entries()).length;

  const response = await post("rename", {
    path: "assets/my clip.mp4",
    name: "talk & walk.mp4",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    path: "assets/talk & walk.mp4",
    sources: ["index.html", "compositions/intro.html"],
  });
  expect(await present("assets/my clip.mp4")).toBe(false);
  expect(await readFile(at("assets/talk & walk.mp4"))).toEqual(VIDEO);
  // Each reference keeps the spelling its author used: percent-encoded, plain, or relative.
  const after = await readFile(at("index.html"), "utf8");
  expect(after).toContain(
    'src="assets/talk%20%26%20walk.mp4" muted id="picture"',
  );
  expect(after).toContain('src="assets/talk &amp; walk.mp4" id="sound"');
  expect(after).toContain(
    'src="./assets/talk &amp; walk.mp4" muted id="again"',
  );
  expect(await readFile(at("compositions/intro.html"), "utf8")).toContain(
    'src="../assets/talk &amp; walk.mp4"',
  );
  expect(await readFile(at("CLAUDE.md"), "utf8")).toBe(instructions);
  expect(await readFile(at(".claude/settings.local.json"), "utf8")).toBe(
    settings,
  );
  expect((await entries()).slice(steps)).toEqual([
    { label: "Rename my clip.mp4 to talk & walk.mp4", undone: false },
  ]);

  expect((await step("undo")).status).toBe(200);
  expect(await readFile(at("assets/my clip.mp4"))).toEqual(VIDEO);
  expect(await present("assets/talk & walk.mp4")).toBe(false);
  expect(await readFile(at("index.html"), "utf8")).toBe(before);
  expect(await readFile(at("compositions/intro.html"), "utf8")).toContain(
    'src="../assets/my clip.mp4"',
  );

  expect((await step("redo")).status).toBe(200);
  expect(await readFile(at("assets/talk & walk.mp4"))).toEqual(VIDEO);
  expect(await readFile(at("index.html"), "utf8")).toBe(after);
});

test("a rename is the owner's edit on every clip that plays the file", async () => {
  expect(
    (await post("rename", { path: "assets/my clip.mp4", name: "talk.mp4" }))
      .status,
  ).toBe(200);
  const { clipEdits } = await fixture.review.clipChanges(project, "index.html");
  // Attributed rows keep the editor from reporting its own rename as an outside change.
  expect(
    clipEdits
      .filter((edit) => edit.composition === "index.html")
      .map(({ clipId, label, by }) => ({ clipId, label, by }))
      .sort((a, b) => String(a.clipId).localeCompare(String(b.clipId))),
  ).toEqual(
    ["again", "picture", "sound"].map((clipId) => ({
      clipId,
      label: "Rename my clip.mp4 to talk.mp4",
      by: "human",
    })),
  );
});

test("a rename refuses names that would lose or replace a file", async () => {
  await writeFile(at("assets/taken.mp4"), "other");
  const refused = async (body: unknown) => {
    const response = await post("rename", body);
    return [
      response.status,
      z.object({ error: z.string() }).parse(await response.json()).error,
    ];
  };
  expect(
    await refused({ path: "assets/my clip.mp4", name: "taken.mp4" }),
  ).toEqual([
    409,
    "taken.mp4 already exists in this folder. Choose another name.",
  ]);
  expect(
    await refused({ path: "assets/my clip.mp4", name: "talk.mov" }),
  ).toEqual([
    400,
    "Keep the .mp4 extension. Renaming does not convert the file.",
  ]);
  for (const name of ["../escape.mp4", "nested/clip.mp4", ".hidden.mp4", " "])
    expect((await refused({ path: "assets/my clip.mp4", name }))[0]).toBe(400);
  // Only media is renamed here; sources and protected files have their own routes.
  for (const path of ["index.html", "cutroom.json", "../outside.mp4"])
    expect((await refused({ path, name: "renamed.mp4" }))[0]).toBeOneOf([
      400, 403,
    ]);
  expect(await readFile(at("assets/my clip.mp4"))).toEqual(VIDEO);
  expect(await readFile(at("assets/taken.mp4"), "utf8")).toBe("other");
});

test("remove moves an unused file to the project trash and undo brings it back", async () => {
  const audio = await readFile(at("assets/unused.mp3"));
  const response = await post("remove", { path: "assets/unused.mp3" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    path: "assets/unused.mp3",
    trash: "trash/unused.mp3",
    uses: 0,
  });
  expect(await present("assets/unused.mp3")).toBe(false);
  expect(await readFile(at("trash/unused.mp3"))).toEqual(audio);
  expect((await entries()).at(-1)).toEqual({
    label: "Remove unused.mp3",
    undone: false,
  });

  // History keeps no copy of audio or video, so the trash is what makes this undo possible.
  expect((await step("undo")).status).toBe(200);
  expect(await readFile(at("assets/unused.mp3"))).toEqual(audio);
  expect(await readdir(at("trash")).catch(() => [])).toEqual([]);

  expect((await step("redo")).status).toBe(200);
  expect(await present("assets/unused.mp3")).toBe(false);
  expect(await readFile(at("trash/unused.mp3"))).toEqual(audio);

  // A second file of the same name never replaces the one already in the trash.
  await writeFile(at("assets/unused.mp3"), "second");
  expect(
    await (await post("remove", { path: "assets/unused.mp3" })).json(),
  ).toMatchObject({ trash: "trash/unused 2.mp3" });
  expect(await readFile(at("trash/unused.mp3"))).toEqual(audio);
  expect(await readFile(at("trash/unused 2.mp3"), "utf8")).toBe("second");
});

test("remove asks before taking a file the timeline still uses", async () => {
  const asked = await post("remove", { path: "assets/my clip.mp4" });
  expect(asked.status).toBe(409);
  // The picture and its linked sound are one clip to the editor; the nested composition adds one.
  expect(await asked.json()).toEqual({
    error:
      "assets/my clip.mp4 has 3 uses in the project. Removing it leaves existing clips and references offline until the file is back. Send confirmUsed: true to remove it anyway.",
    uses: 3,
  });
  expect(await readFile(at("assets/my clip.mp4"))).toEqual(VIDEO);

  const source = await readFile(at("index.html"), "utf8");
  const confirmed = await post("remove", {
    path: "assets/my clip.mp4",
    confirmUsed: true,
  });
  expect(await confirmed.json()).toEqual({
    path: "assets/my clip.mp4",
    trash: "trash/my clip.mp4",
    uses: 3,
  });
  // The clips stay where they were, so undo restores the cut exactly.
  expect(await readFile(at("index.html"), "utf8")).toBe(source);
  expect((await step("undo")).status).toBe(200);
  expect(await readFile(at("assets/my clip.mp4"))).toEqual(VIDEO);
});

test("removed files leave the project listing and cannot be removed twice", async () => {
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/editor", editor);
  try {
    const files = async () =>
      z
        .object({ files: z.array(z.string()) })
        .parse(
          await (
            await fixture.app.request(`/api/editor/projects/${project.id}`)
          ).json(),
        )
        .files.filter((file) => /\.mp[34]$/.test(file))
        .sort();
    expect(await files()).toEqual(["assets/my clip.mp4", "assets/unused.mp3"]);
    await post("remove", { path: "assets/unused.mp3" });
    expect(await files()).toEqual(["assets/my clip.mp4"]);
    for (const action of ["remove", "rename"] as const)
      expect(
        (await post(action, { path: "trash/unused.mp3", name: "again.mp3" }))
          .status,
      ).toBe(400);
    expect(await present("trash/unused.mp3")).toBe(true);
  } finally {
    await editor.dispose();
  }
});

test("an agent renames, removes, and restores media through MCP as the owner does", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "media-test", version: "1" });
  const call = async (name: string, input: Record<string, unknown>) => {
    const result = z
      .object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ text: z.string() })),
      })
      .parse(
        await client.callTool({
          name,
          arguments: { projectId: project.id, ...input },
        }),
      );
    return { refused: result.isError === true, text: result.content[0]!.text };
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const renamed = await call("media_rename", {
      path: "assets/my clip.mp4",
      name: "talk.mp4",
    });
    expect(renamed.refused).toBe(false);
    expect(await readFile(at("index.html"), "utf8")).toContain(
      'src="assets/talk.mp4" muted id="picture"',
    );

    // The question the editor asks its owner reaches an agent as a refusal it can answer.
    const asked = await call("media_remove", { path: "assets/talk.mp4" });
    expect(asked.refused).toBe(true);
    expect(asked.text).toContain("assets/talk.mp4 has 3 uses in the project.");
    expect(await present("assets/talk.mp4")).toBe(true);
    expect(
      (
        await call("media_remove", {
          path: "assets/talk.mp4",
          confirmUsed: true,
        })
      ).refused,
    ).toBe(false);
    expect(await readFile(at("trash/talk.mp4"))).toEqual(VIDEO);

    expect((await call("history_undo", {})).refused).toBe(false);
    expect(await readFile(at("assets/talk.mp4"))).toEqual(VIDEO);
    // The entries are the agent's, named as the editor names its own.
    const history = z
      .object({
        entries: z.array(
          z.object({ label: z.string(), who: z.object({ kind: z.string() }) }),
        ),
      })
      .parse(
        await (await fixture.request(`/projects/${project.id}/history`)).json(),
      );
    expect(
      history.entries
        .filter((entry) => entry.who.kind === "agent")
        .map((entry) => entry.label),
    ).toEqual(["Rename my clip.mp4 to talk.mp4", "Remove talk.mp4"]);
  } finally {
    await client.close();
    await server.stop(true);
  }
});
