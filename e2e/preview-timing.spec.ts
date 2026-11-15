import { execFile } from "node:child_process";
import { writeFile, readFile, mkdir, chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { waitForPreview } from "./preview-ready";

const token = (page: Page) =>
  page.locator(".edit-stage").getAttribute("data-preview-ready");
const live = (page: Page) =>
  page.locator("iframe[data-live]").getAttribute("src");

async function replaceIndex(dir: string, html: string) {
  const pending = join(dir, ".cutroom", "preview-next.html");
  await mkdir(join(dir, ".cutroom"), { recursive: true });
  await writeFile(pending, html);
  await rename(pending, join(dir, "index.html"));
}

async function fixture(
  request: APIRequestContext,
  page: Page,
  scripts = "",
  css = "",
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Live timing", width: 640, height: 360, duration: 10 },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30000/1001:d=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=10",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-threads",
    "2",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "talk.mp4"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#111}main{position:relative;width:640px;height:360px}video{position:absolute;inset:0;width:100%;height:100%}#title{position:absolute;top:20px;left:20px;color:white;font:24px sans-serif}${css}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-fps="30000/1001" data-duration="10"><video id="v1" src="talk.mp4" muted data-link="p1" data-start="0" data-duration="2.535867" data-media-start="0" data-track-index="0"></video><audio id="a1" src="talk.mp4" data-link="p1" data-start="0" data-duration="2.535867" data-media-start="0" data-track-index="1"></audio><video id="v2" src="talk.mp4" muted data-link="p2" data-start="2.535867" data-duration="7.464133" data-media-start="2.535867" data-track-index="0"></video><audio id="a2" src="talk.mp4" data-link="p2" data-start="2.535867" data-duration="7.464133" data-media-start="2.535867" data-track-index="1"></audio><div id="title" class="clip" data-start="1" data-duration="3" data-track-index="2">Chapter one</div></main></body></html>`,
  );

  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  const edit = async (commands: CommandInput[]) => {
    const view = await read();
    const response = await request.post(
      `/api/cutroom/projects/${project.id}/commands`,
      {
        data: {
          composition: "index.html",
          expectedRevision: view.revision,
          label: "Timing test",
          commands,
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
  };
  if (scripts) {
    const path = join(project.path, "index.html");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("</body>", scripts + "</body>"),
    );
  }
  // Establish the editor's managed track stylesheet before measuring timing-only changes.
  await edit([{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }]);
  await edit([{ type: "move", clipIds: ["title"], by: -1, mode: "overwrite" }]);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  if (!scripts) await waitForPreview(page, { timing: true });
  return { project, read, edit };
}

async function seek(page: Page, frame: number) {
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page
    .getByLabel("Go to time")
    .pressSequentially(
      `${String(Math.floor(frame / 30)).padStart(2, "0")}${String(frame % 30).padStart(2, "0")}`,
    );
  await page.keyboard.press("Enter");
  await page.evaluate(async () => {
    const frame =
      document.querySelector<HTMLIFrameElement>("iframe[data-live]")!;
    const id = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        removeEventListener("message", receive);
        reject(Error("paint timeout"));
      }, 10000);
      const receive = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.data?.id !== id)
          return;
        clearTimeout(timer);
        removeEventListener("message", receive);
        event.data.error ? reject(Error(event.data.error)) : resolve();
      };
      addEventListener("message", receive);
      frame.contentWindow!.postMessage(
        { source: "cutroom-viewer", id, action: "paint" },
        "*",
      );
    });
  });
}

