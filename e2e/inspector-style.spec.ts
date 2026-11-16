import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
import { waitForPreview } from "./preview-ready";

const HistorySchema = z.object({
  entries: z.array(z.object({ undone: z.boolean() })),
});

/**
 * A starter project, whose headline and caption are ordinary HyperFrames text styled by its own
 * stylesheet, plus a plain shape on V4.
 */
async function styleProject(request: APIRequestContext, name: string) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name, width: 1920, height: 1080, duration: 6 },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8"))
      .replace(
        "</style>",
        ".badge { position: absolute; left: 12%; top: 18%; width: 240px; height: 120px; background: #3a6df0; }\n</style>",
      )
      .replace(
        "</main>",
        '<div id="badge" class="clip badge" data-start="0" data-duration="6" data-track-index="3" data-label="Badge"></div>\n</main>',
      ),
  );
  const steps = async () =>
    HistorySchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/history`)
      ).json(),
    ).entries.filter((entry) => !entry.undone).length;
  return { project, index, steps };
}

const controls = (page: Page) => {
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  return {
    inspector,
    type: async (field: string, value: string) => {
      const input = inspector.getByRole("textbox", {
        name: field,
        exact: true,
      });
      await input.fill(value);
      await input.press("Enter");
    },
    choose: async (menu: string, option: string) => {
      await inspector
        .getByRole("combobox", { name: menu, exact: true })
        .click();
      await page
        .getByRole("listbox", { name: `${menu} options`, exact: true })
        .getByRole("option", { name: option, exact: true })
        .click();
    },
  };
};
const shown = (page: Page, id: string) =>
  page.locator("iframe[data-live]").contentFrame().locator(`#${id}`);
const documentShown = (page: Page) =>
  page.locator("iframe[data-live]").getAttribute("src");

test("Style rows restyle authored text and a shape in place, one undo step each", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { project, index, steps } = await styleProject(request, "Styles");
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  const loaded = await documentShown(page);
  const { inspector, type, choose } = controls(page);
  const headline = shown(page, "headline");
  await expect(headline).toHaveCSS("font-size", "96px");

  /** Runs one control change, then checks it took exactly one history step. */
  const change = async (act: () => Promise<void>) => {
    const before = await steps();
    await act();
    await expect.poll(steps).toBe(before + 1);
  };

  await page.locator('.tl-lanes [data-clip="headline"]').click();
  await expect(inspector).toContainText("Project title");
  // Style starts closed so Timing stays in view, and stays open once opened.
  const style = inspector.locator("details", {
    has: page.locator("summary", { hasText: /^Style$/ }),
  });
  await expect(style).not.toHaveAttribute("open");
  await style.locator("summary").click();
  await change(() => type("Size", "140"));
  await expect(headline).toHaveCSS("font-size", "140px");
  await change(() => choose("Weight", "Bold"));
  await expect(headline).toHaveCSS("font-weight", "700");
  await change(() => choose("Font", "Oswald"));
  await expect(headline).toHaveCSS("font-family", "Oswald, sans-serif");
  await change(() =>
    inspector.getByRole("checkbox", { name: "Colour", exact: true }).check(),
  );
  await change(() => type("Colour colour hex", "ffcc00"));
  await expect(headline).toHaveCSS("color", "rgb(255, 204, 0)");
  await change(() => choose("Case", "Uppercase"));
  await expect(headline).toHaveCSS("text-transform", "uppercase");
  await change(() => type("Tracking", "10%"));
  await expect(headline).toHaveCSS("letter-spacing", "14px");
  await change(() => type("Leading", "90%"));
  await expect(headline).toHaveCSS("line-height", "126px");
  await change(() => choose("Align", "Centre"));
  await expect(headline).toHaveCSS("text-align", "center");

  await page.locator('.tl-lanes [data-clip="badge"]').click();
  await expect(inspector).toContainText("Badge");
  // The shape has no words, so it offers no text style.
  await expect(
    inspector.getByRole("combobox", { name: "Font", exact: true }),
  ).toHaveCount(0);
  const badge = shown(page, "badge");
  await change(() => choose("Fill", "Colour"));
  await change(() => type("Fill colour hex", "#ff3366"));
  await change(() => type("Fill opacity", "100"));
  await expect(badge).toHaveCSS("background-color", "rgb(255, 51, 102)");
  await change(() => type("Radius", "60"));
  await expect(badge).toHaveCSS("border-radius", "60px");
  await change(() =>
    inspector.getByRole("checkbox", { name: "Shadow", exact: true }).check(),
  );
  await expect(badge).toHaveCSS(
    "filter",
    "drop-shadow(rgba(0, 0, 0, 0.7) 0px 4px 12px)",
  );
  await change(() => type("Width", "480"));
  await expect(badge).toHaveCSS("width", "480px");

  // Every change above patched the open document; none reloaded it.
  expect(await documentShown(page)).toBe(loaded);
  const source = await readFile(index, "utf8");
  expect(source).toContain(
    `style="font-size: 140px; font-weight: 700; font-family: &quot;Oswald&quot;, sans-serif; color: #ffcc00; text-transform: uppercase; letter-spacing: 0.1em; line-height: 0.9; text-align: center"`,
  );
  expect(source).toContain(
    `style="background: #ff3366; border-radius: 60px; filter: drop-shadow(0px 4px 12px #000000b3); width: 480px"`,
  );

  // Undo takes one change back, in place; Auto hands the value back to the stylesheet.
  await page.keyboard.press("Control+z");
  await expect(badge).toHaveCSS("width", "240px");
  await page.locator('.tl-lanes [data-clip="headline"]').click();
  await change(() => type("Size", "auto"));
  await expect(headline).toHaveCSS("font-size", "96px");
  expect(await documentShown(page)).toBe(loaded);
});

test("Copy style and Paste style carry one shape's look to other clips in one undo step", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const { project, index, steps } = await styleProject(request, "Paste");
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  const { type } = controls(page);
  const menu = async (clip: string) => {
    await page
      .locator(`.tl-lanes [data-clip="${clip}"]`)
      .click({ button: "right" });
    return page.getByRole("menu");
  };
  await page.locator('.tl-lanes [data-clip="badge"]').click();
  await page
    .getByRole("complementary", { name: "Inspector" })
    .locator("summary", { hasText: /^Style$/ })
    .click();
  await type("Radius", "24");
  await expect.poll(steps).toBe(1);
  await (
    await menu("badge")
  )
    .getByRole("menuitem", { name: "Copy style" })
    .click();
  await page.locator('.tl-lanes [data-clip="caption"]').click();
  await (
    await menu("caption")
  )
    .getByRole("menuitem", { name: "Paste style" })
    .click();
  await expect(shown(page, "caption")).toHaveCSS("border-radius", "24px");
  await expect.poll(steps).toBe(2);
  expect(await readFile(index, "utf8")).toContain(
    `data-label="Getting started" style="border-radius: 24px">Drop media in`,
  );
});
