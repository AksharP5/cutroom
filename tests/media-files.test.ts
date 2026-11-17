import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { localMediaPath } from "../src/shared/media";
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

test("a freeze frame is one Media item through nested reuse, rename, trash and history", async () => {
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/editor", editor);
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const preview = "assets/freeze/still.png";
  const exported = "assets/freeze/export/still.png";
  const scene = "compositions/deep/scene.html";
  await mkdir(at("assets/freeze/export"), { recursive: true });
  await mkdir(at("compositions/deep"));
  await writeFile(at(preview), "preview pixels");
  await writeFile(at(exported), "export pixels");
  const entry = await readFile(at("index.html"), "utf8");
  const html = (src: string, extra: string) =>
    `<img id="still" class="clip" src="${src}" ${extra} data-start="0" data-duration="2" data-track-index="0">`;
  await writeFile(
    at("index.html"),
    entry.replace(
      /<main([^>]*)>[\s\S]*<\/main>/,
      `<main$1>${html(preview, `data-cutroom-freeze-export="${exported}"`)}</main>`,
    ),
  );
  await writeFile(
    at(scene),
    '<main data-composition-id="scene" data-duration="4" data-width="320" data-height="180" data-fps="30"></main>',
  );
  await (await fixture.store.history(project)).checkpoint();
  const base = `/projects/${project.id}`;
  const files = async () =>
    z
      .object({ files: z.array(z.string()) })
      .parse(await (await fixture.app.request(`/api/editor${base}`)).json())
      .files.filter((path) => path.startsWith("assets/freeze/"));
  try {
    expect(await files()).toEqual([preview]);
    const { revision } = z
      .object({ revision: z.string() })
      .parse(
        await (
          await fixture.request(`${base}/timeline?composition=${scene}`)
        ).json(),
      );
    const insert = await fixture.request(`${base}/commands`, "POST", {
      composition: scene,
      expectedRevision: revision,
      commands: [
        {
          type: "insert",
          at: 15,
          track: 0,
          clip: {
            kind: "image",
            src: `../../${preview}`,
            id: "reused",
            duration: 30,
          },
        },
      ],
    });
    expect(insert.status).toBe(200);
    const nested = await readFile(at(scene), "utf8");
    expect(nested).toContain(`data-cutroom-freeze-export="../../${exported}"`);
    for (const path of [preview, exported]) {
      const ask = await post("remove", { path });
      expect(ask.status).toBe(409);
      expect(await ask.json()).toMatchObject({ uses: 2 });
    }

    const name = "renamed & held.png";
    const renamed = `assets/freeze/${name}`;
    const renamedExport = `assets/freeze/export/${name}`;
    await writeFile(at(renamedExport), "collision");
    expect((await post("rename", { path: preview, name })).status).toBe(409);
    expect(await files()).toEqual([preview]);
    expect(await readFile(at(renamedExport), "utf8")).toBe("collision");
    // Use another name with the same characters that need escaping in HTML.
    const finalName = "held & reused.png";
    const finalPreview = renamed.replace(name, finalName);
    const finalExport = renamedExport.replace(name, finalName);
    expect(
      (await post("rename", { path: preview, name: finalName })).status,
    ).toBe(200);
    expect(await files()).toEqual([finalPreview]);
    expect(await readFile(at(finalPreview), "utf8")).toBe("preview pixels");
    expect(await readFile(at(finalExport), "utf8")).toBe("export pixels");
    expect(await readFile(at(scene), "utf8")).toContain(
      'data-cutroom-freeze-export="../../assets/freeze/export/held &amp; reused.png"',
    );
    expect(await readFile(at("index.html"), "utf8")).toContain(
      'data-cutroom-freeze-export="assets/freeze/export/held &amp; reused.png"',
    );
    expect((await step("undo")).status).toBe(200);
    expect(await readFile(at(scene), "utf8")).toBe(nested);
    expect(await files()).toEqual([preview]);
    expect((await step("redo")).status).toBe(200);

    const removal = await post("remove", {
      path: finalExport,
      confirmUsed: true,
    });
    expect(removal.status).toBe(200);
    expect(await removal.json()).toEqual({
      path: finalPreview,
      trash: `trash/${finalName}`,
      uses: 2,
    });
    expect(await files()).toEqual([]);
    expect(await readFile(at(`trash/${finalName}`), "utf8")).toBe(
      "preview pixels",
    );
    expect(
      await readFile(at(`trash/assets/freeze/export/${finalName}`), "utf8"),
    ).toBe("export pixels");
    expect((await step("undo")).status).toBe(200);
    expect(await files()).toEqual([finalPreview]);
    expect(await readFile(at(finalExport), "utf8")).toBe("export pixels");
    expect((await step("redo")).status).toBe(200);
    expect(await present(finalExport)).toBe(false);
  } finally {
    await editor.dispose();
  }
});

