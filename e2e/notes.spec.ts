import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { AnnotationSchema, ProjectSchema } from "../src/shared/project";
import { ReviewItemSchema } from "../src/shared/review";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

async function openProject(
  page: Page,
  request: APIRequestContext,
  name: string,
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", { data: { name } })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(
    page
      .frameLocator("iframe[title='Composition preview']")
      .locator("#headline"),
  ).toHaveText(name);
  const base = `/api/cutroom/projects/${project.id}`;
  const picture = page.locator(".edit-picture");
  return {
    id: project.id,
    path: project.path,
    base,
    picture,
    /** A point on the picture, in its 0 to 1 coordinates. */
    async at(x: number, y: number) {
      const box = await picture.boundingBox();
      if (!box) throw new Error("The picture has no box.");
      return { x: box.x + box.width * x, y: box.y + box.height * y };
    },
    notes: async () =>
      z
        .object({ items: z.array(ReviewItemSchema) })
        .parse(await (await request.get(`${base}/review`)).json()).items,
    range: async () =>
      TimelineViewSchema.parse(
        await (await request.get(`${base}/timeline`)).json(),
      ).timeline.range,
  };
}

/** Where a pin's marked corner is on the picture, from 0 to 1. */
async function pinPoint(page: Page, name: string) {
  const pin = await page
    .getByRole("button", { name, exact: true })
    .boundingBox();
  const picture = await page.locator(".edit-picture").boundingBox();
  if (!pin || !picture) throw new Error("The pin or picture has no box.");
  return {
    x: (pin.x - picture.x) / picture.width,
    y: (pin.y + pin.height - picture.y) / picture.height,
  };
}

test("a five-note pass keeps its pins and strokes when the same tool row edits the timeline", async ({
  page,
  request,
}, testInfo) => {
  const project = await openProject(page, request, "Notes and drag edits");
  const bodies = [
    "Lift this title",
    "Keep the first mark",
    "Hold this beat",
    "Keep both strokes",
    "End on this frame",
  ];
  for (const [index, body] of bodies.entries()) {
    const draw = index === 1 || index === 3;
    await page
      .getByRole("button", { name: draw ? /^Draw/ : /^Comment/ })
      .click();
    const x = 0.15 + (index % 3) * 0.25;
    const y = index < 3 ? 0.3 : 0.7;
    const start = await project.at(x, y);
    if (draw) {
      for (const offset of [0, 0.05]) {
        const from = await project.at(x, y + offset);
        const to = await project.at(x + 0.08, y + offset);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await page.mouse.up();
      }
    } else await page.mouse.click(start.x, start.y);
    const field = page.getByLabel("What should change?");
    await field.fill(body);
    await field.press("Enter");
  }
  await expect
    .poll(async () => (await project.notes()).map((note) => note.body))
    .toEqual(bodies);
  const saved = await project.notes();
  expect(saved.map((note) => note.strokes.length)).toEqual([0, 2, 0, 2, 0]);
  expect(saved.every((note) => note.framePath)).toBe(true);
  await expect(page.locator(".edit-note-pin")).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath("five-note-pass.png") });

  await page.getByRole("button", { name: /^Select/ }).click();
  const rule = page.locator('[data-clip="rule"]');
  const box = await rule.boundingBox();
  if (!box) throw new Error("The rule has no timeline box.");
  const ppf = await page
    .locator(".tl-grid")
    .evaluate((grid) => Number(grid.style.getPropertyValue("--ppf")));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 30 * ppf,
    box.y + box.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect
    .poll(() => rule.evaluate((clip) => clip.style.getPropertyValue("--s")))
    .toBe("30");
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => rule.evaluate((clip) => clip.style.getPropertyValue("--s")))
    .toBe("0");
  expect(await project.notes()).toEqual(saved);
  await expect(page.locator(".edit-note-pin")).toHaveCount(5);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator(".review-row")).toHaveCount(5);
});

