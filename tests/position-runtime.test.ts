import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPositionSupport } from "../src/server/timeline/positionSupport";
import { createThumbnailRenderer } from "../src/server/hyperframes/thumbnails";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { positionCheckFrames } from "../src/shared/timeline/positionCheck";
import { projectFixture } from "./project-fixture";

const fixture = await projectFixture();
const routes = createTimelineRoutes(fixture.store, fixture.review);
fixture.app.route("/api/cutroom", routes);
afterAll(async () => {
  await routes.dispose();
  await fixture.close();
});
beforeAll(async () => {
  process.env.HYPERFRAMES_NO_TELEMETRY = "1";
  const child = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=40x30:r=30:d=2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      join(fixture.directory, "sample.mp4"),
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  expect(await child.exited).toBe(0);
});
const cases = [
  { name: "plain text", supported: true },
  {
    name: "plain video",
    supported: true,
    tag: '<video id="title" src="sample.mp4" muted data-start="0" data-duration="2"/>',
  },
  {
    name: "plain image",
    supported: true,
    tag: '<img id="title" src="picture.svg" data-start="0" data-duration="2">',
  },
  {
    name: "x/y slide-in",
    supported: true,
    script:
      "window.__timelines.main=gsap.timeline({paused:true}).fromTo('#title',{x:-100,y:50},{x:20,y:0,duration:2,ease:'none'},0);",
  },
  {
    name: "opacity and colour",
    supported: true,
    script:
      "window.__timelines.main=gsap.timeline({paused:true}).to('#title',{opacity:.5,color:'red',duration:2},0);",
  },
  {
    name: "hf-after-fonts translate",
    supported: false,
    scriptType: "text/hf-after-fonts",
    script:
      "window.__timelines.main=gsap.timeline({paused:true}).to('#title',{translate:'100px 20px',duration:2},0);",
  },
  {
    name: "uppercase script translate",
    supported: false,
    scriptType: "TEXT/JAVASCRIPT",
    script:
      "window.__timelines.main=gsap.timeline({paused:true}).to('#title',{translate:'100px 20px',duration:2},0);",
  },
  {
    name: "sub-composition host translate",
    supported: false,
    tag: '<div id="title" data-composition-src="scene.html" data-start="0" data-duration="2"></div>',
  },
  { name: "clip zoom", supported: false, style: "#title{zoom:.5}" },
  {
    name: "translate transition",
    supported: false,
    style: "#title{transition:translate 1s}",
  },
  {
    name: "late GSAP",
    supported: false,
    late: true,
    script:
      "setTimeout(()=>{const s=document.createElement('script');s.src='gsap.min.js';s.onload=()=>{window.__timelines.main=gsap.timeline({paused:true}).to('#title',{x:100,y:140,duration:1})};document.head.append(s)},100);",
  },
  {
    name: "authored translate with GSAP",
    supported: false,
    style: "#title{translate:20px 10px}",
    script:
      "window.__timelines.main=gsap.timeline({paused:true}).to('#title',{opacity:.5,duration:1});",
  },
  {
    name: "scaled ancestor",
    supported: false,
    style: "main{transform:scale(.5);transform-origin:0 0}",
  },
  {
    name: "chained timeline scale",
    supported: false,
    script:
      "window.__timelines.main=gsap.timeline({paused:true}).to('#main',{scale:.5,duration:1}).to('#title',{opacity:.5,duration:1});",
  },
];
for (const scenario of cases) {
  test(`assembled runtime: ${scenario.name}`, async () => {
    const project = await fixture.store.create({ name: scenario.name });
    if (scenario.name === "plain video")
      await copyFile(
        join(fixture.directory, "sample.mp4"),
        join(project.path, "sample.mp4"),
      );
    await copyFile(
      join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
      join(project.path, "gsap.min.js"),
    );
    await writeFile(
      join(project.path, "picture.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="lime"/></svg>',
    );
    await writeFile(
      join(project.path, "scene.html"),
      '<main data-composition-id="scene" data-width="320" data-height="240" data-duration="2"><p data-start="0" data-duration="2">Scene</p><script src="gsap.min.js"></script><script>window.__timelines.main=gsap.timeline({paused:true}).to(document.querySelector("p").parentElement.parentElement,{translate:"100px 20px",duration:2});</script></main>',
    );
    const file = join(project.path, "index.html");
    const source = `<!doctype html><html><head><style>html,body{margin:0}main{position:relative;width:320px;height:240px}#title{position:absolute;left:20px;top:30px;width:40px;height:30px;background:lime}${scenario.style ?? ""}</style>${scenario.script && !scenario.late ? '<script src="gsap.min.js"></script>' : ""}</head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="2">${scenario.tag ?? '<div id="title" data-start="0" data-duration="2">Title</div>'}</main>${scenario.script ? `<script type="${scenario.scriptType ?? "text/javascript"}">${scenario.script}</script>` : ""}</body></html>`;
    await writeFile(file, source);
    const path = `/projects/${project.id}`;
    const before = TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
    const checkPath = `${path}/position-support?clipId=title&revision=${before.revision}`;
    const [first, second] = await Promise.all([
      fixture.request(checkPath),
      fixture.request(checkPath),
    ]);
    expect(first.status, await first.clone().text()).toBe(200);
    const result = await first.json();
    expect(await second.json()).toEqual(result);
    expect(result).toEqual({
      reason: scenario.supported
        ? null
        : "Position moves differently in this composition.",
    });
    const response = await fixture.request(`${path}/commands`, "POST", {
      expectedRevision: before.revision,
      commands: [{ type: "setClip", clipId: "title", x: 40, y: -10 }],
    });
    expect(response.status, await response.clone().text()).toBe(
      scenario.supported ? 200 : 422,
    );
    if (!scenario.supported) expect(await readFile(file, "utf8")).toBe(source);
  });
}

test("starter template supports Position", async () => {
  const project = await fixture.store.create({ name: "Starter" });
  const path = `/projects/${project.id}`;
  const view = TimelineViewSchema.parse(
    await (await fixture.request(`${path}/timeline`)).json(),
  );
  const clip = view.timeline.clips[0]!;
  const response = await fixture.request(`${path}/commands`, "POST", {
    expectedRevision: view.revision,
    commands: [{ type: "setClip", clipId: clip.id, x: 37, y: 23 }],
  });
  expect(response.status, await response.clone().text()).toBe(200);
});

test("sampling checks every short-clip frame and bounds long clips with both endpoints", () => {
  expect(positionCheckFrames(30, 180)).toEqual(
    Array.from({ length: 150 }, (_, i) => 30 + i),
  );
  const long = positionCheckFrames(60, 960);
  expect(long.length).toBe(152);
  expect(long[0]).toBe(60);
  expect(long.at(-1)).toBe(959);
  expect(new Set(long).size).toBe(152);
});

test("a split piece cannot bypass the runtime check or write a refused batch", async () => {
  const project = await fixture.store.create({ name: "Scaled split" });
  const file = join(project.path, "index.html");
  const html =
    '<style>body{font-family:sans-serif}</style><main id="main" data-composition-id="main" data-fps="30" data-duration="2" style="transform:scale(.5)"><div id="title" data-start="0" data-duration="2">Title</div></main>';
  await writeFile(file, html);
  const path = `/projects/${project.id}`;
  const view = TimelineViewSchema.parse(
    await (await fixture.request(`${path}/timeline`)).json(),
  );
  const response = await fixture.request(`${path}/commands`, "POST", {
    expectedRevision: view.revision,
    commands: [
      {
        type: "split",
        clipIds: ["title"],
        at: 30,
        ids: { title: ["title-end"] },
      },
      { type: "setClip", clipId: "title-end", x: 40 },
    ],
  });
  expect(response.status, await response.clone().text()).toBe(422);
  expect(await response.json()).toMatchObject({
    command: 1,
    error: "Position moves differently in this composition.",
  });
  expect(await readFile(file, "utf8")).toBe(html);
});

test("a newer timeline revision supersedes a pending result and rechecks changed units", async () => {
  const project = await fixture.store.create({ name: "Revision" });
  const file = join(project.path, "index.html");
  const html =
    '<style>body{font-family:sans-serif}</style><main id="main" data-composition-id="main" data-duration="2"><div id="title" data-start="0" data-duration="2">Title</div></main>';
  await writeFile(file, html);
  const path = `/projects/${project.id}`;
  const before = TimelineViewSchema.parse(
    await (await fixture.request(`${path}/timeline`)).json(),
  );
  const pending = fixture.request(
    `${path}/position-support?clipId=title&revision=${before.revision}`,
  );
  await writeFile(file, html.replace("<main ", '<main style="zoom:.5" '));
  const after = TimelineViewSchema.parse(
    await (await fixture.request(`${path}/timeline`)).json(),
  );
  expect((await pending).status).toBe(409);
  const response = await fixture.request(
    `${path}/position-support?clipId=title&revision=${after.revision}`,
  );
  expect(await response.json()).toEqual({
    reason: "Position moves differently in this composition.",
  });
});

test("a changed stylesheet invalidates a cached check even without an open preview", async () => {
  const project = await fixture.store.create({ name: "External style" });
  const file = join(project.path, "index.html");
  const css = join(project.path, "style.css");
  await writeFile(
    file,
    '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-duration="2"><div id="title" data-start="0" data-duration="2">Title</div></main></body></html>',
  );
  await writeFile(css, "body{font-family:sans-serif}");
  const path = `/projects/${project.id}`;
  const view = TimelineViewSchema.parse(
    await (await fixture.request(`${path}/timeline`)).json(),
  );
  const url = `${path}/position-support?clipId=title&revision=${view.revision}`;
  expect(await (await fixture.request(url)).json()).toEqual({ reason: null });
  await writeFile(css, "body{font-family:sans-serif}main{transform:scale(.5)}");
  const response = await fixture.request(`${path}/commands`, "POST", {
    expectedRevision: view.revision,
    commands: [{ type: "setClip", clipId: "title", x: 40 }],
  });
  expect(response.status, await response.clone().text()).toBe(422);
  expect(await (await fixture.request(url)).json()).toEqual({
    reason: "Position moves differently in this composition.",
  });
});

test("Position in a split batch preserves the engine's generated piece ids", async () => {
  const project = await fixture.store.create({ name: "Split and position" });
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><head><style>body{font-family:sans-serif}.subject{width:40px;height:30px}</style></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-duration="2"><div id="title" class="subject" data-start="0" data-duration="2">Title</div></main></body></html>',
  );
  const path = `/projects/${project.id}`;
  const view = TimelineViewSchema.parse(
    await (await fixture.request(`${path}/timeline`)).json(),
  );
  const response = await fixture.request(`${path}/commands`, "POST", {
    expectedRevision: view.revision,
    commands: [
      { type: "split", clipIds: ["title"], at: 30 },
      { type: "setClip", clipId: "title", x: 40 },
    ],
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const after = TimelineViewSchema.parse(await response.json());
  expect(after.timeline.clips.length).toBe(2);
  expect(new Set(after.timeline.clips.map((clip) => clip.id)).size).toBe(2);
  expect(after.timeline.clips.find((clip) => clip.id === "title")?.x).toBe(40);
  const readback = TimelineViewSchema.parse(
    await (await fixture.request(`${path}/timeline`)).json(),
  );
  expect(readback.timeline).toEqual(after.timeline);
});

test("the check assembles nested track settings through the same overrides as export", async () => {
  const project = await fixture.store.create({ name: "Nested mix" });
  const scene =
    '<main data-composition-id="scene" data-width="320" data-height="240" data-duration="2"><div id="inner" data-start="0" data-duration="2">Child</div></main>';
  await writeFile(join(project.path, "scene.html"), scene);
  const path = `/projects/${project.id}`;
  const nested = TimelineViewSchema.parse(
    await (
      await fixture.request(`${path}/timeline?composition=scene.html`)
    ).json(),
  );
  const disabled = await fixture.request(`${path}/commands`, "POST", {
    composition: "scene.html",
    expectedRevision: nested.revision,
    commands: [{ type: "setTrack", index: 0, enabled: false }],
  });
  expect(disabled.status).toBe(200);
  // Outside source writes do not clear saved track settings.
  await writeFile(join(project.path, "scene.html"), scene);
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><head><style>body{font-family:sans-serif}#main:has([data-hidden]){transform:scale(.5)}</style></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-duration="2"><div id="title" data-start="0" data-duration="2">Title</div><div id="nested" data-composition-src="scene.html" data-start="0" data-duration="2" data-track-index="1"></div></main></body></html>',
  );
  const view = TimelineViewSchema.parse(
    await (await fixture.request(`${path}/timeline`)).json(),
  );
  const response = await fixture.request(
    `${path}/position-support?clipId=title&revision=${view.revision}`,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({
    reason: "Position moves differently in this composition.",
  });
});

test("a newer revision cancels a stuck check so the latest commit is not queued behind it", async () => {
  const project = await fixture.store.create({ name: "Cancel obsolete check" });
  const renderer = createThumbnailRenderer();
  const checks = createPositionSupport(renderer);
  const html =
    '<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="2"><div id="title" data-start="0" data-duration="2">Title</div></main></body></html>';
  const shifted = html.replace(
    'id="title"',
    'id="title" data-x="37" data-y="23" data-hf-edit-base-x="0" data-hf-edit-base-y="0"',
  );
  const hold =
    '<script>Object.defineProperty(window,"__hfWaitForSeekCompletion",{value:()=>new Promise(()=>{}),configurable:false,writable:false});</script>';
  await writeFile(join(project.path, "index.html"), html);
  const input = {
    projectDir: project.path,
    composition: "index.html",
    overrides: {},
    clipId: "title",
    start: 0,
    end: 60,
    fps: { num: 30, den: 1 },
    width: 320,
    height: 240,
  };
  try {
    const { browser } = await renderer.getBrowser();
    const obsolete = checks
      .check("project", "old", {
        ...input,
        sources: [html + hold, shifted + hold],
      })
      .catch((error) => error);
    // The real isolated page is open before superseding it. Its seek cannot settle.
    await browser.waitForTarget(
      (target) => target.type() === "page" && target.url().startsWith("http:"),
    );
    const latest = checks.check("project", "new", {
      ...input,
      sources: [html, shifted],
    });
    expect(await obsolete).toMatchObject({ status: 409 });
    expect(await latest).toBeNull();
    // Concurrent callers get the one in-flight/completed check for this key.
    expect(
      checks.check("project", "new", { ...input, sources: [html, shifted] }),
    ).toBe(latest);
  } finally {
    await checks.close();
  }
}, 30_000);