test("paused timing keeps the document and matches fresh pictures at NTSC cuts, linked source-in/rate, titles, undo and redo", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120000);
  const { project, edit, read } = await fixture(request, page);
  const original = await live(page);
  let previous = await token(page);
  await edit([
    { type: "setTiming", clipId: "v1", mediaStart: 1, playbackRate: 1.5 },
    { type: "trim", clipId: "v1", edge: "end", to: 75, ripple: false },
    { type: "move", clipIds: ["title"], by: 1, mode: "overwrite" },
  ]);
  await waitForPreview(page, { after: previous });
  const picture = page.locator("iframe[data-live]").contentFrame();
  await expect(picture.locator("#v1")).toHaveAttribute("data-media-start", "1");
  await waitForPreview(page);
  expect(await live(page)).toBe(original);
  const clips = (await read()).timeline.clips;
  expect(clips.find((c) => c.id === "a1")?.mediaStart).toBe(1);
  expect(clips.find((c) => c.id === "a1")?.playbackRate).toBe(1.5);
  expect(clips.find((c) => c.id === "v1")?.duration).toBe(75);
  expect(clips.find((c) => c.id === "a1")?.duration).toBe(75);
  const control = await page.context().newPage();
  try {
    // The patched page never reloads. Every control picture starts in another fresh document.
    for (const step of ["Control+z", "Control+Shift+z"]) {
      previous = await token(page);
      await page.getByRole("button", { name: /^Current time/ }).focus();
      await page.keyboard.press(step);
      await waitForPreview(page, { after: previous });
      await expect(picture.locator("#v1")).toHaveAttribute(
        "data-media-start",
        step === "Control+z" ? "0" : "1",
      );
      await waitForPreview(page);
      expect(await live(page)).toBe(original);
      await control.goto(`/#project/${project.id}`);
      await waitForPreview(control);
      await seek(page, 0);
      await seek(control, 0);
      const patched = await page.locator(".edit-picture").screenshot();
      const fresh = await control.locator(".edit-picture").screenshot();
      await info.attach("history live.png", {
        body: patched,
        contentType: "image/png",
      });
      await info.attach("history fresh.png", {
        body: fresh,
        contentType: "image/png",
      });
      expect(patched.equals(fresh), step).toBe(true);
      // The reference is a fresh render, not a second editor applying the next history step.
      await control.goto("about:blank");
    }
    for (const frame of [0, 30, 31, 75, 76, 77]) {
      await seek(page, frame);
      const patched = await page.locator(".edit-picture").screenshot();
      await control.goto(`/#project/${project.id}`);
      await waitForPreview(control);
      await seek(control, frame);
      const fresh = await control.locator(".edit-picture").screenshot();
      expect(patched.equals(fresh), `frame ${frame}`).toBe(true);
      expect(await live(page)).toBe(original);
      if (frame === 76)
        await info.attach("NTSC cut.png", {
          body: fresh,
          contentType: "image/png",
        });
      await control.goto("about:blank");
    }
  } finally {
    await control.close();
  }
});

/** Each frame of the edited tab must equal the same frame of a freshly loaded document. */
async function matchesFresh(
  page: Page,
  projectId: string,
  frames: number[],
  label: string,
) {
  const control = await page.context().newPage();
  try {
    await control.goto(`/#project/${projectId}`);
    await waitForPreview(control);
    for (const frame of frames) {
      await seek(page, frame);
      await seek(control, frame);
      const patched = await page.locator(".edit-picture").screenshot();
      const fresh = await control.locator(".edit-picture").screenshot();
      expect(patched.equals(fresh), `${label}, frame ${frame}`).toBe(true);
    }
  } finally {
    await control.close();
  }
}

test("a timing edit after the playhead crosses a cut keeps the document", async ({
  page,
  request,
}) => {
  const { project, edit } = await fixture(request, page);
  // The runtime swaps the visible clips once the new one has decoded, after the seek returns.
  await seek(page, 100);
  const original = await live(page);
  const previous = await token(page);
  await edit([{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }]);
  await waitForPreview(page, { after: previous });
  await waitForPreview(page);
  expect(await live(page)).toBe(original);
  await matchesFresh(page, project.id, [40, 100], "after a seek");
});

