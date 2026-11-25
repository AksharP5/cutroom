import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
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

/** A 30 fps timeline of one 440 Hz tone from 0, looped when the clip is longer than the source. */
async function openTone(
  page: Page,
  request: APIRequestContext,
  name: string,
  {
    duration = 20,
    sourceDuration = duration,
    more,
  }: {
    duration?: number;
    sourceDuration?: number;
    more?: (directory: string) => Promise<void>;
  } = {},
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name, duration },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-fps="30" data-duration="${duration}"><audio id="tone" src="tone.wav" data-start="0" data-duration="${duration}" data-track-index="1"${sourceDuration < duration ? " loop" : ""}></audio></main></body></html>`,
  );
  await promisify(execFile)("ffmpeg", [
    ...["-v", "error", "-f", "lavfi"],
    ...[
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${sourceDuration}`,
    ],
    join(project.path, "tone.wav"),
  ]);
  await more?.(project.path);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
}

const context = (page: Page) =>
  page.evaluate(() => window.cutroomScrubAudio!.context());

test("frame steps hear the same source frame on every loop", async ({
  page,
  request,
}) => {
  await openTone(page, request, "Looped tone", {
    duration: 4,
    sourceDuration: 1,
  });
  const step = async (frame: number) => {
    await seekFrame(page, frame - 1);
    await page.getByRole("region", { name: "Viewer" }).click();
    await probe(page);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(120);
    return probe(page);
  };
  await expect
    .poll(async () => (await step(8))?.peak ?? 0)
    .toBeGreaterThan(0.05);
  for (const frame of [38, 68, 98]) {
    const result = await step(frame);
    expect(result?.peak).toBeGreaterThan(0.05);
    expect([result?.low, result?.high]).toEqual([12_800, 14_399]);
  }
});

test("J and L shuttle sounds through the audio worklet, backwards in reverse and silent when muted", async ({
  page,
  request,
}) => {
  await openTone(page, request, "Shuttle sound");
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

  // A steady shuttle stays on the audio clock. Headless Chromium's fake output moves its
  // reported latency in 8 ms steps, two frames at 8x, which can call for one re-anchor.
  await page.keyboard.press("k");
  await seekFrame(page, 30);
  await page.getByRole("region", { name: "Viewer" }).click();
  await page.keyboard.press("Shift+L");
  await page.keyboard.press("l");
  await expect(speed).toHaveText("8x");
  const { runs } = (await probe(page))!;
  await page.waitForTimeout(1500);
  expect((await probe(page))!.runs - runs).toBeLessThanOrEqual(1);
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

  // A shuttle from sleep waits for the output clock, then runs without re-anchoring.
  const { runs: asleep } = (await probe(page))!;
  await page.keyboard.press("j");
  await expect.poll(() => peakOver(page, 100)).toBeGreaterThan(0.05);
  await page.waitForTimeout(500);
  expect((await probe(page))!.runs).toBe(asleep + 1);
  await page.keyboard.press("k");
});

