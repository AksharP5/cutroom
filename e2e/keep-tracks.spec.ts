import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { startMediaDrag } from "./media-drag";

async function open(page: Page, request: APIRequestContext, starter = true) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Launch cut" },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=12",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "interview.mp4"),
  ]);
  if (!starter)
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><head><style>body{margin:0;background:#171717;color:white;font-family:sans-serif}.clip{position:absolute;left:10%;top:40%;font-size:72px}</style></head><body><main data-composition-id="main" data-width="1920" data-height="1080" data-duration="12" data-fps="30">
<div id="title" class="clip" data-label="Lower third" data-start="0" data-duration="2" data-track-index="0">Lower third</div>
<div id="copy" class="clip" data-label="Replacement" data-start="6" data-duration="3" data-track-index="0">Replacement</div></main></body></html>`,
    );
  const base = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    ).timeline;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("[data-clip]").first()).toBeVisible();
  await expect(page.locator(".tl-grid")).toHaveAttribute(
    "data-refit",
    "settled",
  );
  const drop = async (row: number) => {
    await startMediaDrag(
      page,
      page
        .getByRole("region", { name: "Media", exact: true })
        .getByRole("listitem")
        .filter({ hasText: "interview.mp4" }),
    );
    const lane = (await page
      .locator(`.tl-lane[data-row="${row}"]`)
      .boundingBox())!;
    await page.mouse.move(lane.x + 1, lane.y + lane.height / 2, { steps: 12 });
    await page.mouse.move(lane.x + 1, lane.y + lane.height / 2);
    await page.mouse.up();
  };
  return { base, read, drop };
}

test("lifting starter clips keeps V1-V3 through reload, and an interview drop on V1 preserves the title", async ({
  page,
  request,
}, info) => {
  const { read, drop } = await open(page, request);
  const before = await read();
  await page.locator('[data-clip="rule"]').click();
  await page.keyboard.press("x");
  await expect
    .poll(async () => (await read()).clips.some((clip) => clip.id === "rule"))
    .toBe(false);
  await page.locator('[data-clip="caption"]').click();
  await page.keyboard.press("x");
  await expect
    .poll(async () => (await read()).clips.map((clip) => clip.id))
    .toEqual(["headline"]);
  await page.reload();
  await expect(page.locator('[data-clip="headline"]')).toBeVisible();
  await page.screenshot({ path: info.outputPath("after-lifts.png") });
  const v1 = page
    .locator(".tl-head.video")
    .filter({ has: page.locator(".tl-head-id", { hasText: /^V1$/ }) });
  await drop(Number(await v1.getAttribute("data-row")));
  await expect
    .poll(async () =>
      (await read()).clips.filter((clip) => clip.src === "interview.mp4"),
    )
    .toHaveLength(2);
  await expect(
    page.frameLocator("iframe[data-live]").locator("video"),
  ).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("after-interview-drop.png") });
  await expect(
    page.frameLocator("iframe[data-live]").locator("#headline"),
  ).toContainText("Launch cut");
  expect((await read()).clips.find((clip) => clip.id === "headline")).toEqual(
    before.clips.find((clip) => clip.id === "headline"),
  );
  await expect(page.locator(".tl-head.video")).toHaveCount(3);
  expect(
    (await read()).tracks.filter((track) => track.kind === "video"),
  ).toEqual(before.tracks);
  // Only explicitly removed empty tracks leave the stack. Removal is one undo step.
  const height = page.getByRole("separator", {
    name: "Height V3",
    exact: true,
  });
  const resized = Number(await height.getAttribute("aria-valuenow")) + 4;
  await height.press("ArrowDown");
  await page.getByLabel("Name V3", { exact: true }).fill("Spare picture");
  await page.getByLabel("Name V3", { exact: true }).press("Enter");
  await page.locator('.tl-head[data-row="2"]').click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Remove empty track", exact: true })
    .click();
  await expect(page.locator('.tl-head[data-row="2"]')).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(page.getByLabel("Name V3", { exact: true })).toHaveValue(
    "Spare picture",
  );
  await expect(
    page.getByRole("separator", { name: "Height V3", exact: true }),
  ).toHaveAttribute("aria-valuenow", String(resized));
});

for (const action of ["drop", "paste"] as const)
  test(`a whole-clip ${action} overwrite names the replaced clip with working Undo`, async ({
    page,
    request,
  }, info) => {
    const { read, drop } = await open(page, request, false);
    const before = await read();
    if (action === "drop") await drop(0);
    else {
      await page.locator('[data-clip="copy"]').click();
      await page.keyboard.press("Control+c");
      await page.keyboard.press("Control+v");
    }
    await expect
      .poll(async () =>
        (await read()).clips.some((clip) => clip.id === "title"),
      )
      .toBe(false);
    const notice = page.getByRole("status").filter({
      hasText:
        action === "paste"
          ? "Replaced Lower third."
          : "Replaced Lower third and Replacement.",
    });
    await expect(notice).toBeVisible();
    await expect(
      page.frameLocator("iframe[data-live]").locator("#title"),
    ).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`overwrite-${action}.png`) });
    await notice.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(read).toEqual(before);
    await expect(notice).toHaveCount(0);
  });