test("a comment pins where you click, takes every key while you type, and stays put through a resize", async ({
  page,
  request,
}) => {
  const project = await openProject(page, request, "Pinned comment");
  const now = page.getByRole("button", { name: /^Current time/ });
  const stop = page.getByRole("button", { name: "Stop" });
  const note = page.getByLabel("What should change?");

  await page.keyboard.press("n");
  const spot = await project.at(0.6, 0.3);
  await page.mouse.click(spot.x, spot.y);
  await expect(note).toBeFocused();
  // Transport, marking, tool and editing keys all land in the note.
  await page.keyboard.type("Lift it, keep a beat. Ok? Jump");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("x i o");
  await expect(note).toHaveValue("Lift it, keep a beat. Ok? Jump\nx i o");
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(now).toHaveText("00:00:00:00");
  expect(await project.range()).toEqual({ in: null, out: null });
  await expect(page.getByRole("button", { name: /^Comment/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.keyboard.press("Enter");
  await expect(note).toBeHidden();
  const pin = page.getByRole("button", { name: "Note 1", exact: true });
  await expect(pin).toBeVisible();
  const [saved] = await project.notes();
  expect(saved).toMatchObject({
    kind: "comment",
    body: "Lift it, keep a beat. Ok? Jump\nx i o",
    strokes: [],
  });
  expect(saved?.point?.x).toBeCloseTo(0.6, 2);
  expect(saved?.point?.y).toBeCloseTo(0.3, 2);

  // The pin is held in picture coordinates, so it marks the same place at any size.
  const wide = await pinPoint(page, "Note 1");
  expect(wide.x).toBeCloseTo(0.6, 2);
  expect(wide.y).toBeCloseTo(0.3, 2);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect
    .poll(
      async () => (await page.locator(".edit-picture").boundingBox())?.width,
    )
    .toBeLessThan(900);
  const narrow = await pinPoint(page, "Note 1");
  expect(narrow.x).toBeCloseTo(0.6, 2);
  expect(narrow.y).toBeCloseTo(0.3, 2);

  // Esc discards an open note and the tool stays armed for the next one.
  const next = await project.at(0.2, 0.7);
  await page.mouse.click(next.x, next.y);
  await page.keyboard.type("never mind");
  await page.keyboard.press("Escape");
  await expect(note).toBeHidden();
  expect(await project.notes()).toHaveLength(1);
  await page.mouse.click(next.x, next.y);
  await expect(note).toHaveValue("");

  // A pin opens its note in Review.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await pin.click();
  await expect(page.locator(`#review-note-${saved?.id}`)).toBeVisible();
});

test("a drawing holds several strokes, Ctrl+Z takes back the last, and saved notes show only at their time", async ({
  page,
  request,
}) => {
  const project = await openProject(page, request, "Drawn notes");
  const pencil = page.locator(".edit-note-pencil path[d]:not([data-live])");
  const stroke = async (points: [number, number][]) => {
    const [first, ...rest] = points;
    if (!first) return;
    const start = await project.at(...first);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const point of rest) {
      const to = await project.at(...point);
      await page.mouse.move(to.x, to.y, { steps: 4 });
    }
    await page.mouse.up();
  };

  // An edit in the project's history that undo must leave alone.
  await page.keyboard.press("i");
  await expect.poll(project.range).toEqual({ in: 0, out: null });
  await page.keyboard.press("Shift+n");
  await stroke([
    [0.1, 0.5],
    [0.2, 0.4],
    [0.3, 0.5],
  ]);
  await stroke([
    [0.1, 0.8],
    [0.3, 0.8],
  ]);
  await stroke([
    [0.15, 0.2],
    [0.25, 0.2],
  ]);
  // Every stroke stays on the picture while the note is open.
  await expect(pencil).toHaveCount(3);
  await expect(page.getByLabel("What should change?")).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect(pencil).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect(pencil).toHaveCount(1);
  // Undo while the note is open takes strokes, never the project's last edit.
  expect(await project.range()).toEqual({ in: 0, out: null });
  await stroke([
    [0.1, 0.8],
    [0.3, 0.8],
  ]);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Note 1", exact: true }),
  ).toBeVisible();
  const [drawing] = await project.notes();
  expect(drawing).toMatchObject({ kind: "drawing", body: "" });
  expect(drawing?.strokes).toHaveLength(2);
  expect(drawing?.framePath).toBeTruthy();
  await expect(pencil).toHaveCount(2);

  // A comment a second later through a third, made while another tool is chosen.
  await page.getByRole("button", { name: /^Select/ }).click();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("n");
  const spot = await project.at(0.7, 0.4);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.type("Hold this longer");
  await page.getByRole("button", { name: /^Select/ }).click();
  const ppf = await page
    .locator(".tl-grid")
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).getPropertyValue("--ppf")),
    );
  await page.locator(".tl-ruler").click({ position: { x: 90 * ppf, y: 15 } });
  await page.getByRole("button", { name: "Set end" }).click();
  expect(
    await page.locator(".edit-note-popover").evaluate((element) => {
      const form = element.getBoundingClientRect();
      return [...element.querySelectorAll("button")].every((button) => {
        const bounds = button.getBoundingClientRect();
        return (
          bounds.left >= form.left &&
          bounds.right <= form.right &&
          bounds.top >= form.top &&
          bounds.bottom <= form.bottom
        );
      });
    }),
  ).toBe(true);
  await page.getByLabel("What should change?").press("Enter");
  await expect(
    page.getByRole("button", { name: "Note 2", exact: true }),
  ).toBeVisible();
  const [, ranged] = await project.notes();
  expect(ranged?.time).toBe(1);
  expect(ranged?.endTime).toBe(3);
  // The timeline names each pin by the same number.
  await expect(
    page.getByRole("button", { name: /^Review note 2 at 00:00:01:00/ }),
  ).toBeVisible();

  const shownAt = async (
    frame: "00:00:00:00" | "00:00:02:00" | "00:00:03:01",
  ) => {
    const now = page.getByRole("button", { name: /^Current time/ });
    await now.click();
    await page.keyboard.type(frame.replaceAll(":", ""));
    await page.keyboard.press("Enter");
    await expect(now).toHaveText(frame);
    return Promise.all(
      ["Note 1", "Note 2"].map((name) =>
        page.getByRole("button", { name, exact: true }).isVisible(),
      ),
    );
  };
  await expect.poll(() => shownAt("00:00:02:00")).toEqual([false, true]);
  await expect.poll(() => shownAt("00:00:03:01")).toEqual([false, false]);
  await expect.poll(() => shownAt("00:00:00:00")).toEqual([true, false]);
});

