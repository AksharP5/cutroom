import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { SourceSchema } from "../src/shared/project";
import { sourceClipVersions } from "../src/server/projects/changes";
import { projectFixture } from "./project-fixture";
import { createReviewService } from "../src/server/projects/review";

const clip = (id: string) =>
  `<div id="${id}" class="clip" data-start="0" data-duration="5">${id}</div>`;
const source = `<!doctype html><html><head><style>body{background:black}</style></head><body><main data-composition-id="main" data-duration="5"><section style="transform:translateX(0px);font:20px serif">${clip("title")}${clip("caption")}</section></main><template><span>Cloned text</span></template><script>const intro=gsap.timeline({paused:true,delay:0,defaults:{duration:1}});const outro=gsap.timeline({paused:true});intro.to("#title",{x:300},0);document.querySelector("#title").append(document.querySelector("template").content.cloneNode(true));window.__timelines={main:intro};</script></body></html>`;

async function setup(content = source) {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Composition review" });
  await writeFile(`${project.path}/index.html`, content);
  const base = `/projects/${project.id}`;
  const save = async (content: string, path = "index.html") => {
    const current = SourceSchema.parse(
      await (await fixture.request(`${base}/source?path=${path}`)).json(),
    );
    const response = await fixture.app.request(`/api/cutroom${base}/source`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-cutroom-agent": "external",
      },
      body: JSON.stringify({ path, expectedVersion: current.version, content }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  return {
    ...fixture,
    project,
    base,
    save,
    read: () => fixture.review.clipChanges(project, "index.html"),
  };
}

for (const [name, before, after] of [
  ["timeline receiver", 'intro.to("#title"', 'outro.to("#title"'],
  ["timeline delay", "delay:0", "delay:1"],
  ["timeline defaults", "defaults:{duration:1}", "defaults:{duration:2}"],
  ["wrapper transform", "translateX(0px)", "translateX(100px)"],
  ["wrapper font", "20px serif", "40px monospace"],
  ["body background", "background:black", "background:red"],
  ["cloned template", "Cloned text", "Changed clone"],
] as const) {
  test(`${name} produces one composition row and no clip marks`, async () => {
    const f = await setup();
    try {
      await f.save(source.replace(before, after));
      const view = await f.read();
      expect(view.agentChanges).toEqual([]);
      expect(view.clipEdits).toHaveLength(1);
      expect(view.clipEdits[0]).toMatchObject({
        clipId: null,
        composition: "index.html",
        accepted: false,
        resolution: undefined,
      });
      await f.save(source.replace(before, after));
      expect((await f.read()).clipEdits).toEqual(view.clipEdits);
    } finally {
      await f.close();
    }
  });
}

test.each(["attribute", "text"])(
  "a clip's own %s edit marks only that clip",
  async (kind) => {
    const f = await setup();
    try {
      await f.save(
        kind === "attribute"
          ? source.replace('id="title"', 'id="title" style="color:red"')
          : source.replace(">title</div>", ">Changed title</div>"),
      );
      const view = await f.read();
      expect(view.agentChanges).toEqual(["title"]);
      expect(view.clipEdits).toHaveLength(1);
      expect(view.clipEdits[0]?.clipId).toBe("title");
    } finally {
      await f.close();
    }
  },
);

test.each(["changes", "clipEdits", "history-backed", "v2"])(
  "legacy %s pending work survives an unrelated agent edit and reload",
  async (format) => {
    const f = await setup();
    try {
      const history = await f.store.history(f.project);
      await f.save(source.replace(">caption</div>", ">Earlier caption</div>"));
      await history.checkpoint();
      const hash =
        format === "v2"
          ? "v2:19d9c9f0d5be4176524a1069bea452688fb7c68a12c9fe1da1290f2b6912c3a4"
          : "fa3495c46c40bdb2ca4dba8ccfe53afdb8c332f44173fb3acdaad97c8339634a";
      const row = {
        id: "legacy",
        composition: "index.html",
        clipId: "title",
        signature: hash,
        noteIds: [],
        label: "Edited title",
        by: "agent",
        at: "",
        accepted: false,
        ...(format === "history-backed" && {
          historyId: history.list().at(-1)!.id,
        }),
      };
      await mkdir(`${f.project.path}/.cutroom`, { recursive: true });
      await writeFile(
        `${f.project.path}/.cutroom/review.json`,
        JSON.stringify({
          schemaVersion: 1,
          items: [],
          ...(format === "changes" ? { changes: [row] } : { clipEdits: [row] }),
        }),
      );
      expect((await f.read()).agentChanges).toEqual(["title"]);
      await f.save(
        source
          .replace(">caption</div>", ">Earlier caption</div>")
          .replace("delay:0", "delay:1"),
      );
      const view = await f.read();
      expect(view.agentChanges).toEqual(["title"]);
      expect(
        view.clipEdits.find((edit) => edit.clipId === "title"),
      ).toMatchObject({ accepted: false, resolution: undefined });
      expect(
        (
          await createReviewService(f.store).clipChanges(
            f.project,
            "index.html",
          )
        ).clipEdits,
      ).toEqual(view.clipEdits);
      await f.review.acceptChanges(f.project);
      expect((await f.read()).agentChanges).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test("sub-composition script edits appear in entry and scene reviews", async () => {
  const entry = source.replace(
    "</main>",
    '<div id="scene" data-start="0" data-duration="5" data-composition-src="scene.html"></div></main>',
  );
  const f = await setup(entry);
  try {
    await writeFile(
      `${f.project.path}/scene.html`,
      `<template>${source}</template>`,
    );
    await f.save(
      `<template>${source.replace('intro.to("#title"', 'outro.to("#title"')}</template>`,
      "scene.html",
    );
    for (const path of ["index.html", "scene.html"]) {
      const view = await f.review.clipChanges(f.project, path);
      expect(view.agentChanges).toEqual([]);
      expect(view.clipEdits).toHaveLength(1);
      expect(view.clipEdits[0]).toMatchObject({
        clipId: null,
        composition: "scene.html",
        accepted: false,
        resolution: undefined,
      });
    }
  } finally {
    await f.close();
  }
});

test.each(["clip", "composition"])(
  "%s review stays pending across other edits, resolves on returning to accepted bytes, and survives undo/redo",
  async (target) => {
    const f = await setup();
    const change =
      target === "clip"
        ? (s: string, value: string) =>
            s.replace(">title</div>", `>${value}</div>`)
        : (s: string, value: string) => s.replace("delay:0", `delay:${value}`);
    try {
      await f.save(change(source, "1"));
      const row = (await f.read()).clipEdits[0]!;
      await f.save(
        change(source, "2").replace(
          ">caption</div>",
          ">Unrelated caption</div>",
        ),
      );
      expect(
        (await f.read()).clipEdits.find((edit) => edit.id === row.id)
          ?.resolution,
      ).toBeUndefined();
      await f.save(
        source.replace(">caption</div>", ">Unrelated caption</div>"),
      );
      expect(
        (await f.read()).clipEdits.find((edit) => edit.id === row.id)
          ?.resolution,
      ).toBe("source");
      const history = f.review.history(
        f.project,
        await f.store.history(f.project),
        { kind: "human" },
      );
      await history.step("back", { kind: "person", name: "You" });
      expect(
        (await f.read()).clipEdits.find((edit) => edit.id === row.id)
          ?.resolution,
      ).toBeUndefined();
      await f.review.acceptChanges(f.project);
      await history.step("back", { kind: "person", name: "You" });
      await history.step("forward", { kind: "person", name: "You" });
      expect(
        (await f.read()).clipEdits
          .filter((edit) => edit.by === "agent")
          .every((edit) => edit.accepted),
      ).toBe(true);
    } finally {
      await f.close();
    }
  },
);

test("every source byte is covered, including anonymous clips, invalid timelines and DOM order", () => {
  const before = sourceClipVersions(source, "index.html");
  for (const changed of [
    source.replace('id="title"', ""),
    source.replace('data-composition-id="main"', ""),
    source.replace(
      clip("title") + clip("caption"),
      clip("caption") + clip("title"),
    ),
  ]) {
    expect(sourceClipVersions(changed, "index.html").get(null)).not.toBe(
      before.get(null),
    );
  }
});

test.each(["clip", "composition"])(
  "accepting an earlier %s row updates the accepted bytes without accepting the later edit",
  async (target) => {
    const f = await setup();
    const replace = (value: string) =>
      target === "clip"
        ? source.replace(">title</div>", `>${value}</div>`)
        : source.replace("delay:0", `delay:${value}`);
    try {
      await f.save(replace("1"));
      const first = (await f.read()).clipEdits[0]!;
      await f.save(replace("2"));
      await f.review.acceptChanges(f.project, first.id);
      const later = (await f.read()).clipEdits.at(-1)!;
      expect(later).toMatchObject({ accepted: false, resolution: undefined });
      await f.save(replace("1"));
      expect(
        (await f.read()).clipEdits.find((edit) => edit.id === later.id)
          ?.resolution,
      ).toBe("source");
    } finally {
      await f.close();
    }
  },
);

test.each(["owner", "external"])(
  "an %s replacement cannot dismiss a pending clip",
  async (by) => {
    const f = await setup();
    try {
      await f.save(source.replace(">title</div>", ">Agent title</div>"));
      const row = (await f.read()).clipEdits[0]!;
      const replacement = source.replace(
        ">title</div>",
        ">Different title</div>",
      );
      if (by === "external")
        await writeFile(`${f.project.path}/index.html`, replacement);
      else {
        const current = SourceSchema.parse(
          await (await f.request(`${f.base}/source`)).json(),
        );
        expect(
          (
            await f.request(`${f.base}/source`, "PUT", {
              path: "index.html",
              content: replacement,
              expectedVersion: current.version,
            })
          ).status,
        ).toBe(200);
      }
      expect(
        (await f.read()).clipEdits.find((edit) => edit.id === row.id),
      ).toMatchObject({ accepted: false, resolution: undefined });
    } finally {
      await f.close();
    }
  },
);

test.each(["animation.js", "styles.css"])(
  "an authored %s edit produces one file row in entry Review",
  async (path) => {
    const f = await setup();
    try {
      await writeFile(
        `${f.project.path}/${path}`,
        path.endsWith("js")
          ? "gsap.defaults({duration:1});"
          : "body{background:black}",
      );
      await f.save(
        path.endsWith("js")
          ? "gsap.defaults({duration:2});"
          : "body{background:red}",
        path,
      );
      expect((await f.read()).clipEdits).toHaveLength(1);
      expect((await f.read()).clipEdits[0]).toMatchObject({
        clipId: null,
        composition: path,
        accepted: false,
        resolution: undefined,
      });
    } finally {
      await f.close();
    }
  },
);

test("several sub-composition clip edits produce one entry row without underlining the host", async () => {
  const f = await setup(
    source.replace(
      "</main>",
      '<div id="scene" data-start="0" data-duration="5" data-composition-src="scene.html"></div></main>',
    ),
  );
  const sceneSource = source.replace(
    "<template><span>Cloned text</span></template>",
    "",
  );
  try {
    await writeFile(`${f.project.path}/scene.html`, sceneSource);
    await f.save(
      sceneSource
        .replace(">title</div>", ">New title</div>")
        .replace(">caption</div>", ">New caption</div>"),
      "scene.html",
    );
    const entry = await f.read();
    expect(entry.agentChanges).toEqual([]);
    expect(entry.clipEdits).toHaveLength(1);
    expect(entry.clipEdits[0]).toMatchObject({
      composition: "scene.html",
      clipId: null,
      resolution: undefined,
      accepted: false,
    });
    const scene = await f.review.clipChanges(f.project, "scene.html");
    expect(scene.agentChanges).toEqual(["title", "caption"]);
    expect(scene.clipEdits).toHaveLength(2);
  } finally {
    await f.close();
  }
});
