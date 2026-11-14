import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { expect } from "./fixtures";

export function waitForPreview(
  page: Page,
  { timing = false, after }: { timing?: boolean; after?: string | null } = {},
) {
  return page.waitForFunction(
    ({ timing, after }) => {
      const stage = document.querySelector(".edit-stage");
      return (
        stage?.hasAttribute("data-preview-ready") &&
        (after === undefined ||
          stage.getAttribute("data-preview-ready") !== after) &&
        (!timing || stage.getAttribute("data-preview-timing-ready") === "true")
      );
    },
    { timing, after },
    // The product allows fifteen seconds to prepare, beyond the default action timeout.
    { timeout: 20_000 },
  );
}

/** Establish an approved script-free fixture without changing its saved history. */
export async function prepareTimingPreview(
  page: Page,
  request: APIRequestContext,
) {
  await waitForPreview(page);
  await expect
    .poll(
      async () => {
        const url = await page.locator("iframe[data-live]").getAttribute("src");
        const { allowed } = z
          .object({ allowed: z.boolean() })
          .parse(await (await request.get(`${url}&cutroom-status=1`)).json());
        if (allowed) return true;
        // Asset indexing can invalidate a build before it finalizes navigation proof.
        // An unapproved navigation stays unapproved, so wait for a fresh approved one.
        await page.reload();
        await waitForPreview(page);
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await waitForPreview(page, { timing: true });
}
