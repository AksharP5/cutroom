import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  LibraryAddedSchema,
  LibraryCatalogSchema,
  librarySearch,
} from "../src/shared/library";
import { ProjectDocumentSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { claudeToolPermissions } from "../src/server/agents/tool-permissions";
import { componentHost } from "../src/server/library/add";
import { createLibraryPreviews } from "../src/server/library/preview";
import { LIBRARY_RELEASE, createLibrary } from "../src/server/library/registry";
import { createLibraryRoutes } from "../src/server/library/routes";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";
import { COMMIT, REF, fragmentHtml, registryFetch } from "./library-fixture";

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
    createLibraryRoutes(fixture.store, fixture.review, library, timeline),
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
    // Items that would write outside the project, at its root, under node_modules, or fetch code
    // from outside the pinned registry fail validation and are left out, as are examples.
    expect(catalog.items.map((item) => item.name)).toEqual([
      "lt-clean-bar",
      "blur-in",
      "grain",
      "old-title",
      "future-chart",
      "elsewhere",
      "globe",
      "eased",
      "redirected",
      "oversize",
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
    // three.js from a CDN cannot load in preview or export; GSAP and its plugins can, locally.
    expect(byName.get("globe")?.disabled).toBe("Needs online scripts");
    expect(byName.get("eased")?.disabled).toBeUndefined();
    // Items are read at the release's commit, never at a tag that could move.
    expect(
      registry.state.requests.every(
        (url) =>
          !url.includes("raw.githubusercontent.com") ||
          url.includes(`/hyperframes/${COMMIT}/registry/`),
      ),
    ).toBe(true);

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
      createTimelineRoutes(fixture.store, fixture.review),
    );
    const again = LibraryCatalogSchema.parse(
      await (await restarted.request("/library")).json(),
    );
    expect(again.items).toHaveLength(10);
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
    // Items that would write outside the project, at its root (bunfig.toml), under node_modules, or
    // take code from outside the pinned registry are not in the library at all.
    for (const name of ["escape", "root-config", "node-modules", "cdn-code"]) {
      const refused = await call(`/projects/${project.id}/library`, "POST", {
        name,
        track: 0,
        at: 0,
      });
      expect(refused.status, name).toBe(404);
    }
    expect(existsSync(join(project.path, "bunfig.toml"))).toBe(false);
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

test("a placement the timeline refuses writes nothing and leaves no history", async () => {
  const { fixture, project, call, ok, read } = await libraryFixture();
  try {
    const view = TimelineViewSchema.parse(
      await ok(`/projects/${project.id}/timeline`),
    );
    await ok(`/projects/${project.id}/commands`, "POST", {
      expectedRevision: view.revision,
      commands: [{ type: "setTrack", index: 1, kind: "audio" }],
    });
    const entries = async () =>
      (
        (await ok(`/projects/${project.id}/history`)) as {
          entries: unknown[];
        }
      ).entries.length;
    const before = {
      entries: await entries(),
      source: await read("index.html"),
    };
    const refused = await call(`/projects/${project.id}/library`, "POST", {
      name: "lt-clean-bar",
      track: 1,
      at: 0,
    });
    expect(refused.status).toBe(422);
    expect(await entries()).toBe(before.entries);
    expect(await read("index.html")).toBe(before.source);
    expect(existsSync(join(project.path, "compositions"))).toBe(false);
    expect(existsSync(join(project.path, "assets/lt"))).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("item files and posters refuse redirects and bodies past their caps", async () => {
  const { fixture, project, call } = await libraryFixture();
  try {
    for (const [name, reason] of [
      ["redirected", "redirected"],
      ["oversize", "larger than"],
    ] as const) {
      const added = await call(`/projects/${project.id}/library`, "POST", {
        name,
        track: 0,
        at: 0,
      });
      expect(added.status, name).toBe(502);
      expect(added.body).toMatchObject({
        error: expect.stringContaining(reason),
      });
    }
    expect(existsSync(join(project.path, "compositions"))).toBe(false);
    const poster = await call("/library/posters/redirected");
    expect(poster.status).toBe(502);
  } finally {
    await fixture.close();
  }
});

test("a damaged or tampered cache counts as not downloaded", async () => {
  const { fixture, registry, project, ok, read } = await libraryFixture();
  try {
    const add = (at: number) =>
      ok(`/projects/${project.id}/library`, "POST", {
        name: "lt-clean-bar",
        track: 0,
        at,
      });
    await add(0);
    const cached = join(
      fixture.directory,
      "data/library",
      REF,
      "items/lt-clean-bar",
    );
    await writeFile(join(cached, ".files.json"), "{not json");
    await writeFile(join(cached, "assets/lt/bar.png"), "tampered");
    const fetched = registry.state.requests.length;
    await rm(join(project.path, "assets/lt/bar.png"));
    await add(200);
    // Both were fetched again, so the project gets the registry's bytes, not the tampered ones.
    expect(registry.state.requests.length).toBeGreaterThan(fetched);
    expect(await read("assets/lt/bar.png")).toBe("PNG bytes");
  } finally {
    await fixture.close();
  }
});

test("GSAP plugins load from the project's own copies", async () => {
  const { fixture, project, ok, read } = await libraryFixture();
  try {
    const added = LibraryAddedSchema.parse(
      await ok(`/projects/${project.id}/library`, "POST", {
        name: "eased",
        track: 0,
        at: 0,
      }),
    );
    expect(added.added).toContain("assets/vendor/CustomEase.min.js");
    const scene = await read("compositions/eased.html");
    expect(scene).toContain('src="../assets/vendor/CustomEase.min.js"');
    expect(scene).not.toContain("cdn.jsdelivr.net");
  } finally {
    await fixture.close();
  }
});

test("an item without a license records the registry's, marked as inherited", async () => {
  const { fixture, project, ok, read } = await libraryFixture();
  try {
    await ok(`/projects/${project.id}/library`, "POST", {
      name: "blur-in",
      track: 0,
      at: 0,
    });
    expect(
      ProjectDocumentSchema.parse(JSON.parse(await read("cutroom.json")))
        .library,
    ).toEqual([
      {
        name: "blur-in",
        ref: REF,
        source: "registry/components/blur-in",
        license: "Apache-2.0",
        licenseInherited: true,
        files: ["compositions/blur-in.html"],
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test("undoing a second use keeps the files the first one placed", async () => {
  const { fixture, project, ok, read, timelineView } = await libraryFixture();
  try {
    const add = (at: number) =>
      ok(`/projects/${project.id}/library`, "POST", {
        name: "lt-clean-bar",
        track: 0,
        at,
      }).then((body) => LibraryAddedSchema.parse(body));
    const first = await add(0);
    await add(200);
    await ok(`/projects/${project.id}/history/undo`, "POST");
    expect(
      (await timelineView()).timeline.clips.map((clip) => clip.id),
    ).toEqual([first.clipId]);
    expect(await read("assets/lt/bar.png")).toBe("PNG bytes");
    expect(await read("compositions/lt-clean-bar.html")).toContain(
      "lt-clean-bar",
    );
  } finally {
    await fixture.close();
  }
});

test("the Library reads the release Cutroom's HyperFrames packages pin", async () => {
  const pinned = JSON.parse(
    await readFile(
      new URL("../node_modules/hyperframes/package.json", import.meta.url),
      "utf8",
    ),
  ) as { version: string };
  expect<string>(LIBRARY_RELEASE.version).toBe(pinned.version);
  expect(LIBRARY_RELEASE.commit).toBe(COMMIT);
});

test("search matches the title as the panel shows it, commas included", () => {
  const matches = librarySearch("Lower Third, Clean");
  expect(
    matches({
      title: "Lower Third — Clean Bar",
      name: "lt-clean-bar",
      tags: [],
      description: "Minimal",
    }),
  ).toBe(true);
});

test("a saved list goes offline when a download fails, and back once the registry answers", async () => {
  const fixture = await projectFixture();
  try {
    const registry = registryFetch();
    const library = createLibrary({
      dataDir: join(fixture.directory, "data"),
      fetchImpl: registry.fetchImpl,
      ref: REF,
      retryMs: 0,
    });
    const routes = createLibraryRoutes(
      fixture.store,
      fixture.review,
      library,
      createTimelineRoutes(fixture.store, fixture.review),
    );
    const list = async () =>
      LibraryCatalogSchema.parse(
        await (await routes.request("/library")).json(),
      );
    expect((await list()).offline).toBe(false);
    // The list is saved; the network drops before any item was downloaded.
    registry.state.offline = true;
    const item = await library.item("lt-clean-bar");
    await expect(library.files(item)).rejects.toThrow(
      "Can't reach the HyperFrames library.",
    );
    const offline = await list();
    expect(offline.offline).toBe(true);
    // The panel disables what it has not downloaded.
    expect(
      offline.items.find(({ name }) => name === "lt-clean-bar")?.cached,
    ).toBe(false);
    registry.state.offline = false;
    expect((await list()).offline).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("a preview serves only its own files, under a sandboxing policy", async () => {
  const fixture = await projectFixture();
  try {
    const registry = registryFetch();
    const previews = createLibraryPreviews(
      createLibrary({
        dataDir: join(fixture.directory, "data"),
        fetchImpl: registry.fetchImpl,
        ref: REF,
      }),
    );
    const open = await previews.request(
      "/cutroom/library/lt-clean-bar/preview?width=640&height=360",
    );
    expect(open.status).toBe(302);
    const page = open.headers.get("location")!;
    expect(page).toMatch(
      /^\/api\/isolated\/[0-9a-f-]{36}\/lt-clean-bar\/640x360\/$/,
    );
    const request = (path: string) =>
      previews.request(`http://127.0.0.1${path.replace(/^\/api/, "")}`);
    const document = await request(page);
    expect(document.status).toBe(200);
    expect(document.headers.get("content-security-policy")).toStartWith(
      "sandbox allow-scripts; default-src 'none'",
    );
    const html = await document.text();
    expect(html).toContain(
      'data-hyperframes-preview-runtime="1" src="../../runtime.js"',
    );
    // The scene goes in at its own length, with its asset beside it.
    expect(html).toContain('data-duration="4.8"');
    expect((await request(`${page}assets/lt/bar.png`)).status).toBe(200);
    expect(
      (await request(`${page.replace(/\/[^/]+\/\d+x\d+\/$/, "/")}runtime.js`))
        .status,
    ).toBe(200);
    // Nothing outside the built folder, no hidden file, and no folder that was never built.
    for (const path of [
      `${page}..%2F..%2F..%2Fcatalog.json`,
      `${page}.preview@640x360.html`,
      page.replace("640x360", "1920x1080"),
    ])
      expect((await request(path)).status, path).toBe(404);
  } finally {
    await fixture.close();
  }
});

test("a part marked from an In point keeps its place and length and plays from there, in one step", async () => {
  const { fixture, project, ok, read, timelineView } = await libraryFixture();
  try {
    const added = LibraryAddedSchema.parse(
      await ok(`/projects/${project.id}/library`, "POST", {
        name: "lt-clean-bar",
        track: 0,
        at: 30,
        start: 24,
        duration: 60,
      }),
    );
    const clip = (await timelineView()).timeline.clips.find(
      ({ id }) => id === added.clipId,
    );
    // 24 frames in at 30 fps.
    expect(clip).toMatchObject({ start: 30, duration: 60, mediaStart: 0.8 });
    expect(await read("index.html")).toContain('data-playback-start="0.8"');
    await ok(`/projects/${project.id}/history/undo`, "POST");
    expect((await timelineView()).timeline.clips).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("search gives lengths in the timeline's frames, as library_add takes them", async () => {
  const { fixture, project, ok } = await libraryFixture();
  try {
    const found = (await ok(
      `/projects/${project.id}/library?query=${encodeURIComponent("lower third")}`,
    )) as { items: { name: string; duration: number }[] };
    // 4.8 seconds at the timeline's 30 fps.
    expect(found.items).toEqual([
      expect.objectContaining({ name: "lt-clean-bar", duration: 144 }),
    ]);
    const component = (await ok(
      `/projects/${project.id}/library?query=blur`,
    )) as { items: { name: string; duration: number }[] };
    expect(component.items[0]).toMatchObject({ name: "blur-in", duration: 90 });
  } finally {
    await fixture.close();
  }
});

test("previews at two sizes share the item's files, and only a component host is drawn per size", async () => {
  const fixture = await projectFixture();
  try {
    const registry = registryFetch();
    const library = createLibrary({
      dataDir: join(fixture.directory, "data"),
      fetchImpl: registry.fetchImpl,
      ref: REF,
    });
    const previews = createLibraryPreviews(library);
    for (const [name, size] of [
      ["lt-clean-bar", "width=640&height=360"],
      ["lt-clean-bar", "width=1080&height=1920"],
      ["blur-in", "width=640&height=360"],
      ["blur-in", "width=1080&height=1920"],
    ])
      expect(
        (await previews.request(`/cutroom/library/${name}/preview?${size}`))
          .status,
      ).toBe(302);
    const files = async (name: string) =>
      (await readdir(library.previewDir(name), { recursive: true })).sort();
    expect(await files("lt-clean-bar")).toEqual([
      ".preview@1080x1920.html",
      ".preview@640x360.html",
      "assets",
      "assets/lt",
      "assets/lt/bar.png",
      "assets/vendor",
      "assets/vendor/gsap.min.js",
      "compositions",
      "compositions/lt-clean-bar.html",
      "index@1080x1920.html",
      "index@640x360.html",
    ]);
    expect(
      (await files("blur-in")).filter((path) =>
        path.startsWith("compositions/"),
      ),
    ).toEqual([
      "compositions/blur-in@1080x1920.html",
      "compositions/blur-in@640x360.html",
    ]);
  } finally {
    await fixture.close();
  }
});

test("startup removes the caches of other HyperFrames releases", async () => {
  const fixture = await projectFixture();
  try {
    const root = join(fixture.directory, "data/library");
    await mkdir(join(root, "v0.9.20/items/old"), { recursive: true });
    await mkdir(join(root, REF), { recursive: true });
    await createLibrary({
      dataDir: join(fixture.directory, "data"),
      ref: REF,
    }).removeOtherReleases();
    expect(await readdir(root)).toEqual([REF]);
  } finally {
    await fixture.close();
  }
});
