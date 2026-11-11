import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { timelineWorkload } from "../scripts/timeline-performance";
import { expect, test } from "./fixtures";
import { positionField, waitFrames } from "./position-helpers";

interface MeasuredWindow extends Window {
  positionPerf: {
    observations: { start: number; duration: number }[];
    boxes: number[];
    frames: number[];
    running: boolean;
    observer: PerformanceObserver;
  };
}

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;

test(
  "Position observation, outline tracking and picture hit tests stay in budget during 500-clip playback and scrubbing",
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
      mode: "playback" | "scrub";
      selected: boolean;
      interval: number;
      observations: MeasuredWindow["positionPerf"]["observations"];
      boxes: number[];
      frames: number[];
      maxObservation: number;
      lateFrames: number;
    }[] = [];
    for (let run = 0; run < 3; run++) {
      for (const mode of ["playback", "scrub"] as const) {
        for (const selected of [false, true]) {
          await page.goto("about:blank");
          await page.goto(`/#project/${project.id}`);
          await expect(
            page.locator(".edit-stage[data-preview-ready]"),
          ).toBeVisible();
          await expect(page.locator("[data-clip]")).toHaveCount(500);
          if (selected) {
            await page.locator('[data-clip="title-0"]').click();
            await expect(positionField(page)).toHaveValue("40 px");
          }
          // Zoom both conditions equally so ruler drags can seek within the title's 4 seconds.
          if (mode === "scrub") {
            for (let i = 0; i < 10; i++)
              await page.keyboard.press("Control+Equal");
          }
          await waitFrames(page, 15);
          const preview = page
            .frameLocator("iframe[data-live]")
            .locator("#title-0");
          const interval = await preview.evaluate(async () => {
            const entries: number[] = [];
            for (let i = 0; i < 20; i++) {
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              entries.push(performance.now());
            }
            const gaps = entries.slice(1).map((at, i) => at - entries[i]!);
            return gaps.toSorted((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
          });
          await preview.evaluate(() => {
            const stats = {
              observations: [] as { start: number; duration: number }[],
              boxes: [] as number[],
              frames: [] as number[],
              running: true,
              observer: new PerformanceObserver((list) => {
                for (const entry of list.getEntries())
                  if (entry.name === "cutroom:position-observation")
                    stats.observations.push({
                      start: entry.startTime,
                      duration: entry.duration,
                    });
                  else if (entry.name === "cutroom:clip-box")
                    stats.boxes.push(entry.duration);
              }),
            };
            stats.observer.observe({ type: "measure" });
            Object.assign(window, { positionPerf: stats });
            let previous = performance.now();
            const sample = () => {
              const now = performance.now(); // Actual callback entry, not rAF's scheduled timestamp.
              stats.frames.push(now - previous);
              previous = now;
              if (stats.running) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          if (mode === "playback") {
            await page
              .getByRole("button", { name: "Play forward", exact: true })
              .click();
            await page.waitForTimeout(2500);
            await page
              .getByRole("button", { name: "Stop", exact: true })
              .click();
          } else {
            const ppf = await page
              .locator(".tl-grid")
              .evaluate((el) =>
                Number.parseFloat(
                  getComputedStyle(el).getPropertyValue("--ppf"),
                ),
              );
            const ruler = await page.locator(".tl-ruler").boundingBox();
            if (!ruler) throw new Error("Timeline ruler missing");
            await page.mouse.move(ruler.x + 3 * ppf, ruler.y + 12);
            await page.mouse.down();
            for (let i = 0; i < 90; i++) {
              await page.mouse.move(
                ruler.x + (3 + (i % 75)) * ppf,
                ruler.y + 12,
              );
              await waitFrames(page, 1);
            }
            await page.mouse.up();
            await expect(
              page.locator(".edit-stage[data-preview-ready]"),
            ).toBeVisible();
          }
          await waitFrames(page, 2);
          const samples = await preview.evaluate(() => {
            const stats = (window as unknown as MeasuredWindow).positionPerf;
            stats.running = false;
            stats.observer.disconnect();
            return {
              observations: stats.observations,
              boxes: stats.boxes,
              frames: stats.frames.slice(1),
            };
          });
          results.push({
            run,
            mode,
            selected,
            interval,
            ...samples,
            maxObservation: Math.max(
              0,
              ...samples.observations.map((entry) => entry.duration),
            ),
            lateFrames: samples.frames.filter((gap) => gap > interval * 1.5)
              .length,
          });
        }
      }
    }
    const summary = (["playback", "scrub"] as const).flatMap((mode) =>
      [false, true].map((selected) => {
        const runs = results.filter(
          (result) => result.mode === mode && result.selected === selected,
        );
        return {
          mode,
          selected,
          observations: runs.reduce(
            (sum, result) => sum + result.observations.length,
            0,
          ),
          maxObservation: Math.max(
            ...runs.map((result) => result.maxObservation),
          ),
          boxReads: runs.reduce((sum, result) => sum + result.boxes.length, 0),
          maxBoxRead: Math.max(0, ...runs.flatMap((result) => result.boxes)),
          lateFrames: runs.map((result) => result.lateFrames),
          medianLateRate: median(
            runs.map((result) => result.lateFrames / result.frames.length),
          ),
        };
      }),
    );
    const evidence = JSON.stringify(
      { browser: page.context().browser()?.version(), summary, results },
      null,
      2,
    );
    await info.attach("position-observation.json", {
      body: evidence,
      contentType: "application/json",
    });
    if (process.env.CUTROOM_POSITION_TIMING_OUT)
      await writeFile(process.env.CUTROOM_POSITION_TIMING_OUT, evidence);
    console.log(JSON.stringify({ positionObservation: summary }));
    for (const result of results) {
      expect(result.frames.length).toBeGreaterThan(30);
      if (!result.selected) {
        expect(result.observations).toEqual([]);
        expect(result.boxes).toEqual([]);
      } else {
        // The outline reads one clip's box per displayed frame, never the other 499.
        expect(result.boxes.length).toBeGreaterThan(0);
        expect(result.boxes.length).toBeLessThanOrEqual(
          result.frames.length * 2 + 4,
        );
        expect(
          Math.max(...result.boxes),
          `${result.mode} run ${result.run}: outline box budget`,
        ).toBeLessThan(5);
        // Playback reads a layout the frame already made, so the usual read costs nothing.
        if (result.mode === "playback")
          expect(
            median(result.boxes),
            `playback run ${result.run}: usual outline box read`,
          ).toBeLessThan(0.5);
        expect(result.observations.length).toBeGreaterThanOrEqual(
          result.mode === "playback" ? 6 : 1,
        );
        expect(result.observations.length).toBeLessThanOrEqual(
          result.mode === "playback" ? 10 : result.frames.length + 2,
        );
        expect(
          result.maxObservation,
          `${result.mode} run ${result.run}: observer budget`,
        ).toBeLessThan(5);
      }
    }
    for (const mode of ["playback", "scrub"] as const) {
      const none = summary.find(
        (result) => result.mode === mode && !result.selected,
      )!;
      const positioned = summary.find(
        (result) => result.mode === mode && result.selected,
      )!;
      expect(
        positioned.medianLateRate - none.medianLateRate,
        `${mode}: added late-frame rate`,
      ).toBeLessThan(0.05);
    }

    // A press on the picture asks the preview what is under it, once, among all 500 clips.
    await page.locator('[data-clip="talk-0"]').click();
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
    const picture = await page.locator(".edit-picture").boundingBox();
    if (!picture) throw new Error("Picture missing");
    const scale = picture.width / 1920;
    for (let press = 0; press < 5; press++) {
      // Off the title, then on its glyphs.
      await page.mouse.click(picture.x + 900 * scale, picture.y + 600 * scale);
      await expect(positionField(page)).toHaveValue("0 px");
      // The title sits at 20 px plus its 40 px Position.
      await page.mouse.click(picture.x + 80 * scale, picture.y + 30 * scale);
      await expect(positionField(page)).toHaveValue("40 px");
    }
    const hitDurations = await hits.jsonValue();
    console.log(JSON.stringify({ pictureHit: hitDurations }));
    expect(hitDurations).toHaveLength(10);
    expect(Math.max(...hitDurations), "picture hit budget").toBeLessThan(8);
  },
);