test("freeze reuse and removal resolve in-project media aliases", async () => {
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const preview = "assets/freeze/still.png";
  const exported = "assets/freeze/export/still.png";
  await mkdir(at("assets/freeze/export"), { recursive: true });
  await writeFile(at(preview), "preview pixels");
  await writeFile(at(exported), "export pixels");
  await symlink("assets/freeze", at("alias"));
  await symlink(exported, at("render.png"));
  const html = await readFile(at("index.html"), "utf8");
  await writeFile(
    at("index.html"),
    html.replace(
      /<main([^>]*)>[\s\S]*<\/main>/,
      '<main$1><img id="still" class="clip" src="alias/still.png" data-start="0" data-duration="2" data-track-index="0"></main>',
    ),
  );
  await (await fixture.store.history(project)).checkpoint();

  const base = `/projects/${project.id}`;
  const insert = async (src: string) => {
    const { revision } = z
      .object({ revision: z.string() })
      .parse(await (await fixture.request(`${base}/timeline`)).json());
    return fixture.request(`${base}/commands`, "POST", {
      expectedRevision: revision,
      commands: [
        {
          type: "insert",
          at: 60,
          track: 0,
          clip: { kind: "image", src, id: "reused", duration: 30 },
        },
      ],
    });
  };

  const refusal = await post("remove", { path: preview });
  expect(refusal.status).toBe(409);
  expect(await refusal.json()).toMatchObject({ uses: 1 });
  for (const alias of ["alias/export/still.png", "render.png"]) {
    const result = await insert(alias);
    expect(result.status).toBe(422);
    expect(await result.json()).toMatchObject({
      error: expect.stringContaining("keep its preview and export together"),
    });
  }
  expect((await insert("alias/still.png")).status).toBe(200);
  const authored = await readFile(at("index.html"), "utf8");
  expect(authored).toContain(
    `src="alias/still.png" data-cutroom-freeze-export="${exported}"`,
  );
  expect(
    (await post("remove", { path: preview, confirmUsed: true })).status,
  ).toBe(200);
  expect(await present("alias/still.png")).toBe(false);
  expect((await step("undo")).status).toBe(200);
  expect(await present("alias/still.png")).toBe(true);
  expect(await readFile(at("index.html"), "utf8")).toBe(authored);
});

