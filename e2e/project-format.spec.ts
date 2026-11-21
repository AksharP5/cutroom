import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { startMediaDrag } from "./media-drag";
import { waitForPreview } from "./preview-ready";

const run = promisify(execFile);
const width = 640;
const height = 360;
const choose = async (page: Page, label: string, option: string | RegExp) => {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};

test("New project remembers its format and the Inspector previews, applies and undoes a format change", async ({
  page,
  request,
}, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const newProject = page.getByRole("dialog", { name: "New project" });
  await newProject.getByLabel("Project name").fill("Vertical cut");
  await choose(page, "Size", /^Vertical/);
  await choose(page, "Frame rate", "59.94 fps");
  await newProject.screenshot({ path: info.outputPath("new-project.png") });
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/cutroom/projects"),
  );
  await newProject.getByRole("button", { name: "Create project" }).click();
  const project = ProjectSchema.parse(await (await created).json());
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  await expect(page).toHaveURL(new RegExp(`#project/${project.id}`));
  expect((await read()).timeline.fps).toEqual({ num: 60000, den: 1001 });
  expect((await read()).size).toEqual({ width: 1080, height: 1920 });
  const moved = await request.post(
    `/api/cutroom/projects/${project.id}/commands`,
    {
      data: {
        expectedRevision: (await read()).revision,
        commands: [
          { type: "move", mode: "overwrite", clipIds: ["headline"], by: 1 },
        ],
      },
    },
  );
  expect(moved.ok(), await moved.text()).toBe(true);
  await page.reload();

  await page.getByRole("button", { name: "Edit project format" }).click();
  const format = page.getByRole("dialog", { name: "Project format" });
  await choose(page, "Size", "Custom");
  await format.getByLabel("Width").fill("768");
  await format.getByLabel("Height").fill("512");
  await choose(page, "Frame rate", "24 fps");
  await expect(format.getByRole("status")).toContainText("edges move");
  await format.screenshot({ path: info.outputPath("change-format.png") });
  await format.getByRole("button", { name: "Apply format" }).click();
  await expect(format).toBeHidden();
  expect((await read()).size).toEqual({ width: 768, height: 512 });
  expect((await read()).timeline.fps).toEqual({ num: 24, den: 1 });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(async () => (await read()).timeline.fps)
    .toEqual({ num: 60000, den: 1001 });
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect
    .poll(async () => (await read()).timeline.fps)
    .toEqual({ num: 24, den: 1 });

  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(
    newProject.getByRole("combobox", { name: "Size", exact: true }),
  ).toContainText("Vertical");
  await expect(
    newProject.getByRole("combobox", { name: "Frame rate" }),
  ).toContainText("59.94 fps");
});

/** Six binary blocks encode every picture number from 0 through 59. */
async function shownFrame(page: Page) {
  const png = (await page.locator(".edit-picture").screenshot()).toString(
    "base64",
  );
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext(
      "2d",
    )!;
    context.drawImage(bitmap, 0, 0);
    let label = 0;
    for (let bit = 0; bit < 6; bit++) {
      const x = Math.floor(((bit + 0.5) * bitmap.width) / 6);
      const red = context.getImageData(x, Math.floor(bitmap.height / 20), 1, 1)
        .data[0]!;
      if (red > 128) label |= 1 << bit;
    }
    return label;
  }, png);
}

