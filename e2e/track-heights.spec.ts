import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { audioGainToDb } from "@hyperframes/core/audio-gain";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { test, expect } from "./fixtures";

test("track height and density survive reload, keep gain travel fixed, and leave undo to edits", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Track heights" },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="12" data-fps="30"><div id="title" class="clip" data-start="0" data-duration="10" data-track-index="0">Title</div><div id="upper" class="clip" data-start="1" data-duration="8" data-track-index="2">Upper title</div><audio id="sound" src="missing.wav" data-start="0" data-duration="10" data-track-index="1"></audio></main></body></html>',
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const clip = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    ).timeline.clips.find((clip) => clip.id === "sound")!;
  await page.goto(`/#project/${project.id}`);
  const density = page.getByRole("combobox", { name: "Track density" });
  const height = page.getByRole("separator", { name: "Height V1" });
  await expect(height).toHaveAttribute("aria-valuenow", "56");
  const titleTop = (await page.locator('[data-clip="title"]').boundingBox())!.y;
  const upperTop = (await page.locator('[data-clip="upper"]').boundingBox())!.y;
  const box = (await height.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 66, { steps: 12 });
  await expect(height).toHaveAttribute("aria-valuenow", "120");
  expect((await page.locator('[data-clip="title"]').boundingBox())!.y).toBe(
    titleTop,
  );
  expect((await page.locator('[data-clip="upper"]').boundingBox())!.y).toBe(
    upperTop,
  );
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${api}/timeline-view`)).json()).heights,
    )
    .toEqual({ "0": 120 });
  await page.reload();
  await expect(height).toHaveAttribute("aria-valuenow", "120");
  await density.selectOption("compact");
  await expect(height).toHaveAttribute("aria-valuenow", "32");
  await expect(
    page.getByRole("separator", { name: "Height A1" }),
  ).toHaveAttribute("aria-valuenow", "32");
  await expect
    .poll(
      async () =>
        (await (await request.get(`${api}/timeline-view`)).json()).density,
    )
    .toBe("compact");
  await page.reload();
  await expect(density).toHaveValue("compact");
  const before = await clip();
  for (const [densityValue, shift, pixels, db] of [
    ["compact", false, 20, -5],
    ["tall", false, 20, -5],
    ["compact", true, 20, -1],
    ["tall", true, 20, -1],
  ] as const) {
    await density.selectOption(densityValue);
    await expect(page.locator(".tl-grid")).toHaveAttribute(
      "data-refit",
      "settled",
    );
    const point = await page
      .locator('[data-clip-mix="sound"] path')
      .first()
      .evaluate((path: SVGPathElement) => {
        const at = path
          .getPointAtLength(path.getTotalLength() / 2)
          .matrixTransform(path.getScreenCTM()!);
        return { x: at.x, y: at.y };
      });
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y + pixels, { steps: 10 });
    await expect(page.locator(".tl-readout")).toContainText(
      `${db.toFixed(2)} dB`,
    );
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
    await expect
      .poll(async () => audioGainToDb((await clip()).volume!))
      .toBeCloseTo(db, 5);
    await page.keyboard.press("Control+z");
    await expect.poll(clip).toEqual(before);
    await expect(density).toHaveValue(densityValue);
  }
  // View changes never consume an undo. The only person edits are the four gain drags.
  const history = await (await request.get(`${api}/history`)).json();
  expect(
    history.entries.filter(
      (entry: { who: { kind: string }; label: string }) =>
        entry.who.kind === "person" && entry.label.startsWith("Set gain to "),
    ),
  ).toHaveLength(4);
  for (const value of ["compact", "tall"] as const) {
    await density.selectOption(value);
    const handle = page.locator('[data-clip-mix="sound"] [data-mix="fadeIn"]');
    const bounds = (await handle.boundingBox())!;
    const ppf = await page
      .locator(".tl-grid")
      .evaluate((grid: HTMLElement) =>
        Number(grid.style.getPropertyValue("--ppf")),
      );
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width / 2 + ppf * 30,
      bounds.y + bounds.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect.poll(async () => (await clip()).fadeIn).toBe(30);
    await page.keyboard.press("Control+z");
    await expect.poll(clip).toEqual(before);
  }
  await density.selectOption("compact");
  await page.getByRole("separator", { name: "Height V2" }).focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("separator", { name: "Height V2" }),
  ).toHaveAttribute("aria-valuenow", "200");
  const title = (await page.locator('[data-clip="title"]').boundingBox())!;
  const upper = (await page.locator('.tl-head[data-row="2"]').boundingBox())!;
  await page.mouse.move(title.x + 50, title.y + 20);
  await page.mouse.down();
  await page.mouse.move(title.x + 50, upper.y + 80, { steps: 12 });
  expect(
    (await page.locator('[data-clip="title"]').boundingBox())!.height,
  ).toBe(198);
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        TimelineViewSchema.parse(
          await (await request.get(`${api}/timeline`)).json(),
        ).timeline.clips.find((clip) => clip.id === "title")!.track,
    )
    .toBe(2);
  await page.keyboard.press("Control+z");
  await expect.poll(clip).toEqual(before);
  await writeFile(join(project.path, ".cutroom/view.json"), "{broken");
  await page.reload();
  await expect(density).toHaveValue("normal");
  await expect(height).toHaveAttribute("aria-valuenow", "56");
});
