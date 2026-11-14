import { execFile } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const ready = (page: Page) =>
  page.waitForFunction(() =>
    document.querySelector(".edit-stage")?.hasAttribute("data-preview-ready"),
  );
const token = (page: Page) =>
  page.locator(".edit-stage").getAttribute("data-preview-ready");
const changed = (page: Page, old: string | null) =>
  page.waitForFunction((old) => {
    const stage = document.querySelector(".edit-stage");
    return (
      stage?.hasAttribute("data-preview-ready") &&
      stage.getAttribute("data-preview-ready") !== old
    );
  }, old);
const live = (page: Page) =>
  page.locator("iframe[data-live]").getAttribute("src");

async function fixture(request: APIRequestContext, page: Page) {
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
    `<!doctype html><html><head><style>html,body{margin:0;background:#111}main{position:relative;width:640px;height:360px}video{position:absolute;inset:0;width:100%;height:100%}#title{position:absolute;top:20px;left:20px;color:white;font:24px sans-serif}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-fps="30000/1001" data-duration="10"><video id="v1" src="talk.mp4" muted data-link="p1" data-start="0" data-duration="2.535867" data-media-start="0" data-track-index="0"></video><audio id="a1" src="talk.mp4" data-link="p1" data-start="0" data-duration="2.535867" data-media-start="0" data-track-index="1"></audio><video id="v2" src="talk.mp4" muted data-link="p2" data-start="2.535867" data-duration="7.464133" data-media-start="2.535867" data-track-index="0"></video><audio id="a2" src="talk.mp4" data-link="p2" data-start="2.535867" data-duration="7.464133" data-media-start="2.535867" data-track-index="1"></audio><div id="title" class="clip" data-start="1" data-duration="3" data-track-index="2">Chapter one</div></main></body></html>`,
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
  // Establish the editor's managed track stylesheet before measuring timing-only changes.
  await edit([{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }]);
  await edit([{ type: "move", clipIds: ["title"], by: -1, mode: "overwrite" }]);
  await page.goto(`/#project/${project.id}`);
  await ready(page);
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
  const { edit, read } = await fixture(request, page);
  const original = await live(page);
  let previous = await token(page);
  await edit([
    { type: "setTiming", clipId: "v1", mediaStart: 1, playbackRate: 1.5 },
    { type: "move", clipIds: ["title"], by: 1, mode: "overwrite" },
  ]);
  await changed(page, previous);
  expect(await live(page)).toBe(original);
  const clips = (await read()).timeline.clips;
  expect(clips.find((c) => c.id === "a1")?.mediaStart).toBe(1);
  expect(clips.find((c) => c.id === "a1")?.playbackRate).toBe(1.5);
  // Two source-in controls from the study plus both sides of the rational cut/title edges.
  for (const frame of [0, 30, 31, 75, 76, 77]) {
    await seek(page, frame);
    const patched = await page.locator(".edit-picture").screenshot();
    await page.reload();
    await ready(page);
    await seek(page, frame);
    const fresh = await page.locator(".edit-picture").screenshot();
    expect(patched.equals(fresh), `frame ${frame}`).toBe(true);
    if (frame === 76)
      await info.attach("NTSC cut.png", {
        body: fresh,
        contentType: "image/png",
      });
  }
  for (const step of ["Control+z", "Control+Shift+z"]) {
    const doc = await live(page);
    previous = await token(page);
    await page.getByRole("region", { name: "Viewer", exact: true }).click();
    await page.keyboard.press(step);
    await changed(page, previous);
    expect(await live(page)).toBe(doc);
    const patched = await page.locator(".edit-picture").screenshot();
    await page.reload();
    await ready(page);
    await seek(page, 77);
    expect(
      patched.equals(await page.locator(".edit-picture").screenshot()),
    ).toBe(true);
  }
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
  await ready(second);
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
  await Promise.all([changed(page, tokens[0]!), changed(second, tokens[1]!)]);
  expect(await Promise.all([live(page), live(second)])).toEqual(docs);
  let source = await readFile(join(project.path, "index.html"), "utf8");
  let previous = await token(page);
  source = source.replace('data-media-start="1"', 'data-media-start="2"');
  await writeFile(join(project.path, "index.html"), source);
  await changed(page, previous);
  expect(await live(page)).toBe(docs[0]);
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
    await changed(page, previous);
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
  await changed(page, previous);
  await ready(page);
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
  await ready(page);
  for (const failure of ["missing", "late", "error"] as const) {
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
    await changed(page, before);
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
  await changed(page, previous);
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
  await changed(page, playingToken);
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