test("ripple delete and lift keep the document and match fresh pictures, and undo still lands", async ({
  page,
  request,
}) => {
  test.setTimeout(150000);
  const { project, edit } = await fixture(request, page);
  const picture = page.locator("iframe[data-live]").contentFrame();
  const undo = async (label: string) => {
    const previous = await token(page);
    await page.getByRole("button", { name: /^Current time/ }).focus();
    await page.keyboard.press("Control+z");
    await waitForPreview(page, { after: previous });
    await waitForPreview(page);
    await expect(picture.locator("#v1, #a1")).toHaveCount(2);
    await matchesFresh(page, project.id, [0, 76], label);
  };
  // Removing the first pair closes the gap: the second pair and the title move back,
  // and the composition shortens.
  await seek(page, 100);
  let original = await live(page);
  const length = await picture.locator("main").getAttribute("data-duration");
  let previous = await token(page);
  await edit([{ type: "remove", clipIds: ["v1"], ripple: true }]);
  await waitForPreview(page, { after: previous });
  await expect(picture.locator("#v1, #a1")).toHaveCount(0);
  await expect(picture.locator("main")).not.toHaveAttribute(
    "data-duration",
    length!,
  );
  await waitForPreview(page);
  expect(await live(page)).toBe(original);
  await matchesFresh(page, project.id, [0, 43, 44, 100], "ripple delete");
  // Undo adds the clips back, which still needs a fresh document.
  await undo("undo ripple delete");

  await seek(page, 40);
  original = await live(page);
  previous = await token(page);
  await edit([{ type: "remove", clipIds: ["v1"], ripple: false }]);
  await waitForPreview(page, { after: previous });
  await expect(picture.locator("#v1, #a1")).toHaveCount(0);
  await waitForPreview(page);
  expect(await live(page)).toBe(original);
  await matchesFresh(page, project.id, [0, 40, 75, 76], "lift");
  await undo("undo lift");
});

test("lifting a clip matches fresh pictures through a dissolve, a transform and track gain", async ({
  page,
  request,
}) => {
  test.setTimeout(150000);
  const { project, edit } = await fixture(request, page);
  let previous = await token(page);
  await edit([
    { type: "setClip", clipId: "v2", scale: 1.25, rotation: 5 },
    {
      type: "setTransition",
      from: "v1",
      to: "v2",
      transition: { kind: "dissolve", duration: 20, alignment: "center" },
    },
    { type: "setTrack", index: 1, volume: 0.5 },
  ]);
  await waitForPreview(page, { after: previous });
  await waitForPreview(page, { timing: true });
  // A second title keeps its track, and so the track stylesheet, after the lift.
  previous = await token(page);
  await edit([
    {
      type: "insert",
      track: 2,
      at: 200,
      clip: { kind: "title", id: "late", text: "Later", duration: 60 },
    },
  ]);
  await waitForPreview(page, { after: previous });
  await waitForPreview(page, { timing: true });
  const original = await live(page);
  previous = await token(page);
  await edit([{ type: "remove", clipIds: ["title"], ripple: false }]);
  await waitForPreview(page, { after: previous });
  await waitForPreview(page);
  expect(await live(page)).toBe(original);
  await matchesFresh(page, project.id, [60, 70, 76, 80, 86, 150], "lift");
});

// Authored rules that depend on which clips are present restyle the clips that stay.
for (const [kind, css] of [
  [
    "an animation",
    "main:not(:has(#a1)) #title{animation:slide 20s linear both}@keyframes slide{to{transform:translateX(400px)}}",
  ],
  [
    "a transition",
    "#title{transition:transform 6s linear}main:not(:has(#a1)) #title{transform:translateX(300px)}",
  ],
] as const)
  test(`a lift that starts ${kind} on another clip reloads and matches a fresh document`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    const { project, edit } = await fixture(request, page, "", css);
    await seek(page, 40);
    const original = await live(page);
    const previous = await token(page);
    await edit([{ type: "remove", clipIds: ["v1"], ripple: false }]);
    await waitForPreview(page, { after: previous });
    await waitForPreview(page);
    // The runtime discovers CSS animations and transitions only when a document loads.
    expect(await live(page)).not.toBe(original);
    await matchesFresh(page, project.id, [40, 60], kind);
  });

