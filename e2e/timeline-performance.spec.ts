import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test, expect } from "./fixtures";
import {
  frameSummary,
  timelineFrames,
  timelineWorkload,
} from "../scripts/timeline-performance";

for (const count of [400, 500] as const)
  test(
    `${count} real-media clips stay inside the zoom and ripple frame budgets`,
    { tag: "@performance" },
    async ({ page, request }, info) => {
      test.setTimeout(180_000);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const project = await timelineWorkload(request, count);
      await page.goto(`/#project/${project.id}`);
      await expect(page.locator("iframe[data-live]")).toHaveCount(1);
      await expect(page.locator("[data-clip]")).toHaveCount(count);
      // Warm the actual canvas, including decoded sprites and waveform chunks.
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
      const renderer = await page.evaluate(() => {
        const gl = document.createElement("canvas").getContext("webgl");
        const debug = gl?.getExtension("WEBGL_debug_renderer_info");
        if (!gl || !debug) return null;
        const renderer: unknown = gl.getParameter(
          debug.UNMASKED_RENDERER_WEBGL,
        );
        return typeof renderer === "string" ? renderer : null;
      });
      const cdp = await page.context().newCDPSession(page);
      const trace = process.env.CUTROOM_PERF_TRACE === "1";
      if (trace)
        await cdp.send("Tracing.start", {
          categories:
            "devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,disabled-by-default-v8.cpu_profiler",
          transferMode: "ReturnAsStream",
        });
      const results: Awaited<ReturnType<typeof timelineFrames>>[] = [];
      const fit = async () => {
        await page
          .getByRole("slider", { name: "Zoom", exact: true })
          .dblclick();
        await page.getByRole("region", { name: "Viewer", exact: true }).click();
        await page.waitForTimeout(700);
      };
      const runs = Number(process.env.CUTROOM_PERF_RUNS ?? 1);
      for (let run = 0; run < runs; run++) {
        await fit();
        const key = await timelineFrames(page, "key");
        expect(key.inputs).toBe(12);
        results.push(key);
        expect(
          await page
            .getByRole("slider", { name: "Zoom", exact: true })
            .getAttribute("aria-valuenow"),
        ).not.toBe("0");
        await fit();
        const wheel = await timelineFrames(page, "wheel");
        expect(wheel.inputs).toBe(16);
        results.push(wheel);
        await fit();
        await page.locator('[data-clip="talk-3"]').click({ force: true });
        await page.waitForTimeout(300);
        results.push(await timelineFrames(page, "ripple"));
        await expect(page.locator('[data-clip="talk-3"]')).toHaveCount(0);
        results.push(await timelineFrames(page, "undo"));
        await expect(page.locator('[data-clip="talk-3"]')).toHaveCount(1);
        results.push(await timelineFrames(page, "redo"));
        await expect(page.locator('[data-clip="talk-3"]')).toHaveCount(0);
        await timelineFrames(page, "undo");
        await expect(page.locator('[data-clip="talk-3"]')).toHaveCount(1);
        await fit();
        for (let step = 0; step < 12; step++)
          await page.keyboard.press("Control+=");
        await page.waitForTimeout(800);
        results.push(await timelineFrames(page, "fit"));
        await expect(
          page.getByRole("slider", { name: "Zoom", exact: true }),
        ).toHaveAttribute("aria-valuenow", "0");
      }
      const summary = frameSummary(results);
      const evidence = {
        count,
        runs,
        browser: page.context().browser()?.version(),
        renderer,
        viewport: page.viewportSize(),
        summary,
        results,
      };
      await info.attach("frame-times.json", {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      });
      const output = process.env.CUTROOM_PERF_DIR;
      if (output) {
        await mkdir(output, { recursive: true });
        await writeFile(
          join(output, `${count}.json`),
          JSON.stringify(evidence, null, 2),
        );
        await page.screenshot({ path: join(output, `${count}.png`) });
      }
      if (trace) {
        const complete = new Promise<string>((resolve) =>
          cdp.once("Tracing.tracingComplete", (event) =>
            resolve(event.stream!),
          ),
        );
        await cdp.send("Tracing.end");
        const handle = await complete;
        let contents = "";
        for (;;) {
          const chunk = await cdp.send("IO.read", { handle });
          contents += chunk.data;
          if (chunk.eof) break;
        }
        await cdp.send("IO.close", { handle });
        const body = gzipSync(contents);
        await info.attach("timeline.trace.json.gz", {
          body,
          contentType: "application/gzip",
        });
        if (output)
          await writeFile(join(output, `${count}.trace.json.gz`), body);
      }
      // 60 Hz target locally, with headroom for shared CI runners. This catches the measured
      // 200–267 ms stalls without treating a runner's single missed refresh as a regression.
      // Profiling changes frame times; the CI budgets use the untraced runs.
      if (!trace) {
        expect(summary.key.max).toBeLessThan(150);
        expect(summary.ripple.max).toBeLessThan(150);
      }
    },
  );
