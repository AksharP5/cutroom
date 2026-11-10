import { expect, test } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

test("the new editor plays, steps, and marks in and out as undoable timeline edits", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Own viewer" },
      })
    ).json(),
  );
  const range = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline.range;
  await page.addInitScript(() =>
    localStorage.setItem("cutroom.newEditor", "true"),
  );
  await page.goto(`/#project/${project.id}`);

  const preview = page.frameLocator("iframe[title='Composition preview']");
  await expect(preview.locator("#headline")).toHaveText("Own viewer");
  const now = page.getByRole("button", { name: /^Current time/ });
  const play = page.getByRole("button", { name: "Play forward" });
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(now).toHaveText("00:00:00:00");
  await expect(page.getByText("00:00:12:00")).toBeVisible();

  // Typing never drives the transport.
  const composer = page.getByPlaceholder("Describe the next edit");
  await composer.fill("");
  await composer.press("l");
  await composer.press("Space");
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(composer).toHaveValue("l ");
  await composer.fill("");
  await page.getByRole("region", { name: "Viewer" }).click();

  await page.keyboard.press("l");
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await expect(now).not.toHaveText("00:00:00:00");
  await page.keyboard.press("l");
  await expect(page.getByLabel("Shuttle speed")).toHaveText("2x");
  await page.keyboard.press("k");
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Shuttle speed")).toHaveText("");

  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(now).toHaveText("00:00:00:02");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(now).toHaveText("00:00:01:02");

  await page.keyboard.press("i");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("o");
  await expect(
    page.getByText(/In\s*00:00:01:02\s*Out\s*00:00:02:02/),
  ).toBeVisible();
  expect(await range()).toEqual({ in: 32, out: 63 });

  await page.keyboard.press("Shift+i");
  await expect(now).toHaveText("00:00:01:02");

  await page.keyboard.press("Control+z");
  await expect.poll(range).toEqual({ in: 32, out: null });
  await expect(page.getByText("Out", { exact: true })).toHaveCount(0);

  // A typed time seeks; digits fill from the right.
  await now.click();
  await page.keyboard.type("504");
  await page.keyboard.press("Enter");
  await expect(now).toHaveText("00:00:05:04");
});
