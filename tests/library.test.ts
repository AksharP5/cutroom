import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  LibraryAddedSchema,
  LibraryCatalogSchema,
} from "../src/shared/library";
import { ProjectDocumentSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { claudeToolPermissions } from "../src/server/agents/tool-permissions";
import { componentHost } from "../src/server/library/add";
import { createLibrary } from "../src/server/library/registry";
import { createLibraryRoutes } from "../src/server/library/routes";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";
import { REF, fragmentHtml, registryFetch } from "./library-fixture";

const index = `<!doctype html><html><head></head><body><main data-composition-id="main" data-width="1280" data-height="720" data-duration="12" data-fps="30"></main></body></html>`;

async function libraryFixture() {
  const fixture = await projectFixture();
  const registry = registryFetch();
  const library = createLibrary({
    dataDir: join(fixture.directory, "data"),
    fetchImpl: registry.fetchImpl,
    ref: REF,
  });
  const timeline = createTimelineRoutes(fixture.store, fixture.review);
  fixture.app.route("/api/cutroom", timeline);
  fixture.app.route(
    "/api/cutroom",
    createLibraryRoutes(
      fixture.store,
      fixture.review,
      library,
      timeline.editInWindow,
    ),
  );
  const project = await fixture.store.create({ name: "Library" });
  await writeFile(join(project.path, "index.html"), index);
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fixture.request(path, method, body);
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
  const ok = async (path: string, method = "GET", body?: unknown) => {
    const result = await call(path, method, body);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body;
  };
  const read = (path: string) => readFile(join(project.path, path), "utf8");
  const timelineView = async () =>
    TimelineViewSchema.parse(await ok(`/projects/${project.id}/timeline`));
  return { fixture, registry, project, call, ok, read, timelineView };
}

test("the list keeps valid blocks and components, says which can't be added, and is read once", async () => {
  const { fixture, registry, ok } = await libraryFixture();
  try {
    const catalog = LibraryCatalogSchema.parse(await ok("/library"));
    // An item writing outside the project fails validation and is left out, as are examples.
    expect(catalog.items.map((item) => item.name)).toEqual([
      "lt-clean-bar",
      "blur-in",
      "grain",
      "old-title",
      "future-chart",
      "elsewhere",
    ]);
    const byName = new Map(catalog.items.map((item) => [item.name, item]));
    expect(byName.get("lt-clean-bar")).toMatchObject({
      kind: "block",
      category: "lower-thirds",
      duration: 4.8,
      hasPoster: true,
      cached: false,
    });
    expect(byName.get("blur-in")).toMatchObject({
      kind: "component",
      category: "text-effects",
    });
    expect(byName.get("old-title")?.disabled).toBe(
      "Deprecated: Use title-card instead",
    );
    expect(byName.get("future-chart")?.disabled).toBe("Needs HyperFrames 0.10");

    // The pinned tag never changes, so a complete list is not fetched again, even after a restart.
    const requests = registry.state.requests.length;
    registry.state.offline = true;
    const restarted = createLibraryRoutes(
      fixture.store,
      fixture.review,
      createLibrary({
        dataDir: join(fixture.directory, "data"),
        fetchImpl: registry.fetchImpl,
        ref: REF,
      }),
      createTimelineRoutes(fixture.store, fixture.review).editInWindow,
    );
    const again = LibraryCatalogSchema.parse(
      await (await restarted.request("/library")).json(),
    );
    expect(again.items).toHaveLength(6);
    expect(again.offline).toBe(false);
    expect(registry.state.requests.length).toBe(requests);
  } finally {
    await fixture.close();
  }
});

test("with no saved list and no network, the library says it can't be reached", async () => {
  const { fixture, registry, call } = await libraryFixture();
  try {
    registry.state.offline = true;
    const result = await call("/library");
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      error: expect.stringContaining("Can't reach the HyperFrames library."),
    });
  } finally {
    await fixture.close();
  }
});

