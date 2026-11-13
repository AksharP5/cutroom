import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { z } from "zod";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);

async function settledPpf(page: Page) {
  await expect(page.locator(".tl-lanes")).not.toHaveAttribute("data-sliding");
  await expect(page.locator(".tl-grid")).toHaveAttribute(
    "data-refit",
    "settled",
  );
  await expect
    .poll(() =>
      page
        .locator(".tl-grid")
        .evaluate(
          (grid) =>
            grid
              .getAnimations({ subtree: true })
              .filter((animation) => animation.timeline === document.timeline)
              .length,
        ),
    )
    .toBe(0);
  return page
    .locator(".tl-grid")
    .evaluate((grid: HTMLElement) =>
      Number(grid.style.getPropertyValue("--ppf")),
    );
}

async function drag(page: Page, selector: string, dx: number, dy: number) {
  await settledPpf(page);
  const box = (await page.locator(selector).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

async function peaks(file: string, time: number) {
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(Math.max(0, time - 0.05)),
      "-i",
      file,
      "-t",
      "0.05",
      "-vn",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 2 ** 20 },
  );
  const samples = new Float32Array(
    stdout.buffer,
    stdout.byteOffset,
    stdout.byteLength / 4,
  );
  const level = [0, 0];
  for (let i = 0; i < samples.length; i++)
    level[i % 2] = Math.max(level[i % 2]!, Math.abs(samples[i]!));
  return level;
}

