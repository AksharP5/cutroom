import { writeFile } from "node:fs/promises";
import { test, expect } from "./fixtures";
import { timelineWorkload } from "../scripts/timeline-performance";

test(
  "400 clips resize tracks without per-clip writes",
  { tag: "@performance" },
  async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const project = await timelineWorkload(request, 400);
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator("[data-clip]")).toHaveCount(400);
    await expect(page.locator("iframe[data-live]")).toHaveCount(1);
    await page.waitForTimeout(4500);
    const handle = page.getByRole("separator", { name: "Height V2" });
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.evaluate(() => {
      const frames: number[] = [];
      const longTasks: number[] = [];
      let clipWrites = 0;
      let rowWrites = 0;
      let canvasResizes = 0;
      let previous = performance.now();
      let running = true;
      const sample = () => {
        const now = performance.now();
        frames.push(now - previous);
        previous = now;
        if (running) requestAnimationFrame(sample);
      };
      const observer = new MutationObserver((changes) => {
        for (const change of changes) {
          const node = change.target;
          if (!(node instanceof Element)) continue;
          if (node.matches("[data-clip], [data-clip-mix], [data-clip-label]"))
            clipWrites++;
          if (node.matches("[data-row]")) rowWrites++;
          if (node.matches(".tl-bodies") && change.attributeName !== "style")
            canvasResizes++;
        }
      });
      observer.observe(document.querySelector(".tl-grid")!, {
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "width", "height"],
      });
      const tasks = new PerformanceObserver((list) =>
        longTasks.push(...list.getEntries().map((entry) => entry.duration)),
      );
      tasks.observe({ type: "longtask" });
      requestAnimationFrame(sample);
      Object.assign(window, {
        heightDragResult: () => {
          running = false;
          observer.disconnect();
          tasks.disconnect();
          const sorted = frames.slice(1).sort((a, b) => a - b);
          return {
            frames: sorted.length,
            p50: sorted[Math.floor(sorted.length * 0.5)],
            p95: sorted[Math.floor(sorted.length * 0.95)],
            max: sorted.at(-1),
            late: sorted.filter((ms) => ms > 20).length,
            longTasks,
            clipWrites,
            rowWrites,
            canvasResizes,
          };
        },
      });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline",
      transferMode: "ReturnAsStream",
    });
    const start = performance.now();
    for (let step = 1; step <= 180; step++) {
      await page.mouse.move(x, y + (step <= 90 ? step : 180 - step));
      const wait = start + step * (1000 / 60) - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const result = await page.evaluate(() => {
      const state = window as unknown as {
        heightDragResult(): {
          frames: number;
          p50: number;
          p95: number;
          max: number;
          late: number;
          longTasks: number[];
          clipWrites: number;
          rowWrites: number;
          canvasResizes: number;
        };
      };
      return state.heightDragResult();
    });
    const traceComplete = new Promise<{ stream?: string }>((resolve) =>
      cdp.once("Tracing.tracingComplete", resolve),
    );
    await cdp.send("Tracing.end");
    const { stream } = await traceComplete;
    if (!stream)
      throw new Error("Chromium did not return the height-drag trace.");
    let json = "";
    for (;;) {
      const chunk = await cdp.send("IO.read", { handle: stream });
      json += chunk.data;
      if (chunk.eof) break;
    }
    await cdp.send("IO.close", { handle: stream });
    const trace = JSON.parse(json) as {
      traceEvents: {
        name: string;
        dur?: number;
        args?: { elementCount?: number; beginData?: { elementCount?: number } };
      }[];
    };
    const styles = trace.traceEvents.filter(
      (entry) => entry.name === "UpdateLayoutTree",
    );
    const measurements = {
      ...result,
      clips: 400,
      pointerInputs: 180,
      styleElements: styles.map(
        (entry) =>
          entry.args?.elementCount ?? entry.args?.beginData?.elementCount ?? 0,
      ),
      styleMilliseconds: styles.reduce(
        (total, entry) => total + (entry.dur ?? 0) / 1000,
        0,
      ),
    };
    await writeFile(
      info.outputPath("height-drag.json"),
      JSON.stringify(measurements, null, 2),
    );
    console.log(JSON.stringify({ heightDrag: measurements }));
    await page.mouse.up();
    expect(result.clipWrites).toBe(0);
    expect(result.canvasResizes).toBe(0);
    expect(result.frames).toBeGreaterThan(90);
    expect(result.p95).toBeLessThan(40);
  },
);
