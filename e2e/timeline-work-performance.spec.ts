import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { timelineWorkload } from "../scripts/timeline-performance";
import { waitForPreview } from "./preview-ready";
import { filmstripSettle, watchFilmstrip } from "./filmstrip-performance";
import {
  installWorkCounters,
  measureWork,
  settle,
  type Work,
} from "./work-counts";

/**
 * Budgets for the work each gesture causes on 500 clips. Each is the count measured on main
 * (in the comment, from three runs and runs at 4x and 6x CPU throttling) plus a margin for
 * browser versions, well under what one extra layout, restyle or render per input or frame
 * adds. docs/performance.md, Work counts, has the table and what each budget caught.
 */
const budgets = {
  // 16 Ctrl+wheel steps, one per two frames. Each step forces one style and one layout.
  "wheel zoom": {
    commits: 40, // 32
    bodyPaints: 24, // 17 to 18
    editorLayouts: 50, // 41
    editorForced: 40, // 32
    editorRestyled: 3600, // 2387; an inherited --ppf restyles about 790 elements a step
  },
  // 60 scroll steps of 8 px, one per frame. The test's own scrollLeft write forces one each.
  scroll: {
    commits: 2, // 0
    bodyPaints: 16, // 1 to 9, as filmstrip frames arrive
    editorLayouts: 10, // 5
    editorForced: 70, // 64
    editorRestyled: 3500, // 2328
  },
  // 6 eased Ctrl+= steps. Restyles follow the easing's frames, so only counts are budgeted.
  "key zoom": {
    commits: 10, // 6
    bodyPaints: 16, // 12
    editorLayouts: 24, // 18
    editorForced: 24, // 12 to 16
  },
  // 40 pointer moves of 2 px on a clip, then Esc.
  drag: {
    commits: 4, // 2
    bodyPaints: 64, // 44 to 52
    editorLayouts: 60, // 45 to 47
    editorForced: 12, // 7
    editorRestyled: 3500, // 2247 to 2355
  },
  // 40 pointer moves on a clip's end, then Esc.
  trim: {
    commits: 4, // 1
    bodyPaints: 50, // 39
    editorLayouts: 56, // 42 to 44
    editorForced: 10, // 4 to 6
    editorRestyled: 3300, // 2176 to 2179
    previewForced: 8, // 1 to 2
  },
  // 40 pointer moves of up to 9 px on a clip's body with the Trim tool, then Esc. Each move
  // decodes the slipped clip's in and out in turn for the viewer.
  slip: {
    commits: 4, // 3
    bodyPaints: 50, // 39
    editorLayouts: 56, // 43
    editorForced: 10, // 6
    editorRestyled: 3300, // 2179 to 2180
    previewForced: 30, // 17 to 19
  },
  // The same on its name strip, which slides it between its neighbours.
  slide: {
    commits: 4, // 2
    bodyPaints: 50, // 39
    editorLayouts: 56, // 41
    editorForced: 10, // 4
    editorRestyled: 3300, // 2197
    previewForced: 30, // 16
  },
  // Each edit, until the preview shows it and the editor has been quiet for 30 frames.
  "ripple delete": {
    commits: 45, // 27 to 34
    bodyPaints: 24, // 12 to 15
    editorLayouts: 20, // 14
    editorForced: 8, // 4
    previewForced: 900, // 744 to 745
  },
  undo: {
    commits: 45, // 24 to 31
    bodyPaints: 24, // 10 to 16
    editorLayouts: 20, // 10 to 13
    editorForced: 8, // 3
    previewForced: 900, // 747 to 748
  },
  // Comma with the Trim tool slips the selected clip a frame; after S, period slides it.
  "slip key": {
    commits: 45, // 20 to 21
    bodyPaints: 24, // 3
    editorLayouts: 20, // 5
    editorForced: 8, // 0
    previewForced: 900, // 774 to 775
  },
  "slide key": {
    commits: 45, // 16 to 18
    bodyPaints: 24, // 3
    editorLayouts: 20, // 2
    editorForced: 8, // 1
    previewForced: 900, // 2
  },
  W: {
    commits: 45, // 24 to 33
    bodyPaints: 24, // 12 to 15
    editorLayouts: 20, // 10 to 11
    editorForced: 8, // 3
    previewForced: 900, // 774 to 775
  },
  // 40 ruler moves of 3 px, one per two frames.
  scrub: {
    commits: 4, // 2
    bodyPaints: 1, // 0
    editorLayouts: 50, // 42
    editorForced: 4, // 0
    editorRestyled: 150, // 95
    previewForced: 2400, // 1069 to 1475, as the preview's seeks coalesce
  },
  // Play at 1x, at Fit, for 120 frames. The preview's runtime plays on its own clock, so its
  // work is budgeted per frame it drew.
  play: {
    commits: 15, // 2 to 8
    bodyPaints: 1, // 0
    editorLayouts: 180, // 51 to 126
    editorForced: 20, // 9 to 14
    previewForcedPerFrame: 24, // 13 to 15
  },
} satisfies Record<string, Partial<Record<Metric, number>>>;

