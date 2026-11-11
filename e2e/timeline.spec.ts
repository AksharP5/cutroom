import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

test("Fit lets a ripple close its gap before rescaling, and a zoom key takes over", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Fit ripple motion" },
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
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`/#project/${project.id}`);
  const grid = page.locator(".tl-grid");
  const scale = () =>
    grid.evaluate((element) =>
      Number(getComputedStyle(element).getPropertyValue("--ppf")),
    );
  const old = await scale();
  const last = page.locator('[data-clip="last"]');
  await page.locator('[data-clip="middle"]').click();
  const slide = last.evaluate(
    (element) =>
      new Promise<{ scale: number; distance: number; duration: number }>(
        (resolve, reject) => {
          const deadline = performance.now() + 3000;
          const read = () => {
            const animation = element
              .getAnimations()
              .find((animation) => animation.playState === "running");
            if (animation) {
              const grid = element.closest(".tl-grid")!;
              return resolve({
                scale: Number(getComputedStyle(grid).getPropertyValue("--ppf")),
                distance: new DOMMatrixReadOnly(
                  getComputedStyle(element).transform,
                ).e,
                duration: Number(animation.effect?.getTiming().duration),
              });
            }
            if (performance.now() > deadline)
              return reject(new Error("The gap never slid closed."));
            requestAnimationFrame(read);
          };
          read();
        },
      ),
  );
  await page.keyboard.press("Delete");
  const moving = await slide;
  expect(moving.scale).toBe(old);
  expect(moving.distance).toBeGreaterThan(120 * old * 0.5);
  expect(moving.duration).toBeGreaterThan(100);
  await expect.poll(scale).toBeGreaterThan(old * 1.4);
  await expect(
    page.getByRole("slider", { name: "Zoom", exact: true }),
  ).toHaveAttribute("aria-valuenow", "0");
  await expect
    .poll(() =>
      last.evaluate(
        (element) =>
          element
            .getAnimations()
            .filter((animation) => animation.playState === "running").length,
      ),
    )
    .toBe(0);

  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-clip="middle"]')).toHaveCount(1);
  await expect.poll(scale).toBeCloseTo(old);
  await page.waitForTimeout(250);
  await page.locator('[data-clip="middle"]').click();
  await page.keyboard.press("Delete");
  await expect(page.locator('[data-clip="middle"]')).toHaveCount(0);
  await page.keyboard.press("Control+=");
  await page.keyboard.press("Control+=");
  const chosen = await scale();
  await page.waitForTimeout(500);
  expect(await scale()).toBe(chosen);
  await expect(
    page.getByRole("slider", { name: "Zoom", exact: true }),
  ).not.toHaveAttribute("aria-valuenow", "0");
});

test("scrolling while Fit waits to rescale after a ripple keeps the view where you scrolled", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Fit ripple scroll" },
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
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`/#project/${project.id}`);
  const grid = page.locator(".tl-grid");
  const scroller = page.locator(".tl-scroll");
  const scale = () =>
    grid.evaluate((element) =>
      Number(getComputedStyle(element).getPropertyValue("--ppf")),
    );
  const old = await scale();
  await page.locator('[data-clip="middle"]').click();
  await page.keyboard.press("Delete");
  // During the slide, before Fit would rescale, the user scrolls the timeline.
  const scrolled = await scroller.evaluate((element) => {
    element.scrollLeft = 120;
    return element.scrollLeft;
  });
  expect(scrolled).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(
    scrolled,
  );
  expect(await scale()).toBe(old);
});
