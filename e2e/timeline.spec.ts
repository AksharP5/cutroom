import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

test("Fit returns a scrolled timeline to frame zero with whole ruler labels", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Fit the whole timeline" },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      'data-duration="12"',
      'data-duration="120"',
    ),
  );
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  const slider = timeline.getByRole("slider", { name: "Zoom" });
  await expect(slider).toBeVisible();
  await page.getByRole("region", { name: "Viewer" }).click();
  for (let step = 0; step < 5; step++) await page.keyboard.press("Control+=");
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("013000");
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: "Viewer" }).click();
  const scroller = timeline.locator(".tl-scroll");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  const zoom = await slider.getAttribute("aria-valuenow");
  await page.keyboard.press("Shift+Z");
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollLeft))
    .toBe(0);
  await expect
    .poll(() =>
      timeline
        .locator(".tl-tick-label")
        .evaluateAll((labels) =>
          labels
            .filter((label) => Number(getComputedStyle(label).opacity) > 0)
            .every(
              (label) =>
                label.getBoundingClientRect().right <=
                document.documentElement.clientWidth,
            ),
        ),
    )
    .toBe(true);
  await page.keyboard.press("Shift+Z");
  await expect(slider).toHaveAttribute("aria-valuenow", zoom!);
  await slider.dblclick();
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollLeft))
    .toBe(0);
});

test("the new editor's timeline scrubs, selects clips, and zooms at the cursor", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Own timeline" },
      })
    ).json(),
  );
  const tracks = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline.tracks;
  await page.goto(`/#project/${project.id}`);

  const timeline = page.getByRole("region", { name: "Timeline" });
  const now = page.getByRole("button", { name: /^Current time/ });
  const clip = (id: string) => timeline.locator(`[data-clip="${id}"]`);
  const selected = timeline.locator("[data-clip].selected");
  // Each ruler label starts 4px right of its tick.
  const tick = async (timecode: string) => {
    const box = await timeline
      .getByText(timecode, { exact: true })
      .boundingBox();
    if (!box) throw new Error(`No ruler label ${timecode}.`);
    return { x: box.x - 4, y: box.y + 4 };
  };

  // The template's three elements, one per video track, named and stacked upward.
  await expect(timeline.locator("[data-clip]")).toHaveCount(3);
  await expect(
    timeline.getByText("Project title", { exact: true }),
  ).toBeVisible();
  await expect(timeline.getByText("V3", { exact: true })).toBeVisible();

  // A press on the ruler seeks to that frame, and a drag scrubs.
  const five = await tick("00:00:05:00");
  const eight = await tick("00:00:08:00");
  await page.mouse.move(five.x, five.y);
  await page.mouse.down();
  await expect(now).toHaveText("00:00:05:00");
  await page.mouse.move(eight.x, eight.y, { steps: 8 });
  await expect(now).toHaveText("00:00:08:00");
  await page.mouse.up();

  // Click selects one clip, Ctrl-click adds another, Esc clears.
  await clip("headline").click();
  await expect(selected).toHaveCount(1);
  await expect(clip("headline")).toHaveClass(/selected/);
  await clip("caption").click({ modifiers: ["Control"] });
  await expect(selected).toHaveCount(2);
  await clip("rule").click();
  await expect(selected).toHaveCount(1);
  await expect(clip("rule")).toHaveClass(/selected/);
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(0);

  // Auto-select is a timeline edit; Shift+V then skips that track.
  await timeline.getByRole("button", { name: "Auto-select V1" }).click();
  await expect
    .poll(async () => (await tracks()).map((track) => track.autoSelect))
    .toEqual([false, true, true]);
  await page.keyboard.press("Shift+V");
  await expect(selected).toHaveCount(2);
  await expect(clip("rule")).not.toHaveClass(/selected/);

  // A locked track's clips cannot be selected, and locking drops them from the selection.
  await timeline.getByRole("button", { name: "Lock V3" }).click();
  await expect
    .poll(async () => (await tracks()).map((track) => track.locked))
    .toEqual([false, false, true]);
  await expect(selected).toHaveCount(1);
  await clip("caption").click({ force: true });
  await expect(clip("caption")).not.toHaveClass(/selected/);

  // Two quick clicks on a slow connection flip the lock twice, back to where it started.
  let answered = 0;
  await page.route("**/api/cutroom/projects/*/commands", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const response = await route.fetch();
    await route.fulfill({ response });
    answered++;
  });
  const lock = timeline.getByRole("button", { name: "Lock V2" });
  await lock.click();
  await lock.click();
  await expect.poll(() => answered).toBe(2);
  expect((await tracks()).map((track) => track.locked)).toEqual([
    false,
    false,
    true,
  ]);
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await page.unroute("**/api/cutroom/projects/*/commands");

  // An empty A1 stands in until the timeline has audio. Locking it creates an audio track.
  await timeline.getByRole("button", { name: "Lock A1" }).click();
  await expect
    .poll(async () => (await tracks()).find((track) => track.index === 3))
    .toMatchObject({ kind: "audio", locked: true });
  await expect(timeline.getByText("V3", { exact: true })).toBeVisible();
  await expect(timeline.getByText("A1", { exact: true })).toBeVisible();

  // Ctrl+wheel zooms around the cursor: the frame under it stays put while the ruler spreads.
  const before = await tick("00:00:08:00");
  const apart = before.x - (await tick("00:00:07:00")).x;
  await page.mouse.move(before.x, before.y + 80);
  await page.keyboard.down("Control");
  for (let notch = 0; notch < 3; notch++) await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect
    .poll(
      async () => (await tick("00:00:08:00")).x - (await tick("00:00:07:00")).x,
    )
    .toBeGreaterThan(apart * 1.5);
  expect(Math.abs((await tick("00:00:08:00")).x - before.x)).toBeLessThan(2);

  // On the zoom slider, End and Home zoom and never reach the transport.
  const slider = timeline.getByRole("slider", { name: "Zoom" });
  await slider.focus();
  await page.keyboard.press("End");
  await expect(slider).toHaveAttribute("aria-valuenow", "100");
  await expect(now).toHaveText("00:00:08:00");

  // A timeline edit does not pull a scrolled view back to the playhead.
  const scroller = timeline.locator(".tl-scroll");
  await scroller.evaluate((element) => (element.scrollLeft = 0));
  await timeline.getByRole("button", { name: "Auto-select V2" }).click();
  await expect
    .poll(async () => (await tracks()).map((track) => track.autoSelect))
    .toEqual([false, false, true, true]);
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(0);

  await slider.focus();
  await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  await expect(now).toHaveText("00:00:08:00");

  // A zoom key eases visibly. The built CSS is minified, so this also checks `.2s` reads as 200ms.
  const eased = timeline
    .locator(".tl-scaled")
    .first()
    .evaluate(
      (layer) =>
        new Promise<number>((resolve) => {
          const deadline = performance.now() + 2000;
          const look = () => {
            const [animation] = layer.getAnimations();
            if (animation)
              return void animation.finished.then(() =>
                resolve(
                  Number(document.timeline.currentTime) -
                    Number(animation.startTime),
                ),
              );
            if (performance.now() > deadline) return resolve(0);
            requestAnimationFrame(look);
          };
          look();
        }),
    );
  await page.keyboard.press("Control+=");
  expect(await eased).toBeGreaterThan(100);

  // Playback started past the paging threshold still brings the playhead back into view.
  await page.keyboard.press("Control+=");
  await page.keyboard.press("Control+=");
  await scroller.evaluate((element) => (element.scrollLeft = 0));
  const edge = await scroller.boundingBox();
  if (!edge) throw new Error("The timeline has no box.");
  const ruler = await timeline.locator(".tl-ruler").boundingBox();
  if (!ruler) throw new Error("The ruler has no box.");
  await page.mouse.click(edge.x + edge.width - 30, ruler.y + 12);
  await page.keyboard.press("l");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await page.keyboard.press("k");
});