test("ruler scrubbing returns focus to an open note and exit io never edits the timeline", async ({
  page,
  request,
}) => {
  const project = await openProject(page, request, "Ruler focus");
  const before = await (await request.get(`${project.base}/timeline`)).json();
  await page.keyboard.press("n");
  const at = await project.at(0.3, 0.4);
  await page.mouse.click(at.x, at.y);
  const field = page.getByLabel("What should change?");
  await field.fill("Keep ");
  await page.locator(".tl-ruler").click({ position: { x: 180, y: 15 } });
  await expect(field).toBeFocused();
  await page.keyboard.type("exit io");
  await expect(field).toHaveValue("Keep exit io");
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await (await request.get(`${project.base}/timeline`)).json()).toEqual(
    before,
  );
  await page.getByRole("button", { name: "Set end", exact: true }).click();
  // Even a focusable editor button cannot send subsequent printable keys to shortcuts.
  await page.getByRole("button", { name: /^Select/ }).click();
  await page.keyboard.type(" x i o");
  await expect(field).toHaveValue("Keep exit io x i o");
  // Selection is allowed with the mouse; Delete and modified shortcuts must still stay local.
  await page
    .locator('[data-clip="headline"]')
    .click({ position: { x: 60, y: 20 } });
  await page.keyboard.press("Delete");
  await expect(field).toBeFocused();
  await page.getByRole("button", { name: /^Select/ }).click();
  await page.keyboard.press("Control+Backslash");
  await expect(field).toBeFocused();
  expect(await (await request.get(`${project.base}/timeline`)).json()).toEqual(
    before,
  );
});

