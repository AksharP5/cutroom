import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";

/** Start the native drag before locating a track: its drop bands appear at dragstart. */
export async function startMediaDrag(page: Page, row: Locator) {
  await expect(row).toHaveAttribute("draggable", "true");
  await row.hover();
  await page.mouse.down();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, {
    steps: 2,
  });
  await expect(page.locator(".tl-drop-above")).toBeVisible();
}
