import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";

test("a fresh starter loads its local font and keeps the same picture after seeking backwards", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "First cut & next steps", duration: 2 },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  const preview = page.frameLocator("iframe[data-live]");
  await expect(preview.locator("#headline")).toHaveText(project.name);
  await expect(preview.locator("#caption")).toHaveText(
    "Drop media in, or ask your agent to start.",
  );
  expect(
    await preview.locator("#headline").evaluate(async (title) => {
      await title.ownerDocument.fonts.ready;
      return [...title.ownerDocument.fonts].some(
        (font) => font.family === "Instrument Sans" && font.status === "loaded",
      );
    }),
  ).toBe(true);
  for (const [id, label] of [
    ["rule", "Background"],
    ["headline", "Project title"],
    ["caption", "Getting started"],
  ] as const) {
    await expect(page.locator(`[data-clip-label="${id}"]`)).toContainText(
      label,
    );
  }
  const initial = await page.locator("iframe[data-live]").screenshot();
  const time = page.getByRole("button", {
    name: "Current time. Click to type a time.",
  });
  for (const value of ["00:00:01:20", "00:00:00:10", "00:00:00:00"]) {
    await time.click();
    const input = page.getByRole("textbox", { name: "Go to time" });
    await input.pressSequentially(value.replaceAll(":", ""));
    await input.press("Enter");
    await expect(time).toHaveText(value);
    await expect(preview.locator("#headline")).toBeVisible();
    expect(await page.locator("iframe[data-live]").screenshot()).toEqual(
      initial,
    );
  }
});
