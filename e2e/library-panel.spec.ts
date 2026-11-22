import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { LIBRARY_SIZE, seedLibrary } from "./library-fixture";

test.beforeAll(seedLibrary);

async function openProject(
  page: Page,
  request: APIRequestContext,
  name: string,
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name, width: 640, height: 360, duration: 4 },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".tl-lanes")).toBeVisible();
  const timeline = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  return { project, timeline };
}

const libraryRows = (page: Page) =>
  page.getByRole("list", { name: "Library" }).locator(".media-row");

test("the Library tab browses, filters and adds items as clips, and Undo takes them back", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const libraryRequests: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().includes("/api/cutroom/library"))
      libraryRequests.push(sent.url());
  });
  const { project, timeline } = await openProject(
    page,
    request,
    "Library panel",
  );
  // Nothing is read for the Library until its tab is opened.
  await page.waitForTimeout(500);
  expect(libraryRequests).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("before.png") });

  await page.keyboard.press("Control+6");
  const rows = libraryRows(page);
  await expect(rows).toHaveCount(LIBRARY_SIZE);
  await expect(
    page.getByRole("button", { name: "Library", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // Ctrl+6 lands on the list's current row.
  await expect(rows.first()).toBeFocused();
  await expect(rows.first()).toHaveAttribute("title", "Lower Third, Fixture");
  await expect(rows.first().locator(".media-duration")).toContainText("02:00");
  // A component has no length of its own.
  await expect(rows.nth(1).locator(".media-duration")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("browse.png") });

  const search = page.getByRole("searchbox", { name: "Search library" });
  await search.fill("lower third");
  await expect(rows).toHaveCount(1);
  await search.press("ArrowDown");
  await expect(rows.first()).toBeFocused();
  await search.fill("nothing like this");
  await expect(
    page.getByRole("status").filter({ hasText: "No matches" }),
  ).toBeVisible();
  await search.press("Escape");
  await expect(rows).toHaveCount(LIBRARY_SIZE);

  await page.getByRole("combobox", { name: "Category" }).click();
  await page.getByRole("option", { name: "Lower thirds" }).click();
  await expect(rows).toHaveCount(1);

  // Overwrite at playhead from the row's menu: one clip on the video destination.
  await rows.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Overwrite at playhead" }).click();
  await expect
    .poll(
      async () =>
        (await timeline()).timeline.clips.filter((clip) =>
          clip.src?.endsWith("lt-fixture.html"),
        ).length,
    )
    .toBe(1);
  const placed = (await timeline()).timeline.clips.find((clip) =>
    clip.src?.endsWith("lt-fixture.html"),
  )!;
  expect(placed).toMatchObject({ start: 0, duration: 60, kind: "composition" });
  const clip = page.locator(`.tl-lanes [data-clip="${placed.id}"]`);
  await expect(clip).toBeVisible();
  await expect(clip).not.toHaveClass(/\boffline\b/);
  // The row now carries Media's rail, and In this project lists it.
  await expect(rows.first()).toHaveAttribute("data-used", "true");
  await page.getByRole("combobox", { name: "Category" }).click();
  await page.getByRole("option", { name: "In this project" }).click();
  await expect(rows).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("added.png") });

  // A drag from the row lands where the drop preview showed it.
  await page.getByRole("combobox", { name: "Category" }).click();
  await page.getByRole("option", { name: "Text effects" }).click();
  const word = rows.filter({ hasText: "Fixture Word" });
  const lanes = page.locator(".tl-lanes");
  const box = (await lanes.boundingBox())!;
  await word.dragTo(lanes, {
    targetPosition: { x: Math.round(box.width * 0.6), y: 20 },
  });
  await expect
    .poll(async () =>
      (await timeline()).timeline.clips.some((clip) =>
        clip.src?.endsWith("fx-fixture.html"),
      ),
    )
    .toBe(true);
  const dropped = (await timeline()).timeline.clips.find((clip) =>
    clip.src?.endsWith("fx-fixture.html"),
  )!;
  expect(dropped.start).toBeGreaterThan(0);
  expect(dropped.duration).toBe(90);

  // Undo takes the drop back with its files, and the rail follows.
  await lanes.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () =>
      (await timeline()).timeline.clips.some((clip) =>
        clip.src?.endsWith("fx-fixture.html"),
      ),
    )
    .toBe(false);
  await expect(word).not.toHaveAttribute("data-used");
  expect(
    (
      await request.get(
        `/api/cutroom/projects/${project.id}/source?path=compositions/fx-fixture.html`,
      )
    ).status(),
  ).toBe(404);
  expect(errors).toEqual([]);
});

