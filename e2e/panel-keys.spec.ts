import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);

/** Two clips of `talk.mp4` on V1, with `music.wav` and `talk.mp4` in Media. */
async function open(page: Page, request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: `Panel keys ${Date.now()}`, duration: 6 },
      })
    ).json(),
  );
  const assets = join(project.path, "assets");
  await mkdir(assets, { recursive: true });
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=6",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    join(assets, "talk.mp4"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=2",
    join(assets, "music.wav"),
  ]);
  const path = join(project.path, "index.html");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      /<main([^>]*)>[\s\S]*<\/main>/,
      `<main$1>
    <video src="assets/talk.mp4" muted id="first" class="clip" data-start="0" data-duration="2" data-track-index="0"></video>
    <video src="assets/talk.mp4" muted id="second" class="clip" data-start="2" data-duration="2" data-media-start="2" data-track-index="0"></video>
    </main>`,
    ),
  );
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(2);
  await expect(timeline.locator(".tl-grid")).toHaveAttribute(
    "data-refit",
    "settled",
  );
  const media = page.getByRole("region", { name: "Media", exact: true });
  const file = (name: string) =>
    media.getByRole("listitem").filter({ hasText: name });
  await expect(file("talk.mp4")).toHaveAttribute("draggable", "true");
  return {
    timeline,
    media,
    file,
    viewer: page.getByRole("region", { name: "Viewer", exact: true }),
    inspector: page.getByRole("complementary", { name: "Inspector" }),
    clock: page.getByRole("button", { name: /^Current time/ }),
    /** A press in the lanes' empty space, as an editor working in the timeline leaves focus. */
    async clickTimeline() {
      const lanes = (await timeline.locator(".tl-lanes").boundingBox())!;
      await page.mouse.click(lanes.x + 40, lanes.y + lanes.height - 8);
    },
  };
}

test("one key moves the keyboard from the timeline to Media and back, where it took a run of Tabs", async ({
  page,
  request,
}) => {
  const { timeline, file, clock, clickTimeline } = await open(page, request);
  await clickTimeline();

  await page.keyboard.press("Control+2");
  await expect(file("music.wav")).toBeFocused();
  // Reached by key, the list takes the arrows: the next file, not the next edit.
  await page.keyboard.press("ArrowDown");
  await expect(file("talk.mp4")).toBeFocused();
  await expect(clock).toHaveText("00:00:00:00");

  await page.keyboard.press("Control+4");
  await expect(timeline).toBeFocused();
  // The timeline has the keys again: Down is the next edit.
  await page.keyboard.press("ArrowDown");
  await expect(clock).toHaveText("00:00:02:00");
  // Tab walks the timeline's own controls from here, not the status bar's.
  await page.keyboard.press("Tab");
  await expect(
    timeline.getByRole("button", { name: "Zoom out" }),
  ).toBeFocused();
  // The panel itself is never a Tab stop.
  await page.keyboard.press("Shift+Tab");
  await expect(timeline).not.toBeFocused();

  // Media remembers its file, and a click in the timeline still leaves focus where it always did.
  await page.keyboard.press("Control+2");
  await expect(file("talk.mp4")).toBeFocused();
  await clickTimeline();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
    "BODY",
  );
});

test("the viewer and inspector keys show their panel and take the keyboard there", async ({
  page,
  request,
}) => {
  const { timeline, file, viewer, inspector, clickTimeline } = await open(
    page,
    request,
  );
  const shown = page
    .getByRole("group", { name: "Viewer" })
    .getByRole("button", { pressed: true });
  await clickTimeline();

  // Nothing is loaded yet, so the source key says so and focus stays put.
  await page.keyboard.press("Control+3");
  await expect(page.locator('.toast[role="status"] span')).toHaveText(
    "Open a file from Media to see its source.",
  );
  await expect(viewer).not.toBeFocused();

  await file("talk.mp4").dblclick();
  await expect(shown).toHaveText("Source");
  // The timeline key shows the timeline, as an edit made from the source does.
  await page.keyboard.press("Control+4");
  await expect(timeline).toBeFocused();
  await expect(shown).toHaveText("Timeline");
  await page.keyboard.press("Control+3");
  await expect(viewer).toBeFocused();
  await expect(shown).toHaveText("Source");
  await page.keyboard.press("Control+5");
  await expect(viewer).toBeFocused();
  await expect(shown).toHaveText("Timeline");
  // The line that marks the focused panel shows after mouse use too.
  expect(
    await viewer.evaluate(
      (panel) => getComputedStyle(panel, "::after").position,
    ),
  ).toBe("absolute");

  // A closed inspector opens for its key.
  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(inspector).toBeHidden();
  await page.keyboard.press("Control+9");
  await expect(inspector).toBeVisible();
  await expect(inspector).toBeFocused();
});

test("panel keys leave a text field with its text kept, and a dialog keeps the keyboard", async ({
  page,
  request,
}) => {
  const { timeline, file } = await open(page, request);
  const composer = page.getByRole("textbox", { name: "Message your agent" });
  await composer.click();
  await page.keyboard.type("tighten the intro 2");
  await page.keyboard.press("Control+4");
  await expect(timeline).toBeFocused();
  await expect(composer).toHaveValue("tighten the intro 2");
  // The keys go to the timeline now, not into the message.
  await page.keyboard.press("Shift+v");
  await expect(timeline.locator("[data-clip].selected")).toHaveCount(1);
  await expect(composer).toHaveValue("tighten the intro 2");

  await page.keyboard.press("Control+Alt+k");
  const search = page.getByRole("searchbox", { name: "Search shortcuts" });
  await expect(search).toBeFocused();
  await page.keyboard.press("Control+2");
  await expect(search).toBeFocused();
  await expect(file("music.wav")).not.toBeFocused();
  // The sheet lists the panel keys with the rest.
  await search.fill("focus media");
  await expect(
    page.getByRole("region", { name: "Panels" }).locator("kbd"),
  ).toHaveText("Ctrl+2");
});

test("after a click on a media file the arrows stay the playhead's", async ({
  page,
  request,
}) => {
  const { file, clock } = await open(page, request);
  await file("music.wav").click();
  await page.keyboard.press("ArrowDown");
  await expect(clock).toHaveText("00:00:02:00");
  await expect(file("talk.mp4")).not.toBeFocused();
  // Tab away and back is the keyboard's way in, and then they move through the list.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(file("music.wav")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(file("talk.mp4")).toBeFocused();
  await expect(clock).toHaveText("00:00:02:00");
});
