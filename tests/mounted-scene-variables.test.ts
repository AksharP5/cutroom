import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectFixture } from "./project-fixture";
import { createVariableRoutes } from "../src/server/projects/variables";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { parseHTML } from "linkedom";

const page = (body: string, id = "main") =>
  `<!doctype html><html><head></head><body><main id="${id}" data-composition-id="${id}" data-width="160" data-height="120" data-duration="2">${body}</main></body></html>`;
const slot = (
  id: string,
  child: string,
  src: string,
  values = "{}",
  track = 0,
) =>
  `<div id="${id}" class="clip" data-composition-id="${child}" data-composition-src="${src}" data-start="0" data-duration="2" data-track-index="${track}" data-variable-values='${values}'></div>`;
const variable = (id: string, type: string, value: string) => ({
  id,
  label: id,
  type,
  default: value,
});
const sceneRoot = (id: string, vars: unknown[]) =>
  `<section data-composition-id="${id}" data-width="160" data-height="120" data-duration="2" data-composition-variables='${JSON.stringify(vars)}'><p data-var-text="title">Placeholder</p><img data-var-src="art" src="default.svg"></section>`;
const scene = (id: string, vars: unknown[]) =>
  `<template>${sceneRoot(id, vars)}</template>`;
const art = variable("art", "image", "default.svg");
const title = variable("title", "string", "Default");
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
const data = async (response: Response) => ({
  status: response.status,
  body: await response.json(),
});
function wav() {
  const output = Buffer.alloc(44 + 32000);
  output.write("RIFF");
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(8000, 24);
  output.writeUInt32LE(16000, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(output.length - 44, 40);
  return output;
}
async function fixture() {
  const f = await projectFixture();
  const project = await f.store.create({
    name: "Scene review",
    duration: 2,
    width: 320,
    height: 240,
  });
  const editor = createHyperframesApi(f.store, f.review);
  f.app.route("/api", editor);
  f.app.route("/api/cutroom", createVariableRoutes(f.store, f.review));
  f.app.route("/api/cutroom", createTimelineRoutes(f.store, f.review));
  const base = `/projects/${project.id}`;
  const request = async (...args: Parameters<typeof f.request>) =>
    f.request(...args);
  const path = (name: string) => join(project.path, name);
  const put = (
    clipId: string,
    id: string,
    value: string,
    composition = "index.html",
    expectedVersion?: string,
  ) =>
    request(`${base}/variables/instance`, "PUT", {
      clipId,
      id,
      value,
      composition,
      expectedVersion,
    }).then(data);
  const get = (clipId: string, composition = "index.html") =>
    request(
      `${base}/variables/instance?${new URLSearchParams({ clipId, composition })}`,
    ).then(data);
  const bundle = async (entryFile = "index.html") => {
    const suffix = entryFile === "index.html" ? "" : "/comp/" + entryFile;
    const response = await f.app.request("/api" + base + "/preview" + suffix);
    expect(response.status).toBe(200);
    const html = await response.text();
    const { document } = parseHTML(html);
    const script = [...document.head.querySelectorAll("script")].find((s) =>
      s.textContent.startsWith("window.__hfVariablesByComp = Object.assign"),
    );
    const table = script
      ? JSON.parse(
          script.textContent
            .split("window.__hfVariablesByComp || {}, ")[1]
            .slice(0, -2),
        )
      : null;
    return {
      table,
      document,
      mounts: [...document.querySelectorAll("[data-composition-file][id]")].map(
        (el) => [
          el.id,
          el.getAttribute("data-composition-id"),
          el.getAttribute("data-composition-file"),
        ],
      ),
    };
  };
  return {
    ...f,
    request,
    project,
    base,
    path,
    put,
    get,
    bundle,
    async close() {
      await editor.dispose();
      await f.close();
    },
  };
}

test("scene values can be edited beside audio with inferred duration", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path("clip.wav"), wav());
    await writeFile(f.path("default.svg"), svg);
    await writeFile(f.path("chosen.svg"), svg);
    await writeFile(f.path("child.html"), scene("child", [title, art]));
    const parent = page(
      slot("mount", "child", "child.html", '{"art":"chosen.svg"}'),
    );
    await writeFile(f.path("index.html"), parent);
    expect((await f.put("mount", "title", "Previously editable")).status).toBe(
      200,
    );
    await writeFile(
      f.path("index.html"),
      parent.replace(
        "</main>",
        '<audio id="music" src="clip.wav" data-start="0" data-track-index="1"></audio></main>',
      ),
    );
    const timeline = await f.request(`${f.base}/timeline`).then(data);
    const read = await f.get("mount");
    const save = await f.put("mount", "title", "New title");
    const remove = await f
      .request(`${f.base}/media/remove`, "POST", { path: "chosen.svg" })
      .then(data);
    expect(timeline.status).toBe(200);
    expect(timeline.body.timeline.clips).toContainEqual(
      expect.objectContaining({ id: "mount" }),
    );
    expect(read.status).toBe(200);
    expect(save.status).toBe(200);
    expect(save.body.values.title).toBe("New title");
    expect(remove.status).toBe(409);
    expect(await Bun.file(f.path("chosen.svg")).exists()).toBe(true);
  } finally {
    await f.close();
  }
});

