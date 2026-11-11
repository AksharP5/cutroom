import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { timelineWorkload } from "../scripts/timeline-performance";
import { expect, test } from "./fixtures";

test(
  "selected Position observation leaves 500-clip playback frame timing unchanged",
  { tag: "@performance" },
  async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const project = await timelineWorkload(request, 500);
    const file = join(project.path, "index.html");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        'id="title-0"',
        'id="title-0" data-x="40" data-y="0" data-hf-edit-base-x="0" data-hf-edit-base-y="0"',
      ),
    );
    const results: {
      run: number;
      selected: boolean;
      observations: number;
      frames: number[];
      p50: number;
      p95: number;
      max: number;
    }[] = [];
    for (let run = 0; run < 3; run++) {
      for (const selected of [false, true]) {
        await page.goto("about:blank");
        await page.goto(`/#project/${project.id}`);
        await expect(
          page.locator(".edit-stage[data-preview-ready]"),
        ).toBeVisible();
        await expect(page.locator("[data-clip]")).toHaveCount(500);
        if (selected) {
          await page.locator('[data-clip="title-0"]').click();
          await expect(
            page.getByRole("textbox", { name: "Position X", exact: true }),
          ).toHaveValue("40 px");
        }
        // Observe the actual iframe's displayed frames while the editor and real media play.
        await page.evaluate(() => {
          const samples = { observations: 0 };
          Object.assign(window, { positionPlayback: samples });
          addEventListener("message", (event) => {
            if (event.data?.type === "position-warning") samples.observations++;
          });
        });
        await page
          .getByRole("button", { name: "Play forward", exact: true })
          .click();
        const frames = await page
          .frameLocator("iframe[data-live]")
          .locator("#title-0")
          .evaluate(async () => {
            const frames: number[] = [];
            const next = () =>
              new Promise<number>((resolve) => requestAnimationFrame(resolve));
            let previous = await next();
            const start = previous;
            while (previous - start < 2500) {
              const now = await next();
              frames.push(now - previous);
              previous = now;
            }
            return frames;
          });
        await page.getByRole("button", { name: "Stop", exact: true }).click();
        const observations = await page.evaluate(
          () =>
            (
              window as unknown as {
                positionPlayback: { observations: number };
              }
            ).positionPlayback.observations,
        );
        const sorted = frames.toSorted((a, b) => a - b);
        const result = {
          run,
          selected,
          observations,
          frames,
          p50: sorted[Math.floor(sorted.length * 0.5)]!,
          p95: sorted[Math.floor(sorted.length * 0.95)]!,
          max: Math.max(...frames),
        };
        results.push(result);
        if (!selected) expect(observations).toBe(0);
        else if (!process.env.CUTROOM_POSITION_BEFORE) {
          expect(observations).toBeGreaterThanOrEqual(6);
          expect(observations).toBeLessThanOrEqual(10);
        }
      }
    }
    const median = (values: number[]) =>
      values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
    const summary = [false, true].map((selected) => ({
      selected,
      p50: median(
        results
          .filter((run) => run.selected === selected)
          .map((run) => run.p50),
      ),
      p95: median(
        results
          .filter((run) => run.selected === selected)
          .map((run) => run.p95),
      ),
    }));
    expect(summary[1]!.p50 - summary[0]!.p50).toBeLessThan(1);
    expect(summary[1]!.p95 - summary[0]!.p95).toBeLessThan(1);
    const evidence = JSON.stringify(
      { browser: page.context().browser()?.version(), summary, results },
      null,
      2,
    );
    await info.attach("position-playback.json", {
      body: evidence,
      contentType: "application/json",
    });
    if (process.env.CUTROOM_POSITION_TIMING_OUT)
      await writeFile(process.env.CUTROOM_POSITION_TIMING_OUT, evidence);
    console.log(JSON.stringify({ positionPlayback: summary }));
  },
);