type Gesture = keyof typeof budgets;
type Metric = keyof ReturnType<typeof metrics>;

const metrics = (work: Work, previewFrames = Number.NaN) => ({
  commits: work.commits,
  bodyPaints: work.bodyPaints,
  editorLayouts: work.editor.layouts,
  editorForced: work.editor.forced,
  editorRestyled: work.editor.styled,
  previewForced: work.preview.forced,
  previewForcedPerFrame: work.preview.forced / previewFrames,
});

const frames = (page: Page, count = 2) =>
  page.evaluate(async (count) => {
    for (let i = 0; i < count; i++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
  }, count);

test(
  "500-clip timeline and viewer gestures stay inside their work budgets",
  { tag: "@performance" },
  async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const graded = process.env.CUTROOM_PERF_GRADED === "1";
    await installWorkCounters(page);
    if (graded) await watchFilmstrip(page);
    const project = await timelineWorkload(request, 500, { graded });
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
    await expect(page.locator("[data-clip]")).toHaveCount(500);
    await expect
      .poll(() =>
        page.locator(".tl-bodies").evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          return canvas
            .getContext("2d")!
            .getImageData(0, 80, canvas.width, 80)
            .data.some((value, index) => index % 4 === 3 && value > 0);
        }),
      )
      .toBe(true);
    if (graded)
      console.log(
        JSON.stringify({
          count: 500,
          filmstrip: await filmstripSettle(page),
        }),
      );
    else await page.waitForTimeout(3000);
    const cdp = await page.context().newCDPSession(page);
    // Diagnostic: counts should not move under CPU throttling, while frame times do.
    const throttle = Number(process.env.CUTROOM_WORK_THROTTLE ?? 1);
    if (throttle > 1)
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    const fit = async () => {
      await page.getByRole("slider", { name: "Zoom", exact: true }).dblclick();
      await page.getByRole("region", { name: "Viewer", exact: true }).click();
      await page.waitForTimeout(700);
    };
    const results: Partial<Record<Gesture, Work>> = {};
    // An edit's work ends once the preview shows the new revision and the editor goes quiet.
    const edit = async (press: () => Promise<void>) => {
      const after = await page
        .locator(".edit-stage")
        .getAttribute("data-preview-ready");
      await press();
      await waitForPreview(page, { after });
      await settle(page);
    };
    const measure = async (
      gesture: Gesture,
      perform: () => Promise<unknown>,
    ) => {
      results[gesture] = await measureWork(page, cdp, perform);
    };

    await fit();
    await measure("wheel zoom", () =>
      page.evaluate(async () => {
        const scroller = document.querySelector(".tl-scroll")!;
        const { x, y } = scroller.getBoundingClientRect();
        for (let step = 0; step < 16; step++) {
          scroller.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: -24,
              ctrlKey: true,
              clientX: x + 350,
              clientY: y + 80,
              bubbles: true,
              cancelable: true,
            }),
          );
          for (let i = 0; i < 2; i++)
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }),
    );
    await page.waitForTimeout(500);
    await measure("scroll", () =>
      page.evaluate(async () => {
        const scroller = document.querySelector(".tl-scroll")!;
        const start = scroller.scrollLeft;
        for (let step = 1; step <= 60; step++) {
          scroller.scrollLeft = start + step * 8;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }),
    );
    await fit();
    await measure("key zoom", async () => {
      for (let step = 0; step < 6; step++) {
        await page.keyboard.press("Control+Equal");
        await page.waitForTimeout(150);
      }
      await frames(page, 4);
    });
    await fit();

    const clip = page.locator('[data-clip="talk-3"]');
    const box = (await clip.boundingBox())!;
    const y = box.y + box.height / 2;
    const pointerGesture = async (x: (step: number) => number, at = y) => {
      await page.mouse.move(x(0), at);
      await page.mouse.down();
      for (let step = 1; step <= 40; step++) {
        await page.mouse.move(x(step), at);
        await frames(page);
      }
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await frames(page, 4);
    };
    const middle = box.x + box.width / 2;
    await measure("drag", () => pointerGesture((step) => middle + step * 2));
    const end = box.x + box.width - 0.3;
    await measure("trim", () => pointerGesture((step) => end - (step % 10)));

    await clip.click({ force: true });
    await page.waitForTimeout(300);
    await measure("ripple delete", () =>
      edit(() => page.keyboard.press("Delete")),
    );
    await expect(clip).toHaveCount(0);
    await measure("undo", () => edit(() => page.keyboard.press("Control+z")));
    await expect(clip).toHaveCount(1);

    const ruler = (await page.locator(".tl-ruler").boundingBox())!;
    await measure("scrub", async () => {
      await page.mouse.move(ruler.x + 20, ruler.y + 10);
      await page.mouse.down();
      for (let step = 1; step <= 40; step++) {
        await page.mouse.move(ruler.x + 20 + step * 3, ruler.y + 10);
        await frames(page);
      }
      await page.mouse.up();
      await frames(page, 4);
    });
    await page.waitForTimeout(500);
    const placements = () =>
      page
        .locator("[data-clip]")
        .evaluateAll((clips) =>
          clips.map((clip) => (clip as HTMLElement).style.cssText),
        );
    const before = await placements();
    await measure("W", () => edit(() => page.keyboard.press("w")));
    expect(await placements(), "W trimmed a clip").not.toEqual(before);
    const preview = (await page
      .locator("iframe[data-live]")
      .elementHandle()
      .then((frame) => frame?.contentFrame()))!;
    let previewFrames = 0;
    await measure("play", async () => {
      const counted = preview.evaluate(
        () =>
          new Promise<number>((resolve) => {
            let count = 0;
            const tick = () => {
              if (document.documentElement.dataset.workStop)
                return resolve(count);
              count++;
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
      await page
        .getByRole("button", { name: "Play forward", exact: true })
        .click();
      await frames(page, 120);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await frames(page, 4);
      await preview.evaluate(
        () => (document.documentElement.dataset.workStop = "1"),
      );
      previewFrames = await counted;
    });

    // The Trim tool slips a clip by its body and slides it by its name strip.
    await page.keyboard.press("t");
    const trimmed = (await clip.boundingBox())!;
    const body = trimmed.y + trimmed.height - 4;
    const centre = trimmed.x + trimmed.width / 2;
    await measure("slip", () =>
      pointerGesture((step) => centre + (step % 10), body),
    );
    await measure("slide", () =>
      pointerGesture((step) => centre + (step % 10), trimmed.y + 4),
    );
    await page.mouse.click(centre, body);
    await page.waitForTimeout(300);
    await measure("slip key", () => edit(() => page.keyboard.press(",")));
    await page.keyboard.press("s");
    await measure("slide key", () => edit(() => page.keyboard.press(".")));

    const report = Object.fromEntries(
      Object.entries(results).map(([gesture, work]) => [
        gesture,
        {
          ...work,
          ...(gesture === "play" && { previewFrames }),
          budget: budgets[gesture as Gesture],
        },
      ]),
    );
    console.log(JSON.stringify({ timelineWork: report }));
    await info.attach("timeline-work.json", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    for (const [gesture, budget] of Object.entries(budgets)) {
      const work = results[gesture as Gesture]!;
      // A probe that saw nothing would pass every budget.
      expect(
        work.editor.styles,
        `${gesture}: editor work seen`,
      ).toBeGreaterThan(0);
      const measured = metrics(work, previewFrames);
      for (const [metric, limit] of Object.entries(budget)) {
        // The graded probe measures the timeline. Its native preview does additional
        // work that the default, ungraded workload budgets independently.
        if (graded && metric === "previewForced") continue;
        expect
          .soft(measured[metric as Metric], `${gesture}: ${metric}`)
          .toBeLessThanOrEqual(limit);
      }
    }
    for (const gesture of [
      "ripple delete",
      "undo",
      "W",
      "slip",
      "slide",
      "slip key",
      "slide key",
      "scrub",
      "play",
    ] as const)
      expect(
        results[gesture]!.preview.styles,
        `${gesture}: preview work seen`,
      ).toBeGreaterThan(0);
  },
);