test("drag clip gain and fades in single undo steps, then match stereo preview levels to export", async ({
  page,
  request,
}, info) => {
  test.setTimeout(180_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Voice plus music mix",
          width: 320,
          height: 240,
          duration: 8,
        },
      })
    ).json(),
  );
  for (const [name, frequency, channel] of [
    ["Voice", 660, 0],
    ["Music", 220, 1],
  ] as const)
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=8`,
      "-af",
      `pan=stereo|c0=${channel === 0 ? "c0" : "0*c0"}|c1=${channel === 1 ? "c0" : "0*c0"}`,
      join(project.path, `${name}.wav`),
    ]);
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><body><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-duration="8" data-fps="30"><audio id="voice" src="Voice.wav" data-start="0" data-duration="8" data-track-index="1"></audio><audio id="music" src="Music.wav" data-start="0" data-duration="8" data-track-index="2"></audio></main></body></html>',
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  const music = async () =>
    (await read()).timeline.clips.find(({ id }) => id === "music")!;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  // Cold playback must drive the visible meter on its first press, before any edit or export.
  await page.keyboard.press("Space");
  await expect
    .poll(() =>
      page.locator(".tl-meter-level").evaluateAll((bars) =>
        // The lit part is what the clip-path's top inset leaves.
        bars.every(
          (bar) =>
            Number.parseFloat(
              /inset\(([\d.]+)%/.exec(getComputedStyle(bar).clipPath)?.[1] ??
                "100",
            ) < 90,
        ),
      ),
    )
    .toBe(true);
  await page.keyboard.press("k");
  await page.keyboard.press("Home");
  const gain = '[data-clip-mix="music"] [data-mix="gain"]';
  const initial = (await read()).timeline;
  await drag(page, gain, 0, 3);
  await expect.poll(async () => (await music()).volume).toBe(10 ** (-3 / 20));
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read()).timeline).toEqual(initial);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await music()).volume).toBe(10 ** (-3 / 20));
  const gainOnly = (await read()).timeline;
  const ppf = await settledPpf(page);
  await drag(
    page,
    '[data-clip-mix="music"] [data-mix="fadeOut"]',
    -ppf * 120,
    0,
  );
  await expect.poll(async () => (await music()).fadeOut).toBe(120);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read()).timeline).toEqual(gainOnly);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await music()).fadeOut).toBe(120);
  // Fade-in is independent and can be cancelled without creating a history entry.
  const mix = (await read()).timeline;
  const handle = (await page
    .locator('[data-clip-mix="music"] [data-mix="fadeIn"]')
    .boundingBox())!;
  await page.mouse.move(handle.x + 3, handle.y + 3);
  await page.mouse.down();
  await page.mouse.move(handle.x + ppf * 20, handle.y + 3, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await read()).timeline).toEqual(mix);
  await expect(page.locator(".tl-meters")).toHaveCSS("width", "36px");
  // A real boosted clip exercises the opaque iframe's Web Audio path, not native volume's unity clamp.
  const view = await read();
  expect(
    (
      await request.post(`${api}/commands`, {
        data: {
          expectedRevision: view.revision,
          commands: [
            { type: "setClip", clipId: "voice", volume: 10 ** (6 / 20) },
          ],
        },
      })
    ).ok(),
  ).toBe(true);
  await expect(
    page.frameLocator("iframe[data-live]").locator("#voice"),
  ).toHaveAttribute("data-volume", String(10 ** (6 / 20)));
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  await dialog.getByRole("button", { name: "Export MP4" }).click();
  const { jobId } = z
    .object({ jobId: z.string() })
    .parse(await (await started).json());
  await expect(dialog).toContainText("Export complete.", { timeout: 90_000 });
  const output = info.outputPath("mix.mp4");
  const exported = await request.get(`/api/render/${jobId}/download`);
  expect(exported.ok()).toBeTruthy();
  await writeFile(output, await exported.body());
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("region", { name: "Viewer", exact: true }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  const frame = page
    .frames()
    .find((frame) => frame.url().includes("/api/isolated/"))!;
  const samples = await frame.evaluate(
    () =>
      new Promise<{ time: number; l: number; r: number }[]>((resolve) => {
        const win = window as Window & {
          __player?: { getTime(): number };
          __hf?: {
            audioMeter?: { read(): { master: { l: number; r: number } } };
          };
        };
        const collected: { time: number; l: number; r: number }[] = [];
        const take = () => {
          const time = win.__player?.getTime() ?? 0;
          if (time > 0.5)
            collected.push({
              time,
              ...(win.__hf?.audioMeter?.read().master ?? { l: 0, r: 0 }),
            });
          if (time >= 7) resolve(collected);
          else requestAnimationFrame(take);
        };
        take();
      }),
  );
  await page.keyboard.press("k");
  const evidence = [];
  for (const target of [1.5, 5, 6.5]) {
    const sample = samples.reduce((best, next) =>
      Math.abs(next.time - target) < Math.abs(best.time - target) ? next : best,
    );
    const exported = await peaks(output, sample.time);
    expect(sample.l).toBeGreaterThan(0.2);
    expect(sample.r).toBeGreaterThan(0.005);
    const difference = [sample.l, sample.r].map(
      (level, index) => 20 * Math.log10(level / exported[index]!),
    );
    for (const db of difference) expect(Math.abs(db)).toBeLessThan(1);
    evidence.push({
      time: sample.time,
      preview: [sample.l, sample.r],
      export: exported,
      differenceDb: difference,
    });
  }
  expect(samples.find((sample) => sample.time > 6.5)!.r).toBeLessThan(
    samples.find((sample) => sample.time > 1.5)!.r * 0.5,
  );
  await writeFile(
    info.outputPath("levels.json"),
    JSON.stringify(evidence, null, 2),
  );
  const idle = await page
    .locator(".tl-meter-level")
    .first()
    .getAttribute("style");
  await page.waitForTimeout(200);
  expect(
    await page.locator(".tl-meter-level").first().getAttribute("style"),
  ).toBe(idle);
  await page.screenshot({ path: info.outputPath("mix-envelope.png") });
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("400");
  await page.keyboard.press("Enter");
  await page
    .locator('[data-clip="music"]')
    .click({ position: { x: 40, y: 7 } });
  await page.keyboard.press("e");
  await expect
    .poll(async () => ({
      duration: (await music()).duration,
      fadeOut: (await music()).fadeOut,
    }))
    .toEqual({ duration: 120, fadeOut: 0 });
  await expect(
    page.locator('[data-clip-mix="music"] [data-mix="fadeOut"]'),
  ).toHaveCSS("--fade", "0%");
  await page.screenshot({ path: info.outputPath("split-envelope.png") });
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await music()).duration).toBe(240);
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("200");
  await page.keyboard.press("Enter");
  await page
    .locator('[data-clip="music"]')
    .click({ position: { x: 40, y: 7 } });
  await page.keyboard.press("w");
  await expect
    .poll(async () => ({
      duration: (await music()).duration,
      fadeOut: (await music()).fadeOut,
    }))
    .toEqual({ duration: 60, fadeOut: 120 });
  await expect(page.locator('[data-clip-mix="music"]')).toHaveCSS("--d", "60");
  await drag(page, '[data-clip-mix="music"] [data-mix="fadeOut"]', 35, 0);
  await expect.poll(async () => (await music()).fadeOut).toBeLessThan(60);
  expect((await music()).fadeOut).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("trimmed-envelope.png") });
});

test("pressing the curved envelope changes gain without moving the clip, in one undo step", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Curved envelope drag", duration: 8 },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=8",
    join(project.path, "tone.wav"),
  ]);
  const source =
    '<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="8" data-fps="30"><audio id="music" src="tone.wav" data-start="0" data-duration="8" data-fade-out="4"></audio></main></body></html>';
  await writeFile(index, source);
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    ).timeline;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  const initial = await read();
  const path = page
    .locator('[data-clip-mix="music"] .tl-fade-curve path')
    .first();
  // Get the rendered line's point at 7.75 seconds, including its real SVG transform.
  const point = await path.evaluate((element: SVGPathElement) => {
    const length = element.getTotalLength();
    let low = 0;
    let high = length;
    for (let i = 0; i < 30; i++) {
      const middle = (low + high) / 2;
      if (element.getPointAtLength(middle).x < 96.875) low = middle;
      else high = middle;
    }
    const point = element
      .getPointAtLength((low + high) / 2)
      .matrixTransform(element.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.screenshot({ path: info.outputPath("curve-before.png") });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.keyboard.down("Alt");
  await page.mouse.move(point.x, point.y - 3, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect.poll(read).not.toEqual(initial);
  const actual = await read();
  await writeFile(
    info.outputPath("curve-readback.json"),
    JSON.stringify(
      { before: initial.clips[0], after: actual.clips[0] },
      null,
      2,
    ),
  );
  await page.screenshot({ path: info.outputPath("curve-after.png") });
  expect(actual.clips[0]).toEqual({
    ...initial.clips[0],
    volume: 10 ** (12 / 20),
  });
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(initial);
  expect(await readFile(index, "utf8")).toBe(source);
  // Split uses the same history path and must restore the exact authored bytes too.
  await page
    .locator('[data-clip="music"]')
    .click({ position: { x: 40, y: 12 } });
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("600");
  await page.keyboard.press("Enter");
  await page.keyboard.press("e");
  await expect.poll(async () => (await read()).clips.length).toBe(2);
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(initial);
  expect(await readFile(index, "utf8")).toBe(source);
});

test("trim and roll out and back keep edge fades and each gesture undoes exactly", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Edge fade trims", duration: 12 },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=16",
    join(project.path, "tone.wav"),
  ]);
  const source =
    '<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="12" data-fps="30"><audio id="music" src="tone.wav" data-start="0" data-duration="8" data-fade-out="4"></audio><audio id="next" src="tone.wav" data-start="8" data-duration="4" data-media-start="8" data-fade-in="2"></audio></main></body></html>';
  await writeFile(index, source);
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    ).timeline;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  const initial = await read();
  const ppf = await settledPpf(page);
  const edgeDrag = async (
    clipId: string,
    dx: number,
    edge: "start" | "end",
  ) => {
    const clip = page.locator(`[data-clip="${clipId}"]`);
    await expect(page.locator(".tl-lanes")).not.toHaveAttribute("data-sliding");
    await expect
      .poll(() => clip.evaluate((element) => element.getAnimations().length))
      .toBe(0);
    const box = (await clip.boundingBox())!;
    const x = edge === "start" ? box.x + 3 : box.x + box.width - 3;
    const y = box.y + 12;
    await clip.hover({
      position: { x: edge === "start" ? 3 : box.width - 3, y: 12 },
    });
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 12 });
    await page.mouse.up();
  };
  const evidence = [];
  for (const roll of [false, true]) {
    await page.keyboard.press(roll ? "t" : "a");
    await edgeDrag(roll ? "next" : "music", -180 * ppf, roll ? "start" : "end");
    await expect
      .poll(
        async () =>
          (await read()).clips.find((clip) => clip.id === "music")?.duration,
      )
      .toBe(60);
    const short = await read();
    expect(short.clips.find((clip) => clip.id === "music")).toMatchObject({
      fadeOut: 120,
      automation: null,
    });
    await page.screenshot({
      path: info.outputPath(`${roll ? "roll" : "trim"}-short.png`),
    });
    await expect(
      page.locator('[data-clip-mix="music"] [data-mix="fadeOut"]'),
    ).toHaveCSS("--fade", "100%");
    const handle = (await page
      .locator('[data-clip-mix="music"] [data-mix="fadeOut"]')
      .boundingBox())!;
    const clip = (await page.locator('[data-clip="music"]').boundingBox())!;
    expect(handle.x).toBeGreaterThanOrEqual(clip.x);
    expect(handle.x + handle.width).toBeLessThanOrEqual(clip.x + clip.width);
    await edgeDrag(roll ? "next" : "music", 180 * ppf, roll ? "start" : "end");
    await expect.poll(read).toEqual(initial);
    evidence.push({
      gesture: roll ? "roll" : "trim",
      short: short.clips,
      restored: (await read()).clips,
    });
    await page.keyboard.press("Control+z");
    await expect.poll(read).toEqual(short);
    await page.keyboard.press("Control+z");
    await expect.poll(read).toEqual(initial);
    expect(await readFile(index, "utf8")).toBe(source);
  }
  await page.keyboard.press("a");
  await page
    .locator('[data-clip="music"]')
    .click({ position: { x: 40, y: 12 } });
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("400");
  await page.keyboard.press("Enter");
  await page.keyboard.press("e");
  await expect.poll(async () => (await read()).clips.length).toBe(3);
  const split = await read();
  const right = split.clips.find((clip) => clip.start === 120)!;
  const splitBytes = await readFile(index, "utf8");
  await edgeDrag(right.id, -60 * ppf, "end");
  await expect
    .poll(
      async () =>
        (await read()).clips.find((clip) => clip.id === right.id)?.duration,
    )
    .toBe(60);
  expect(
    (await read()).clips.find((clip) => clip.id === right.id),
  ).toMatchObject({ fadeOut: 120, automation: null });
  await edgeDrag(right.id, 60 * ppf, "end");
  await expect.poll(read).toEqual(split);
  evidence.push({
    gesture: "split-right-trim",
    restored: (await read()).clips,
  });
  await page.keyboard.press("Control+z");
  await expect
    .poll(
      async () =>
        (await read()).clips.find((clip) => clip.id === right.id)?.duration,
    )
    .toBe(60);
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(split);
  expect(await readFile(index, "utf8")).toBe(splitBytes);
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(initial);
  expect(await readFile(index, "utf8")).toBe(source);
  await writeFile(
    info.outputPath("edge-readback.json"),
    JSON.stringify(evidence, null, 2),
  );
});

test("a fade drag that returns to its start redraws the fade it began with", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Fade drag back", duration: 2 },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=2",
    join(project.path, "tone.wav"),
  ]);
  // Authored fades of 2 s and 6 s on a 2 s clip: the runtime scales them to 0.5 s and 1.5 s.
  const source =
    '<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="2" data-fps="30"><audio id="music" src="tone.wav" data-start="0" data-duration="2" data-fade-in="2" data-fade-out="6"></audio></main></body></html>';
  await writeFile(index, source);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  const mix = page.locator('[data-clip-mix="music"]');
  const drawing = () =>
    mix.evaluate((element) => ({
      curve: element.querySelector("path")?.getAttribute("d"),
      fadeIn: element
        .querySelector<HTMLElement>('[data-mix="fadeIn"]')
        ?.style.getPropertyValue("--fade"),
      fadeOut: element
        .querySelector<HTMLElement>('[data-mix="fadeOut"]')
        ?.style.getPropertyValue("--fade"),
    }));
  const before = await drawing();
  for (const edge of ["fadeIn", "fadeOut"]) {
    const box = (await mix.locator(`[data-mix="${edge}"]`).boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (edge === "fadeIn" ? -40 : 40), y, {
      steps: 8,
    });
    await expect.poll(drawing).not.toEqual(before);
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
    expect(await drawing()).toEqual(before);
  }
  expect(await readFile(index, "utf8")).toBe(source);
});

test("gain follows the pointer, Shift adjusts finely, horizontal presses move clips, and baked ramps clear explicitly in one undo step", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Mix gestures", duration: 10 },
      })
    ).json(),
  );
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=10",
    join(project.path, "Music.wav"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="10" data-fps="30"><audio id="music" src="Music.wav" data-start="0" data-duration="8"></audio></main></body></html>',
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    ).timeline;
  const music = async () =>
    (await read()).clips.find((clip) => clip.id === "music")!;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  const initial = await read();
  const line = page.locator('[data-clip-mix="music"] path').first();
  const point = () =>
    line.evaluate((path: SVGPathElement) => {
      const point = path
        .getPointAtLength(path.getTotalLength() / 2)
        .matrixTransform(path.getScreenCTM()!);
      return { x: point.x, y: point.y };
    });
  const origin = await point();
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  const measurements = [];
  // On a default audio row a pixel is 1 dB down to -6 dB, then 2.25 dB to -24 dB, where a bed sits.
  for (const [dy, level] of [
    [3, "-3.0 dB"],
    [6, "-6.0 dB"],
    [8, "-10.5 dB"],
    [10, "-15.0 dB"],
    [12, "-19.5 dB"],
    [14, "-24.0 dB"],
  ] as const) {
    await page.mouse.move(origin.x, origin.y + dy, { steps: 6 });
    const actual = await point();
    await expect(page.locator(".tl-readout")).toHaveText(level);
    expect(Math.abs(actual.y - (origin.y + dy))).toBeLessThanOrEqual(0.5);
    measurements.push({ pointerY: origin.y + dy, lineY: actual.y });
    await expect(page.locator(".tl-readout")).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath("pointer-gain.png") });
  await writeFile(
    info.outputPath("pointer-gain.json"),
    JSON.stringify(measurements, null, 2),
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await read()).toEqual(initial);
  await page.keyboard.down("Shift");
  await drag(page, '[data-clip-mix="music"] [data-mix="gain"]', 0, 25);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await music()).volume).toBe(10 ** (-2.5 / 20));
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(initial);
  await drag(page, '[data-clip-mix="music"] [data-mix="gain"]', 50, 1);
  await expect.poll(async () => (await music()).start).toBeGreaterThan(0);
  expect((await music()).volume).toBeNull();
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(initial);
  const ppf = await settledPpf(page);
  await drag(
    page,
    '[data-clip-mix="music"] [data-mix="fadeOut"]',
    -ppf * 120,
    0,
  );
  await expect.poll(async () => (await music()).fadeOut).toBe(120);
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("600");
  await page.keyboard.press("Enter");
  await page.keyboard.press("e");
  await expect.poll(async () => (await read()).clips.length).toBe(2);
  const tail = (await read()).clips.find((clip) => clip.id !== "music")!;
  await page
    .locator(`[data-clip="${tail.id}"]`)
    .click({ position: { x: 20, y: 5 } });
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await read()).clips.length).toBe(1);
  const baked = await read();
  expect((await music()).automation).toBeTruthy();
  await page
    .locator('[data-clip="music"]')
    .click({ position: { x: 25, y: 5 } });
  const clear = page.getByRole("button", {
    name: "Clear automation",
    exact: true,
  });
  await expect(clear).toBeVisible();
  await clear.click();
  await expect.poll(async () => (await music()).automation).toBeNull();
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(baked);
  const currentPpf = await settledPpf(page);
  await drag(
    page,
    '[data-clip-mix="music"] [data-mix="fadeOut"]',
    -currentPpf * 30,
    0,
  );
  // A fresh fade never removes automation on its own; clearing is explicit.
  await expect
    .poll(async () => ({
      automation: (await music()).automation,
      fadeOut: (await music()).fadeOut,
    }))
    .toEqual({
      automation: baked.clips.find((clip) => clip.id === "music")!.automation,
      fadeOut: 30,
    });
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(baked);
});

test("cold audio starting at five seconds drives meters, clipping latches until click or restart, and stop clears peak markers", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Late clip meters", duration: 12 },
      })
    ).json(),
  );
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='if(lt(t,1),0.8,0.03)*sin(2*PI*440*t)':s=48000:d=7",
    "-ac",
    "2",
    join(project.path, "Late.wav"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="12" data-fps="30"><audio id="late" src="Late.wav" data-start="5" data-duration="7" data-volume="${10 ** (12 / 20)}"></audio></main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  await page.keyboard.press("Space");
  const left = page.getByRole("button", {
    name: "Clear L clipping indicator",
    exact: true,
  });
  const right = page.getByRole("button", {
    name: "Clear R clipping indicator",
    exact: true,
  });
  await expect(left).toBeEnabled();
  await expect(right).toBeEnabled();
  const frame = page
    .frames()
    .find((frame) => frame.url().includes("/api/isolated/"))!;
  await expect
    .poll(() =>
      frame.evaluate(
        () =>
          (
            window as Window & { __player?: { getTime(): number } }
          ).__player?.getTime() ?? 0,
      ),
    )
    .toBeGreaterThan(6.5);
  await expect(left).toBeEnabled();
  await page.screenshot({ path: info.outputPath("latched-meters.png") });
  await left.click();
  await expect(left).toBeDisabled();
  await expect(right).toBeEnabled();
  await page.keyboard.press("k");
  await expect(page.locator(".tl-meter-peak:visible")).toHaveCount(0);
  await expect(right).toBeEnabled();
  const idle = await page.locator(".tl-meter-channel").last().innerHTML();
  await page.waitForTimeout(200);
  expect(await page.locator(".tl-meter-channel").last().innerHTML()).toBe(idle);
  await page.keyboard.press("Space");
  await expect(left).toBeDisabled();
  await expect(right).toBeDisabled();
  await page.keyboard.press("k");
  await expect(page.locator(".tl-meter-scale")).toHaveText("0-6-12-24-48");
});

/** A project with one 10 s tone on a default audio row, opened and settled. */
async function openTone(
  page: Page,
  request: APIRequestContext,
  name: string,
  attributes = "",
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name, duration: 12 },
      })
    ).json(),
  );
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.75*sin(2*PI*220*t):d=10",
    join(project.path, "Music.wav"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="12" data-fps="30"><audio id="music" src="Music.wav" data-start="0" data-duration="10" ${attributes}></audio></main></body></html>`,
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  await settledPpf(page);
  return {
    api,
    read,
    music: async () => (await read()).timeline.clips[0]!,
    gainEdits: async () =>
      (await (await request.get(`${api}/history`)).json()).entries.filter(
        (entry: { label: string }) => entry.label.startsWith("Set gain to "),
      ).length,
  };
}