async function quickCapture(page: Page, projectId: string) {
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.route(`**/api/projects/${projectId}/thumbnail/**`, (route) => {
    if (route.request().resourceType() !== "fetch") return route.fallback();
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(image, "base64"),
    });
  });
}

test("drafts and a two-stroke failed save recover in their project after switching away", async ({
  page,
  request,
}) => {
  const project = await openProject(page, request, "Draft owner A");
  await quickCapture(page, project.id);
  const second = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Draft owner B" },
      })
    ).json(),
  );
  const switchTo = async (id: string) => {
    await page.evaluate((id) => {
      location.hash = `project/${id}`;
    }, id);
    await expect(page.locator(".project-switcher")).toHaveText(
      id === project.id ? "Draft owner A" : "Draft owner B",
    );
    await expect(page.locator(".edit-picture iframe")).toHaveCount(1);
  };
  await page.keyboard.press("n");
  const at = await project.at(0.3, 0.4);
  await page.mouse.click(at.x, at.y);
  const field = page.getByLabel("What should change?");
  await field.fill("Do not lose this comment");
  await switchTo(second.id);
  await expect(field).toBeHidden();
  await switchTo(project.id);
  await expect(field).toHaveValue("Do not lose this comment");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+n");
  for (const y of [0.35, 0.7]) {
    const start = await project.at(0.1, y);
    const end = await project.at(0.3, y);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 20 });
    await page.mouse.up();
  }
  await field.fill("Recover both strokes");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route(`**${project.base}/annotations`, async (route) => {
    entered();
    await held;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Held save failed" }),
    });
  });
  try {
    await field.press("Enter");
    await started;
    await switchTo(second.id);
    release();
    await switchTo(project.id);
    await expect(field).toHaveValue("Recover both strokes");
    await expect(page.getByRole("alert")).toContainText("Held save failed");
    await expect(
      page.locator(".edit-note-pencil path[d]:not([data-live])"),
    ).toHaveCount(2);
    await page.unroute(`**${project.base}/annotations`);
    await field.press("Enter");
    await expect.poll(async () => (await project.notes()).length).toBe(1);
    expect((await project.notes())[0]?.strokes).toHaveLength(2);
  } finally {
    release();
  }
});

