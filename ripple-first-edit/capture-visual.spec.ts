import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { timelineWorkload } from "../scripts/timeline-performance";

declare global {
  interface Window {
    rfeClock: number;
    rfeAnimations: Animation[];
  }
}

test("capture ripple at 110 ms and after Fit on a controlled animation clock", async ({ page, request }) => {
  test.setTimeout(90_000);
  const out = process.env.RFE_VISUAL_DIR!;
  await mkdir(out, { recursive: true });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const project = await timelineWorkload(request, 500);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("[data-clip]")).toHaveCount(500);
  await expect(page.locator(".edit-stage")).toHaveAttribute("data-preview-ready", "0");
  await page.waitForTimeout(4500);
  await page.locator('[data-clip="talk-3"]').click({ force: true });
  await page.mouse.move(100, 100);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.rfeClock = Number(document.timeline.currentTime);
    window.rfeAnimations = [];
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => frame(() => callback(window.rfeClock));
    Object.defineProperty(performance, "now", { configurable: true, value: () => window.rfeClock });
    Object.defineProperty(document.timeline, "currentTime", { configurable: true, get: () => window.rfeClock });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.closest(".tl-grid")) {
        animation.pause();
        animation.currentTime = 0;
        window.rfeAnimations.push(animation);
      }
      return animation;
    };
  });
  await page.keyboard.press("Delete");
  await expect(page.locator('[data-clip="talk-3"]')).toHaveCount(0);
  await expect(page.locator(".tl-grid")).toHaveAttribute("data-refit", "pending");
  await page.evaluate(async () => {
    window.rfeClock += 110;
    for (const animation of window.rfeAnimations) animation.currentTime = 110;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const geometry = () => page.locator('[data-clip="talk-4"]').evaluate(element => ({
    rect: element.getBoundingClientRect().toJSON(),
    scale: getComputedStyle(element.closest(".tl-grid")!).getPropertyValue("--ppf"),
    refit: element.closest(".tl-grid")?.getAttribute("data-refit"),
    animationTimes: window.rfeAnimations.map(animation => animation.currentTime),
  }));
  const mid = await geometry();
  await page.getByRole("region", { name: "Timeline", exact: true }).screenshot({ path: join(out, "mid-slide.png") });
  await page.evaluate(async () => {
    window.rfeClock += 1000;
    for (let step = 0; step < 5; step++) {
      for (const animation of window.rfeAnimations) animation.finish();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  });
  await expect(page.locator(".tl-grid")).toHaveAttribute("data-refit", "settled");
  await page.getByRole("region", { name: "Timeline", exact: true }).screenshot({ path: join(out, "after-edit.png") });
  await writeFile(join(out, "capture.json"), JSON.stringify({ mid, after: await geometry(), viewport: page.viewportSize(), method: "Timeline animation callbacks and canvas use a frozen clock. Native edit animations pause at 110 ms. Fit is paused until the mid-slide capture, then all clocks advance to completion." }, null, 2));
});
