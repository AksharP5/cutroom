import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

/** The shuttle worklet's counters: the peak since the last probe and the last source sample read. */
const probe = (page: Page) =>
  page.evaluate(() => window.cutroomScrubAudio!.probe());

/** Reads the peak over `ms` of sound, starting from a fresh probe. */
async function peakOver(page: Page, ms: number) {
  await probe(page);
  await page.waitForTimeout(ms);
  return (await probe(page))!.peak;
}

test("J and L shuttle sounds through the audio worklet, backwards in reverse and silent when muted", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Shuttle sound", duration: 20 },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-fps="30" data-duration="20"><audio id="tone" src="tone.wav" data-start="0" data-duration="20" data-track-index="1"></audio></main></body></html>`,
  );
  await promisify(execFile)("ffmpeg", [
    ...["-v", "error", "-f", "lavfi"],
    ...["-i", "sine=frequency=440:sample_rate=48000:duration=20"],
    join(project.path, "tone.wav"),
  ]);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  const context = () =>
    page.evaluate(() => window.cutroomScrubAudio!.context());
  const speed = page.getByLabel("Shuttle speed");

  // Moving the playhead and 1x playback leave sound to the preview runtime.
  await seekFrame(page, 300);
  await page.getByRole("region", { name: "Viewer" }).click();
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  await page.keyboard.press("k");
  expect(await context()).toBeNull();

  // 2x forward: the first shuttle makes the context and asks for the source's samples.
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect(speed).toHaveText("2x");
  await expect
    .poll(() => peakOver(page, 100), { timeout: 20_000 })
    .toBeGreaterThan(0.05);
  const forward = (await probe(page))!.source!;
  await page.waitForTimeout(200);
  expect((await probe(page))!.source).toBeGreaterThan(forward);

  // A steady shuttle stays on the audio clock: no re-anchoring jumps.
  await page.keyboard.press("k");
  await seekFrame(page, 30);
  await page.getByRole("region", { name: "Viewer" }).click();
  await page.keyboard.press("Shift+L");
  await page.keyboard.press("l");
  await expect(speed).toHaveText("8x");
  const { runs } = (await probe(page))!;
  await page.waitForTimeout(1500);
  expect((await probe(page))!.runs).toBe(runs);
  await page.keyboard.press("k");
  await expect.poll(() => peakOver(page, 100)).toBe(0);

  // 1x reverse reads the source backwards.
  await page.keyboard.press("j");
  await expect(speed).toHaveText("-1x");
  await expect.poll(() => peakOver(page, 100)).toBeGreaterThan(0.05);
  const reverse = (await probe(page))!.source!;
  await page.waitForTimeout(200);
  expect((await probe(page))!.source).toBeLessThan(reverse);
  await page.keyboard.press("k");

  // The viewer's mute silences shuttle sound.
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await page.getByRole("region", { name: "Viewer" }).click();
  await page.keyboard.press("j");
  await expect(speed).toHaveText("-1x");
  expect(await peakOver(page, 300)).toBe(0);
  await page.keyboard.press("k");
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await page.getByRole("region", { name: "Viewer" }).click();

  await seekFrame(page, 150);
  await page.getByRole("region", { name: "Viewer" }).click();
  // From key to the first audible block, alternating 1x reverse and 4x forward.
  await page.evaluate(() => {
    addEventListener(
      "keydown",
      (event) => {
        (window as Window & { pressedAt?: number }).pressedAt = event.timeStamp;
      },
      { capture: true },
    );
  });
  // The block's own time on the output clock, less the device's latency, as the design measures
  // it; and, as a looser bound, when its message reached the page.
  const rendered: number[] = [];
  const posted: number[] = [];
  let device = 0;
  for (let gesture = 0; gesture < 30; gesture++) {
    await page.keyboard.press(gesture % 2 ? "Shift+L" : "j");
    const result = await page.waitForFunction(() => {
      const { sounded } = window.cutroomScrubAudio!;
      const pressedAt = (window as Window & { pressedAt?: number }).pressedAt!;
      return sounded && sounded.posted > pressedAt
        ? {
            rendered: sounded.heard - pressedAt - sounded.outputLatency * 1000,
            posted: sounded.posted - pressedAt,
            device: sounded.outputLatency * 1000,
          }
        : null;
    });
    const latency = (await result.jsonValue())!;
    rendered.push(latency.rendered);
    posted.push(latency.posted);
    device = latency.device;
    await page.keyboard.press("k");
    await page.waitForTimeout(100);
  }
  const median = (values: number[]) =>
    values.toSorted((a, b) => a - b)[values.length >> 1]!;
  const report = `key to first audible block: median ${median(rendered).toFixed(1)} ms before ${device.toFixed(1)} ms of device latency (max ${Math.max(...rendered).toFixed(1)}); message back on the page: median ${median(posted).toFixed(1)} ms`;
  test.info().annotations.push({ type: "latency", description: report });
  console.log(report);
  expect(median(rendered)).toBeLessThan(15);

  // Five seconds after the last sound the context sleeps.
  expect(await context()).toBe("running");
  await expect.poll(context, { timeout: 8000 }).toBe("suspended");
});
