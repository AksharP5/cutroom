import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { timelineWorkload } from "../scripts/timeline-performance";
import { expect, test } from "./fixtures";
import { positionField, waitFrames } from "./position-helpers";

// A trace snapshots the whole 500-clip page after every click and check, on the editor's main
// thread. Those snapshots land inside the measured click, often between the outline's frame and
// the task that stamps its paint.
test.use({ trace: "off" });

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;

test(
  "picture selection paints within three frames on 500 clips",
  { tag: "@performance" },
  async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const clicksPerRun = 20;
    const project = await timelineWorkload(request, 500);
    const file = join(project.path, "index.html");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        'id="title-0"',
        'id="title-0" data-x="40" data-y="0" data-hf-edit-base-x="0" data-hf-edit-base-y="0"',
      ),
    );
    // Test-only negative control. This runs inside the actual bridge hit path, in the iframe.
    const stall = Number(process.env.CUTROOM_PICTURE_HIT_STALL_MS ?? 0);
    if (stall > 0)
      await page.addInitScript((stall) => {
        const elementsFromPoint = Document.prototype.elementsFromPoint;
        Document.prototype.elementsFromPoint = function (x, y) {
          const end = performance.now() + stall;
          while (performance.now() < end) {
            /* injected hit-path stall */
          }
          return elementsFromPoint.call(this, x, y);
        };
      }, stall);
    const runs = [];
    for (let run = 0; run < 3; run++) {
      await page.goto("about:blank");
      await page.goto(`/#project/${project.id}`);
      await expect(
        page.locator(".edit-stage[data-preview-ready]"),
      ).toBeVisible();
      await expect(page.locator("[data-clip]")).toHaveCount(500);
      // Match #63's real-media warm-up. Cold means the first picture hit, after sprites and
      // waveforms are drawn, rather than measuring startup media decoding as input latency.
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
      await page.waitForTimeout(4500);
      const hits = await page
        .frameLocator("iframe[data-live]")
        .locator("#title-0")
        .evaluateHandle(() => {
          const durations: number[] = [];
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              if (entry.name === "cutroom:picture-hit")
                durations.push(entry.duration);
          }).observe({ type: "measure" });
          return durations;
        });
      const paints = await page
        .locator(".edit-select")
        .evaluateHandle((surface) => {
          const samples: {
            pointerDown: number;
            painted: number;
            outlined: number;
            duration: number;
            clipId: string;
          }[] = [];
          const outline = surface.querySelector<HTMLElement>(
            ".edit-select-outline",
          )!;
          let pending: { start: number; clipId: string } | null = null;
          let scheduled = false;
          surface.addEventListener(
            "pointerdown",
            (event) => {
              pending = {
                start: (event as PointerEvent).timeStamp,
                clipId: samples.length % 2 === 0 ? "talk-0" : "title-0",
              };
            },
            true,
          );
          new MutationObserver(() => {
            if (
              !pending ||
              scheduled ||
              outline.hidden ||
              outline.dataset.outlined !== pending.clipId
            )
              return;
            scheduled = true;
            const outlined = performance.now();
            // A task after the next rAF runs after that frame's rendering opportunity. Read the
            // real callback clock so queueing, bridge, React, geometry and paint delays all count.
            requestAnimationFrame(() =>
              setTimeout(() => {
                if (
                  !pending ||
                  outline.hidden ||
                  outline.dataset.outlined !== pending.clipId
                )
                  throw new Error("Selection disappeared before paint");
                const painted = performance.now();
                samples.push({
                  pointerDown: pending.start,
                  outlined,
                  painted,
                  duration: painted - pending.start,
                  clipId: pending.clipId,
                });
                pending = null;
                scheduled = false;
              }, 0),
            );
          }).observe(outline, { attributes: true, subtree: true });
          return samples;
        });
      const picture = await page.locator(".edit-picture").boundingBox();
      if (!picture) throw new Error("Picture missing");
      const scale = picture.width / 1920;
      for (let press = 0; press < clicksPerRun; press++) {
        const title = press % 2 === 1;
        await page.mouse.click(
          // The workload's titles sit lower left; title-0 is offset 40 px right.
          picture.x + (title ? 220 : 900) * scale,
          picture.y + (title ? 935 : 600) * scale,
        );
        // Check the inspector once the paint is stamped. Its locator walks the whole page on
        // the editor's main thread and would otherwise be timed as selection work.
        await expect
          .poll(async () => (await paints.jsonValue()).length)
          .toBe(press + 1);
        await expect(positionField(page)).toHaveValue(title ? "40 px" : "0 px");
      }
      await waitFrames(page, 2);
      const samples = await paints.jsonValue();
      const hitDurations = await hits.jsonValue();
      runs.push({
        run,
        coldClick: samples[0],
        samples,
        max: Math.max(...samples.map((sample) => sample.duration)),
        hitDurations,
      });
      await paints.dispose();
      await hits.dispose();
    }
    const coldDeadline = 67;
    const deadline = 50;
    const maxLateRate = 0.05;
    // The November 20–21 CI sample peaked at 69.9 ms. Keep a separate limit
    // for a single freeze, even if the first click and the pooled rate pass.
    const paintCeiling = 150;
    const clicks = runs.flatMap((run) => run.samples);
    const lateClicks = clicks.filter(
      ({ duration }) => duration > deadline,
    ).length;
    const lateRate = lateClicks / clicks.length;
    const maxClick = Math.max(...clicks.map(({ duration }) => duration));
    const medianCold = median(runs.map((run) => run.coldClick!.duration));
    const hitMedian = median(runs.flatMap((run) => run.hitDurations));
    const evidence = JSON.stringify(
      {
        browser: page.context().browser()?.version(),
        budget: { coldDeadline, deadline, lateRate: maxLateRate, paintCeiling },
        medianCold,
        maxClick,
        lateClicks,
        lateRate,
        hitMedian,
        runs,
      },
      null,
      2,
    );
    const evidencePath = info.outputPath("picture-selection-paint.json");
    await writeFile(evidencePath, evidence);
    await info.attach("picture-selection-paint", {
      path: evidencePath,
      contentType: "application/json",
    });
    if (process.env.CUTROOM_PICTURE_TIMING_OUT)
      await writeFile(process.env.CUTROOM_PICTURE_TIMING_OUT, evidence);
    console.log(
      JSON.stringify({
        pictureSelection: {
          maxima: runs.map((run) => run.max),
          medianCold,
          lateClicks,
          lateRate,
          hitMedian,
        },
      }),
    );
    // One hit per press, and at most one more for the pointer coming to rest before it.
    for (const run of runs) {
      expect(run.hitDurations.length).toBeGreaterThanOrEqual(clicksPerRun);
      expect(run.hitDurations.length).toBeLessThanOrEqual(2 * clicksPerRun);
    }
    // Give the first click four frames at 60 Hz. Keep three frames for 95% of
    // all clicks, with a separate ceiling for an isolated stall.
    expect(
      medianCold,
      "median first pointer-down to outline-paint delay",
    ).toBeLessThanOrEqual(coldDeadline);
    expect(
      lateRate,
      `${lateClicks}/${clicks.length} clicks took more than ${deadline} ms to paint`,
    ).toBeLessThanOrEqual(maxLateRate);
    expect(
      maxClick,
      "slowest pointer-down to outline-paint delay",
    ).toBeLessThanOrEqual(paintCeiling);
  },
);
