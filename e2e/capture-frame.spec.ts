import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";

const pngSize = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
});

test("Ctrl+Alt+G and the Export dialog save the playhead's frame as a PNG at the composition's size", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Stills", width: 1280, height: 720 },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("[data-clip]").first()).toBeVisible();
  await page.getByRole("region", { name: "Viewer", exact: true }).click();
  for (let step = 0; step < 15; step++) await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: /^Current time/ }),
  ).toContainText("00:00:00:15");

  await page.keyboard.press("Control+Alt+g");
  await expect(
    page.getByText("Saved Stills 00-00-00-15.png in .cutroom/renders"),
  ).toBeVisible({ timeout: 30_000 });
  const renders = join(project.path, ".cutroom/renders");
  const first = await readFile(join(renders, "Stills 00-00-00-15.png"));
  expect(pngSize(first)).toEqual({ width: 1280, height: 720 });

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "Save frame as PNG" }).click();
  await expect(
    page.getByText("Saved Stills 00-00-00-15 2.png in .cutroom/renders"),
  ).toBeVisible({ timeout: 30_000 });
  expect(
    pngSize(await readFile(join(renders, "Stills 00-00-00-15 2.png"))),
  ).toEqual({ width: 1280, height: 720 });
});
