import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";

test("open projects refresh from disk and reopen with edits made while closed", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Watcher lifecycle" },
      })
    ).json(),
  );
  const path = join(project.path, "index.html");
  const original = await readFile(path, "utf8");
  await page.goto(`/#project/${project.id}`);
  const title = page.locator('[data-clip-label="headline"] .tl-text');
  await expect(title).toHaveText("Watcher lifecycle");
  await writeFile(
    path,
    original.replaceAll("Watcher lifecycle", "Edited while open"),
  );
  await expect(title).toHaveText("Edited while open");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await writeFile(
    path,
    original.replaceAll("Watcher lifecycle", "Edited while closed"),
  );
  await page
    .locator(".home-project")
    .filter({
      has: page.locator(".home-name").getByText(project.name, { exact: true }),
    })
    .click();
  await expect(title).toHaveText("Edited while closed");
  await writeFile(
    path,
    original.replaceAll("Watcher lifecycle", "Watching again"),
  );
  await expect(title).toHaveText("Watching again");
  await page.screenshot({ path: info.outputPath("watching-again.png") });
});