test("a notebook arriving before its POST response never duplicates a note or advances its next number", async ({
  page,
  request,
}) => {
  const project = await openProject(page, request, "Stable identity");
  await quickCapture(page, project.id);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route(`**${project.base}/annotations`, async (route) => {
    const response = await route.fetch();
    entered();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.keyboard.press("n");
    const at = await project.at(0.3, 0.4);
    await page.mouse.click(at.x, at.y);
    const field = page.getByLabel("What should change?");
    await field.fill("One identity");
    await field.press("Enter");
    await started;
    await expect.poll(async () => (await project.notes()).length).toBe(1);
    await expect(
      page.getByRole("button", { name: /^Review note 1/ }),
    ).toHaveAttribute("title", "Note 1");
    await expect(page.locator(".edit-note-pin")).toHaveCount(1);
    await expect(page.locator(".edit-note-pin")).toHaveText("1");
    await expect(
      page.getByRole("button", { name: "Agent", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const next = await project.at(0.1, 0.8);
    await page.mouse.click(next.x, next.y);
    await expect(
      page.getByRole("form", { name: "Note 2", exact: true }),
    ).toBeVisible();
    release();
    await expect(page.locator(".edit-note-pin")).toHaveCount(2);
    await expect(
      page.getByRole("form", { name: "Note 2", exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1024, height: 640 },
]) {
  test(`popover stays fully visible with 8px clearance at ${viewport.width}x${viewport.height}`, async ({
    page,
    request,
  }) => {
    const project = await openProject(page, request, "Popover edges");
    await page.setViewportSize(viewport);
    await page.keyboard.press("n");
    for (const [x, y] of [
      [0.01, 0.01],
      [0.99, 0.01],
      [0.99, 0.99],
      [0.01, 0.99],
    ]) {
      await page
        .getByRole("button", { name: "First frame", exact: true })
        .click();
      const spot = await project.at(x!, y!);
      await page.mouse.click(spot.x, spot.y);
      const field = page.getByLabel("What should change?");
      await field.fill(
        "A long comment\nwith several lines\nthat changes the height\nand stays readable",
      );
      await page.locator(".tl-ruler").click({ position: { x: 200, y: 15 } });
      await page.getByRole("button", { name: "Set end", exact: true }).click();
      await expect
        .poll(() =>
          page.locator(".edit-note-popover").evaluate((element) => {
            const popover = element.getBoundingClientRect();
            const stage = document
              .querySelector(".edit-stage")!
              .getBoundingClientRect();
            const actionsVisible = [
              ...element.querySelectorAll("button"),
            ].every((button) => {
              const action = button.getBoundingClientRect();
              return (
                action.left >= popover.left &&
                action.right <= popover.right &&
                action.top >= popover.top &&
                action.bottom <= popover.bottom
              );
            });
            return (
              actionsVisible &&
              popover.left >= stage.left + 7.5 &&
              popover.top >= stage.top + 7.5 &&
              popover.right <= stage.right - 7.5 &&
              popover.bottom <= stage.bottom - 7.5
            );
          }),
        )
        .toBe(true);
      await field.press("Escape");
    }
  });
}

test("text undo precedes stroke undo, stroke redo returns it, and saved-note undo offers Redo", async ({
  page,
  request,
}) => {
  const project = await openProject(page, request, "Undo notes");
  await quickCapture(page, project.id);
  await page.keyboard.press("Shift+n");
  const a = await project.at(0.1, 0.5);
  const b = await project.at(0.35, 0.5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 40 });
  await page.mouse.up();
  const field = page.getByLabel("What should change?");
  const strokes = page.locator(".edit-note-pencil path[d]:not([data-live])");
  await field.pressSequentially("Words after ink");
  for (const body of ["Words after ", "Words ", ""]) {
    await field.press("Control+z");
    await expect(field).toHaveValue(body);
    await expect(strokes).toHaveCount(1);
  }
  await field.press("Control+z");
  await expect(strokes).toHaveCount(0);
  await field.press("Control+Shift+z");
  await expect(strokes).toHaveCount(1);
  await field.press("Enter");
  await expect.poll(async () => (await project.notes()).length).toBe(1);
  await page.getByRole("button", { name: /^Select/ }).click();
  await page.keyboard.press("Control+z");
  await expect(page.locator(".toast")).toHaveText(
    "Note 1 removed ·RedoDismiss",
  );
  await expect(strokes).toHaveCount(0);
  await page
    .locator(".toast")
    .getByRole("button", { name: "Redo", exact: true })
    .click();
  await expect.poll(async () => (await project.notes()).length).toBe(1);
  await expect(strokes).toHaveCount(1);
});

test("single-frame notes stay readable in playback and acceptance removes both pin and strokes", async ({
  page,
  request,
}) => {
  const project = await openProject(page, request, "Readable playback");
  const item = AnnotationSchema.parse(
    await (
      await request.post(`${project.base}/annotations`, {
        data: {
          kind: "drawing",
          body: "Check this frame",
          time: 0.5,
          point: { x: 0.3, y: 0.5 },
          strokes: [
            {
              points: [
                { x: 0.2, y: 0.5 },
                { x: 0.3, y: 0.5 },
              ],
              color: "#F1CF5A",
            },
          ],
        },
      })
    ).json(),
  );
  const pin = page.getByRole("button", { name: "Note 1", exact: true });
  await expect(
    page.getByRole("button", { name: /^Review note 1/ }),
  ).toBeVisible();
  await expect(pin).toBeHidden();
  const playback = page.evaluate(async () => {
    const started = performance.now();
    let appeared: number | null = null;
    let held = false;
    while (performance.now() - started < 6000) {
      await new Promise(requestAnimationFrame);
      const pin = document.querySelector('.edit-note-pin[aria-label="Note 1"]');
      const now = performance.now();
      if (pin) {
        appeared ??= now;
        if (now - appeared >= 750 && now - appeared < 950)
          held = getComputedStyle(pin).opacity === "1";
      } else if (appeared !== null) {
        return { held, visibleFor: now - appeared };
      }
    }
    throw new Error("The playback note did not appear and fade.");
  });
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  const observed = await playback;
  expect(observed.held).toBe(true);
  expect(observed.visibleFor).toBeGreaterThanOrEqual(1000);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: /^Review note 1/ }).click();
  await expect(pin).toBeVisible();
  await expect(
    page.locator(".edit-note-pencil path[d]:not([data-live])"),
  ).toHaveCount(1);
  const completed = await request.post(
    `${project.base}/review/${item.id}/agent`,
    { data: { type: "complete", note: "Checked" } },
  );
  expect(completed.ok()).toBe(true);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(pin).toHaveCount(0);
  await expect(
    page.locator(".edit-note-pencil path[d]:not([data-live])"),
  ).toHaveCount(0);
});

test("finishing another stroke moves the popover clear of all ink and a slow 400px line stores under 80 points", async ({
  page,
  request,
}) => {
  const project = await openProject(page, request, "Clear ink");
  await quickCapture(page, project.id);
  await page.keyboard.press("Shift+n");
  const start = await project.at(0.1, 0.6);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 400, start.y, { steps: 400 });
  await page.mouse.up();
  const firstPin = await page
    .locator(".edit-note-pin[data-status=draft]")
    .boundingBox();
  const second = await project.at(0.4, 0.8);
  const end = await project.at(0.7, 0.8);
  await page.mouse.move(second.x, second.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 60 });
  await page.mouse.up();
  expect(
    await page.locator(".edit-note-pin[data-status=draft]").boundingBox(),
  ).toEqual(firstPin);
  const clear = await page.locator(".edit-note-popover").evaluate((element) => {
    const form = element.getBoundingClientRect();
    const ink = document
      .querySelector(".edit-note-pencil")!
      .getBoundingClientRect();
    return (
      form.left >= ink.right + 23.5 ||
      form.right <= ink.left - 23.5 ||
      form.top >= ink.bottom + 23.5 ||
      form.bottom <= ink.top - 23.5
    );
  });
  expect(clear).toBe(true);
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect.poll(async () => (await project.notes()).length).toBe(1);
  expect((await project.notes())[0]!.strokes[0]!.points.length).toBeLessThan(
    80,
  );
  await expect(
    page.locator(".edit-note-casing path[d]:not([data-live])").first(),
  ).toHaveCSS("stroke-width", "7px");
  await expect(
    page.locator(".edit-note-casing path[d]:not([data-live])").first(),
  ).toHaveCSS("stroke", "rgba(0, 0, 0, 0.7)");
});

test("ink spanning the whole picture gets space beside the picture", async ({
  page,
  request,
}) => {
  const project = await openProject(page, request, "Full-picture drawing");
  await page.keyboard.press("Shift+n");
  const corners = await Promise.all(
    [
      [0.03, 0.03],
      [0.97, 0.03],
      [0.97, 0.97],
      [0.03, 0.97],
      [0.03, 0.03],
    ].map(([x, y]) => project.at(x!, y!)),
  );
  await page.mouse.move(corners[0]!.x, corners[0]!.y);
  await page.mouse.down();
  for (const point of corners.slice(1))
    await page.mouse.move(point.x, point.y, { steps: 40 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.locator(".edit-note-popover").evaluate((element) => {
        const form = element.getBoundingClientRect();
        const ink = document
          .querySelector(".edit-note-pencil")!
          .getBoundingClientRect();
        return (
          form.left >= ink.right + 23.5 ||
          form.right <= ink.left - 23.5 ||
          form.top >= ink.bottom + 23.5 ||
          form.bottom <= ink.top - 23.5
        );
      }),
    )
    .toBe(true);
});

test("six alternating notes on one frame keep their drafted numbers when the first capture is late", async ({
  page,
  request,
}, testInfo) => {
  const project = await openProject(page, request, "One-frame review pass");
  await quickCapture(page, project.id);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captures = 0;
  await page.route(
    `**/api/projects/${project.id}/thumbnail/**`,
    async (route) => {
      if (route.request().resourceType() !== "fetch") return route.fallback();
      captures++;
      if (captures === 1) await held;
      await route.fallback();
    },
  );
  const notes = [
    { body: "Drawing 1", x: 0.12, y: 0.25, draw: true },
    { body: "Comment 2", x: 0.35, y: 0.25, draw: false },
    { body: "Drawing 3", x: 0.55, y: 0.25, draw: true },
    { body: "Comment 4", x: 0.2, y: 0.65, draw: false },
    { body: "Drawing 5", x: 0.45, y: 0.65, draw: true },
    { body: "Comment 6", x: 0.75, y: 0.65, draw: false },
  ];
  try {
    for (const [index, note] of notes.entries()) {
      await page
        .getByRole("button", { name: note.draw ? /^Draw/ : /^Comment/ })
        .click();
      const start = await project.at(note.x, note.y);
      if (note.draw) {
        const end = await project.at(note.x + 0.08, note.y);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 8 });
        await page.mouse.up();
      } else await page.mouse.click(start.x, start.y);
      await expect(
        page.getByRole("form", { name: `Note ${index + 1}`, exact: true }),
      ).toBeVisible();
      const field = page.getByLabel("What should change?");
      await field.fill(note.body);
      await field.press("Enter");
    }
    // Captures can run together, but their completion order must not choose the note numbers.
    await expect.poll(() => captures).toBe(6);
    release();
    await expect.poll(async () => (await project.notes()).length).toBe(6);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.locator(".review-row")).toHaveCount(6);
    await expect(page.locator(".notebook-content > div:visible")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(page.locator(".toast")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("same-frame-notes.png"),
    });
    const saved = await project.notes();
    expect(saved.every((note) => note.framePath)).toBe(true);
    expect(saved.map((note) => note.body)).toEqual(
      notes.map((note) => note.body),
    );
    for (const [index, note] of notes.entries()) {
      const number = index + 1;
      await expect(
        page.getByRole("button", { name: `Note ${number}`, exact: true }),
      ).toHaveAttribute("title", note.body);
      await expect(
        page.locator(`#review-note-${saved[index]!.id} .note-pin`),
      ).toHaveText(String(number));
    }
  } finally {
    release();
  }
});

