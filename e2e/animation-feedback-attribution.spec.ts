import { copyFile, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { ProjectSchema } from "../src/shared/project";
import {
  AnimationFeedbackSchema,
  TimelineViewSchema,
} from "../src/shared/timeline/schema";
import { test, expect } from "./fixtures";
import type { Page, APIRequestContext } from "@playwright/test";

async function open(page: Page, request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Selector attribution" },
      })
    ).json(),
  );
  const html = `<!doctype html><html><head><script src="gsap.min.js"></script><style>body{margin:0;background:#111;color:white;font:48px system-ui}.clip{position:absolute;left:40px}.title{top:140px}.shot{top:20px}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="20"><div id="shot" class="clip shot" data-start="0" data-duration="4" data-track-index="0">Shot</div><div id="title" class="clip title" data-label="Lower third" data-start="4" data-duration="4" data-track-index="1">Ada Lovelace</div><div id="child" class="clip" data-composition-id="child" data-composition-src="child.html" data-start="10" data-duration="4" data-track-index="2"></div></main><script>const tl=gsap.timeline({paused:true});tl.fromTo(".clip.title",{x:-40},{x:0,duration:.5},4);window.__timelines.main=tl;</script></body></html>`;
  const file = join(project.path, "index.html");
  await writeFile(file, html);
  await copyFile(
    join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
    join(project.path, "gsap.min.js"),
  );
  await writeFile(
    join(project.path, "child.html"),
    '<template><main data-composition-id="child" data-width="640" data-height="360"><p id="child-text">Clip-local title</p></main><script>{const local=gsap.timeline({paused:true});local.fromTo("#child-text",{x:0},{x:100,duration:1},0);window.__timelines.child=local;}</script></template>',
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(base + "/timeline")).json(),
    );
  const connected = page.waitForRequest((r) =>
    r.url().includes(`/projects/${project.id}/events`),
  );
  await page.goto(`/#project/${project.id}`);
  const origin =
    new URL((await connected).url()).searchParams.get("origin") ?? "";
  await expect(page.locator('[data-clip="title"]')).toBeVisible();
  return {
    project,
    base,
    read,
    file,
    html,
    headers: { "x-cutroom-tab-origin": origin },
  };
}

test("qualified selectors leave a shot and clip-local host quiet, then warn only for the title", async ({
  page,
  request,
}, info) => {
  const f = await open(page, request);
  const response = await request.post(f.base + "/commands", {
    headers: f.headers,
    data: {
      expectedRevision: (await f.read()).revision,
      commands: [
        { type: "move", clipIds: ["shot", "child"], by: 30, mode: "place" },
      ],
    },
  });
  expect(response.ok()).toBe(true);
  await expect
    .poll(
      async () =>
        (await f.read()).timeline.clips.find((c) => c.id === "child")!.start,
    )
    .toBe(330);
  await page.waitForTimeout(500);
  await expect(
    page.locator(".toast").filter({ hasText: "animation" }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("unrelated-quiet.png") });
  await page.locator('[data-clip="title"]').click();
  const start = page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("textbox", { name: "Start", exact: true });
  await start.fill("5s");
  await start.press("Enter");
  const toast = page
    .getByRole("status")
    .filter({ hasText: "Lower third's animation stayed behind." });
  await expect(toast).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(1);
  expect(
    (await readFile(f.file, "utf8")).match(/<script>[^]*?<\/script>/g),
  ).toEqual(f.html.match(/<script>[^]*?<\/script>/g));
  await page.screenshot({ path: info.outputPath("title-warning.png") });
  await toast.getByRole("button", { name: "Ask agent", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(f.base + "/review")).json()).items.length,
    )
    .toBe(1);
  const note = (await (await request.get(f.base + "/review")).json()).items[0];
  expect(note.elementId).toBe("title");
  expect(note.body).toContain("Its root animation still uses composition time");
  expect(note.body).not.toContain("shifted automatically");
});

test("animation toast expires at the existing four-second hold without a dismiss action", async ({
  page,
  request,
}) => {
  const f = await open(page, request);
  await request.post(f.base + "/commands", {
    headers: f.headers,
    data: {
      expectedRevision: (await f.read()).revision,
      commands: [{ type: "move", clipIds: ["title"], by: 30, mode: "place" }],
    },
  });
  const toast = page
    .getByRole("status")
    .filter({ hasText: "Lower third's animation stayed behind." });
  await expect(toast).toBeVisible();
  await expect(toast).toHaveCount(0, { timeout: 6000 });
  expect(
    (await (await request.get(f.base + "/review")).json()).items,
  ).toHaveLength(0);
});

test("HTTP MCP gets its edit result first and an animation notification afterward", async ({
  page,
  request,
  baseURL,
}) => {
  const f = await open(page, request);
  const client = new Client({
    name: "animation-followup-browser",
    version: "1",
  });
  const warning = Promise.withResolvers<unknown>();
  const order: string[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    order.push("warning");
    warning.resolve(n.params.data);
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const result = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: f.project.id,
        expectedRevision: (await f.read()).revision,
        commands: [{ type: "move", clipIds: ["title"], by: 30, mode: "place" }],
      },
    });
    order.push("result");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).not.toHaveProperty(
      "result.animationLeftBehind",
    );
    const feedback = AnimationFeedbackSchema.parse(await warning.promise);
    expect(feedback.clips).toEqual([{ clipId: "title", label: "Lower third" }]);
    expect(order).toEqual(["result", "warning"]);
    await page.waitForTimeout(150);
    await expect(
      page.locator(".toast").filter({ hasText: "animation" }),
    ).toHaveCount(0);
  } finally {
    await client.close();
  }
});

test("only the initiating tab warns and leaving the project clears its action", async ({
  page,
  context,
  request,
}, info) => {
  const f = await open(page, request);
  const other = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Other project" },
      })
    ).json(),
  );
  const observer = await context.newPage();
  try {
    await observer.goto(`/#project/${f.project.id}`);
    await expect(observer.locator('[data-clip="title"]')).toBeVisible();
    const observerEvents: string[] = [];
    observer.on("response", (r) => {
      if (r.url().includes("/timeline")) observerEvents.push(r.url());
    });
    await page.locator('[data-clip="title"]').click();
    const start = page
      .getByRole("complementary", { name: "Inspector" })
      .getByRole("textbox", { name: "Start", exact: true });
    await start.fill("5s");
    await start.press("Enter");
    const toast = page
      .getByRole("status")
      .filter({ hasText: "Lower third's animation stayed behind." });
    await expect(toast).toBeVisible();
    // Observe the saved edit in the other tab before asserting its warning stays absent.
    await expect.poll(() => observerEvents.length).toBeGreaterThan(0);

    await expect
      .soft(observer.locator(".toast").filter({ hasText: "animation" }))
      .toHaveCount(0, { timeout: 500 });
    await page.screenshot({ path: info.outputPath("initiator-warning.png") });
    await observer.screenshot({ path: info.outputPath("observer-quiet.png") });
    await page.evaluate((id) => {
      location.hash = `project/${id}`;
    }, other.id);
    await expect(page.locator('[data-clip="title"]')).toHaveCount(0);
    expect.soft(await toast.count()).toBe(0);
    expect(
      await page
        .getByRole("button", { name: "Ask agent", exact: true })
        .count(),
    ).toBe(0);
    await page.screenshot({
      path: info.outputPath("switched-project-quiet.png"),
    });
    expect(
      (await (await request.get(f.base + "/review")).json()).items,
    ).toHaveLength(0);
  } finally {
    await observer.close();
  }
});