for (const seconds of [4, 12_000])
  test(`ripple and history keep clip coordinates and scroll bounds aligned (${seconds}s pieces)`, async ({
    page,
    request,
  }) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: "Ripple coordinates" },
        })
      ).json(),
    );
    await writeFile(
      join(project.path, "index.html"),
      `<main data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="${seconds * 3}">
        <div id="first" class="clip" data-start="0" data-duration="${seconds}" data-track-index="0">First</div>
        <div id="middle" class="clip" data-start="${seconds}" data-duration="${seconds}" data-track-index="0">Middle</div>
        <div id="last" class="clip" data-start="${seconds * 2}" data-duration="${seconds}" data-track-index="0">Last</div>
      </main>`,
    );
    await page.goto(`/#project/${project.id}`);
    const last = page.locator('[data-clip="last"]');
    const aligned = async (start: number) => {
      // The edit's slide holds clips by transforms until it ends.
      await expect(page.locator(".tl-lanes")).not.toHaveAttribute(
        "data-sliding",
      );
      await expect(page.locator(".tl-grid")).toHaveAttribute(
        "data-refit",
        "settled",
      );
      const geometry = await last.evaluate((element) => {
        const grid = element.closest(".tl-grid")!;
        const lanes = element.closest(".tl-lanes")!;
        const scroller = grid.parentElement!;
        return {
          ppf: Number(getComputedStyle(grid).getPropertyValue("--ppf")),
          left:
            element.getBoundingClientRect().left -
            lanes.getBoundingClientRect().left,
          width: element.getBoundingClientRect().width,
          overflow: scroller.scrollWidth - grid.getBoundingClientRect().width,
        };
      });
      expect(Math.abs(geometry.left - start * 30 * geometry.ppf)).toBeLessThan(
        1,
      );
      expect(
        Math.abs(geometry.width - (seconds * 30 * geometry.ppf - 1)),
      ).toBeLessThan(1);
      expect(Math.abs(geometry.overflow)).toBeLessThanOrEqual(1);
    };
    await aligned(seconds * 2);
    await page.locator('[data-clip="middle"]').click();
    await page.keyboard.press("Shift+X");
    await expect(page.locator('[data-clip="middle"]')).toHaveCount(0);
    await aligned(seconds);
    await page.keyboard.press("Control+z");
    await expect(page.locator('[data-clip="middle"]')).toHaveCount(1);
    await aligned(seconds * 2);
    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator('[data-clip="middle"]')).toHaveCount(0);
    await aligned(seconds);
  });

