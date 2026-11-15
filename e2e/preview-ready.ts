import type { Page } from "@playwright/test";

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
