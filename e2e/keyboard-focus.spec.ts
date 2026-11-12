import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";

test.beforeEach(async ({ page, request }) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Keyboard focus" },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(
    page.getByRole("button", { name: "Snapping", exact: true }),
  ).toBeVisible();
});

test("Space activates a toolbar button reached by keyboard without playing", async ({
  page,
}) => {
  const snapping = page.getByRole("button", { name: "Snapping", exact: true });
  await snapping.click();
  await expect(snapping).toHaveAttribute("aria-pressed", "false");
  // Tab away and back so this is keyboard focus, regardless of pointer-focus policy.
  await snapping.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(snapping).toBeFocused();
  expect(
    await snapping.evaluate((button) => button.matches(":focus-visible")),
  ).toBe(true);
  await page.keyboard.press("Space");
  await expect(snapping).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    "00:00:00:00",
  );
});

test("Space plays after mouse activation of toolbar and transport buttons", async ({
  page,
}) => {
  const snapping = page.getByRole("button", { name: "Snapping", exact: true });
  const play = page.getByRole("button", { name: "Play forward", exact: true });
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const now = page.getByRole("button", { name: /^Current time/ });
  await snapping.click();
  await expect(snapping).not.toBeFocused();
  await page.keyboard.press("Space");
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await expect(now).not.toHaveText("00:00:00:00");
  await expect(snapping).toHaveAttribute("aria-pressed", "false");
  await stop.click();
  await expect(stop).not.toBeFocused();
  await page.keyboard.press("Space");
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(stop).toHaveAttribute("aria-pressed", "true");
});

test("Space stays native in text fields, dialogs and viewer menus", async ({
  page,
}) => {
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const now = page.getByRole("button", { name: /^Current time/ });
  const composer = page.getByPlaceholder("Describe the next edit");
  await composer.fill("two");
  await composer.press("Space");
  await expect(composer).toHaveValue("two ");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  const file = dialog.getByLabel("File name", { exact: true });
  await file.fill("two");
  await file.press("Space");
  await expect(file).toHaveValue("two ");
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Space");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .focus();
  await page.keyboard.press("Space");
  await expect(dialog).toBeHidden();
  const zoom = page.getByRole("combobox", { name: "Viewer zoom", exact: true });
  await zoom.click();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("listbox", { name: "Viewer zoom options", exact: true }),
  ).toBeHidden();
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(now).toHaveText("00:00:00:00");
});