test("the Library shows its offline and unreachable states", async ({
  page,
  request,
}, testInfo) => {
  const saved = await (await request.get("/api/cutroom/library")).json();
  let answer: "unreachable" | "offline" = "unreachable";
  await page.route("**/api/cutroom/library", (route) =>
    answer === "unreachable"
      ? route.fulfill({
          status: 502,
          json: { error: "Can't reach the HyperFrames library." },
        })
      : route.fulfill({
          json: {
            ...saved,
            offline: true,
            savedAt: "2026-11-18T10:00:00.000Z",
            items: saved.items.map((item: { name: string }) => ({
              ...item,
              cached: item.name === "lt-fixture",
            })),
          },
        }),
  );
  await openProject(page, request, "Library offline");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(
    page.getByText("Can't reach the HyperFrames library."),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("unreachable.png") });

  answer = "offline";
  await page.getByRole("button", { name: "Try again" }).click();
  const rows = libraryRows(page);
  await expect(rows).toHaveCount(LIBRARY_SIZE);
  const status = page.locator(".panel-header .library-status");
  await expect(status).toHaveText("Offline");
  await expect(status).toHaveAttribute(
    "title",
    "Showing the list saved on 18 Nov. Items you haven't opened yet can't be added.",
  );
  // Only the item whose files are saved can be added.
  await expect(rows.first()).not.toHaveAttribute("aria-disabled");
  await expect(rows.nth(1)).toHaveAttribute("aria-disabled", "true");
  await page.screenshot({ path: testInfo.outputPath("offline.png") });
});

test("@performance the Library opens within 100 ms, loads posters for rows in view, and costs nothing closed", async ({
  page,
  request,
}, testInfo) => {
  await openProject(page, request, "Library performance");
  // Warm the list once, as a later open in the same session would find it.
  const posters: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().includes("/library/posters/")) posters.push(sent.url());
  });
  const opened = await page.evaluate(async () => {
    const tab = [
      ...document.querySelectorAll<HTMLButtonElement>(".panel-view"),
    ].find((button) => button.textContent === "Library")!;
    const start = performance.now();
    tab.click();
    for (;;) {
      await new Promise(requestAnimationFrame);
      if (document.querySelectorAll('[aria-label="Library"] .media-row').length)
        return performance.now() - start;
    }
  });
  const rows = libraryRows(page);
  await expect(rows).toHaveCount(LIBRARY_SIZE);
  await page.waitForTimeout(500);
  const visible = await rows.evaluateAll((items) => {
    const list = items[0]!.closest("ul")!.getBoundingClientRect();
    return items.filter((item) => {
      const box = item.getBoundingClientRect();
      return box.bottom > list.top && box.top < list.bottom;
    }).length;
  });
  const firstPosters = posters.length;

  // Scrolling the whole list keeps frames under budget.
  const frames = await page.evaluate(async () => {
    const list = document.querySelector<HTMLElement>('[aria-label="Library"]')!;
    const times: number[] = [];
    let last = performance.now();
    while (list.scrollTop + list.clientHeight < list.scrollHeight) {
      list.scrollTop += 60;
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      times.push(now - last);
      last = now;
    }
    times.sort((a, b) => a - b);
    return {
      count: times.length,
      p95: times[Math.floor(times.length * 0.95)]!,
      max: times.at(-1)!,
    };
  });

  // Search filters 448 items within a frame.
  const keystroke = await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search library"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    const start = performance.now();
    setter.call(input, "synthetic 4");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(requestAnimationFrame);
    return performance.now() - start;
  });

  // Closed, the tab makes no requests and keeps no timers running.
  await page.getByRole("button", { name: "Media", exact: true }).click();
  const before = posters.length;
  const quiet: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().includes("/library")) quiet.push(sent.url());
  });
  await page.waitForTimeout(2_000);

  const measured = {
    openToFirstPaintMs: Math.round(opened),
    rowsInView: visible,
    postersAfterOpen: firstPosters,
    postersAfterScroll: before,
    scroll: frames,
    keystrokeMs: Math.round(keystroke * 10) / 10,
    requestsWhileClosed: quiet.length,
  };
  await testInfo.attach("library performance", {
    body: JSON.stringify(measured, null, 2),
    contentType: "application/json",
  });
  console.log(JSON.stringify(measured));
  expect(opened).toBeLessThan(100);
  expect(firstPosters).toBeLessThanOrEqual(visible + 2);
  expect(frames.p95).toBeLessThan(34);
  expect(keystroke).toBeLessThan(16);
  expect(quiet).toEqual([]);
});