test("MCP and disk timing refresh both tabs, while structural, script and CSS changes reload", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120000);
  const { project, read } = await fixture(request, page);
  const second = await page.context().newPage();
  await second.goto(`/#project/${project.id}`);
  await waitForPreview(second);
  await waitForPreview(second, { timing: true });
  const docs = await Promise.all([live(page), live(second)]);
  const tokens = await Promise.all([token(page), token(second)]);
  const client = new Client({ name: "timing-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  try {
    const view = await read();
    const result = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        composition: "index.html",
        expectedRevision: view.revision,
        label: "Agent source in",
        commands: [{ type: "setTiming", clipId: "v1", mediaStart: 1 }],
      },
    });
    expect(result.isError).not.toBe(true);
  } finally {
    await client.close();
  }
  await Promise.all([
    waitForPreview(page, { after: tokens[0]! }),
    waitForPreview(second, { after: tokens[1]! }),
  ]);
  for (const tab of [page, second])
    await expect(
      tab.locator("iframe[data-live]").contentFrame().locator("#v1"),
    ).toHaveAttribute("data-media-start", "1");
  await Promise.all([waitForPreview(page), waitForPreview(second)]);
  expect(await Promise.all([live(page), live(second)])).toEqual(docs);
  let source = await readFile(join(project.path, "index.html"), "utf8");
  const diskTokens = await Promise.all([token(page), token(second)]);
  source = source.replace('data-media-start="1"', 'data-media-start="2"');
  await replaceIndex(project.path, source);
  await Promise.all([
    waitForPreview(page, { after: diskTokens[0]! }),
    waitForPreview(second, { after: diskTokens[1]! }),
  ]);
  for (const tab of [page, second])
    await expect(
      tab.locator("iframe[data-live]").contentFrame().locator("#v1"),
    ).toHaveAttribute("data-media-start", "2");
  let previous = await token(page);
  for (const transform of [
    (s: string) => s.replace("Chapter one", "Chapter two"),
    (s: string) => s.replace("color:white", "color:yellow"),
    (s: string) =>
      s.replace("</body>", "<script>window.testValue=42</script></body>"),
    (s: string) => s.replace('id="title"', 'id="title" data-track-index="3"'),
    (s: string) =>
      s.replace(
        "</main>",
        '<div class="clip" id="new" data-start="0" data-duration="1">New</div></main>',
      ),
    (s: string) => s.replace(/<div class="clip" id="new".*?<\/div>/, ""),
  ]) {
    const oldDoc = await live(page);
    previous = await token(page);
    source = transform(source);
    await writeFile(join(project.path, "index.html"), source);
    await waitForPreview(page, { after: previous });
    expect(await live(page)).not.toBe(oldDoc);
  }
  await second.close();
});

test("rapid edits and missing, failed or late acknowledgments fall back without accepting stale pictures", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    addEventListener(
      "message",
      (event) => {
        const failure = document.documentElement?.dataset.failTiming;
        if (!failure || event.data?.action !== "timing") return;
        event.stopImmediatePropagation();
        console.debug(`timing fault: ${failure}`);
        if (failure === "missing") return;
        setTimeout(
          () =>
            parent.postMessage(
              {
                source: "cutroom-preview",
                id: event.data.id,
                state: {
                  ready: true,
                  root: true,
                  error: null,
                  width: 640,
                  height: 360,
                  fps: "30000/1001",
                  time: 0,
                  playing: false,
                },
                error: failure === "error" ? "injected failure" : undefined,
                timingRevision: event.data.timing.revision,
              },
              "*",
            ),
          failure === "late" ? 2500 : 0,
        );
      },
      true,
    );
  });
  const { edit } = await fixture(request, page);
  const previous = await token(page);
  await page.locator('[data-clip="title"]').click({ force: true });
  // Native inputs go through the editor's queue even when a picture is still pending.
  const started = performance.now();
  for (let index = 0; index < 8; index++) {
    const delay = started + index * 125 - performance.now();
    if (delay > 0) await page.waitForTimeout(delay);
    const field = page.getByLabel("Start", { exact: true });
    await field.focus();
    await field.press("ArrowUp");
    await field.press("Enter");
  }
  await waitForPreview(page, { after: previous });
  await waitForPreview(page);
  await expect
    .poll(async () =>
      page
        .frames()
        .find((f) => f.url().includes("/api/isolated/"))
        ?.evaluate(() =>
          document.querySelector("#title")?.getAttribute("data-start"),
        ),
    )
    .toBe(String((38 * 1001) / 30000));
  await waitForPreview(page);
  for (const failure of ["missing", "late", "error"] as const) {
    await waitForPreview(page, { timing: true });
    const intercepted = page.waitForEvent("console", {
      predicate: (message) => message.text() === `timing fault: ${failure}`,
    });
    const doc = await live(page),
      before = await token(page);
    // Alter only the next live document's bridge, never its replacement.
    const frame = (await (await page
      .locator("iframe[data-live]")
      .elementHandle())!.contentFrame())!;
    await frame.evaluate((failure) => {
      document.documentElement.dataset.failTiming = failure;
    }, failure);
    await edit([
      { type: "move", clipIds: ["title"], by: 1, mode: "overwrite" },
    ]);
    await intercepted;
    await waitForPreview(page, { after: before });
    await expect.poll(() => live(page)).not.toBe(doc);
    await page.waitForTimeout(600);
    expect(await live(page)).not.toBe(doc);
  }
});