test("freeze rename keeps directory aliases and rewrites file aliases in their declaring scope", async () => {
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const preview = "assets/freeze/still.png";
  const exported = "assets/freeze/export/still.png";
  await mkdir(at("assets/freeze/export"), { recursive: true });
  await writeFile(at(preview), "preview pixels");
  await writeFile(at(exported), "export pixels");
  await symlink("assets/freeze", at("alias"));
  await symlink("../assets/freeze/still.png", at("compositions/file.png"));
  const main = (await readFile(at("index.html"), "utf8")).replace(
    /<main([^>]*)>[\s\S]*<\/main>/,
    `<main$1><img id="still" class="clip" src="/${preview}" data-cutroom-freeze-export="/${exported}" data-start="0" data-duration="2" data-track-index="0"></main>`,
  );
  await writeFile(at("index.html"), main);
  const scene = "compositions/intro.html";
  const before = await insertImages(scene, [
    "../alias/still.png",
    "./file.png",
  ]);
  expect(before).toContain(
    `src="../alias/still.png" data-cutroom-freeze-export="../${exported}"`,
  );
  expect(before).toContain(
    `src="./file.png" data-cutroom-freeze-export="../${exported}"`,
  );

  const rootBefore = await readFile(at("index.html"), "utf8");
  const name = "held#2 %23.png";
  const encoded = "held%232 %2523.png";
  const renamed = await post("rename", { path: preview, name });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({
    sources: ["index.html", scene],
  });
  const root = await readFile(at("index.html"), "utf8");
  const nested = await readFile(at(scene), "utf8");
  expect(root).toContain(
    `src="/assets/freeze/${encoded}" data-cutroom-freeze-export="/assets/freeze/export/${encoded}"`,
  );
  expect(nested).toContain(
    `src="../alias/${encoded}" data-cutroom-freeze-export="../assets/freeze/export/${encoded}"`,
  );
  expect(nested).toContain('src="../assets/freeze/held%232%20%2523.png"');
  for (const [file, source] of [
    ["index.html", root],
    [scene, nested],
  ] as const) {
    for (const [, attribute, value] of source.matchAll(
      /(src|data-cutroom-freeze-export)="([^"]+held[^"]+)"/g,
    )) {
      const path = localMediaPath(file, value!);
      expect(path).not.toBeNull();
      expect(await readFile(at(path!), "utf8")).toBe(
        attribute === "src" ? "preview pixels" : "export pixels",
      );
    }
  }
  expect((await step("undo")).status).toBe(200);
  expect(await readFile(at("index.html"), "utf8")).toBe(rootBefore);
  expect(await readFile(at(scene), "utf8")).toBe(before);
  expect(await readFile(at("compositions/file.png"), "utf8")).toBe(
    "preview pixels",
  );
  expect(await readFile(at(exported), "utf8")).toBe("export pixels");
  expect((await step("redo")).status).toBe(200);
  expect(await readFile(at(scene), "utf8")).toBe(nested);
});

