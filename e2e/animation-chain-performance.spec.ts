import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { test, expect } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { TweenWindowsSchema } from "../src/shared/preview";
import { afterPaint } from "./position-helpers";

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;

test(
  "40 held-preview moves keep command latency and retained animation inputs bounded",
  { tag: "@performance" },
  async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: "Animation chain", duration: 60 },
        })
      ).json(),
    );
    await copyFile(
      "node_modules/gsap/dist/gsap.min.js",
      join(project.path, "gsap.min.js"),
    );
    const clips = Array.from(
      { length: 500 },
      (_, i) =>
        `<div id="c${i}" data-start="${i / 10}" data-duration="1" data-track-index="${i === 60 ? 9 : i % 9}">${i}</div>`,
    ).join("");
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><head><script src="gsap.min.js"></script></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="60" data-fps="30">${clips}</main><script>const tl=gsap.timeline({paused:true});window.__timelines.main=tl;for(let i=0;i<500;i++)for(let j=0;j<20;j++)tl.to('#c'+i,{x:j,duration:.01},i/10+j*.02);</script></body></html>`,
    );
    const report = page.waitForResponse((response) =>
      response.url().endsWith("/animation-windows"),
    );
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
    const windows = z
      .object({ windows: TweenWindowsSchema })
      .parse((await report).request().postDataJSON()).windows;
    expect(Object.keys(windows)).toHaveLength(500);
    expect(
      Object.values(windows).flatMap((groups) =>
        groups.flatMap(([, starts]) => starts),
      ),
    ).toHaveLength(10_000);
    const base = `/api/cutroom/projects/${project.id}`;
    let revision = TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    ).revision;
    const times: number[] = [];
    const ledger = join(project.path, ".cutroom/review.json");
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/isolated-preview?*", async (route) => {
      await gate;
      await route.continue().catch(() => {});
    });
    let pendingBytes = 0;
    try {
      for (let i = 0; i < 40; i++) {
        const start = performance.now();
        const response = await request.post(`${base}/commands`, {
          data: {
            composition: "index.html",
            expectedRevision: revision,
            commands: [{ type: "move", clipIds: ["c60"], by: 1 }],
          },
        });
        const body: unknown = await response.json();
        times.push(performance.now() - start);
        expect(response.ok(), JSON.stringify(body)).toBe(true);
        revision = z.object({ revision: z.string() }).parse(body).revision;
      }
      pendingBytes = (await readFile(ledger)).length;
    } finally {
      release();
      await page.unroute("**/isolated-preview?*");
    }
    await expect(
      page.frameLocator("iframe[data-live]").locator("#c60"),
    ).toHaveAttribute("data-start", String(220 / 30));
    await page.locator('[data-clip="c60"]').click();
    await expect(
      page.locator(".inspector-timing .inspector-warning"),
    ).toContainText("00:00:06:00");
    const settledBytes = (await readFile(ledger)).length;
    for (const direction of ["undo", "redo"] as const) {
      await afterPaint(page, async () => {
        const response = await request.post(`${base}/history/${direction}`);
        expect(response.ok(), await response.text()).toBe(true);
      });
      await expect(
        page.locator(".inspector-timing .inspector-warning"),
      ).toBeVisible();
    }
    const result = {
      clips: 500,
      tweens: 10_000,
      moves: 40,
      times,
      firstTenMs: median(times.slice(0, 10)),
      lastTenMs: median(times.slice(-10)),
      growth: median(times.slice(-10)) / median(times.slice(0, 10)),
      pendingBytes,
      settledBytes,
      afterUndoRedoBytes: (await readFile(ledger)).length,
    };
    console.log("animation chain", JSON.stringify(result));
    await writeFile(
      info.outputPath("animation-chain.json"),
      JSON.stringify(result, null, 2),
    );
    if (process.env.CUTROOM_CHAIN_TIMING_OUT)
      await writeFile(
        process.env.CUTROOM_CHAIN_TIMING_OUT,
        JSON.stringify(result, null, 2),
      );
    await page.screenshot({ path: info.outputPath("animation-chain.png") });
    expect(result.growth).toBeLessThan(2.5);
    expect(result.afterUndoRedoBytes).toBeLessThan(200_000);
  },
);
