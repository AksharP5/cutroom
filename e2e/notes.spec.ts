import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { ReviewItemSchema } from "../src/shared/review";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

async function openProject(page: Page, name: string) {
  const project = ProjectSchema.parse(
    await (
      await page.request.post("/api/cutroom/projects", { data: { name } })
    ).json(),
  );
  await page.addInitScript(() =>
    localStorage.setItem("cutroom.newEditor", "true"),
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
        .parse(await (await page.request.get(`${base}/review`)).json()).items,
    range: async () =>
      TimelineViewSchema.parse(
        await (await page.request.get(`${base}/timeline`)).json(),
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

test("a comment pins where you click, takes every key while you type, and stays put through a resize", async ({
  page,
}) => {
  const project = await openProject(page, "Pinned comment");
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
}) => {
  const project = await openProject(page, "Drawn notes");
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
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.getByRole("button", { name: "Set end" }).click();
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