/** Where the gain line is on screen at a fraction of the clip's width. */
const lineAt = (page: Page, fraction: number) =>
  page
    .locator('[data-clip-mix="music"] path')
    .first()
    .evaluate((path: SVGPathElement, x) => {
      let low = 0;
      let high = path.getTotalLength();
      for (let i = 0; i < 30; i++) {
        const middle = (low + high) / 2;
        if (path.getPointAtLength(middle).x < x) low = middle;
        else high = middle;
      }
      const point = path
        .getPointAtLength(low)
        .matrixTransform(path.getScreenCTM()!);
      return { x: point.x, y: point.y };
    }, fraction * 100);

test("a gain line answers its first pixel, and a press without a drag changes nothing", async ({
  page,
  request,
}) => {
  const { read, music, gainEdits } = await openTone(page, request, "Gain step");
  const initial = (await read()).timeline;
  const readout = page.locator(".tl-readout");
  const origin = await lineAt(page, 0.5);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x, origin.y + 1);
  await expect(readout).toHaveText("-1.0 dB");
  expect(
    Math.abs((await lineAt(page, 0.5)).y - (origin.y + 1)),
  ).toBeLessThanOrEqual(0.5);
  await page.mouse.move(origin.x, origin.y + 2);
  await expect(readout).toHaveText("-2.0 dB");
  await page.mouse.move(origin.x, origin.y - 1);
  await expect(readout).toHaveText("+1.3 dB");
  await page.mouse.up();
  await expect.poll(async () => (await music()).volume).toBe(10 ** (1.3 / 20));
  expect(await gainEdits()).toBe(1);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read()).timeline).toEqual(initial);
  const before = await (await read()).revision;
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await expect(readout).toHaveText("0.0 dB");
  await page.mouse.up();
  await expect(readout).toBeHidden();
  expect(await read()).toMatchObject({ revision: before, timeline: initial });
});

