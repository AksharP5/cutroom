import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import {
  afterPaint,
  createPositionProject,
  positionField,
  seekFrame,
} from "./position-helpers";

test("translate animation warns only at frames where it overrides Position", async ({
  page,
  request,
  baseURL,
}, info) => {
  const project = await createPositionProject(request, {
    name: "Position warning",
    width: 320,
    height: 240,
    duration: 3,
  });
  await copyFile(
    join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
    join(project.path, "gsap.min.js"),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0}#title{position:absolute;left:30px;top:80px;width:100px;height:40px;background:lime}</style><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="3"><div id="title" class="clip" data-start="0" data-duration="3">Slide-in title</div><div id="other" class="clip" data-start="0" data-duration="3" data-track-index="1">Other</div></main><script>window.__timelines.main=gsap.timeline({paused:true}).to('#title',{translate:'80px 0px',duration:1,ease:'none'},.5).set('#title',{translate:'40px 0px'},1.5);</script></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="title"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const field = positionField(page);
  const path = `/api/cutroom/projects/${project.id}`;
  const client = new Client({ name: "position-warning", version: "1.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const before = TimelineViewSchema.parse(
      await (await request.get(`${path}/timeline`)).json(),
    );
    const result = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: before.revision,
        commands: [{ type: "setClip", clipId: "title", x: 40 }],
      },
    });
    expect(result.isError).not.toBe(true);
    await expect(field).toHaveValue("40 px");
    await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
    const warning = inspector.getByRole("status");
    const seek = async (frame: number) => {
      await seekFrame(page, frame);
      await expect
        .poll(() =>
          page
            .frameLocator("iframe[data-live]")
            .locator("#title")
            .evaluate((element) => getComputedStyle(element).translate),
        )
        .toBe(frame === 30 ? "60px" : "40px");
    };
    for (const frame of [0, 30, 60, 30, 0]) {
      await seek(frame);
      if (frame === 30) {
        await expect(warning).toHaveText(
          "This clip's animation overrides Position at 00:00:01:00.",
        );
        await expect(field).toBeEnabled();
        await page.locator('[data-clip="other"]').click();
        await expect(warning).toHaveCount(0);
        await page.locator('[data-clip="title"]').click();
        await expect(warning).toBeVisible();
      } else {
        await expect(warning).toHaveCount(0);
      }
    }
    await page
      .getByRole("button", { name: "Play forward", exact: true })
      .click();
    await expect(warning).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await seek(60);
    await expect(warning).toHaveCount(0);
  } finally {
    await client.close();
  }
});

test("scale, rotation and zoom warn without blocking edits, and reset clears the warning", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(request, {
    name: "Position units",
    width: 320,
    height: 240,
    duration: 2,
  });
  const fixtures = [
    { id: "matrix", ancestor: "transform:scale(.5)", clip: "" },
    { id: "zoom", ancestor: "zoom:1.5", clip: "" },
    { id: "scale", ancestor: "", clip: "scale:.5" },
    { id: "rotate", ancestor: "rotate:15deg", clip: "" },
  ];
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="2">${fixtures.map(({ id, ancestor, clip }, track) => `<section style="${ancestor}"><div id="${id}" class="clip" data-start="0" data-duration="2" data-track-index="${track}" style="position:absolute;width:40px;height:30px;background:lime;${clip}">${id}</div></section>`).join("")}</main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  const path = `/api/cutroom/projects/${project.id}`;
  const view = TimelineViewSchema.parse(
    await (await request.get(`${path}/timeline`)).json(),
  );
  const response = await request.post(`${path}/commands`, {
    data: {
      expectedRevision: view.revision,
      commands: fixtures.map(({ id }) => ({
        type: "setClip",
        clipId: id,
        x: 40,
      })),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  for (const { id } of fixtures) {
    await page.locator(`[data-clip="${id}"]`).click();
    await expect(inspector.getByRole("status")).toContainText(
      "overrides Position",
    );
    await expect(positionField(page)).toBeEnabled();
    await inspector.getByRole("button", { name: "Reset position" }).click();
    await expect(positionField(page)).toHaveValue("0 px");
    await expect(inspector.getByRole("status")).toHaveCount(0);
  }
});

test("paused video observes the held picture when zoom reduces the Position offset", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(
    request,
    { name: "Paused Position warning", width: 320, height: 240, duration: 2 },
    `<!doctype html><html><head><style>html,body{margin:0}#picture{position:absolute;left:20px;top:30px;width:64px;height:48px;zoom:.5}</style></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="2"><video id="picture" src="picture.mp4" muted data-start="0" data-duration="2"></video></main></body></html>`,
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=64x48:r=30:d=2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    join(project.path, "picture.mp4"),
  ]);
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="picture"]').click();
  const field = positionField(page);
  await field.fill("40");
  await afterPaint(page, () => field.press("Enter"));
  await expect(field).toHaveValue("40 px");
  const preview = page.frameLocator("iframe[data-live]");
  const warning = page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("status");
  for (const frame of [0, 30]) {
    await seekFrame(page, frame);
    await expect(preview.locator("#picture")).toHaveCSS("visibility", "hidden");
    const held = preview.locator("canvas[data-cutroom-video-hold]");
    await expect(held).toBeVisible();
    expect(await held.evaluate((el) => el.getBoundingClientRect().left)).toBe(
      30,
    );
    await expect(warning).toHaveText(
      `This clip's animation overrides Position at 00:00:0${frame / 30}:00.`,
    );
    await expect(field).toBeEnabled();
  }
});
