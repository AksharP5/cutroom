import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";

const HistorySchema = z.object({
  entries: z.array(z.object({ undone: z.boolean() })),
});

/**
 * The starter project: V1, V2 and V3 are tracks 0, 1 and 2, each filled for the whole 12 s, and
 * V1 is the video destination.
 */
async function starter(page: Page, request: APIRequestContext, name: string) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name, width: 1920, height: 1080, duration: 12 },
      })
    ).json(),
  );
  const path = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${path}/timeline`)).json(),
    );
  const before = (await read()).timeline;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".tl-lanes [data-clip]")).toHaveCount(3);
  return {
    before,
    edit: async (commands: CommandInput[]) => {
      const response = await request.post(`${path}/commands`, {
        data: {
          composition: "index.html",
          expectedRevision: (await read()).revision,
          label: "Set up",
          commands,
        },
      });
      expect(response.status(), await response.text()).toBe(200);
    },
    titles: async () =>
      (await read()).timeline.clips.filter((clip) => clip.title),
    videoTracks: async () =>
      (await read()).timeline.tracks
        .filter((track) => track.kind === "video")
        .map((track) => track.index),
    steps: async () =>
      HistorySchema.parse(
        await (await request.get(`${path}/history`)).json(),
      ).entries.filter((entry) => !entry.undone).length,
  };
}

const words = (page: Page) =>
  page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("textbox", { name: "Text", exact: true });

test("Alt+Shift+T adds a title above the destination in three track layouts, ready to type, and one undo removes it", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { before, edit, titles, videoTracks, steps } = await starter(
    page,
    request,
    "Add title",
  );
  await seekFrame(page, 60);
  const undo = () =>
    page.getByRole("button", { name: "Undo", exact: true }).click();

  // Layout 1: every track above V1 is occupied at the playhead, so the title gets a new top track.
  const start = await steps();
  await page.keyboard.press("Alt+Shift+T");
  await expect.poll(titles).toHaveLength(1);
  const [added] = await titles();
  expect(added).toMatchObject({
    track: 3,
    start: 60,
    duration: 150,
    text: "Title",
    title: { position: "lower-left" },
  });
  expect(await videoTracks()).toEqual([0, 1, 2, 3]);
  expect(await steps()).toBe(start + 1);
  // It is the selection, and its placeholder is selected in the inspector's Text field.
  await expect(
    page.locator(`.tl-lanes [data-clip="${added!.id}"].selected`),
  ).toHaveCount(1);
  await expect(words(page)).toBeFocused();
  expect(
    await words(page).evaluate((field: HTMLTextAreaElement) =>
      field.value.slice(field.selectionStart, field.selectionEnd),
    ),
  ).toBe("Title");
  // Typing replaces it, Enter saves, and the picture shows the words lower left.
  await page.keyboard.type("Ada Lovelace");
  await page.keyboard.press("Enter");
  const shown = page.frameLocator("iframe[data-live]").locator(`#${added!.id}`);
  await expect(shown).toHaveText("Ada Lovelace");
  await expect(shown).toHaveCSS("font-size", "64px");
  // Past its fade in, it is fully drawn.
  await seekFrame(page, 120);
  await expect(shown).toHaveCSS("opacity", "1");
  const box = (await shown.boundingBox())!;
  const picture = (await page
    .frameLocator("iframe[data-live]")
    .locator("[data-composition-id]")
    .first()
    .boundingBox())!;
  expect(box.x - picture.x).toBeLessThan(picture.width / 4);
  expect(box.y - picture.y).toBeGreaterThan(picture.height / 2);
  await seekFrame(page, 60);
  // The key does nothing while a field has the keyboard.
  await words(page).focus();
  await page.keyboard.press("Alt+Shift+T");
  await page.keyboard.press("Escape");
  // Undo takes back the words, then the title together with the track it made.
  await undo();
  await expect.poll(async () => (await titles())[0]?.text).toBe("Title");
  await undo();
  await expect.poll(titles).toHaveLength(0);
  expect(await videoTracks()).toEqual([0, 1, 2]);
  expect(before.clips.map((clip) => clip.id)).toHaveLength(3);

  // Layout 2: a free track above the destination takes the title, and no track is added.
  await edit([{ type: "setTrack", index: 3, kind: "video" }]);
  await expect(page.locator(".tl-head.video")).toHaveCount(4);
  await page.keyboard.press("Alt+Shift+T");
  await expect.poll(titles).toHaveLength(1);
  expect((await titles())[0]).toMatchObject({ track: 3, start: 60 });
  expect(await videoTracks()).toEqual([0, 1, 2, 3]);
  await page.keyboard.press("Escape");
  // A second title at the same frame finds that track taken and goes above it.
  await page.keyboard.press("Alt+Shift+T");
  await expect.poll(titles).toHaveLength(2);
  expect((await titles()).map((clip) => clip.track)).toEqual([3, 4]);
  await page.keyboard.press("Escape");
  await undo();
  await undo();
  await expect.poll(titles).toHaveLength(0);
  // A locked free track is skipped.
  await edit([{ type: "setTrack", index: 3, locked: true }]);
  await expect(
    page.getByRole("button", { name: "Lock V4", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+Shift+T");
  await expect.poll(titles).toHaveLength(1);
  expect((await titles())[0]).toMatchObject({ track: 4 });
  await page.keyboard.press("Escape");
  await undo();
  await expect.poll(titles).toHaveLength(0);

  // Layout 3: the destination is the top track, so there is nothing above it to use.
  await edit([
    { type: "setTrack", index: 3, locked: false },
    { type: "removeTrack", index: 3 },
  ]);
  await expect(page.locator(".tl-head.video")).toHaveCount(3);
  await page.keyboard.press("Alt+3");
  await page.keyboard.press("Alt+Shift+T");
  await expect.poll(titles).toHaveLength(1);
  expect((await titles())[0]).toMatchObject({ track: 3 });
  expect(await videoTracks()).toEqual([0, 1, 2, 3]);
  await page.keyboard.press("Escape");
  await undo();
  await expect.poll(titles).toHaveLength(0);
  expect(await videoTracks()).toEqual([0, 1, 2]);
});

test("Add title in the lane and track header menus does what the key does", async ({
  page,
  request,
}) => {
  const { titles } = await starter(page, request, "Add title menus");
  await seekFrame(page, 30);
  const item = (menu: string | RegExp) =>
    page
      .getByRole("menu", { name: menu })
      .getByRole("menuitem", { name: "Add title", exact: true });

  await page
    .locator(".tl-lanes [data-clip]")
    .first()
    .click({ button: "right" });
  await expect(item("Clip").locator("kbd")).toHaveText("Alt+Shift+T");
  await item("Clip").click();
  await expect.poll(titles).toHaveLength(1);
  expect((await titles())[0]).toMatchObject({ track: 3, start: 30 });
  await expect(words(page)).toBeFocused();
  await page.keyboard.press("Escape");

  await seekFrame(page, 200);
  await page
    .locator('.tl-head[data-row="0"]')
    .click({ button: "right", position: { x: 4, y: 4 } });
  await item(/^Track/).click();
  await expect.poll(titles).toHaveLength(2);
  // The first title's track is free again by then, so the second shares it.
  expect((await titles()).map((clip) => [clip.track, clip.start])).toEqual([
    [3, 30],
    [3, 200],
  ]);
  await expect(words(page)).toBeFocused();
});