test("nested mounts resolve the same root file in editing, preview, and Media", async () => {
  const f = await fixture();
  try {
    await mkdir(f.path("scenes"));
    await writeFile(f.path("default.svg"), svg);
    await writeFile(f.path("chosen.svg"), svg);
    await writeFile(f.path("child.html"), scene("child", [art]));
    await writeFile(
      f.path("scenes/child.html"),
      scene("child", [variable("art", "string", "Sibling schema")]),
    );
    const parent = page(
      slot("leaf", "child", "child.html", '{"art":"chosen.svg"}'),
      "parent",
    );
    await writeFile(f.path("scenes/parent.html"), parent);
    await writeFile(
      f.path("index.html"),
      page(slot("parentMount", "parent", "scenes/parent.html")),
    );
    const read = await f.get("leaf", "scenes/parent.html");
    const bundle = await f.bundle();
    const uses = await f
      .request(`${f.base}/media/uses?path=chosen.svg`)
      .then(data);
    const rename = await f
      .request(`${f.base}/media/rename`, "POST", {
        path: "chosen.svg",
        name: "moved.svg",
      })
      .then(data);
    const saved = await readFile(f.path("scenes/parent.html"), "utf8");
    expect(read.body.scene).toBe("child.html");
    expect(read.body.declarations[0].type).toBe("image");
    expect(bundle.mounts).toContainEqual(["leaf", "child__hf1", "child.html"]);
    const standalone = await f.bundle("scenes/parent.html");
    expect(
      standalone.document
        .getElementById("leaf")
        ?.getAttribute("data-composition-src"),
    ).toBe("child.html");
    expect(uses.body.uses).toBe(1);
    expect(rename.status).toBe(200);
    expect(
      JSON.parse(
        parseHTML(saved)
          .document.getElementById("leaf")!
          .getAttribute("data-variable-values")!,
      ),
    ).toEqual({ art: "moved.svg" });
  } finally {
    await f.close();
  }
});

test("declarations come from the host-selected root", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path("default.svg"), svg);
    await writeFile(f.path("chosen.svg"), svg);
    await writeFile(
      f.path("child.html"),
      `<template>${sceneRoot("first", [variable("title", "string", "Wrong default")])}${sceneRoot("chosen", [variable("title", "string", "Actual default"), art])}</template>`,
    );
    await writeFile(
      f.path("index.html"),
      page(slot("mount", "chosen", "child.html", '{"art":"chosen.svg"}')),
    );
    const read = await f.get("mount");
    const bundle = await f.bundle();
    const uses = await f
      .request(`${f.base}/media/uses?path=chosen.svg`)
      .then(data);
    expect(read.body.declarations[0].default).toBe("Actual default");
    expect(bundle.table.chosen.title).toBe("Actual default");
    expect(uses.body.uses).toBe(1);
  } finally {
    await f.close();
  }
});

test("external host without an authored composition id refuses overrides", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path("child.html"), scene("child", [title]));
    await writeFile(
      f.path("index.html"),
      page(
        slot("mount", "child", "child.html").replace(
          ' data-composition-id="child"',
          "",
        ),
      ),
    );
    const saved = await f.put("mount", "title", "My instance");
    const bundle = await f.bundle();
    expect(saved.status).toBe(422);
    expect(saved.body.error).toContain("data-composition-id");
    expect(bundle.mounts).toContainEqual(["mount", null, "child.html"]);
    expect(JSON.stringify(bundle.table)).not.toContain("My instance");
  } finally {
    await f.close();
  }
});

