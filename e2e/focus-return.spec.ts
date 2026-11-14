import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Focus recovery", duration: 12 },
      })
    ).json(),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const view = TimelineViewSchema.parse(
    await (await request.get(`${api}/timeline`)).json(),
  );
  expect(
    (
      await request.post(`${api}/commands`, {
        data: {
          expectedRevision: view.revision,
          commands: [
            { type: "setTrack", index: 3, kind: "audio" },
            { type: "setTrack", index: 4, kind: "audio" },
          ],
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".tl-grid")).toHaveAttribute(
    "data-refit",
    "settled",
  );
  await page.keyboard.press("Control+4");
});

for (const label of ["Viewer zoom", "Track density"]) {
  for (const dismiss of ["choose", "outside"] as const) {
    test(`${label}: ${dismiss} returns transport and destination keys to editing`, async ({
      page,
    }, info) => {
      await page.getByRole("combobox", { name: label, exact: true }).click();
      const list = page.getByRole("listbox", { name: `${label} options` });
      await expect(list).toBeVisible();
      if (dismiss === "choose") await list.getByRole("option").first().click();
      else
        await page
          .getByRole("toolbar", { name: "Tools" })
          .click({ position: { x: 500, y: 15 } });
      await expect(list).toBeHidden();
      await page.keyboard.press("Control+Alt+2");
      await expect(
        page.getByRole("button", { name: "A2 destination", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("l");
      await expect(
        page.getByRole("button", { name: "Play forward", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      const clock = page.getByRole("button", { name: /^Current time/ });
      await expect(clock).not.toHaveText("00:00:00:00");
      await page.keyboard.press("k");
      await page.screenshot({ path: info.outputPath("recovered.png") });
      await expect(
        page.getByRole("button", { name: "Stop", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    });
  }
}

test("right-clicking a track name never starts renaming, and Escape restores editor keys", async ({
  page,
}, info) => {
  const name = page.getByRole("textbox", { name: "Name A1", exact: true });
  await name.click({ button: "right" });
  await expect(
    page.getByRole("menu", { name: "Track A1", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: "Play forward", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("k");
  await expect(name).toHaveValue("");
  await name.fill("unsaved");
  await page.keyboard.press("Escape");
  await expect(name).toHaveValue("");
  await expect(name).not.toBeFocused();
  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: "Play forward", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("k");
  await page.screenshot({ path: info.outputPath("track-name.png") });
});

test("Escape leaves the composer with its draft and returns editor keys", async ({
  page,
}, info) => {
  const composer = page.getByRole("textbox", { name: "Message your agent" });
  await composer.fill("Keep this draft");
  await page.keyboard.press("Escape");
  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: "Play forward", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("k");
  await expect(composer).toHaveValue("Keep this draft");
  await page.screenshot({ path: info.outputPath("composer.png") });
});

test("a pointer menu restores an interrupted field, while a keyboard picker keeps its opener", async ({
  page,
}) => {
  const composer = page.getByRole("textbox", { name: "Message your agent" });
  const zoom = page.getByRole("combobox", { name: "Viewer zoom", exact: true });
  await composer.fill("Keep typing here");
  await zoom.click();
  await page.getByRole("option", { name: "Fit", exact: true }).click();
  await expect(composer).toBeFocused();
  await page.keyboard.type(" lk");
  await expect(composer).toHaveValue("Keep typing here lk");
  await page.keyboard.press("Escape");
  await zoom.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(zoom).toBeFocused();
});