test("a source race retires an in-flight timing snapshot, and playing edits use the reload path", async ({
  page,
  request,
}) => {
  const { project, edit } = await fixture(request, page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route("**/isolated-preview?*cutroom-timing*", async (route) => {
    const response = await route.fetch();
    entered();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  const previous = await token(page),
    doc = await live(page);
  await edit([{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }]);
  await waiting;
  const path = join(project.path, "index.html");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "Chapter one",
      "Outside replacement",
    ),
  );
  await expect.poll(() => live(page)).not.toBe(doc);
  release();
  await waitForPreview(page, { after: previous });
  const current = (await (await page
    .locator("iframe[data-live]")
    .elementHandle())!.contentFrame())!;
  await expect(current.locator("#title")).toHaveText("Outside replacement");
  await page.unroute("**/isolated-preview?*cutroom-timing*");
  const playingDoc = await live(page),
    playingToken = await token(page);
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Play forward", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await edit([{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }]);
  await waitForPreview(page, { after: playingToken });
  expect(await live(page)).not.toBe(playingDoc);
  await page.keyboard.press("Space");
});

test("a refused save never changes the preview document or its picture", async ({
  page,
  request,
}) => {
  await fixture(request, page);
  await seek(page, 45);
  await page.locator('[data-clip="title"]').click({ force: true });
  const original = await live(page);
  const picture = await page.locator(".edit-picture").screenshot();
  await page.route("**/api/cutroom/projects/*/commands", (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Refused timing save",
        code: "unsupported",
      }),
    }),
  );
  await page.locator('[data-clip="title"]').click({ force: true });
  const start = page.getByLabel("Start", { exact: true });
  await start.focus();
  await start.press("ArrowUp");
  await start.press("Enter");
  await expect(
    page.getByText("Refused timing save", { exact: true }),
  ).toBeVisible();
  expect(await live(page)).toBe(original);
  expect(picture.equals(await page.locator(".edit-picture").screenshot())).toBe(
    true,
  );
});

for (const [name, scripts] of [
  [
    "init-time GSAP",
    '<script src="assets/vendor/gsap.min.js"></script><script>const title=document.querySelector("#title");window.__timelines={main:gsap.timeline({paused:true}).fromTo(title,{x:-120},{x:0,duration:1},+title.dataset.start)};</script>',
  ],
  ["noembed", "<noembed><script>window.authored=true</script></noembed>"],
  ["noscript", "<noscript><script>window.authored=true</script></noscript>"],
  [
    "forged timing replies",
    '<script>addEventListener("message",e=>{if(e.data?.action!=="timing")return;parent.postMessage({type:"forged-timing-attempt"},"*");parent.postMessage({source:"cutroom-preview",id:e.data.id,timingRevision:e.data.timing.revision,state:{ready:true,root:true,error:null,width:640,height:360,fps:"30000/1001",time:0,playing:false}},"*")})</script>',
  ],
] as const)
  test(`authored ${name} always reloads, even if the next source becomes script-free`, async ({
    page,
    request,
  }) => {
    await page.addInitScript(() => {
      Reflect.set(window, "forgedTimingAttempts", 0);
      addEventListener("message", (e) => {
        if (e.data?.type === "forged-timing-attempt")
          Reflect.set(
            window,
            "forgedTimingAttempts",
            Number(Reflect.get(window, "forgedTimingAttempts")) + 1,
          );
      });
    });
    let snapshots = 0;
    page.on("request", (request) => {
      if (request.url().includes("cutroom-timing=")) snapshots++;
    });
    const { project, edit } = await fixture(request, page, scripts);
    for (const commands of [
      [{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }],
      [{ type: "remove", clipIds: ["v1"], ripple: true }],
    ] satisfies CommandInput[][]) {
      const doc = await live(page),
        before = await token(page);
      await edit(commands);
      await waitForPreview(page, { after: before });
      expect(await live(page)).not.toBe(doc);
    }
    expect(snapshots).toBe(0);
    if (name === "init-time GSAP") {
      const control = await page.context().newPage();
      try {
        await control.goto(`/#project/${project.id}`);
        await waitForPreview(control);
        await seek(page, 45);
        await seek(control, 45);
        expect(
          (await page.locator(".edit-picture").screenshot()).equals(
            await control.locator(".edit-picture").screenshot(),
          ),
        ).toBe(true);
      } finally {
        await control.close();
      }
    }
    const scripted = await live(page),
      prior = await token(page);
    const path = join(project.path, "index.html");
    await writeFile(path, (await readFile(path, "utf8")).replace(scripts, ""));
    await waitForPreview(page, { after: prior });
    expect(await live(page)).not.toBe(scripted);
    expect(
      await page.evaluate(() => Reflect.get(window, "forgedTimingAttempts")),
    ).toBe(0);
  });

