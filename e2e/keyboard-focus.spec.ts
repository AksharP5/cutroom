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

test("Projects to New project focuses the name for immediate typing", async ({
  page,
}, testInfo) => {
  await page
    .getByRole("button", { name: "Cutroom projects", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Projects", exact: true })
    .getByRole("button", { name: "New project", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "New project", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  await page.screenshot({ path: testInfo.outputPath("new-project-focus.png") });
  await expect(
    dialog.getByLabel("Project name", { exact: true }),
  ).toBeFocused();
  await page.keyboard.type("Keyboard-created project");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Keyboard-created project", exact: true }),
  ).toBeVisible();
});

test("Escape closes Edit marker after Tab moves past Save", async ({
  page,
}, testInfo) => {
  await page.keyboard.press("m");
  const marker = page.locator(".tl-marker");
  await expect(marker).toHaveCount(1);
  await marker.dblclick();
  const editor = page.getByRole("dialog", { name: "Edit marker", exact: true });
  await expect(editor).toBeVisible();
  await editor.getByLabel("Marker name", { exact: true }).fill("Unsaved draft");
  await editor.getByRole("button", { name: "Save", exact: true }).focus();
  await page.keyboard.press("Tab");
  expect(
    await editor.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(false);
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: testInfo.outputPath("marker-after-escape.png"),
  });
  await expect(editor).toHaveCount(0);
  await marker.dblclick();
  await expect(editor.getByLabel("Marker name", { exact: true })).toHaveValue(
    "Marker 1",
  );
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
});