test("a pixel of wobble on the gain line still lets a sideways drag move the clip", async ({
  page,
  request,
}) => {
  const { read, music, gainEdits } = await openTone(
    page,
    request,
    "Gain wobble",
  );
  const initial = (await read()).timeline;
  const readout = page.locator(".tl-readout");
  const origin = await lineAt(page, 0.5);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x, origin.y + 1);
  // The first pixel shows its gain, but has not chosen the axis.
  await expect(readout).toHaveText("-1.0 dB");
  for (let dx = 6; dx <= 60; dx += 6) {
    await page.mouse.move(origin.x + dx, origin.y + 1);
    await page.waitForTimeout(16);
  }
  await expect(page.locator(".tl-lanes")).toHaveAttribute(
    "data-cursor",
    "move",
  );
  // The gain shown for that pixel is taken back while the clip is held.
  await expect(readout).not.toContainText("dB");
  expect(Math.abs((await lineAt(page, 0.5)).y - origin.y)).toBeLessThanOrEqual(
    0.5,
  );
  await page.mouse.up();
  await expect.poll(async () => (await music()).start).toBeGreaterThan(0);
  expect((await music()).volume).toBeNull();
  expect(await gainEdits()).toBe(0);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read()).timeline).toEqual(initial);
});

test("a quick click that wobbles on the gain line selects the clip and leaves the mix alone", async ({
  page,
  request,
}) => {
  const { read, music, gainEdits } = await openTone(
    page,
    request,
    "Gain click",
  );
  const before = await read();
  const readout = page.locator(".tl-readout");
  const clip = page.locator('[data-clip="music"]');
  await expect(clip).not.toHaveClass(/selected/);
  const origin = await lineAt(page, 0.5);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x, origin.y + 1);
  await page.mouse.up();
  await expect(clip).toHaveClass(/selected/);
  await expect(readout).toBeHidden();
  expect(Math.abs((await lineAt(page, 0.5)).y - origin.y)).toBeLessThanOrEqual(
    0.5,
  );
  expect(await read()).toEqual(before);
  expect(await gainEdits()).toBe(0);
  // Held past a click, the same pixel is a change.
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x, origin.y + 1);
  await expect(readout).toHaveText("-1.0 dB");
  await page.waitForTimeout(350);
  await page.mouse.up();
  await expect.poll(async () => (await music()).volume).toBe(10 ** (-1 / 20));
  await page.keyboard.press("Control+z");
  await expect.poll(read).toMatchObject({ timeline: before.timeline });
  // A quick drag that went further and came back still commits where it was let go.
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x, origin.y + 3);
  await page.mouse.move(origin.x, origin.y + 1);
  await page.mouse.up();
  await expect.poll(async () => (await music()).volume).toBe(10 ** (-1 / 20));
});