async function insertImages(composition: string, sources: string[]) {
  const base = `/projects/${project.id}`;
  const { revision } = TimelineViewSchema.parse(
    await (
      await fixture.request(`${base}/timeline?composition=${composition}`)
    ).json(),
  );
  const commands = sources.map<CommandInput>((src, index) => ({
    type: "insert",
    at: 30 * index,
    track: index + 1,
    clip: { kind: "image", src, duration: 30 },
  }));
  const response = await fixture.request(`${base}/commands`, "POST", {
    composition,
    expectedRevision: revision,
    commands,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return readFile(at(composition), "utf8");
}

test("selective history protects a freeze used by another composition, including mounted build scenes", async () => {
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/editor", editor);
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const preview = "assets/freeze/still.png";
  const exported = "assets/freeze/export/still.png";
  const scene = "compositions/intro.html";
  const built = "build/intro.html";
  const builtSource =
    '<div data-composition-id="intro-build" data-width="1920" data-height="1080" data-duration="2"></div>';
  const ledger = await fixture.store.history(project);
  const indexBefore = (await readFile(at("index.html"), "utf8"))
    .replace(
      "<head>",
      "<head><style data-cutroom-track-layer>@layer cutroom-tracks;</style>\n",
    )
    .replace(
      "</main>",
      `<div id="nested-scene" data-composition-src="${scene}" data-start="0" data-duration="2" data-track-index="3"></div></main>`,
    );
  await mkdir(at("build"));
  await writeFile(at(built), builtSource);
  // The broken image URL must not block replay when the freeze has no uses.
  await writeFile(
    at(scene),
    `<div data-composition-id="intro" data-width="1920" data-height="1080" data-duration="2"><div data-composition-src="${built}" data-start="0" data-duration="2" data-track-index="0"></div><img src="../assets/unused.mp3/missing.png"></div>`,
  );
  await writeFile(at("index.html"), indexBefore);
  await ledger.checkpoint();
  const indexFrozen = indexBefore.replace(
    "</main>",
    `<img id="still" class="clip" src="${preview}" data-cutroom-freeze-export="${exported}" data-start="0" data-duration="2" data-track-index="2"></main>`,
  );
  const targets = [{ file: "index.html", id: "still" }];
  const who = { kind: "person", name: "You" } as const;
  const selected = (entryId: string, mode?: "keep-later-edits" | "just-this") =>
    fixture.app.request(`/api/editor/projects/${project.id}/history/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId, mode }),
    });
  const refuse = async (response: Response, usedBy = scene) => {
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining(`still used by ${usedBy}`),
    });
  };
  try {
    await mkdir(at("assets/freeze/export"), { recursive: true });
    await symlink("assets/freeze", at("alias"));
    await writeFile(at(preview), "preview pixels");
    await writeFile(at(exported), "export pixels");
    await writeFile(at("index.html"), indexFrozen);
    await ledger.claim(who, "Freeze frame", ["index.html", preview, exported], {
      targets,
    });
    await ledger.checkpoint();
    const freeze = ledger.list().at(-1)!;
    expect(freeze.targets).toEqual(targets);
    const builtReuse = await insertImages(built, ["../alias/still.png"]);
    const buildHistory = ledger.list();
    await refuse(await selected(freeze.id, "keep-later-edits"), built);
    expect(ledger.list()).toEqual(buildHistory);
    expect(await readFile(at(built), "utf8")).toBe(builtReuse);
    expect(await present(preview)).toBe(true);
    expect(await present(exported)).toBe(true);
    await writeFile(at(built), builtSource);

    const reused = await insertImages(scene, ["../alias/still.png"]);
    const history = ledger.list();
    for (const mode of [undefined, "keep-later-edits", "just-this"] as const)
      await refuse(await selected(freeze.id, mode));
    expect(ledger.list()).toEqual(history);
    expect(await readFile(at(scene), "utf8")).toBe(reused);
    expect(await readFile(at("index.html"), "utf8")).toBe(indexFrozen);
    expect(await present(preview)).toBe(true);
    expect(await present(exported)).toBe(true);

    expect((await step("undo")).status).toBe(200);
    expect((await selected(freeze.id)).status).toBe(200);
    expect(ledger.list().at(-1)).toMatchObject({ undoes: freeze.id, targets });
    expect(await readFile(at("index.html"), "utf8")).toBe(indexBefore);
    expect(await present(preview)).toBe(false);
    expect(await present(exported)).toBe(false);
    expect((await step("redo")).status).toBe(200);
    expect(await readFile(at("index.html"), "utf8")).toBe(indexFrozen);

    expect(
      (await post("rename", { path: preview, name: "renamed.png" })).status,
    ).toBe(200);
    expect((await step("undo")).status).toBe(200);
    const undoneRename = ledger.list().at(-1)!;
    const reusedAgain = await insertImages(scene, ["../alias/still.png"]);
    const beforeRedo = ledger.list();
    await refuse(await selected(undoneRename.id));
    expect(ledger.list()).toEqual(beforeRedo);
    expect(await readFile(at(scene), "utf8")).toBe(reusedAgain);
    expect(await readFile(at(preview), "utf8")).toBe("preview pixels");
    expect(await readFile(at(exported), "utf8")).toBe("export pixels");
  } finally {
    await editor.dispose();
  }
});

test.each([
  ["build", "image"],
  ["node_modules", "image"],
  ["node_modules", "stylesheet"],
])(
  "Media protects a freeze referenced by a mounted %s scene's %s",
  async (directory, reference) => {
    const preview = "assets/freeze/still.png";
    const exported = "assets/freeze/export/still.png";
    const scene = `${directory}/scene.html`;
    await mkdir(at(`${directory}/missing.html`), { recursive: true });
    await mkdir(at("assets/freeze/export"), { recursive: true });
    await writeFile(at(preview), "preview pixels");
    await writeFile(at(exported), "export pixels");
    const source = `<div data-composition-id="mounted" data-width="1920" data-height="1080" data-duration="2">${
      reference === "image"
        ? `<img id="still" class="clip" src="../${preview}" data-cutroom-freeze-export="../${exported}" data-start="0" data-duration="2" data-track-index="0">`
        : '<link rel="stylesheet" href="./scene.css">'
    } </div>`;
    const stylesheet = `${directory}/scene.css`;
    const css = `[data-composition-id="mounted"]{background-image:url("../${preview}")}`;
    if (reference === "stylesheet") await writeFile(at(stylesheet), css);
    await writeFile(at(scene), source);
    await writeFile(
      at("index.html"),
      (await readFile(at("index.html"), "utf8")).replace(
        "</main>",
        `<div id="mounted" data-composition-src="${scene}" data-start="0" data-duration="2" data-track-index="3"></div><div data-composition-src="${directory}/missing.html"></div></main>`,
      ),
    );
    await (await fixture.store.history(project)).checkpoint();

    const removed = await post("remove", { path: preview });
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ uses: 1 });
    const renamed = await post("rename", {
      path: preview,
      name: "renamed.png",
    });
    expect(renamed.status).toBe(409);
    expect(await renamed.json()).toMatchObject({
      error: expect.stringContaining(scene),
    });
    expect(await readFile(at(preview), "utf8")).toBe("preview pixels");
    expect(await readFile(at(exported), "utf8")).toBe("export pixels");
    expect(await readFile(at(scene), "utf8")).toBe(source);
    if (reference === "stylesheet")
      expect(await readFile(at(stylesheet), "utf8")).toBe(css);

    expect(
      (await post("remove", { path: preview, confirmUsed: true })).status,
    ).toBe(200);
    expect(await present(preview)).toBe(false);
    expect(await present(exported)).toBe(false);
    expect((await step("undo")).status).toBe(200);
    expect(await readFile(at(preview), "utf8")).toBe("preview pixels");
    expect(await readFile(at(exported), "utf8")).toBe("export pixels");
    expect(await readFile(at(scene), "utf8")).toBe(source);
  },
);

test("restoring a trash move preserves a mounted freeze with identical pixels", async () => {
  const first = "assets/freeze/first.png";
  const firstExport = "assets/freeze/export/first.png";
  const second = "assets/freeze/second.png";
  const secondExport = "assets/freeze/export/second.png";
  const trash = "trash/first 2.png";
  const trashExport = "trash/assets/freeze/export/first 2.png";
  const scene = "build/scene.html";
  const who = { kind: "person", name: "You" } as const;
  await mkdir(at("build"));
  await mkdir(at("trash"));
  await mkdir(at("assets/freeze/export"), { recursive: true });
  await writeFile(at("trash/first.png"), "older trash");
  await writeFile(at(first), "preview pixels");
  await writeFile(at(firstExport), "export pixels");
  const referencedInScene = (preview: string, exported: string) =>
    `<div data-composition-id="scene" data-width="1920" data-height="1080" data-duration="2"><img id="still" class="clip" src="../${preview}" data-cutroom-freeze-export="../${exported}" data-start="0" data-duration="2" data-track-index="0"></div>`;
  await writeFile(at(scene), referencedInScene(first, firstExport));
  await writeFile(
    at("index.html"),
    (await readFile(at("index.html"), "utf8")).replace(
      "</main>",
      `<div data-composition-src="${scene}" data-start="0" data-duration="2"></div></main>`,
    ),
  );
  const ledger = await fixture.store.history(project);
  await ledger.checkpoint();
  const removed = await post("remove", { path: first, confirmUsed: true });
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({ trash });
  const point = ledger.list().at(-1)!;

  expect((await step("undo")).status).toBe(200);
  expect(await ledger.restore(point.id, who)).toMatchObject({
    restoredTo: point.id,
  });
  expect(await readFile(at(trash), "utf8")).toBe("preview pixels");
  expect(await readFile(at(trashExport), "utf8")).toBe("export pixels");
  expect(await present(first)).toBe(false);
  expect(await present(firstExport)).toBe(false);
  expect((await step("undo")).status).toBe(200);

  await writeFile(at(second), "preview pixels");
  await writeFile(at(secondExport), "export pixels");
  const usedScene = referencedInScene(second, secondExport);
  await writeFile(at(scene), usedScene);
  await ledger.checkpoint();
  const before = ledger.list();
  await expect(ledger.restore(point.id, who)).rejects.toThrow(
    `still used by ${scene}`,
  );
  expect(ledger.list()).toEqual(before);
  expect(await readFile(at(first), "utf8")).toBe("preview pixels");
  expect(await readFile(at(firstExport), "utf8")).toBe("export pixels");
  expect(await readFile(at(second), "utf8")).toBe("preview pixels");
  expect(await readFile(at(secondExport), "utf8")).toBe("export pixels");
  expect(await present(trash)).toBe(false);
  expect(await present(trashExport)).toBe(false);
  expect(await readFile(at(scene), "utf8")).toBe(usedScene);
});

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "history rolls back a failed freeze replay and retries the same entry",
  async () => {
    const preview = "assets/freeze/still.png";
    const exportDir = "assets/freeze/export";
    const exported = `${exportDir}/still.png`;
    const trash = "trash/still.png";
    const trashExportDir = "trash/assets/freeze/export";
    const trashExported = `${trashExportDir}/still.png`;
    const renamed = "assets/freeze/renamed.png";
    const renamedExported = `${exportDir}/renamed.png`;
    await mkdir(at(exportDir), { recursive: true });
    await writeFile(at(preview), "preview pixels");
    await writeFile(at(exported), "export pixels");
    const html = await readFile(at("index.html"), "utf8");
    await writeFile(
      at("index.html"),
      html.replace(
        /<main([^>]*)>[\s\S]*<\/main>/,
        `<main$1><img id="still" class="clip" src="${preview}" data-cutroom-freeze-export="${exported}" data-start="0" data-duration="2" data-track-index="0"></main>`,
      ),
    );
    await (await fixture.store.history(project)).checkpoint();
    const original = await readFile(at("index.html"), "utf8");
    const deny = async (dir: string, direction: "undo" | "redo") => {
      const history = await entries();
      await chmod(at(dir), 0o555);
      try {
        const response = await step(direction);
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({
          error: expect.stringContaining("EACCES"),
        });
      } finally {
        await chmod(at(dir), 0o755);
      }
      expect(await entries()).toEqual(history);
    };
    const state = () =>
      Promise.all(
        [preview, exported, trash, trashExported, renamed, renamedExported].map(
          present,
        ),
      );

    const removed = await post("remove", { path: preview, confirmUsed: true });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ uses: 1 });
    const removedState = [false, false, true, true, false, false];
    const originalState = [true, true, false, false, false, false];
    await deny(exportDir, "undo");
    expect(await state()).toEqual(removedState);
    expect(await readFile(at(trash), "utf8")).toBe("preview pixels");
    expect(await readFile(at(trashExported), "utf8")).toBe("export pixels");
    expect((await step("undo")).status).toBe(200);
    expect(await state()).toEqual(originalState);
    expect((await entries()).at(-1)?.label).toBe("Undid: Remove still.png");

    await deny(trashExportDir, "redo");
    expect(await state()).toEqual(originalState);
    expect((await step("redo")).status).toBe(200);
    expect(await state()).toEqual(removedState);
    expect((await step("undo")).status).toBe(200);

    expect(
      (await post("rename", { path: preview, name: "renamed.png" })).status,
    ).toBe(200);
    const authored = await readFile(at("index.html"), "utf8");
    await deny(exportDir, "undo");
    expect(await state()).toEqual([false, false, false, false, true, true]);
    expect(await readFile(at("index.html"), "utf8")).toBe(authored);
    expect((await step("undo")).status).toBe(200);
    expect(await state()).toEqual(originalState);
    expect(await readFile(at("index.html"), "utf8")).toBe(original);
    await deny(exportDir, "redo");
    expect(await state()).toEqual(originalState);
    expect(await readFile(at("index.html"), "utf8")).toBe(original);
    expect((await step("redo")).status).toBe(200);
    expect(await readFile(at("index.html"), "utf8")).toBe(authored);
  },
);

test("source marks follow the visible still across undo and redo of identical variants", async () => {
  const preview = "assets/freeze/still.png";
  const exported = "assets/freeze/export/still.png";
  const renamed = "assets/freeze/renamed.png";
  const renamedExported = "assets/freeze/export/renamed.png";
  await mkdir(at("assets/freeze/export"), { recursive: true });
  const pixels = Buffer.from("identical PNG bytes");
  await writeFile(at(preview), pixels);
  await writeFile(at(exported), pixels);
  await (await fixture.store.history(project)).checkpoint();

  const identity = { size: pixels.length, duration: 5 };
  const marks = { in: 30, out: 60 };
  await projectViews.saveSource(project, preview, { ...marks, identity });
  expect(
    (await post("rename", { path: preview, name: "renamed.png" })).status,
  ).toBe(200);
  expect(await projectViews.readSource(project, renamed, identity)).toEqual(
    marks,
  );
  expect((await step("undo")).status).toBe(200);
  expect(await projectViews.readSource(project, preview, identity)).toEqual(
    marks,
  );
  expect(await projectViews.readSource(project, exported, identity)).toEqual({
    in: null,
    out: null,
  });
  expect((await step("redo")).status).toBe(200);
  expect(await projectViews.readSource(project, renamed, identity)).toEqual(
    marks,
  );
  expect(
    await projectViews.readSource(project, renamedExported, identity),
  ).toEqual({ in: null, out: null });
});

test("direct file operations cannot split a freeze frame", async () => {
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/editor", editor);
  const preview = "assets/freeze/still.png";
  const exported = "assets/freeze/export/still.png";
  await mkdir(at("assets/freeze/export"), { recursive: true });
  await writeFile(at(preview), "preview pixels");
  await writeFile(at(exported), "export pixels");
  await symlink(at("assets/freeze/export"), at("effects"));
  const base = `/api/editor/projects/${project.id}/files/`;
  try {
    for (const path of [
      preview,
      exported,
      "effects/still.png",
      "assets/freeze/export",
      "assets",
    ]) {
      for (const method of ["DELETE", "PATCH"]) {
        const response = await fixture.app.request(`${base}${path}`, {
          method,
          ...(method === "PATCH" && {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ newPath: "moved.png" }),
          }),
        });
        expect(response.status).toBe(409);
      }
    }
    const moveIntoExport = await fixture.app.request(
      `${base}assets/unused.mp3`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPath: "assets/freeze/export/incoming.png" }),
      },
    );
    expect(moveIntoExport.status).toBe(409);
    expect(
      (await post("remove", { path: "effects/still.png", confirmUsed: true }))
        .status,
    ).toBe(403);
    expect(await readFile(at(preview), "utf8")).toBe("preview pixels");
    expect(await readFile(at(exported), "utf8")).toBe("export pixels");
    expect(await present("moved.png")).toBe(false);
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