test("dragging the playhead sounds as tape, rests silent, and frame steps play their frame; the toggle and mute silence both", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await openTone(page, request, "Drag sound");
  const ruler = await page.locator(".tl-ruler").boundingBox();
  const y = ruler!.y + ruler!.height / 2;
  let x = ruler!.x + ruler!.width * 0.3;
  /** Moves the pointer `steps` times by `dx`, about once a display refresh. */
  const move = async (steps: number, dx: number) => {
    for (let i = 0; i < steps; i++) {
      x += dx;
      await page.mouse.move(x, y);
      await page.waitForTimeout(16);
    }
  };
  const viewer = page.getByRole("region", { name: "Viewer" });
  expect(await context(page)).toBeNull();

  // The first drag makes the context and asks for the source's samples.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect
    .poll(
      async () => {
        await move(6, 3);
        await move(6, -3);
        return (await probe(page))!.peak;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0.05);

  // Dragging right reads forwards, and the sound stops within a frame of the pointer resting.
  const forward: number[] = [];
  await probe(page);
  for (let i = 0; i < 5; i++) {
    await move(4, 3);
    const { source, peak } = (await probe(page))!;
    forward.push(source!);
    expect(peak).toBeGreaterThan(0.05);
  }
  expect(forward).toEqual(forward.toSorted((a, b) => a - b));
  expect(new Set(forward).size).toBe(forward.length);
  await page.waitForTimeout(33 + 5 + 30);
  expect(await peakOver(page, 150)).toBe(0);

  // Dragging left reads backwards.
  const back: number[] = [];
  await probe(page);
  for (let i = 0; i < 5; i++) {
    await move(4, -3);
    const { source, peak } = (await probe(page))!;
    back.push(source!);
    expect(peak).toBeGreaterThan(0.05);
  }
  expect(back).toEqual(back.toSorted((a, b) => b - a));
  expect(new Set(back).size).toBe(back.length);
  await page.mouse.up();

  // A frame step plays exactly the frame it lands on: frame 91 is output samples 145600 to 147199.
  await seekFrame(page, 90);
  await viewer.click();
  await page.waitForTimeout(500);
  await probe(page);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);
  const stepped = (await probe(page))!;
  expect(stepped.peak).toBeGreaterThan(0.05);
  expect([stepped.low, stepped.high]).toEqual([91 * 1600, 92 * 1600 - 1]);

  // Shift+S silences drags and steps, not the shuttle, and is kept for next time.
  const toggle = page.getByRole("button", { name: "Audio scrubbing" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+S");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(
    await page.evaluate(() => localStorage.getItem("cutroom.audioScrubbing")),
  ).toBe("false");
  const silentGestures = async () => {
    await probe(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await move(10, 3);
    await page.mouse.up();
    await viewer.click();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    return (await probe(page))!.peak;
  };
  expect(await silentGestures()).toBe(0);
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect.poll(() => peakOver(page, 100)).toBeGreaterThan(0.05);
  await page.keyboard.press("k");
  await page.keyboard.press("Shift+S");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // The viewer's mute silences them too.
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await page.waitForTimeout(100);
  expect(await silentGestures()).toBe(0);
  await page.getByRole("button", { name: "Mute", exact: true }).click();

  // From pointer move to the first audible block, over 30 drags.
  await page.evaluate(() => {
    const moves: number[] = [];
    (window as Window & { moves?: number[] }).moves = moves;
    addEventListener("pointermove", (event) => moves.push(event.timeStamp), {
      capture: true,
    });
  });
  // The context slept while the gestures above were silent; one drag wakes it.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await move(20, 2);
  await page.mouse.up();
  const rendered: number[] = [];
  for (let gesture = 0; gesture < 30; gesture++) {
    x = ruler!.x + ruler!.width * (0.2 + (gesture % 5) * 0.1);
    const before = await page.evaluate(() => performance.now());
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(40);
    await move(3, 4);
    await page.waitForTimeout(60);
    await page.mouse.up();
    const latency = await page.evaluate((before) => {
      const { sounded } = window.cutroomScrubAudio!;
      if (!sounded || sounded.posted < before) return null;
      const at = sounded.heard - sounded.outputLatency * 1000;
      const moves = (window as Window & { moves?: number[] }).moves!;
      const move = moves.filter((time) => time <= at).at(-1);
      return move === undefined ? null : at - move;
    }, before);
    expect(latency).not.toBeNull();
    rendered.push(latency!);
    await page.waitForTimeout(60);
  }
  const median = rendered.toSorted((a, b) => a - b)[15]!;
  const report = `pointer move to first audible block: median ${median.toFixed(1)} ms (max ${Math.max(...rendered).toFixed(1)}) before device latency`;
  test.info().annotations.push({ type: "latency", description: report });
  console.log(report);
  expect(median).toBeLessThan(15);
});

test("K held with J or L steps a frame on a tap and plays half speed with sound on a hold", async ({
  page,
  request,
}) => {
  await openTone(page, request, "K with J and L");
  const viewer = page.getByRole("region", { name: "Viewer" });
  const speed = page.getByLabel("Shuttle speed");
  const now = page.getByRole("button", { name: /^Current time/ });
  const frame = async () => {
    const [h, m, s, f] = (await now.textContent())!.split(":").map(Number);
    return ((h! * 60 + m!) * 60 + s!) * 30 + f!;
  };
  await seekFrame(page, 150);
  await viewer.click();
  // A shuttle makes the context and asks for the source's samples.
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect.poll(() => peakOver(page, 100)).toBeGreaterThan(0.05);
  await page.keyboard.press("k");
  await expect.poll(() => peakOver(page, 100)).toBe(0);

  // K held, L tapped: one frame forward, playing exactly that frame.
  const start = await frame();
  await page.keyboard.down("k");
  await page.keyboard.down("l");
  await page.keyboard.up("l");
  await page.waitForTimeout(150);
  expect(await frame()).toBe(start + 1);
  const tapped = (await probe(page))!;
  expect(tapped.peak).toBeGreaterThan(0.05);
  expect([tapped.low, tapped.high]).toEqual([
    (start + 1) * 1600,
    (start + 2) * 1600 - 1,
  ]);
  // J tapped: one frame back.
  await page.keyboard.down("j");
  await page.keyboard.up("j");
  await page.waitForTimeout(100);
  expect(await frame()).toBe(start);

  // K held, L held: a key repeat does not step again; past the hold, half speed with sound.
  await page.keyboard.down("l");
  await page.keyboard.down("l");
  await page.waitForTimeout(100);
  expect(await frame()).toBe(start + 1);
  await expect(speed).toHaveText("0.5x");
  await expect.poll(() => peakOver(page, 100)).toBeGreaterThan(0.05);
  const from = (await probe(page))!.source!;
  const at = Date.now();
  await page.waitForTimeout(500);
  const to = (await probe(page))!.source!;
  // Half speed reads about 24,000 samples a second.
  const rate = (to - from) / ((Date.now() - at) / 1000);
  expect(rate).toBeGreaterThan(18_000);
  expect(rate).toBeLessThan(30_000);
  // Releasing L stops.
  await page.keyboard.up("l");
  await expect(speed).toHaveText("");
  await expect(page.getByRole("button", { name: "Stop" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.up("k");

  // L held first, then K: half speed forward at once; releasing K stops.
  await page.keyboard.down("l");
  await page.keyboard.down("k");
  await expect(speed).toHaveText("0.5x");
  await page.keyboard.up("k");
  await expect(speed).toHaveText("");
  await page.keyboard.up("l");

  // K held, J held: half speed in reverse, reading backwards.
  await page.keyboard.down("k");
  await page.keyboard.down("j");
  await expect(speed).toHaveText("-0.5x");
  await expect.poll(() => peakOver(page, 100)).toBeGreaterThan(0.05);
  const back = (await probe(page))!.source!;
  await page.waitForTimeout(300);
  expect((await probe(page))!.source).toBeLessThan(back);
  await page.keyboard.up("k");
  await expect(speed).toHaveText("");
  await page.keyboard.up("j");
});

test("the source viewer sounds its own file: shuttle, drags, steps and K with L, handed over cleanly to the timeline", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const exec = promisify(execFile);
  await openTone(page, request, "Source sound", {
    more: async (directory) => {
      await exec("ffmpeg", [
        ...["-v", "error", "-f", "lavfi"],
        ...["-i", "sine=frequency=1000:sample_rate=48000:duration=20"],
        join(directory, "voice.wav"),
      ]);
      await exec("ffmpeg", [
        ...["-v", "error", "-f", "lavfi"],
        ...["-i", "testsrc=size=160x120:rate=30:duration=4", "-an"],
        ...["-c:v", "libx264", "-pix_fmt", "yuv420p"],
        join(directory, "mute.mp4"),
      ]);
    },
  });
  const source = page.getByRole("group", { name: "Source" });
  const viewer = page.getByRole("region", { name: "Viewer" });
  const speed = page.getByLabel("Shuttle speed");
  const row = (name: string) => page.locator(`.media-row[data-path="${name}"]`);
  /** The probe's lowest and highest sample read over a gesture. */
  const reads = async (gesture: () => Promise<void>) => {
    await probe(page);
    await gesture();
    await page.waitForTimeout(150);
    const { low, high, peak } = (await probe(page))!;
    return { low: low!, high: high!, peak };
  };
  const frame = async () => {
    const text = await page
      .getByRole("button", { name: /^Current time/ })
      .textContent();
    const [h, m, s, f] = text!.split(":").map(Number);
    return ((h! * 60 + m!) * 60 + s!) * 30 + f!;
  };

  // The timeline plays its tone far into it: samples past 700,000.
  await seekFrame(page, 450);
  await expect(row("voice.wav")).toHaveAttribute("draggable", "true");
  await row("voice.wav").dblclick();
  await expect(source).toBeVisible();

  // Shuttle in the source reads the source file from its own start.
  await viewer.click();
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect(speed).toHaveText("2x");
  await expect
    .poll(() => peakOver(page, 100), { timeout: 20_000 })
    .toBeGreaterThan(0.05);
  const ahead = await reads(() => page.waitForTimeout(300));
  expect(ahead.peak).toBeGreaterThan(0.05);
  expect(ahead.high).toBeLessThan(400_000);
  expect(ahead.high).toBeGreaterThan(ahead.low);
  await page.keyboard.press("k");

  // Reverse reads it backwards.
  await page.keyboard.press("j");
  await expect(speed).toHaveText("-1x");
  await expect.poll(() => peakOver(page, 100)).toBeGreaterThan(0.05);
  const back = (await probe(page))!.source!;
  await page.waitForTimeout(200);
  expect((await probe(page))!.source).toBeLessThan(back);
  await page.keyboard.press("k");

  // A drag on the source's own playhead track.
  const track = (await source
    .getByRole("slider", { name: "Playhead" })
    .boundingBox())!;
  const dragged = await reads(async () => {
    let x = track.x + track.width * 0.1;
    await page.mouse.move(x, track.y + track.height / 2);
    await page.mouse.down();
    for (let i = 0; i < 20; i++) {
      x += 2;
      await page.mouse.move(x, track.y + track.height / 2);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  });
  expect(dragged.peak).toBeGreaterThan(0.05);
  expect(dragged.high).toBeLessThan(400_000);

  // A frame step, and K held with L tapped, play exactly the frame they land on.
  await viewer.click();
  const at = await frame();
  const stepped = await reads(() => page.keyboard.press("ArrowRight"));
  expect([stepped.low, stepped.high]).toEqual([
    (at + 1) * 1600,
    (at + 2) * 1600 - 1,
  ]);
  const tapped = await reads(async () => {
    await page.keyboard.down("k");
    await page.keyboard.down("l");
    await page.keyboard.up("l");
    await page.keyboard.up("k");
  });
  expect([tapped.low, tapped.high]).toEqual([
    (at + 2) * 1600,
    (at + 3) * 1600 - 1,
  ]);

  // Alt+Q hands the keys, and the sound, to the timeline: its tone, where its playhead is.
  await page.keyboard.press("Alt+q");
  await expect(source).toBeHidden();
  const there = await frame();
  const timelineStep = await reads(() => page.keyboard.press("ArrowRight"));
  expect([timelineStep.low, timelineStep.high]).toEqual([
    (there + 1) * 1600,
    (there + 2) * 1600 - 1,
  ]);
  expect(timelineStep.low).toBeGreaterThan(700_000);
  // And back again: the source's own frame.
  await page.keyboard.press("Alt+q");
  await expect(source).toBeVisible();
  const again = await reads(() => page.keyboard.press("ArrowRight"));
  expect([again.low, again.high]).toEqual([
    (at + 3) * 1600,
    (at + 4) * 1600 - 1,
  ]);

  // Switching or closing mid-shuttle leaves nothing playing.
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect.poll(() => peakOver(page, 100)).toBeGreaterThan(0.05);
  await page.keyboard.press("Alt+q");
  await expect(source).toBeHidden();
  await page.waitForTimeout(50);
  expect(await peakOver(page, 200)).toBe(0);
  await page.keyboard.press("Alt+q");
  await expect(source).toBeVisible();
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect.poll(() => peakOver(page, 100)).toBeGreaterThan(0.05);
  await source.getByRole("button", { name: "Close source" }).click();
  await expect(source).toBeHidden();
  await page.waitForTimeout(50);
  expect(await peakOver(page, 200)).toBe(0);

  // Shift+S silences source drags and steps; its shuttle still sounds.
  await row("voice.wav").dblclick();
  await expect(source).toBeVisible();
  await viewer.click();
  await page.keyboard.press("Shift+S");
  expect((await reads(() => page.keyboard.press("ArrowRight"))).peak).toBe(0);
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect.poll(() => peakOver(page, 100)).toBeGreaterThan(0.05);
  await page.keyboard.press("k");
  await page.keyboard.press("Shift+S");

  // A source with no sound stays silent.
  await expect(row("mute.mp4")).toHaveAttribute("draggable", "true");
  await row("mute.mp4").dblclick();
  await viewer.click();
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect(speed).toHaveText("2x");
  await page.waitForTimeout(100);
  expect(await peakOver(page, 400)).toBe(0);
  await page.keyboard.press("k");
});
