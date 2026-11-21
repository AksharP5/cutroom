import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { makeScaleProject } from "../scripts/scale-performance-project";
import { scaleFps } from "../scripts/bench-vs-studio-project";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

async function playhead(page: Page) {
  const text = await page
    .getByRole("button", { name: /^Current time/ })
    .textContent();
  const [h, m, s, f] = text!.split(":").map(Number);
  return ((h! * 60 + m!) * 60 + s!) * scaleFps + f!;
}

async function seek(page: Page, frame: number) {
  const seconds = Math.floor(frame / scaleFps);
  const time = [0, Math.floor(seconds / 60), seconds % 60, frame % scaleFps]
    .map((part) => String(part).padStart(2, "0"))
    .join("");
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page
    .getByRole("textbox", { name: "Go to time" })
    .pressSequentially(time);
  await page.keyboard.press("Enter");
  await expect.poll(() => playhead(page)).toBe(frame);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
}

/** Read the frame stamped on the actual viewer, including the GPU canvas when enabled. */
async function picture(page: Page) {
  const png = await page.locator(".edit-picture").screenshot();
  return page.evaluate(async (image) => {
    const bytes = Uint8Array.from(atob(image), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const stripe = ctx.getImageData(
      0,
      Math.floor(canvas.height / 40),
      canvas.width,
      1,
    ).data;
    let number = 0;
    for (let bit = 0; bit < 16; bit++) {
      const at = 4 * Math.floor((canvas.width * (bit + 0.5)) / 16);
      const value = (stripe[at]! + stripe[at + 1]! + stripe[at + 2]!) / 3;
      if (value > 60 && value < 190) return null;
      if (value >= 190) number |= 1 << bit;
    }
    return number >= 120 && number < 4500 ? number : null;
  }, png.toString("base64"));
}

for (const pipeline of [false, true]) {
  test(
    `1,000 clips at 60 fps play, edit and keep history with GPU playback ${pipeline ? "on" : "off"}`,
    {
      tag: "@performance",
    },
    async ({ page, request }, info) => {
      test.setTimeout(180_000);
      const directory = info.outputPath("project");
      const shots = await makeScaleProject(directory, 1000, {
        cameraMedia: true,
      });
      const imported = await request.post("/api/cutroom/projects/import", {
        data: { path: directory, name: "1,000 clip performance check" },
      });
      expect(imported.ok(), await imported.text()).toBe(true);
      const project = ProjectSchema.parse(await imported.json());
      await page.addInitScript((on) => {
        if (window === window.top)
          localStorage.setItem("cutroom.footagePipeline", String(on));
      }, pipeline);
      await page.goto(`/#project/${project.id}`);
      const stage = page.locator(".edit-stage");
      await expect(page.locator("[data-clip]")).toHaveCount(1000);
      if (pipeline) await expect(stage).toHaveAttribute("data-pipeline", "on");
      const at = shots[259]!.start + 12;
      await seek(page, at);
      await expect.poll(() => picture(page)).toBe(shots[259]!.source + 12);
      await page.keyboard.press("Space");
      await expect.poll(() => playhead(page)).toBeGreaterThan(at + 8);
      const startedPlaying = Date.now();
      const firstFrame = await playhead(page);
      const firstPicture = await picture(page);
      await page.waitForTimeout(1250);
      const lastFrame = await playhead(page);
      const elapsed = (Date.now() - startedPlaying) / 1000;
      expect((lastFrame - firstFrame) / elapsed).toBeGreaterThan(48);
      expect((lastFrame - firstFrame) / elapsed).toBeLessThan(72);
      const lastPicture = await picture(page);
      expect(firstPicture).not.toBeNull();
      expect(lastPicture).not.toBeNull();
      expect(lastPicture).not.toBe(firstPicture);
      await page.keyboard.press("k");
      const live = stage.locator("iframe[data-live]");
      const loaded = await live
        .contentFrame()
        .locator("video, audio")
        .evaluateAll((media) => {
          const readyState = Object.getOwnPropertyDescriptor(
            HTMLMediaElement.prototype,
            "readyState",
          )!.get!;
          return media.filter((element) => readyState.call(element) > 0).length;
        });
      expect(loaded).toBeLessThanOrEqual(16);

      const offset = 24;
      const ripple = async (shot: number) => {
        const frame = shots[shot]!.start + offset;
        await seek(page, frame);
        await expect
          .poll(() => picture(page))
          .toBe(shots[shot]!.source + offset);
        await page.locator(`[data-clip="shot-${shot}"]`).click({ force: true });
        const started = Date.now();
        await page.keyboard.press("Delete");
        await expect
          .poll(() => picture(page), { timeout: 6000 })
          .toBe(shots[shot + 1]!.source + offset);
        return Date.now() - started;
      };
      const lateShot = 400;
      const lateRippleMs = await ripple(lateShot);
      for (const [key, source] of [
        ["Control+z", shots[lateShot]!.source],
        ["Control+Shift+z", shots[lateShot + 1]!.source],
        ["Control+z", shots[lateShot]!.source],
      ] as const) {
        await page.keyboard.press(key);
        await expect.poll(() => picture(page)).toBe(source + offset);
      }

      const shot = 8;
      const rippleMs = await ripple(shot);

      const historySize = async () => {
        const response = await request.get(
          `/api/cutroom/projects/${project.id}/history`,
        );
        const { entries } = (await response.json()) as {
          entries: { undone: boolean; undoes?: string }[];
        };
        return entries.filter((entry) => !entry.undone && !entry.undoes).length;
      };
      await expect.poll(historySize).toBe(1);
      const baseline = 1;
      const trims = 10;
      // A one-second step lands inside the next shot once W parks on the cut.
      const trimStart = Date.now();
      for (let index = 0; index < trims; index++) {
        await page.keyboard.press("Shift+ArrowRight");
        await page.keyboard.press("w");
        await page.waitForTimeout(120);
      }
      const keysMs = Date.now() - trimStart;
      await expect
        .poll(historySize, { timeout: 16_000 })
        .toBe(baseline + trims);
      const savedMs = Date.now() - trimStart;
      const trimmedDurations = async () => {
        const response = await request.get(
          `/api/cutroom/projects/${project.id}/timeline?clipEdits=false`,
        );
        const { clips } = TimelineViewSchema.parse(
          await response.json(),
        ).timeline;
        const duration = new Map(clips.map((clip) => [clip.id, clip.duration]));
        return Array.from({ length: trims }, (_, index) =>
          duration.get(`shot-${shot + 1 + index}`),
        );
      };
      const toolbar = page.getByRole("toolbar", { name: "Tools", exact: true });
      const undo = toolbar.getByRole("button", { name: "Undo", exact: true });
      const redo = toolbar.getByRole("button", { name: "Redo", exact: true });
      await expect(undo).toBeEnabled();
      await expect(redo).toBeDisabled();
      const trimmed = [
        offset + scaleFps,
        ...Array<number>(trims - 1).fill(scaleFps),
      ];
      expect(await trimmedDurations()).toEqual(trimmed);
      const historyMs: number[] = [];
      for (const [key, expected] of [
        ["Control+z", baseline],
        ["Control+Shift+z", baseline + trims],
      ] as const) {
        const started = Date.now();
        for (let index = 0; index < trims; index++) {
          await page.keyboard.press(key);
          await page.waitForTimeout(100);
        }
        await expect.poll(historySize, { timeout: 18_000 }).toBe(expected);
        if (key === "Control+z") await expect(redo).toBeEnabled();
        else await expect(redo).toBeDisabled();
        await expect(undo).toBeEnabled();
        historyMs.push(Date.now() - started);
      }
      expect(await trimmedDurations()).toEqual(trimmed);
      const ruler = (await page.locator(".tl-ruler").boundingBox())!;
      const scroller = (await page.locator(".tl-scroll").boundingBox())!;
      const left = Math.max(ruler.x, scroller.x);
      const right = Math.min(
        ruler.x + ruler.width,
        scroller.x + scroller.width,
      );
      const y = ruler.y + ruler.height / 2;
      await page.mouse.move(left + (right - left) * 0.7, y);
      await page.mouse.down();
      await page.mouse.move(left + (right - left) * 0.73, y, { steps: 8 });
      await page.mouse.up();
      const frame = await playhead(page);
      const response = await request.get(
        `/api/cutroom/projects/${project.id}/timeline?clipEdits=false`,
      );
      const { clips } = TimelineViewSchema.parse(
        await response.json(),
      ).timeline;
      const video = clips.find(
        (clip) =>
          clip.kind === "video" &&
          clip.start <= frame &&
          frame < clip.start + clip.duration,
      )!;
      const number =
        Math.round(video.mediaStart! * scaleFps) + frame - video.start;
      await expect.poll(() => picture(page)).toBe(number);
      console.log(
        JSON.stringify({
          pipeline,
          loaded,
          rippleMs,
          lateRippleMs,
          trimKeysMs: keysMs,
          trimSavedMs: savedMs,
          undoMs: historyMs[0],
          redoMs: historyMs[1],
        }),
      );
    },
  );
}