test("releasing Shift mid-drag leaves the gain line where it is, under the pointer", async ({
  page,
  request,
}) => {
  const { read, music, gainEdits } = await openTone(
    page,
    request,
    "Gain Shift",
  );
  const initial = (await read()).timeline;
  const readout = page.locator(".tl-readout");
  const origin = await lineAt(page, 0.5);
  await page.mouse.move(origin.x, origin.y);
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(origin.x, origin.y - 40, { steps: 10 });
  await expect(readout).toHaveText("+4.0 dB");
  await page.keyboard.up("Shift");
  const fine = await lineAt(page, 0.5);
  await page.mouse.move(origin.x, origin.y - 36, { steps: 4 });
  // The line goes on from +4 dB and moves the 4 px the pointer did, past unity.
  await expect(readout).toHaveText("-0.8 dB");
  const coarse = await lineAt(page, 0.5);
  expect(Math.abs(coarse.y - (fine.y + 4))).toBeLessThanOrEqual(0.5);
  await page.keyboard.down("Shift");
  await page.mouse.move(origin.x, origin.y - 32, { steps: 4 });
  await expect(readout).toHaveText("-1.2 dB");
  await page.keyboard.up("Shift");
  await page.mouse.up();
  await expect.poll(async () => (await music()).volume).toBe(10 ** (-1.2 / 20));
  // Each change of Shift took hold again, yet the drag is one step back to where it began.
  expect(await gainEdits()).toBe(1);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read()).timeline).toEqual(initial);
});

