import { timelineWorkload } from "../scripts/timeline-performance";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

declare global {
  interface Window {
    previewTimingSamples: { key: number; shown: number }[];
  }
}

test(
  "a saved one-frame Start edit confirms the 500-clip picture promptly",
  { tag: "@performance" },
  async ({ page, request }, info) => {
    test.setTimeout(120000);
    const project = await timelineWorkload(request, 500);
    // Establish stacking before measuring the timing-only path.
    for (const by of [1, -1]) {
      const view = TimelineViewSchema.parse(
        await (
          await request.get(`/api/cutroom/projects/${project.id}/timeline`)
        ).json(),
      );
      const response = await request.post(
        `/api/cutroom/projects/${project.id}/commands`,
        {
          data: {
            composition: "index.html",
            expectedRevision: view.revision,
            label: "Establish stacking",
            commands: [
              { type: "move", clipIds: ["title-1"], by, mode: "overwrite" },
            ],
          },
        },
      );
      expect(response.ok()).toBe(true);
    }
    await page.addInitScript(() => {
      window.previewTimingSamples = [];
      let key = 0;
      addEventListener(
        "keydown",
        (event: KeyboardEvent) => {
          if (event.code === "Enter") key = performance.now();
        },
        true,
      );
      new MutationObserver((records) => {
        for (const record of records) {
          const element = record.target;
          if (
            key &&
            element instanceof HTMLElement &&
            element.matches(".edit-stage[data-preview-ready]")
          ) {
            window.previewTimingSamples.push({ key, shown: performance.now() });
            key = 0;
          }
        }
      }).observe(document, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-preview-ready"],
      });
    });
    const stall = Number(process.env.CUTROOM_PREVIEW_TIMING_STALL_MS ?? 0);
    if (stall)
      await page.route(
        "**/isolated-preview?*cutroom-timing*",
        async (route) => {
          await new Promise((resolve) => setTimeout(resolve, stall));
          await route.continue();
        },
      );
    await page.goto(`/#project/${project.id}`);
    await page.waitForFunction(() =>
      document.querySelector(".edit-stage")?.hasAttribute("data-preview-ready"),
    );
    await page.waitForTimeout(4500);
    await page.locator('[data-clip="title-1"]').click({ force: true });
    const doc = await page.locator("iframe[data-live]").getAttribute("src");
    for (let run = 0; run < 5; run++) {
      const field = page.getByLabel("Start", { exact: true });
      await field.focus();
      await field.press("ArrowUp");
      const before = await page
        .locator(".edit-stage")
        .getAttribute("data-preview-ready");
      await field.press("Enter");
      await page.waitForFunction((before) => {
        const stage = document.querySelector(".edit-stage");
        return (
          stage?.hasAttribute("data-preview-ready") &&
          stage.getAttribute("data-preview-ready") !== before
        );
      }, before);
      expect(await page.locator("iframe[data-live]").getAttribute("src")).toBe(
        doc,
      );
    }
    const samples = await page.evaluate(() => window.previewTimingSamples);
    expect(samples).toHaveLength(5);
    const times = samples
      .map(({ key, shown }) => shown - key)
      .sort((a, b) => a - b);
    const median = times[2]!;
    console.log(JSON.stringify({ editToPictureMs: times, median }));
    await info.attach("edit-to-picture.json", {
      body: JSON.stringify({ samples, median }, null, 2),
      contentType: "application/json",
    });
    expect(median).toBeLessThan(600);
  },
);