test("edits, history and agent changes keep the timeline's zoom, and only Fit rescales it", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Edits keep zoom" },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="12">
    <div id="first" class="clip" data-start="0" data-duration="4" data-track-index="0">First</div>
    <div id="middle" class="clip" data-start="4" data-duration="4" data-track-index="0">Middle</div>
    <div id="last" class="clip" data-start="8" data-duration="4" data-track-index="0">Last</div>
  </main>`,
  );
  // A music bed seven times as long as the cut.
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=90",
    join(project.path, "music.wav"),
  ]);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`/#project/${project.id}`);
  const grid = page.locator(".tl-grid");
  const slider = page.getByRole("slider", { name: "Zoom", exact: true });
  const first = page.locator('[data-clip="first"]');
  /** The scale once any slide and zoom has finished. */
  const scale = async () => {
    await expect(page.locator(".tl-lanes")).not.toHaveAttribute("data-sliding");
    await expect(grid).toHaveAttribute("data-refit", "settled");
    return grid.evaluate((element) =>
      Number(getComputedStyle(element).getPropertyValue("--ppf")),
    );
  };
  const length = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline.duration;

  // Opening fits the whole twelve seconds.
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  const opened = await scale();
  const width = (await first.boundingBox())!.width;

  // The long clip lands and the ruler stays: the cut's clips keep their size.
  const row = page.locator('.media-row[data-path="music.wav"]');
  await expect(row).toHaveAttribute("draggable", "true");
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Overwrite at playhead", exact: true })
    .click();
  await expect.poll(length).toBe(2700);
  expect(await scale()).toBe(opened);
  expect((await first.boundingBox())!.width).toBe(width);
  await expect(slider).not.toHaveAttribute("aria-valuenow", "0");

  // Fit is asked for, and the same key returns to the zoom it left.
  await page.keyboard.press("Shift+Z");
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  const fitted = await scale();
  expect(fitted).toBeLessThan(opened / 5);
  await page.keyboard.press("Shift+Z");
  expect(await scale()).toBe(opened);

  // Undo and redo change the length and leave the scale, fitted or not.
  await page.keyboard.press("Shift+Z");
  expect(await scale()).toBe(fitted);
  await page.keyboard.press("Control+z");
  await expect.poll(length).toBe(360);
  expect(await scale()).toBe(fitted);
  // The view is now wider than Fit. Zooming out has nowhere to go; zooming in works.
  await page.keyboard.press("Control+-");
  expect(await scale()).toBe(fitted);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(length).toBe(2700);
  expect(await scale()).toBe(fitted);
  await page.keyboard.press("Control+z");
  await expect.poll(length).toBe(360);
  await page.keyboard.press("Shift+Z");
  expect(await scale()).toBe(opened);

  // A ripple delete closes its gap at the same scale, and so does its undo.
  await page.locator('[data-clip="middle"]').click();
  await page.keyboard.press("Shift+X");
  await expect.poll(length).toBe(240);
  expect(await scale()).toBe(opened);
  await page.keyboard.press("Control+z");
  await expect.poll(length).toBe(360);
  expect(await scale()).toBe(opened);

  // A paste past the end lengthens the timeline.
  await page.locator('[data-clip="last"]').click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Control+v");
  await expect.poll(length).toBeGreaterThan(360);
  expect(await scale()).toBe(opened);

  // An edit made outside the editor, as an agent's is, through the same commands.
  const view = TimelineViewSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/timeline`)
    ).json(),
  );
  const before = view.timeline.duration;
  const position = await slider.getAttribute("aria-valuenow");
  expect(
    (
      await request.post(`/api/cutroom/projects/${project.id}/commands`, {
        data: {
          expectedRevision: view.revision,
          commands: [{ type: "move", clipIds: ["first"], by: before + 600 }],
        },
      })
    ).ok(),
  ).toBe(true);
  await expect.poll(length).toBeGreaterThan(before);
  // The slider moves when the editor has the longer timeline: Fit is further away.
  await expect(slider).not.toHaveAttribute("aria-valuenow", position!);
  expect(await scale()).toBe(opened);

  // A fitted view stays fitted when only its width changes.
  await page.keyboard.press("Shift+Z");
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
  const wide = await scale();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(scale).toBeLessThan(wide);
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
});