for (const [divergence, change] of [
  ["text", "timing"],
  ["style", "timing"],
  ["element", "timing"],
  ["element", "removal"],
] as const)
  test(`a script-free document with divergent live ${divergence} fails closed on a ${change} edit`, async ({
    page,
    request,
  }) => {
    const { edit } = await fixture(request, page);
    const before = await token(page),
      doc = await live(page);
    const frame = (await (await page
      .locator("iframe[data-live]")
      .elementHandle())!.contentFrame())!;
    await frame.evaluate((divergence) => {
      const title = document.querySelector<HTMLElement>("#title")!;
      if (divergence === "text") title.textContent = "Divergent";
      if (divergence === "style") title.style.background = "red";
      if (divergence === "element")
        title.append(document.createElement("span"));
    }, divergence);
    await edit(
      change === "timing"
        ? [{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }]
        : [{ type: "remove", clipIds: ["v1"], ripple: true }],
    );
    await waitForPreview(page, { after: before });
    expect(await live(page)).not.toBe(doc);
    const current = (await (await page
      .locator("iframe[data-live]")
      .elementHandle())!.contentFrame())!;
    await expect(current.locator("#title")).toHaveText("Chapter one");
  });

for (const scripted of [false, true])
  test(`${scripted ? "scripted bursts replace candidates" : "eligible bursts keep one active and latest pending refresh"} while preserving every save and undo step`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    let timingWork = 0;
    page.on("request", (request) => {
      if (/cutroom-(status|timing)=/.test(request.url())) timingWork++;
    });
    const { read, project } = await fixture(
      request,
      page,
      scripted ? "<script>window.authored=true</script>" : "",
    );
    const initial = (await read()).timeline.clips.find(
      (clip) => clip.id === "title",
    )!.start;
    let navigations = 0;
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/isolated-preview?*", async (route) => {
      if (!route.request().isNavigationRequest()) return route.continue();
      navigations++;
      if (navigations !== 1) return route.continue();
      captured.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    // Hold a real browser navigation until all saves finish, preserving its
    // navigation-bound authorization instead of replacing it with an API fetch.
    const source = join(project.path, "index.html");
    await replaceIndex(
      project.path,
      (await readFile(source, "utf8")).replace("color:white", "color:yellow"),
    );
    await captured.promise;
    let saves = 0;
    page.on("response", (response) => {
      if (response.url().endsWith("/commands") && response.ok()) saves++;
    });
    await page.locator('[data-clip="title"]').click({ force: true });
    try {
      const started = performance.now();
      for (let index = 0; index < 8; index++) {
        const delay = started + index * 125 - performance.now();
        if (delay > 0) await page.waitForTimeout(delay);
        const field = page.getByLabel("Start", { exact: true });
        await field.focus();
        await field.press("ArrowUp");
        await field.press("Enter");
        expect(
          await page.locator(".edit-picture iframe").count(),
        ).toBeLessThanOrEqual(2);
      }
      await expect.poll(() => saves).toBe(8);
      if (scripted) expect(navigations).toBeGreaterThan(1);
      else expect(navigations).toBe(1);
    } finally {
      release.resolve();
    }
    await expect
      .poll(async () =>
        page
          .locator("iframe[data-live]")
          .contentFrame()
          .locator("#title")
          .getAttribute("data-start"),
      )
      .toBe(String(((initial + 8) * 1001) / 30000));
    await waitForPreview(page);
    if (!scripted) expect(navigations).toBeLessThanOrEqual(2);
    // Preview coalescing must never coalesce saved history.
    for (let index = 0; index < 8; index++) {
      await page.getByRole("region", { name: "Viewer", exact: true }).click();
      await page.keyboard.press("Control+z");
      await expect
        .poll(
          async () =>
            (await read()).timeline.clips.find((clip) => clip.id === "title")!
              .start,
        )
        .toBe(initial + 7 - index);
    }
    await expect
      .poll(async () =>
        Number(
          await page
            .locator("iframe[data-live]")
            .contentFrame()
            .locator("#title")
            .getAttribute("data-start"),
        ),
      )
      .toBeCloseTo((initial * 1001) / 30000, 6);
    await waitForPreview(page);
    if (scripted) expect(timingWork).toBe(0);
  });