test("the first drop offers a format match, then the viewer and export show all 60 source pictures", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Numbered 60 fps", width: 960, height: 540 },
      })
    ).json(),
  );
  const source = join(project.path, "numbered.webm");
  const bits = Array.from(
    { length: 6 },
    (_, bit) =>
      `drawbox=x=${Math.floor((bit * width) / 6)}:y=0:w=${Math.ceil(width / 6)}:h=36:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit}),2),1)'`,
  );
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=s=${width}x${height}:r=60:d=1`,
    "-vf",
    `drawbox=x=0:y=0:w=${width}:h=36:color=black:t=fill,${bits.join(",")}`,
    "-c:v",
    "libvpx-vp9",
    "-threads",
    "2",
    "-deadline",
    "realtime",
    source,
  ]);
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><body style="margin:0;background:#111"><main id="main" data-composition-id="main" data-width="960" data-height="540" data-duration="1" style="position:relative;width:100%;height:100%"></main></body></html>',
  );
  await page.goto(`/#project/${project.id}`);
  await startMediaDrag(
    page,
    page.getByRole("listitem", { name: "numbered.webm" }),
  );
  const lane = (await page.locator(".tl-lane.video").first().boundingBox())!;
  await page.mouse.move(lane.x + 2, lane.y + lane.height / 2, { steps: 8 });
  await page.mouse.up();

  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  const match = page.getByRole("button", { name: "Match", exact: true });
  await expect(match).toBeVisible();
  await expect(page.locator(".toast")).toContainText("640 × 360 · 60 fps");
  expect((await read()).timeline.fps.num).toBe(30);
  await waitForPreview(page);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => shownFrame(page)).toBe(2);
  await page
    .locator(".edit-picture")
    .screenshot({ path: info.outputPath("frame-01-before.png") });
  await match.click();
  await expect.poll(async () => (await read()).timeline.fps.num).toBe(60);
  expect((await read()).size).toEqual({ width, height });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await read()).timeline.fps.num).toBe(30);
  expect((await read()).timeline.clips).toHaveLength(1);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(async () => (await read()).timeline.fps.num).toBe(60);
  await waitForPreview(page);
  await expect(page.locator(".inspector-facts")).toContainText("60 fps");

  await page.keyboard.press("Home");
  for (let frame = 0; frame < 60; frame++) {
    await expect.poll(() => shownFrame(page)).toBe(frame);
    if (frame === 1)
      await page
        .locator(".edit-picture")
        .screenshot({ path: info.outputPath("frame-01.png") });
    if (frame < 59) await page.keyboard.press("ArrowRight");
  }

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  await expect(dialog).toContainText("640 × 360 · 60 fps");
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  await dialog.getByRole("button", { name: "Export MP4" }).click();
  const { outputPath } = z
    .object({ outputPath: z.string() })
    .parse(await (await started).json());
  await expect(dialog).toContainText("Export complete.", { timeout: 45_000 });
  const { stdout: rate } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=avg_frame_rate",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    outputPath,
  ]);
  expect(rate.trim()).toBe("60/1");
  const { stdout: labels } = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      outputPath,
      "-vf",
      "crop=640:36:0:0,format=gray",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 2_000_000 },
  );
  expect(labels.length).toBe(60 * width * 36);
  for (let frame = 0; frame < 60; frame++) {
    let label = 0;
    for (let bit = 0; bit < 6; bit++) {
      const x = Math.floor(((bit + 0.5) * width) / 6);
      if (labels[frame * width * 36 + 18 * width + x]! > 128) label |= 1 << bit;
    }
    expect(label).toBe(frame);
  }
});

test("the first drop offers a supported rate near variable-rate footage's average", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Variable-rate recording" },
      })
    ).json(),
  );
  const source = join(project.path, "variable.mp4");
  // Drop one of 360 pictures and keep the timestamps of the rest.
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:r=60:d=6",
    "-vf",
    "select='not(eq(n,120))'",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-threads",
    "1",
    "-video_track_timescale",
    "60000",
    source,
  ]);
  await writeFile(
    join(project.path, "index.html"),
    '<main id="main" data-composition-id="main" data-width="1920" data-height="1080"></main>',
  );
  await page.goto(`/#project/${project.id}`);
  await startMediaDrag(
    page,
    page.getByRole("listitem", { name: "variable.mp4" }),
  );
  const lane = (await page.locator(".tl-lane.video").first().boundingBox())!;
  await page.mouse.move(lane.x + 2, lane.y + lane.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".toast")).toContainText("320 × 240 · 59.94 fps");
  await page.getByRole("button", { name: "Match", exact: true }).click();
  await expect
    .poll(
      async () =>
        TimelineViewSchema.parse(
          await (
            await request.get(`/api/cutroom/projects/${project.id}/timeline`)
          ).json(),
        ).timeline.fps,
    )
    .toEqual({ num: 60000, den: 1001 });
});
