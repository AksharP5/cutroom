import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { blockFont } from "../tests/test-font";
import { seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";

test("a font file imported from the Font menu is applied to the title and drawn in the picture", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Font import", width: 1920, height: 1080, duration: 12 },
      })
    ).json(),
  );
  const path = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${path}/timeline`)).json(),
    );
  const setUp = await request.post(`${path}/commands`, {
    data: {
      composition: "index.html",
      expectedRevision: (await read()).revision,
      label: "Set up",
      commands: [
        { type: "setTrack", index: 3, kind: "video" },
        {
          type: "insert",
          track: 3,
          at: 60,
          clip: {
            kind: "title",
            id: "lower",
            text: "Ada Lovelace",
            duration: 150,
          },
        },
      ],
    },
  });
  expect(setUp.status(), await setUp.text()).toBe(200);

  await page.goto(`/#project/${project.id}`);
  await page.locator('.tl-lanes [data-clip="lower"]').click();
  await seekFrame(page, 120);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.getByRole("combobox", { name: "Font", exact: true }).click();
  await page
    .getByRole("listbox", { name: "Font options", exact: true })
    .getByRole("option", { name: "Add font...", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Add font" });
  await dialog.getByLabel("Font files").setInputFiles({
    name: "block.ttf",
    mimeType: "font/ttf",
    buffer: Buffer.from(blockFont({ family: "Cutroom Block", weight: 600 })),
  });
  await expect(dialog).toBeHidden();

  await expect(
    inspector.getByRole("combobox", { name: "Font", exact: true }),
  ).toHaveText("Cutroom Block");
  expect((await read()).timeline.fonts).toContain("Cutroom Block");
  const title = (await read()).timeline.clips.find(
    (clip) => clip.id === "lower",
  );
  expect(title?.title?.font).toBe("Cutroom Block");
  // Every letter of the block font is 0.6em wide and a space 0.3em: 11 letters and a space at 64px.
  const shown = page.frameLocator("iframe[data-live]").locator("#lower");
  await expect
    .poll(() =>
      shown.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeCloseTo(11 * 0.6 * 64 + 0.3 * 64, 0);
});