test("a gain drag inside a fade keeps the line under the pointer", async ({
  page,
  request,
}) => {
  const { read, music } = await openTone(
    page,
    request,
    "Gain in a fade",
    'data-fade-in="2"',
  );
  const initial = (await read()).timeline;
  // Halfway up the fade, where the line is drawn at half the gain's height.
  const origin = await lineAt(page, 0.1);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  for (let dy = 1; dy <= 3; dy++) {
    await page.mouse.move(origin.x, origin.y - dy);
    await page.waitForTimeout(16);
  }
  await expect(page.locator(".tl-readout")).toHaveText("+7.6 dB");
  expect(
    Math.abs((await lineAt(page, 0.1)).y - (origin.y - 3)),
  ).toBeLessThanOrEqual(0.5);
  await page.mouse.up();
  await expect.poll(async () => (await music()).volume).toBe(10 ** (7.6 / 20));
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read()).timeline).toEqual(initial);
});

test("a gain drag keeps the line and its level under the pointer, scales the waveform, and matches a command", async ({
  page,
  request,
}, info) => {
  const { api, read, gainEdits } = await openTone(
    page,
    request,
    "Gain feedback",
    'data-fade-out="4"',
  );
  const initial = (await read()).timeline;
  // The line a quarter of the way in, clear of the fade.
  const line = () => lineAt(page, 0.25);
  const clip = (await page.locator('[data-clip="music"]').boundingBox())!;
  // How many pixels tall the drawn waveform is at a fraction of the clip's width.
  const wave = (fraction: number) =>
    page.locator("canvas.tl-bodies").evaluate(
      (canvas: HTMLCanvasElement, at) => {
        const box = canvas.getBoundingClientRect();
        const { data } = canvas
          .getContext("2d")!
          .getImageData(
            Math.round((at.x - box.left) * devicePixelRatio),
            Math.round((at.y - box.top) * devicePixelRatio),
            1,
            Math.round(at.height * devicePixelRatio),
          );
        let filled = 0;
        for (let index = 3; index < data.length; index += 4)
          if (data[index]! > 0) filled++;
        return filled;
      },
      {
        x: clip.x + clip.width * fraction,
        y: clip.y,
        height: clip.height,
      },
    );
  await expect.poll(() => wave(0.25)).toBeGreaterThan(12);
  const full = await wave(0.25);
  // A fade and the gain line are one envelope: the waveform narrows along the fade.
  expect(await wave(0.9)).toBeLessThan(full * 0.7);

  const readout = page.locator(".tl-readout");
  const onLine = async (y: number) => {
    const box = (await readout.boundingBox())!;
    expect(Math.abs(box.y + box.height / 2 - y)).toBeLessThanOrEqual(1);
  };
  const origin = await line();
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  // A press names the level on the line before the pointer moves.
  await expect(readout).toHaveText("0.0 dB");
  await onLine(origin.y);
  for (let dy = 1; dy <= 10; dy++) {
    await page.mouse.move(origin.x, origin.y + dy);
    await page.waitForTimeout(16);
  }
  await expect(readout).toHaveText("-15.0 dB");
  const held = await line();
  expect(Math.abs(held.y - (origin.y + 10))).toBeLessThanOrEqual(0.5);
  await onLine(held.y);
  const box = (await readout.boundingBox())!;
  expect(box.x - origin.x).toBeGreaterThan(0);
  expect(box.x - origin.x).toBeLessThan(24);
  // The clip is visibly quieter while the line is held.
  const quiet = await wave(0.25);
  expect(quiet).toBeLessThan(full * 0.6);
  await page.screenshot({ path: info.outputPath("gain-held.png") });
  await page.mouse.up();
  await expect(readout).toBeHidden();
  await expect
    .poll(async () => (await read()).timeline.clips[0]!.volume)
    .toBe(10 ** (-15 / 20));
  expect(await gainEdits()).toBe(1);
  expect(await wave(0.25)).toBe(quiet);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read()).timeline).toEqual(initial);
  await expect.poll(() => wave(0.25)).toBe(full);

  // The same gain sent as a command, as an agent sends it, draws the same line and waveform.
  expect(
    (
      await request.post(`${api}/commands`, {
        data: {
          expectedRevision: (await read()).revision,
          commands: [
            { type: "setClip", clipId: "music", volume: 10 ** (-15 / 20) },
          ],
        },
      })
    ).ok(),
  ).toBe(true);
  await expect.poll(async () => (await line()).y).toBeCloseTo(held.y, 1);
  await expect.poll(() => wave(0.25)).toBe(quiet);
  await expect(
    page.locator('[data-clip-mix="music"] [data-mix="gain"]'),
  ).toContainText("Gain -15.0 dB");

  // Ducked far down, as a music bed under speech is, the wave keeps a third of its height so
  // its beats still show, and the fade at the end still tapers away from it.
  expect(
    (
      await request.post(`${api}/commands`, {
        data: {
          expectedRevision: (await read()).revision,
          commands: [{ type: "setClip", clipId: "music", volume: 0.01 }],
        },
      })
    ).ok(),
  ).toBe(true);
  await expect.poll(async () => (await line()).y).toBeGreaterThan(held.y + 3);
  await page.waitForTimeout(100);
  const ducked = await wave(0.25);
  expect(ducked).toBeGreaterThan(full * 0.27);
  expect(ducked).toBeLessThanOrEqual(quiet);
  expect(await wave(0.9)).toBeLessThan(ducked * 0.8);
});

