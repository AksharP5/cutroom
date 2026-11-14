import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** A starter project with one lower third on its own track, and the calls the tests check with. */
async function titleProject(request: APIRequestContext, name: string) {
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
  const edit = async (commands: CommandInput[]) => {
    const response = await request.post(`${path}/commands`, {
      data: {
        composition: "index.html",
        expectedRevision: (await read()).revision,
        label: "Set up",
        commands,
      },
    });
    expect(response.status(), await response.text()).toBe(200);
  };
  await edit([
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
        title: { font: "Instrument Sans" },
      },
    },
  ]);
  return {
    project,
    edit,
    title: async () =>
      (await read()).timeline.clips.find((clip) => clip.id === "lower"),
    steps: async () =>
      HistorySchema.parse(
        await (await request.get(`${path}/history`)).json(),
      ).entries.filter((entry) => !entry.undone).length,
  };
}

const openTitle = async (page: Page, projectId: string) => {
  await page.goto(`/#project/${projectId}`);
  await page.locator('.tl-lanes [data-clip="lower"]').click();
  // Past the entrance and before the exit, so the picture shows the title at rest.
  await seekFrame(page, 120);
  return page.getByRole("complementary", { name: "Inspector" });
};

test("each Title control changes the picture and is one undo step", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { project, edit, title, steps } = await titleProject(
    request,
    "Title inspector",
  );
  const inspector = await openTitle(page, project.id);
  await expect(inspector).toContainText("Title on V4");
  const shown = page.frameLocator("iframe[data-live]").locator("#lower");
  await expect(shown).toHaveCSS("font-size", "64px");

  /** Runs one control change, then checks it took exactly one history step. */
  const change = async (act: () => Promise<void>) => {
    const before = await steps();
    await act();
    await expect.poll(steps).toBe(before + 1);
  };
  const choose = (menu: string, option: string) => async () => {
    await inspector.getByRole("combobox", { name: menu, exact: true }).click();
    await page
      .getByRole("listbox", { name: `${menu} options`, exact: true })
      .getByRole("option", { name: option, exact: true })
      .click();
  };
  const type = (field: string, value: string) => async () => {
    const input = inspector.getByRole("textbox", { name: field, exact: true });
    await input.fill(value);
    await input.press("Enter");
  };

  await change(type("Size", "96"));
  await expect(shown).toHaveCSS("font-size", "96px");

  await change(choose("Weight", "Bold"));
  await expect(shown).toHaveCSS("font-weight", "700");

  await change(type("Colour hex", "ffcc00"));
  await expect(shown).toHaveCSS("color", "rgb(255, 204, 0)");

  // The system picker reports colours as it moves; the one it closes on is the single edit.
  await change(() =>
    inspector.getByLabel("Colour", { exact: true }).fill("#00ff88"),
  );
  await expect(shown).toHaveCSS("color", "rgb(0, 255, 136)");

  await change(() =>
    inspector.getByRole("radio", { name: "Align right" }).click(),
  );
  await expect(shown).toHaveCSS("text-align", "right");
  // The arrows move the choice like native radios and never reach the timeline's playhead.
  const now = await page.locator(".edit-now").textContent();
  await change(() =>
    inspector.getByRole("radio", { name: "Align right" }).press("ArrowLeft"),
  );
  await expect(shown).toHaveCSS("text-align", "center");
  await expect(
    inspector.getByRole("radio", { name: "Align centre" }),
  ).toBeFocused();
  await expect(page.locator(".edit-now")).toHaveText(now!);

  await change(() =>
    inspector.getByRole("checkbox", { name: "Plate" }).check(),
  );
  await expect(shown).toHaveCSS("background-color", "rgba(0, 0, 0, 0.7)");
  await change(type("Plate colour hex", "#ffffff"));
  await change(type("Plate opacity", "100"));
  await expect(shown).toHaveCSS("background-color", "rgb(255, 255, 255)");

  await change(choose("Font", "Default"));
  await expect(shown).not.toHaveAttribute("data-title-font");
  await change(choose("Font", "Instrument Sans"));
  await expect(shown).toHaveAttribute("data-title-font", "Instrument Sans");

  await change(choose("In preset", "Slide"));
  await change(type("In", "20f"));
  await change(choose("Out preset", "None"));
  await expect(
    inspector.getByRole("textbox", { name: "Out", exact: true }),
  ).toBeDisabled();
  expect((await title())?.title).toMatchObject({
    in: { preset: "slide", frames: 20 },
    out: { preset: "none" },
  });
  // Mid-entrance on the picture: partly faded and still below its resting place.
  const rest = (await shown.boundingBox())!.y;
  await seekFrame(page, 62);
  await expect
    .poll(async () =>
      shown.evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeLessThan(1);
  expect((await shown.boundingBox())!.y).toBeGreaterThan(rest);
  await seekFrame(page, 120);

  // A drag off the preset, then a new preset: the offset goes in the same step and comes back
  // with one undo.
  await edit([{ type: "setClip", clipId: "lower", x: 300, y: -200 }]);
  await expect(
    inspector.getByRole("textbox", { name: "Position X", exact: true }),
  ).toHaveValue("300 px");
  await expect(shown).toHaveAttribute("data-x", "300");
  const lowerLeft = (await shown.boundingBox())!;
  await change(choose("Position", "Top"));
  await expect
    .poll(async () => (await shown.boundingBox())!.y)
    .toBeLessThan(lowerLeft.y);
  expect(await title()).toMatchObject({
    x: null,
    y: null,
    title: { position: "top" },
  });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(title)
    .toMatchObject({ x: 300, y: -200, title: { position: "lower-left" } });
  await expect
    .poll(async () => (await shown.boundingBox())!.y)
    .toBe(lowerLeft.y);
});

test("a title Cutroom cannot read shows why in place of its controls", async ({
  page,
  request,
}) => {
  const { project } = await titleProject(request, "Title states");
  const inspector = await openTitle(page, project.id);
  const section = inspector.locator(".inspector-title");
  const controls = section.locator("input, button:not([role=option])");
  await expect(controls).toHaveCount(14);

  const file = join(project.path, "index.html");
  const source = await readFile(file, "utf8");
  expect(source).toContain('data-title-size="64px"');
  await writeFile(
    file,
    source.replace('data-title-size="64px"', 'data-title-size="huge"'),
  );
  await expect(section).toContainText(
    "This title's data-title-size is not a value Cutroom writes. Edit it in the source.",
  );
  await expect(controls).toHaveCount(0);
  await expect(inspector).toContainText("Title on V4");
});