test("adding a block copies its files, places one clip, records its license, and undoes in one step", async () => {
  const { fixture, project, ok, read, timelineView } = await libraryFixture();
  try {
    const added = LibraryAddedSchema.parse(
      await ok(`/projects/${project.id}/library`, "POST", {
        name: "lt-clean-bar",
        track: 1,
        at: 30,
        variables: { name: "Akshar" },
      }),
    );
    expect(added.composition).toBe("compositions/lt-clean-bar.html");
    // Documentation is left out; the scene and its asset land at the item's targets.
    expect(added.added.sort()).toEqual([
      "assets/lt/bar.png",
      "compositions/lt-clean-bar.html",
    ]);
    expect(existsSync(join(project.path, "TEMPLATE.md"))).toBe(false);
    expect(await read("assets/lt/bar.png")).toBe("PNG bytes");
    // The sandboxed preview cannot reach the CDN, so GSAP loads from the project's own copy.
    const scene = await read("compositions/lt-clean-bar.html");
    expect(scene).toContain(
      `<script src="../assets/vendor/gsap.min.js"></script>`,
    );
    expect(scene).not.toContain("cdn.jsdelivr.net");

    const view = await timelineView();
    const clip = view.timeline.clips.find((item) => item.id === added.clipId);
    // 4.8 seconds at 30 fps.
    expect(clip).toMatchObject({
      kind: "composition",
      track: 1,
      start: 30,
      duration: 144,
      label: "Lower Third, Clean Bar",
    });
    expect(await read("index.html")).toContain(
      `data-variable-values="{&quot;name&quot;:&quot;Akshar&quot;}"`,
    );
    const document = ProjectDocumentSchema.parse(
      JSON.parse(await read("cutroom.json")),
    );
    expect(document.library).toEqual([
      {
        name: "lt-clean-bar",
        ref: REF,
        source: "registry/blocks/lt-clean-bar",
        license: "Apache-2.0",
        author: "HeyGen",
        files: ["compositions/lt-clean-bar.html", "assets/lt/bar.png"],
      },
    ]);

    const history = (await ok(`/projects/${project.id}/history`)) as {
      entries: { label: string }[];
    };
    expect(history.entries.at(-1)?.label).toBe(
      "Added Lower Third, Clean Bar from the HyperFrames library",
    );

    await ok(`/projects/${project.id}/history/undo`, "POST");
    expect((await timelineView()).timeline.clips).toEqual([]);
    expect(
      existsSync(join(project.path, "compositions/lt-clean-bar.html")),
    ).toBe(false);
    expect(existsSync(join(project.path, "assets/lt/bar.png"))).toBe(false);
    expect(
      ProjectDocumentSchema.parse(JSON.parse(await read("cutroom.json")))
        .library ?? [],
    ).toEqual([]);

    await ok(`/projects/${project.id}/history/redo`, "POST");
    expect((await timelineView()).timeline.clips).toHaveLength(1);
    expect(await read("assets/lt/bar.png")).toBe("PNG bytes");
  } finally {
    await fixture.close();
  }
});

test("a second use shares unchanged files; an edited scene stays and the new copy goes beside it", async () => {
  const { fixture, project, ok, read, timelineView } = await libraryFixture();
  try {
    const add = (at: number) =>
      ok(`/projects/${project.id}/library`, "POST", {
        name: "lt-clean-bar",
        track: 0,
        at,
      }).then((body) => LibraryAddedSchema.parse(body));
    await add(0);
    const again = await add(200);
    expect(again).toMatchObject({
      composition: "compositions/lt-clean-bar.html",
      added: [],
      kept: [],
    });

    const scene = join(project.path, "compositions/lt-clean-bar.html");
    await writeFile(
      scene,
      (await readFile(scene, "utf8")).replace(
        "Name Surname</span>",
        "Edited</span>",
      ),
    );
    await writeFile(join(project.path, "assets/lt/bar.png"), "my own bar");
    const edited = await add(400);
    expect(edited.composition).toBe("compositions/lt-clean-bar-2.html");
    expect(edited.added).toEqual(["compositions/lt-clean-bar-2.html"]);
    expect(edited.kept).toEqual(["assets/lt/bar.png"]);
    expect(await read("compositions/lt-clean-bar.html")).toContain(
      "Edited</span>",
    );
    expect(await read("assets/lt/bar.png")).toBe("my own bar");
    expect(
      (await timelineView()).timeline.clips.map((clip) => clip.src),
    ).toEqual([
      "compositions/lt-clean-bar.html",
      "compositions/lt-clean-bar.html",
      "compositions/lt-clean-bar-2.html",
    ]);
  } finally {
    await fixture.close();
  }
});