test("a horizontal drag from the gain line moves the whole selection, as a body drag does", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Gain handoff", duration: 10 },
      })
    ).json(),
  );
  for (const name of ["Music", "Voice"])
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=10",
      join(project.path, `${name}.wav`),
    ]);
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="10" data-fps="30"><audio id="music" src="Music.wav" data-start="0" data-duration="4" data-track-index="0"></audio><audio id="voice" src="Voice.wav" data-start="0" data-duration="4" data-track-index="1"></audio></main></body></html>',
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const starts = async () =>
    Object.fromEntries(
      TimelineViewSchema.parse(
        await (await request.get(`${api}/timeline`)).json(),
      ).timeline.clips.map((clip) => [clip.id, clip.start]),
    );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  await page
    .locator('[data-clip="music"]')
    .click({ position: { x: 25, y: 5 } });
  await page
    .locator('[data-clip="voice"]')
    .click({ position: { x: 25, y: 5 }, modifiers: ["Control"] });
  await drag(page, '[data-clip-mix="music"] [data-mix="gain"]', 60, 1);
  await expect.poll(async () => (await starts()).music).toBeGreaterThan(0);
  const moved = await starts();
  expect(moved.voice).toBe(moved.music);
});

for (const density of ["compact", "normal", "tall"] as const)
  test(`a vertical drag from the middle of an audio clip moves it to another track, at unity and at bed levels, on ${density} tracks`, async ({
    page,
    request,
  }) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: `Middle drag ${density}`, duration: 10 },
        })
      ).json(),
    );
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=10",
      join(project.path, "Music.wav"),
    ]);
    // Four clips on A1: at unity, and at -6, -12 and -24 dB, where a music bed sits.
    const levels = [null, -6, -12, -24];
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="10" data-fps="30">${levels
        .map(
          (db, index) =>
            `<audio id="clip-${index}" src="Music.wav" data-start="${index * 2.5}" data-duration="2" data-track-index="0"${db === null ? "" : ` data-volume="${10 ** (db / 20)}"`}></audio>`,
        )
        .join("")}</main></body></html>`,
    );
    const api = `/api/cutroom/projects/${project.id}`;
    const read = async () =>
      TimelineViewSchema.parse(
        await (await request.get(`${api}/timeline`)).json(),
      );
    expect(
      (
        await request.post(`${api}/commands`, {
          data: {
            expectedRevision: (await read()).revision,
            commands: [{ type: "setTrack", index: 1, kind: "audio" }],
          },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await request.put(`${api}/timeline-view`, {
          data: { density, heights: {} },
        })
      ).ok(),
    ).toBe(true);
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator("[data-clip-mix]")).toHaveCount(levels.length);
    const lane = (await page.locator(".tl-lane.audio").nth(1).boundingBox())!;
    const clip = async (index: number) =>
      (await read()).timeline.clips.find(
        (item) => item.id === `clip-${index}`,
      )!;
    for (const [index] of levels.entries()) {
      const before = await clip(index);
      const box = (await page
        .locator(`[data-clip="clip-${index}"]`)
        .boundingBox())!;
      const body = (await page
        .locator(`[data-clip-mix="clip-${index}"] svg`)
        .boundingBox())!;
      // The two places a hand takes a clip: the middle of its box, and of its waveform.
      for (const y of [box.y + box.height / 2, body.y + body.height / 2]) {
        const x = box.x + box.width / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, lane.y + lane.height / 2, { steps: 8 });
        await page.mouse.up();
        await expect.poll(async () => (await clip(index)).track).toBe(1);
        expect(await clip(index)).toMatchObject({
          start: before.start,
          volume: before.volume,
        });
        await page.keyboard.press("Control+z");
        await expect.poll(() => clip(index)).toEqual(before);
        // The clip slides back to its track before the next press can find it there.
        await expect
          .poll(async () =>
            page.locator(`[data-clip="clip-${index}"]`).boundingBox(),
          )
          .toEqual(box);
        await expect(page.locator(".tl-lanes")).not.toHaveAttribute(
          "data-sliding",
        );
      }
    }
  });
