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
    startedAt: number;
    running: boolean;
    observer: PerformanceObserver;
  };
}

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0);

const scrubSteps = 90;
// Alternate which condition goes first, so a runner slowing down over a pair counts against
// both. One playback run on CI ranges from 2 to 34 late frames with no change, so playback
// pools six pairs. Runners differ several-fold in how many scrub frames arrive late (2% to
// 39% with nothing selected), so scrubbing is judged on work that is measured.
const pairs = (mode: "playback" | "scrub", count: number) =>
  Array.from({ length: count }, (_, run) =>
    (run % 2 ? [true, false] : [false, true]).map((selected) => ({
      run,
      mode,
      selected,
    })),
  ).flat();
const conditions = [...pairs("playback", 6), ...pairs("scrub", 5)];

test(
  "Position observation and outline tracking stay in budget during 500-clip playback and scrubbing",
  { tag: "@performance" },
  async ({ page, request }, info) => {
    test.setTimeout(300_000);
    // Negative controls stall the actual measured reads, not the test's clock.
    const stall = Number(process.env.CUTROOM_POSITION_READ_STALL_MS ?? 0);
    if (stall > 0)
      await page.addInitScript((stall) => {
        const getBoundingClientRect = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () {
          if (this.getAttribute("data-hf-cutroom-clip-id") === "title-0") {
            const end = performance.now() + stall;
            while (performance.now() < end) {
              /* injected geometry stall */
            }
          }
          return getBoundingClientRect.call(this);
        };
      }, stall);
    const observationStall = Number(
      process.env.CUTROOM_POSITION_OBSERVATION_STALL_MS ?? 0,
    );
    if (observationStall > 0)
      await page.addInitScript((stall) => {
        const readStyle = window.getComputedStyle;
        window.getComputedStyle = function (element, pseudo) {
          if (element.getAttribute("data-hf-cutroom-clip-id") === "title-0") {
            const end = performance.now() + stall;
            while (performance.now() < end) {
              /* injected observation stall */
            }
          }
          return readStyle.call(this, element, pseudo);
        };
      }, observationStall);
    const editorStall = Number(
      process.env.CUTROOM_POSITION_EDITOR_STALL_MS ?? 0,
    );
    if (editorStall > 0)
      await page.addInitScript((stall) => {
        if (window !== top) return;
        window.addEventListener("message", (event) => {
          if (event.data?.type !== "position-warning") return;
          const end = performance.now() + stall;
          while (performance.now() < end) {
            /* injected editor-side stall */
          }
        });
      }, editorStall);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    // CPU time the editor's main thread has used, which a busy runner cannot inflate by
    // descheduling the browser. The sandboxed preview is another process: its Position work
    // is the two measures collected below.
    const editorCpuMs = async () => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      return (
        metrics.find((metric) => metric.name === "ThreadTime")!.value * 1000
      );
    };
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
      windowMs: number;
      observations: MeasuredWindow["positionPerf"]["observations"];
      boxes: number[];
      frames: number[];
      maxObservation: number;
      lateFrames: number;
      positionMs: number;
      editorCpuMs: number;
    }[] = [];
    for (const { run, mode, selected } of conditions) {
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
        for (let i = 0; i < 10; i++) await page.keyboard.press("Control+Equal");
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
          startedAt: performance.now(),
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
        let previous = stats.startedAt;
        const sample = () => {
          const now = performance.now(); // Actual callback entry, not rAF's scheduled timestamp.
          stats.frames.push(now - previous);
          previous = now;
          if (stats.running) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const editorCpuStart = await editorCpuMs();
      if (mode === "playback") {
        await page
          .getByRole("button", { name: "Play forward", exact: true })
          .click();
        await page.waitForTimeout(2500);
        await page.getByRole("button", { name: "Stop", exact: true }).click();
      } else {
        const ppf = await page
          .locator(".tl-grid")
          .evaluate((el) =>
            Number.parseFloat(getComputedStyle(el).getPropertyValue("--ppf")),
          );
        const ruler = await page.locator(".tl-ruler").boundingBox();
        if (!ruler) throw new Error("Timeline ruler missing");
        await page.mouse.move(ruler.x + 3 * ppf, ruler.y + 12);
        await page.mouse.down();
        for (let i = 0; i < scrubSteps; i++) {
          await page.mouse.move(ruler.x + (3 + (i % 75)) * ppf, ruler.y + 12);
          await waitFrames(page, 1);
        }
        await page.mouse.up();
        await expect(
          page.locator(".edit-stage[data-preview-ready]"),
        ).toBeVisible();
      }
      await waitFrames(page, 2);
      const editorCpuEnd = await editorCpuMs();
      const samples = await preview.evaluate(() => {
        const stats = (window as unknown as MeasuredWindow).positionPerf;
        stats.running = false;
        stats.observer.disconnect();
        return {
          windowMs: performance.now() - stats.startedAt,
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
        lateFrames: samples.frames.filter((gap) => gap > interval * 1.5).length,
        positionMs:
          sum(samples.observations.map((entry) => entry.duration)) +
          sum(samples.boxes),
        editorCpuMs: editorCpuEnd - editorCpuStart,
      });
    }
    const summary = (["playback", "scrub"] as const).flatMap((mode) =>
      [false, true].map((selected) => {
        const runs = results.filter(
          (result) => result.mode === mode && result.selected === selected,
        );
        return {
          mode,
          selected,
          observations: sum(runs.map((result) => result.observations.length)),
          observationsPerSecond: runs.map(
            (result) => (result.observations.length * 1000) / result.windowMs,
          ),
          maxObservation: Math.max(
            ...runs.map((result) => result.maxObservation),
          ),
          boxReads: sum(runs.map((result) => result.boxes.length)),
          maxBoxRead: Math.max(0, ...runs.flatMap((result) => result.boxes)),
          observationMaxima: runs.map((result) => result.maxObservation),
          medianMaxObservation: median(
            runs.map((result) => result.maxObservation),
          ),
          boxMaxima: runs.map((result) => Math.max(0, ...result.boxes)),
          medianMaxBoxRead: median(
            runs.map((result) => Math.max(0, ...result.boxes)),
          ),
          lateFrames: runs.map((result) => result.lateFrames),
          // Late frames over every frame played: what a viewer sees across all runs.
          lateRate:
            sum(runs.map((result) => result.lateFrames)) /
            sum(runs.map((result) => result.frames.length)),
          positionMs: runs.map((result) => result.positionMs),
          editorCpuMs: runs.map((result) => result.editorCpuMs),
        };
      }),
    );
    const scrub = (selected: boolean) =>
      summary.find(
        (result) => result.mode === "scrub" && result.selected === selected,
      )!;
    const positionMsPerStep = median(scrub(true).positionMs) / scrubSteps;
    const editorCpuRatios = scrub(true).editorCpuMs.map(
      (ms, run) => ms / scrub(false).editorCpuMs[run]!,
    );
    const scrubCost = {
      positionMsPerStep,
      editorCpuRatios,
      medianEditorCpuRatio: median(editorCpuRatios),
    };
    const evidence = JSON.stringify(
      {
        browser: page.context().browser()?.version(),
        scrubCost,
        summary,
        results,
      },
      null,
      2,
    );
    await info.attach("position-observation.json", {
      body: evidence,
      contentType: "application/json",
    });
    if (process.env.CUTROOM_POSITION_TIMING_OUT)
      await writeFile(process.env.CUTROOM_POSITION_TIMING_OUT, evidence);
    console.log(JSON.stringify({ positionObservation: summary, scrubCost }));
    for (const result of results) {
      expect(result.frames.length).toBeGreaterThan(30);
      if (!result.selected) {
        expect(result.observations).toEqual([]);
        expect(result.boxes).toEqual([]);
      } else {
        expect(result.boxes.length).toBeGreaterThan(0);
        // Static playback only needs start/stop geometry, not one read per displayed frame.
        expect(result.boxes.length).toBeLessThanOrEqual(
          result.mode === "playback" ? 6 : result.frames.length * 2 + 4,
        );
        if (result.mode === "scrub") {
          expect(result.observations.length).toBeGreaterThanOrEqual(1);
          expect(result.observations.length).toBeLessThanOrEqual(
            result.frames.length + 2,
          );
        }
      }
    }
    // Like #63, tolerate one scheduling outlier without hiding a repeated expensive read.
    // Keep every raw sample and the overall maximum in the attachment.
    for (const result of summary.filter((result) => result.selected)) {
      expect(
        result.medianMaxObservation,
        `${result.mode}: observer budget`,
      ).toBeLessThan(5);
      expect(
        result.medianMaxBoxRead,
        `${result.mode}: outline box budget`,
      ).toBeLessThan(5);
    }
    const playback = (selected: boolean) =>
      summary.find(
        (result) => result.mode === "playback" && result.selected === selected,
      )!;
    const rates = playback(true).observationsPerSecond;
    // The bridge polls every 350 ms and also checks at transport changes.
    // Use the time the preview actually spent collecting reads, including those checks.
    expect(
      Math.min(...rates),
      "playback: fewest observations per second",
    ).toBeGreaterThanOrEqual(2);
    expect(
      Math.max(...rates),
      "playback: most observations per second",
    ).toBeLessThanOrEqual(5);
    expect(
      median(rates),
      "playback: median observations per second",
    ).toBeLessThan(4);
    expect(
      playback(true).lateRate - playback(false).lateRate,
      "playback: added late-frame rate",
    ).toBeLessThan(0.05);
    // Many reads that each stay under the per-read budget still add up on every seek.
    expect(
      positionMsPerStep,
      "scrub: Position observation and outline reads per scrub step, ms",
    ).toBeLessThan(2);
    // The editor's own work for the selected clip, such as handling each warning.
    expect(
      scrubCost.medianEditorCpuRatio,
      "scrub: editor main-thread CPU with the positioned title selected, relative to nothing selected",
    ).toBeLessThan(1.3);
  },
);