test("a fragment component plays from a generated host at the timeline's size, 3 seconds long", async () => {
  const { fixture, project, ok, read, timelineView } = await libraryFixture();
  try {
    await rm(join(project.path, "assets/vendor/gsap.min.js"));
    const added = LibraryAddedSchema.parse(
      await ok(`/projects/${project.id}/library`, "POST", {
        name: "blur-in",
        track: 0,
        at: 0,
        mode: "insert",
      }),
    );
    expect(added.composition).toBe("compositions/blur-in.html");
    // The fragment is not a composition on its own, so only its host goes in, with the GSAP
    // copy an imported project may lack.
    expect(added.added).toEqual([
      "compositions/blur-in.html",
      "assets/vendor/gsap.min.js",
    ]);
    const host = await read("compositions/blur-in.html");
    expect(host).toContain(
      `data-composition-id="blur-in" data-width="1280" data-height="720" data-duration="3"`,
    );
    expect(host).toContain("tl.fromTo('.hf-ui-blur-in span', { opacity: 0 }");
    expect(host).toContain(`window.__timelines["blur-in"] = tl;`);
    expect(host).toContain(
      `<script src="../assets/vendor/gsap.min.js"></script>`,
    );
    expect((await timelineView()).timeline.clips[0]).toMatchObject({
      kind: "composition",
      duration: 90,
    });

    // A whole-composition component goes in as it is.
    const grain = LibraryAddedSchema.parse(
      await ok(`/projects/${project.id}/library`, "POST", {
        name: "grain",
        track: 1,
        at: 0,
        duration: 45,
      }),
    );
    expect(grain.composition).toBe("compositions/components/grain.html");
  } finally {
    await fixture.close();
  }
});

test("a host's recipe cannot close its script, and its declarations stay one attribute", () => {
  const host = componentHost(
    {
      name: "x",
      variables: [{ id: "a", type: "string", label: "A", default: "it's" }],
    },
    fragmentHtml.replace(
      "startTime);",
      "startTime);\n  tl.set('</script><script>alert(1)', {});",
    ),
    { width: 1920, height: 1080 },
    "compositions/x.html",
  );
  expect(host).toContain("tl.set('<\\/script><script>alert(1)', {});");
  expect(host).toContain(
    `data-composition-variables='[{"id":"a","type":"string","label":"A","default":"it&#39;s"}]'`,
  );
});

test("refused items leave the project untouched", async () => {
  const { fixture, project, call, read } = await libraryFixture();
  try {
    const before = await read("index.html");
    const outside = await call(`/projects/${project.id}/library`, "POST", {
      name: "elsewhere",
      track: 0,
      at: 0,
    });
    expect(outside.status).toBe(422);
    expect(outside.body).toMatchObject({
      error: expect.stringContaining("https://example.com"),
    });
    const deprecated = await call(`/projects/${project.id}/library`, "POST", {
      name: "old-title",
      track: 0,
      at: 0,
    });
    expect(deprecated.status).toBe(422);
    const missing = await call(`/projects/${project.id}/library`, "POST", {
      name: "escape",
      track: 0,
      at: 0,
    });
    expect(missing.status).toBe(404);
    expect(await read("index.html")).toBe(before);
    expect(existsSync(join(project.path, "compositions"))).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("a redirect is refused rather than followed", async () => {
  const fixture = await projectFixture();
  try {
    const library = createLibrary({
      dataDir: join(fixture.directory, "data"),
      ref: REF,
      fetchImpl: (async () =>
        new Response("", {
          status: 302,
          headers: { location: "https://example.com/registry.json" },
        })) as unknown as typeof fetch,
    });
    await expect(library.catalog()).rejects.toThrow("redirected");
  } finally {
    await fixture.close();
  }
});

test("agents search freely, and adding from the library always asks", () => {
  const permissions = claudeToolPermissions(true);
  expect(permissions.allowedTools).toContain(
    "mcp__cutroom_studio__library_search",
  );
  expect(permissions.allowedTools).not.toContain(
    "mcp__cutroom_studio__library_add",
  );
  expect(permissions.settings.permissions.ask).toContain(
    "mcp__cutroom_studio__library_add",
  );
});