test("Media Remove checks for uses after a queued image save", async () => {
  const f = await fixture();
  let release = () => {};
  try {
    await writeFile(f.path("default.svg"), svg);
    await writeFile(f.path("chosen.svg"), svg);
    await writeFile(f.path("child.html"), scene("child", [art]));
    await writeFile(
      f.path("index.html"),
      page(slot("mount", "child", "child.html")),
    );
    const inQueue = Promise.withResolvers<void>();
    const allowProgress = Promise.withResolvers<void>();
    release = allowProgress.resolve;
    const barrier = f.review.editComposition(
      f.project,
      "index.html",
      undefined,
      async () => {
        inQueue.resolve();
        await allowProgress.promise;
      },
    );
    await inQueue.promise;
    // Trap only this fixture's editAssets to observe that the HTTP route has
    // reached the review queue.
    const removeReachedQueue = Promise.withResolvers<void>();
    const setReachedQueue = Promise.withResolvers<void>();
    const originalAssets = f.review.editAssets;
    const originalComposition = f.review.editComposition;
    f.review.editAssets = (...args) => {
      removeReachedQueue.resolve();
      return originalAssets(...args);
    };
    f.review.editComposition = (...args) => {
      setReachedQueue.resolve();
      return originalComposition(...args);
    };
    const version = (await f.get("mount")).body.version;
    const setting = f.put("mount", "art", "chosen.svg", "index.html", version);
    await setReachedQueue.promise;
    const removing = f
      .request(`${f.base}/media/remove`, "POST", { path: "chosen.svg" })
      .then(data);
    await removeReachedQueue.promise;
    allowProgress.resolve();
    const [saved, removed] = await Promise.all([setting, removing, barrier]);
    expect(saved.status).toBe(200);
    expect(removed.status).toBe(409);
    expect(removed.body.uses).toBe(1);
    expect((await f.get("mount")).body.values.art).toBe("chosen.svg");
    expect(await Bun.file(f.path("chosen.svg")).exists()).toBe(true);
  } finally {
    release();
    await f.close();
  }
});

test("a change to the rendered scene invalidates the instance version", async () => {
  const f = await fixture();
  try {
    await mkdir(f.path("scenes"));
    await writeFile(
      f.path("scenes/parent.html"),
      page(slot("leaf", "child", "child.html"), "parent"),
    );
    await writeFile(
      f.path("index.html"),
      page(slot("outer", "parent", "scenes/parent.html")),
    );
    await writeFile(f.path("child.html"), scene("child", [title]));
    await writeFile(f.path("scenes/child.html"), scene("child", [title]));
    const { version } = (await f.get("leaf", "scenes/parent.html")).body;
    await writeFile(
      f.path("child.html"),
      scene("child", [variable("actualTitle", "string", "New declaration")]),
    );
    const current = await f.get("leaf", "scenes/parent.html");
    const saved = await f.put(
      "leaf",
      "title",
      "Stale",
      "scenes/parent.html",
      version,
    );
    const compiled = await f.bundle();
    expect(current.body.version).not.toBe(version);
    expect(saved.status).toBe(409);
    expect(compiled.table.child__hf1).toEqual({
      actualTitle: "New declaration",
    });
  } finally {
    await f.close();
  }
});

test("a preview-only sibling still protects its image from an unsafe rename", async () => {
  const f = await fixture();
  try {
    await mkdir(f.path("scenes"));
    await writeFile(f.path("default.svg"), svg);
    await writeFile(f.path("chosen.svg"), svg);
    await writeFile(f.path("scenes/child.html"), scene("child", [art]));
    const parent = page(
      slot("leaf", "child", "child.html", '{"art":"chosen.svg"}'),
      "parent",
    );
    await writeFile(f.path("scenes/parent.html"), parent);
    const preview = await f.bundle("scenes/parent.html");
    expect(
      preview.document
        .getElementById("leaf")
        ?.getAttribute("data-composition-src"),
    ).toBe("scenes/child.html");

    const save = await f.put(
      "leaf",
      "art",
      "default.svg",
      "scenes/parent.html",
    );
    expect(save.status).toBe(422);
    const uses = await f
      .request(`${f.base}/media/uses?path=chosen.svg`)
      .then(data);
    expect(uses.body.uses).toBe(1);
    const rename = await f
      .request(`${f.base}/media/rename`, "POST", {
        path: "chosen.svg",
        name: "moved.svg",
      })
      .then(data);
    expect(rename.status).toBe(409);
    expect(await readFile(f.path("scenes/parent.html"), "utf8")).toBe(parent);
    expect(await Bun.file(f.path("chosen.svg")).exists()).toBe(true);
  } finally {
    await f.close();
  }
});