test("Esc after setting or clearing a note end discards the note and keeps its tool armed", async ({
  page,
  request,
}) => {
  const project = await openProject(page, request, "End then escape");
  const field = page.getByLabel("What should change?");
  for (const clearEnd of [false, true]) {
    await page
      .getByRole("button", { name: "First frame", exact: true })
      .click();
    await page.getByRole("button", { name: /^Comment/ }).click();
    const point = await project.at(0.3, 0.5);
    await page.mouse.click(point.x, point.y);
    if (clearEnd) await page.getByRole("button", { name: /^Draw/ }).click();
    await field.fill("Discard this note");
    await page.locator(".tl-ruler").click({ position: { x: 180, y: 15 } });
    await page.getByRole("button", { name: "Set end", exact: true }).click();
    await expect(field).toBeFocused();
    if (clearEnd) {
      await page.getByTitle("Clear the end", { exact: true }).click();
      await expect(field).toBeFocused();
    }
    // Keep focus on the end control to exercise App's earlier window listener as well.
    await page.locator(".edit-note-end").focus();
    await page.keyboard.press("Escape");
    await expect(field).toBeHidden();
    await expect(
      page.getByRole("button", { name: clearEnd ? /^Draw/ : /^Comment/ }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  expect(await project.notes()).toHaveLength(0);
});

test("six notes capture the sandboxed picture with both strokes and no black frames", async ({
  page,
  request,
}, testInfo) => {
  const project = await openProject(page, request, "Isolated note pass");
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html>
<html><head><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden}
main{position:relative;width:1920px;height:1080px;background:rgb(24,74,120)}
#headline{position:absolute;left:10%;top:10%;color:white;font:100px sans-serif}
#band{position:absolute;left:5%;top:78%;width:80%;height:8%;background:white}
</style></head><body>
<main id="capture-surface" data-composition-id="main" data-width="1920" data-height="1080" data-duration="12" data-fps="30" data-no-timeline>
<div id="headline" class="clip" data-start="0" data-duration="12" data-track-index="1">Isolated note pass</div>
<div id="band" class="clip" data-start="0" data-duration="12" data-track-index="0"></div>
</main></body></html>`,
  );
  await expect(
    page.frameLocator("iframe[data-live]").locator("#capture-surface"),
  ).toBeVisible();
  await expect(page.locator("iframe[data-live]")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  for (let index = 0; index < 6; index++) {
    const drawing = index % 2 === 0;
    await page
      .getByRole("button", { name: drawing ? /^Draw/ : /^Comment/ })
      .click();
    if (drawing) {
      for (const y of [0.35, 0.65]) {
        const start = await project.at(0.1 + index * 0.12, y);
        const end = await project.at(0.18 + index * 0.12, y);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 8 });
        await page.mouse.up();
      }
    } else {
      const point = await project.at(0.2 + index * 0.1, 0.82);
      await page.mouse.click(point.x, point.y);
    }
    await expect(
      page.getByRole("form", { name: `Note ${index + 1}`, exact: true }),
    ).toBeVisible();
    const field = page.getByLabel("What should change?");
    await field.fill(`Capture ${index + 1}`);
    await field.press("Enter");
  }
  await expect.poll(async () => (await project.notes()).length).toBe(6);
  const saved = await project.notes();
  expect(saved.map((note) => note.body)).toEqual([
    "Capture 1",
    "Capture 2",
    "Capture 3",
    "Capture 4",
    "Capture 5",
    "Capture 6",
  ]);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator(".notebook-content > div:visible")).toHaveCSS(
    "opacity",
    "1",
  );
  for (const [index, note] of saved.entries()) {
    expect(note.framePath).toBeTruthy();
    expect(note.strokes).toHaveLength(index % 2 === 0 ? 2 : 0);
    const url = await page
      .locator(`#review-note-${note.id} img`)
      .getAttribute("src");
    if (!url) throw new Error(`Capture ${index + 1} has no saved image.`);
    const points = [
      { x: 0.9, y: 0.9 },
      ...(index % 2 === 0
        ? [0.35, 0.65].map((y) => ({ x: 0.14 + index * 0.12, y }))
        : []),
    ];
    const pixels = await page.evaluate(
      async ({ url, points }) => {
        const response = await fetch(url);
        if (!response.ok)
          throw new Error(`Saved capture returned ${response.status}.`);
        const image = await createImageBitmap(await response.blob());
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const paint = canvas.getContext("2d")!;
        paint.drawImage(image, 0, 0);
        const samples = points.map(({ x, y }) =>
          Array.from(
            paint.getImageData(
              Math.floor(x * image.width),
              Math.floor(y * image.height),
              1,
              1,
            ).data,
          ),
        );
        const size = { width: image.width, height: image.height };
        image.close();
        return { size, samples };
      },
      { url, points },
    );
    expect(pixels.size).toEqual({ width: 1920, height: 1080 });
    expect(pixels.samples[0]).toEqual([24, 74, 120, 255]);
    for (const sample of pixels.samples.slice(1)) {
      expect(sample[0]).toBeGreaterThan(180);
      expect(sample[1]).toBeGreaterThan(140);
      expect(sample[2]).toBeLessThan(140);
      expect(sample[3]).toBe(255);
    }
    await writeFile(
      testInfo.outputPath(`capture-${index + 1}.png`),
      await (await request.get(url)).body(),
    );
  }
  await expect(page.locator(".toast")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("sandboxed-six-note-pass.png"),
  });
});