test(
  "a picture drag reaches the picture within three frames on 500 clips",
  { tag: "@performance" },
  async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const project = await timelineWorkload(request, 500);
    const runs = [];
    for (let run = 0; run < 3; run++) {
      await page.goto("about:blank");
      await page.goto(`/#project/${project.id}`);
      await expect(
        page.locator(".edit-stage[data-preview-ready]"),
      ).toBeVisible();
      await expect(page.locator("[data-clip]")).toHaveCount(500);
      await page.waitForTimeout(4500);
      const boxes = await page
        .frameLocator("iframe[data-live]")
        .locator("#title-0")
        .evaluateHandle(() => {
          const durations: number[] = [];
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              if (entry.name === "cutroom:picture-boxes")
                durations.push(entry.duration);
          }).observe({ type: "measure" });
          return durations;
        });
      // Each pointer move waits for the outline to land at the dragged clip's new place and for
      // the frame after it: the move reaching the preview, its draft, the box read and the paint.
      const delays = await page
        .locator(".edit-select")
        .evaluateHandle((surface) => {
          const samples: number[] = [];
          const outline = surface.querySelector<HTMLElement>(
            ".edit-select-outline",
          )!;
          let pending: number | null = null;
          surface.addEventListener(
            "pointermove",
            (event) => {
              if ((event as PointerEvent).buttons) pending ??= event.timeStamp;
            },
            true,
          );
          new MutationObserver(() => {
            const start = pending;
            if (start === null) return;
            pending = null;
            requestAnimationFrame(() =>
              setTimeout(() => samples.push(performance.now() - start), 0),
            );
          }).observe(outline, { attributes: true, subtree: true });
          return samples;
        });
      const picture = await page.locator(".edit-picture").boundingBox();
      if (!picture) throw new Error("Picture missing");
      const scale = picture.width / 1920;
      const at = (x: number) =>
        [picture.x + x * scale, picture.y + 600 * scale] as const;
      // The full-frame talking head, the heaviest picture to move. Each step is wider than a
      // snap's hold, so every move lands somewhere new.
      await page.mouse.click(...at(900));
      await expect(positionField(page)).toHaveValue("0 px");
      await page.mouse.move(...at(900));
      await page.mouse.down();
      for (let step = 1; step <= 30; step++) {
        await page.mouse.move(...at(900 - step * 35));
        await waitFrames(page, 1);
      }
      await waitFrames(page, 2);
      await page.mouse.up();
      await expect(positionField(page)).not.toHaveValue("0 px");
      // The next run starts from the same picture. The field shows the undo before it is
      // saved, and the next run's reload would drop an undo still waiting behind the move's save.
      const undone = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/projects/${project.id}/history/undo`),
      );
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(positionField(page)).toHaveValue("0 px");
      expect((await undone).ok()).toBe(true);
      const samples = await delays.jsonValue();
      runs.push({
        run,
        samples,
        median: median(samples),
        max: Math.max(...samples),
        boxDurations: await boxes.jsonValue(),
      });
      await delays.dispose();
      await boxes.dispose();
    }
    const deadline = 100;
    const maxLateRate = 0.05;
    // The worst individual CI sample was 114.4 ms. A 300 ms ceiling is about 2.6x
    // that delay and still catches a stall even if it happens just once.
    const moveCeiling = 300;
    const moves = runs.flatMap((run) => run.samples);
    const maxMove = Math.max(...moves);
    const lateMoves = moves.filter((delay) => delay > deadline).length;
    const lateRate = lateMoves / moves.length;
    const medianFirst = median(runs.map((run) => run.samples[0]!));
    const medianMedian = median(runs.map((run) => run.median));
    const evidence = JSON.stringify(
      {
        browser: page.context().browser()?.version(),
        budget: { median: 67, deadline, lateRate: maxLateRate, moveCeiling },
        medianMedian,
        medianFirst,
        lateMoves,
        lateRate,
        maxMove,
        runs,
      },
      null,
      2,
    );
    await info.attach("picture-drag.json", {
      body: evidence,
      contentType: "application/json",
    });
    if (process.env.CUTROOM_PICTURE_DRAG_OUT)
      await writeFile(process.env.CUTROOM_PICTURE_DRAG_OUT, evidence);
    console.log(
      JSON.stringify({
        pictureDrag: {
          medianMedian,
          medians: runs.map((run) => run.median),
          maxima: runs.map((run) => run.max),
          medianFirst,
          lateMoves,
          lateRate,
          maxMove,
          boxes: runs.map((run) => run.boxDurations),
        },
      }),
    );
    // Moves the browser coalesces into one outline update count once, from the earliest.
    for (const run of runs)
      expect(run.samples.length).toBeGreaterThanOrEqual(15);
    // A typical move gets four 60 Hz frames. The first move also acquires a drag
    // target, so check that delay on its own. A busy runner can delay any single paint.
    expect(
      medianMedian,
      "median of three median pointer-move to outline-paint delays",
    ).toBeLessThanOrEqual(67);
    expect(
      medianFirst,
      "median time for the first pointer move to paint",
    ).toBeLessThanOrEqual(deadline);
    expect(
      lateRate,
      `${lateMoves}/${moves.length} pointer moves took more than ${deadline} ms to paint`,
    ).toBeLessThanOrEqual(maxLateRate);
    expect(maxMove, "slowest pointer move to paint").toBeLessThanOrEqual(
      moveCeiling,
    );
  },
);
