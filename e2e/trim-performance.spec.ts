import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { timelineWorkload } from "../scripts/timeline-performance";
import { expect, test } from "./fixtures";

declare global {
  interface Window {
    trimMetrics: {
      seeks: number;
      maxPending: number;
      requests: number[];
      frames: number[];
    };
  }
}

test(
  "400 clips keep edit-frame seeks bounded during a roll",
  { tag: "@performance" },
  async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const project = await timelineWorkload(request, 400);
    const runs = Number(process.env.CUTROOM_PERF_RUNS ?? 3);
    if (!Number.isInteger(runs) || runs < 1)
      throw new Error("CUTROOM_PERF_RUNS must be a positive integer.");
    const results = [];
    await page.goto(`/#project/${project.id}`);
    for (let run = 0; run < runs; run++) {
      if (run > 0) await page.reload();
      await expect(page.locator(".edit-stage")).toHaveAttribute(
        "data-preview-ready",
      );
      await expect(page.locator("[data-clip]")).toHaveCount(400);
      await page.getByRole("button", { name: "Snapping", exact: true }).click();
      await page.keyboard.press("t");
      await expect(page.locator(".tl-grid")).toHaveAttribute(
        "data-refit",
        "settled",
      );
      // All 400 clips stay mounted at Fit; a 5px roll spans most of these short clips.
      const box = (await page.locator('[data-clip="talk-3"]').boundingBox())!;
      const from = { x: box.x + box.width - 0.3, y: box.y + box.height / 2 };
      const preview = page
        .frames()
        .find((frame) => frame.url().includes("/api/isolated/"))!;
      await preview.evaluate(() => {
        addEventListener("message", (event: MessageEvent<unknown>) => {
          if (
            event.source !== parent ||
            !event.data ||
            typeof event.data !== "object" ||
            !("action" in event.data) ||
            event.data.action !== "seek" ||
            !("edit" in event.data) ||
            !("id" in event.data)
          )
            return;
          parent.postMessage(
            { source: "trim-perf", id: event.data.id, at: performance.now() },
            "*",
          );
        });
      });
      await page.evaluate(() => {
        const pending = new Set<string>();
        const metrics = {
          seeks: 0,
          maxPending: 0,
          requests: [] as number[],
          frames: [] as number[],
        };
        window.trimMetrics = metrics;
        addEventListener("message", (event: MessageEvent<unknown>) => {
          const data = event.data;
          if (
            !data ||
            typeof data !== "object" ||
            !("source" in data) ||
            !("id" in data) ||
            typeof data.id !== "string"
          )
            return;
          if (
            data.source === "trim-perf" &&
            "at" in data &&
            typeof data.at === "number"
          ) {
            pending.add(data.id);
            metrics.seeks++;
            metrics.requests.push(data.at);
            metrics.maxPending = Math.max(metrics.maxPending, pending.size);
          }
          if (data.source === "cutroom-preview") pending.delete(data.id);
        });
      });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      const timing = await page.evaluate(async (from) => {
        const metrics = window.trimMetrics;
        const lanes = document.querySelector(".tl-lanes")!;
        const start = performance.now();
        let previous = start;
        let inputs = 0;
        for (let frame = 0; frame < 180; frame++) {
          const now = await new Promise<number>((resolve) =>
            requestAnimationFrame(() => resolve(performance.now())),
          );
          metrics.frames.push(now - previous);
          previous = now;
          for (let event = 0; event < 3; event++) {
            const dx = 4.5 * Math.sin((frame * 3 + event) / 25);
            lanes.dispatchEvent(
              new PointerEvent("pointermove", {
                bubbles: true,
                pointerId: 1,
                buttons: 1,
                clientX: from.x + dx,
                clientY: from.y,
              }),
            );
            inputs++;
          }
        }
        return { ...metrics, inputs, elapsed: performance.now() - start };
      }, from);
      await expect
        .poll(() => preview.locator("[data-cutroom-edit-frame]").count())
        .toBe(1);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect
        .poll(() => preview.locator("[data-cutroom-edit-frame]").count())
        .toBe(0);
      const sorted = timing.frames.toSorted((a, b) => a - b);
      const summary = {
        clips: 400,
        inputs: timing.inputs,
        seconds: timing.elapsed / 1000,
        seeks: timing.seeks,
        seeksPerSecond: (timing.seeks * 1000) / timing.elapsed,
        maxPending: timing.maxPending,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: sorted.at(-1),
        minSeekInterval: Math.min(
          ...timing.requests
            .slice(1)
            .map((time, index) => time - timing.requests[index]!),
        ),
      };
      console.log(JSON.stringify({ run: run + 1, ...summary }));
      results.push({ summary, timing });
      expect(summary.seeks).toBeGreaterThan(10);
      expect(summary.maxPending).toBe(1);
      expect(summary.seeks).toBeLessThanOrEqual(timing.frames.length);
    }
    const percentiles = results
      .map(({ summary }) => summary.p95!)
      .toSorted((a, b) => a - b);
    const summary = {
      clips: 400,
      runs,
      medianP95: percentiles[Math.floor(percentiles.length / 2)]!,
    };
    console.log(JSON.stringify(summary));
    await info.attach("trim-frame-times.json", {
      body: JSON.stringify({ summary, results }, null, 2),
      contentType: "application/json",
    });
    const output = process.env.CUTROOM_TRIM_PERF_DIR;
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(
        join(output, "400-trim.json"),
        JSON.stringify({ summary, results }, null, 2),
      );
    }
    // Repeat the roll so one shared-runner pause cannot fail the pacing budget.
    // Seek backlog and throughput must still pass on every run.
    expect(summary.medianP95).toBeLessThan(75);
  },
);
