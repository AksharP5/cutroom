import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { expect } from "./fixtures";

export async function createPositionProject(
  request: APIRequestContext,
  data: { name: string; width: number; height: number; duration: number },
  html?: string,
) {
  const project = ProjectSchema.parse(
    await (await request.post("/api/cutroom/projects", { data })).json(),
  );
  if (html) await writeFile(join(project.path, "index.html"), html);
  return project;
}

export function positionField(page: Page, name = "Position X") {
  return page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("textbox", {
      name,
      exact: true,
    });
}

export async function seekFrame(page: Page, frame: number) {
  await page
    .getByRole("button", {
      name: "Current time. Click to type a time.",
      exact: true,
    })
    .click();
  const time = page.getByRole("textbox", { name: "Go to time", exact: true });
  await time.pressSequentially(
    String(Math.floor(frame / 30) * 100 + (frame % 30)).padStart(8, "0"),
  );
  await time.press("Enter");
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
}

export async function afterPaint<T>(
  page: Page,
  action: () => Promise<T>,
): Promise<T> {
  const stage = page.locator(".edit-stage[data-preview-ready]");
  await expect(stage).toBeVisible();
  const before = await stage.getAttribute("data-preview-ready");
  const result = await action();
  await expect(stage).not.toHaveAttribute("data-preview-ready", before!);
  await expect(stage).toBeVisible();
  return result;
}

export async function waitFrames(page: Page, count = 2) {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
  }, count);
}