test("an unavailable fingerprint keeps the canonical full preview usable and ineligible for live timing", async ({
  page,
  request,
}) => {
  test.skip(
    process.platform === "win32" || process.getuid?.() === 0,
    "Needs directory permission boundaries",
  );
  const { project } = await fixture(request, page);
  const aux = join(project.path, "aux");
  await mkdir(aux);
  await writeFile(join(aux, "unused.tmp"), "temporary");
  await chmod(aux, 0o400);
  try {
    await page.reload();
    await waitForPreview(page);
    await seek(page, 45);
    const frame = page.locator("iframe[data-live]").contentFrame();
    await expect(frame.locator("#title")).toBeVisible();
    const response = await request.get(`${await live(page)}&cutroom-status=1`);
    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual({ allowed: false });
  } finally {
    await chmod(aux, 0o700);
  }
});

for (const scenario of ["playing", "forged hint"] as const)
  test(`${scenario} reloads replace superseded candidates without live timing`, async ({
    page,
    request,
  }) => {
    const scripted = scenario !== "playing";
    if (scenario === "forged hint")
      await page.addInitScript(() => {
        Reflect.set(window, "eligibilityAttempts", 0);
        addEventListener("message", (event) => {
          if (event.data?.type === "eligibility-attempt")
            Reflect.set(
              window,
              "eligibilityAttempts",
              Number(Reflect.get(window, "eligibilityAttempts")) + 1,
            );
        });
      });
    let timingRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes("cutroom-timing=")) timingRequests++;
    });
    const { read } = await fixture(
      request,
      page,
      scenario === "forged hint"
        ? '<script>addEventListener("message",e=>{if(e.data?.source!=="cutroom-viewer"||e.data.action!=="inspect")return;parent.postMessage({type:"eligibility-attempt"},"*");parent.postMessage({source:"cutroom-preview",id:e.data.id,timingRevision:"forged",state:{ready:true,root:true,error:null,width:640,height:360,fps:"30000/1001",time:0,playing:false}},"*")})</script>'
        : scripted
          ? '<meta name="cutroom-timing-contract" content="attributes"><script>window.authored=true</script>'
          : "",
    );
    const first = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let navigations = 0;
    await page.route("**/isolated-preview?*", async (route) => {
      if (!route.request().isNavigationRequest()) return route.continue();
      if (++navigations !== 1) return route.continue();
      first.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    const initial = (await read()).timeline.clips.find(
      (clip) => clip.id === "title",
    )!.start;
    await page.locator('[data-clip="title"]').click({ force: true });
    if (!scripted)
      await page
        .getByRole("button", { name: "Play forward", exact: true })
        .click();
    const field = page.getByLabel("Start", { exact: true });
    await field.focus();
    await field.press("ArrowUp");
    await field.press("Enter");
    try {
      await first.promise;
      await field.press("ArrowUp");
      await field.press("Enter");
      // Main's path can finish the second revision while the first remains blocked.
      await expect.poll(() => navigations).toBeGreaterThanOrEqual(2);
      if (!scripted)
        await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect
        .poll(async () =>
          Number(
            await page
              .locator("iframe[data-live]")
              .contentFrame()
              .locator("#title")
              .getAttribute("data-start"),
          ),
        )
        .toBeCloseTo(((initial + 2) * 1001) / 30000, 6);
      await waitForPreview(page);
    } finally {
      release.resolve();
    }
    expect(timingRequests).toBe(0);
    if (scenario === "forged hint")
      expect(
        await page.evaluate(() => Reflect.get(window, "eligibilityAttempts")),
      ).toBeGreaterThan(0);
  });
