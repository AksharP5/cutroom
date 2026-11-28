import { test, expect } from "./fixtures";
import {
  timelineFrames,
  timelineWorkload,
} from "../scripts/timeline-performance";

test(
  "1,000 clips show a continuous strip at Fit and keep their own picks at both zoom levels",
  { tag: "@performance" },
  async ({ page, request }) => {
    test.setTimeout(180_000);
    const project = await timelineWorkload(request, 1000);
    await page.goto(`/#project/${project.id}`);
    const timeline = page.getByRole("region", { name: "Timeline" });
    const clip = (id: string) => timeline.locator(`[data-clip="${id}"]`);
    const name = (id: string) =>
      timeline.locator(`[data-clip-label="${id}"] .tl-name`);
    const run = timeline.locator("[data-run]");
    await expect(timeline.locator("[data-clip]")).toHaveCount(1000);
    await expect(run).toHaveCount(1);
    await expect(run).toHaveText("talk.mp4 490 clips");
    await expect(name("talk-4")).toHaveCount(0);

    // A cut's picture and waveform continue across the pixel between their hit boxes.
    await expect
      .poll(() =>
        timeline.locator(".tl-bodies").evaluate((element) => {
          if (!(element instanceof HTMLCanvasElement)) return false;
          const ctx = element.getContext("2d");
          const canvas = element.getBoundingClientRect();
          const pixel = (clipId: string, height: (box: DOMRect) => number) => {
            const next = document
              .querySelector(`[data-clip="${clipId}"]`)
              ?.getBoundingClientRect();
            if (!next || !ctx) return;
            const x =
              Math.round((next.left - canvas.left) * devicePixelRatio) - 1;
            const y = Math.round(
              (next.top - canvas.top + height(next)) * devicePixelRatio,
            );
            return ctx.getImageData(x, y, 1, 1).data;
          };
          const image = pixel("talk-5", () => 18);
          const wave = pixel("voice-5", (box) => box.height / 2);
          // The test picture's colour bars and the green peaks are brighter than the flat bodies.
          return (
            !!image &&
            Math.max(image[0]!, image[1]!, image[2]!) > 70 &&
            !!wave &&
            wave[1]! > 100
          );
        }),
      )
      .toBe(true);

    const pick = async (id: string) => {
      const box = await clip(id).boundingBox();
      if (!box) throw new Error(`Missing clip box for ${id}`);
      const x = Math.round(box.x + box.width / 2);
      await page.mouse.click(x, box.y + box.height / 2);
      await expect(timeline.locator(`[data-clip-outline="${id}"]`)).toHaveCount(
        1,
      );
    };
    await pick("talk-4");
    await expect(timeline.locator('[data-clip-outline="voice-4"]')).toHaveCount(
      1,
    );

    await page.getByRole("region", { name: "Viewer", exact: true }).click();
    const wheel = await timelineFrames(page, "wheel");
    expect(wheel.inputs).toBe(16);
    const maxGap = Math.max(...wheel.frames);
    console.log(JSON.stringify({ clips: 1000, wheelMax: maxGap }));
    expect(maxGap).toBeLessThan(250);

    // Move the view through the exact name threshold, with the first cuts in view.
    const grid = timeline.locator(".tl-grid");
    const zoom = () =>
      grid.evaluate((el) =>
        Number((el as HTMLElement).style.getPropertyValue("--ppf")),
      );
    const setWidth = async (width: number) => {
      const scroller = timeline.locator(".tl-scroll");
      for (let step = 0; step < 16; step++) {
        const ppf = await zoom();
        const delta = Math.max(
          -24,
          Math.min(24, -100 * Math.log(width / 75 / ppf)),
        );
        if (Math.abs(delta) < 0.01) break;
        await scroller.evaluate((node, deltaY) => {
          const ruler = node
            .querySelector(".tl-ruler")!
            .getBoundingClientRect();
          node.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY,
              ctrlKey: true,
              clientX: ruler.left,
              clientY: ruler.top + 80,
              bubbles: true,
              cancelable: true,
            }),
          );
          node.scrollLeft = 0;
        }, delta);
        await expect.poll(zoom).toBeCloseTo(ppf * Math.exp(-delta / 100), 4);
      }
      await expect.poll(async () => (await zoom()) * 75).toBeCloseTo(width, 1);
    };
    await setWidth(47.9);
    await expect(clip("talk-5")).toHaveClass(/\bbare\b/);
    await expect(name("talk-5")).toHaveCount(0);
    await clip("talk-5").hover();
    await expect(timeline.locator('[data-clip-tag="talk-5"]')).toContainText(
      "talk.mp4",
    );

    await page.keyboard.press("b");
    await clip("talk-5").click();
    const split = (id: string) => timeline.locator(`[data-clip^="${id}-"]`);
    await expect(split("talk-5")).toHaveCount(1);
    await expect(split("voice-5")).toHaveCount(1);
    await page.keyboard.press("Control+z");
    await expect(split("talk-5")).toHaveCount(0);
    await expect(split("voice-5")).toHaveCount(0);
    await page.keyboard.press("a");

    await setWidth(48.1);
    await expect(clip("talk-5")).not.toHaveClass(/\bbare\b/);
    await expect(name("talk-5")).toBeVisible();
    await expect(timeline.locator('[data-clip-tag="talk-5"]')).toHaveCount(0);
    await pick("talk-5");
    await expect(timeline.locator('[data-clip-outline="voice-5"]')).toHaveCount(
      1,
    );
    await expect(timeline.locator('[data-clip-outline="talk-4"]')).toHaveCount(
      0,
    );
  },
);
