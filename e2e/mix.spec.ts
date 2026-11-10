import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);

async function drag(page: Page, selector: string, dx: number, dy: number) {
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
      page
        .locator(".tl-meter-level")
        .evaluateAll((bars) =>
          bars.every(
            (bar) =>
              new DOMMatrixReadOnly(getComputedStyle(bar).transform).m22 > 0.1,
          ),
        ),
    )
    .toBe(true);
  await page.keyboard.press("k");
  await page.keyboard.press("Home");
  const gain = '[data-clip-mix="music"] [data-mix="gain"]';
  const initial = (await read()).timeline;
  await drag(page, gain, 0, 24);
  await expect.poll(async () => (await music()).volume).toBe(10 ** (-12 / 20));
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read()).timeline).toEqual(initial);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await music()).volume).toBe(10 ** (-12 / 20));
  const gainOnly = (await read()).timeline;
  const ppf = await page
    .locator(".tl-grid")
    .evaluate((grid: HTMLElement) =>
      Number(grid.style.getPropertyValue("--ppf")),
    );
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
  const download = page.waitForEvent("download", { timeout: 90_000 });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const output = info.outputPath("mix.mp4");
  await (await download).saveAs(output);
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
  ).toHaveAttribute("style", "right: 0%;");
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
    .toEqual({ duration: 60, fadeOut: 60 });
  await drag(page, '[data-clip-mix="music"] [data-mix="fadeOut"]', 35, 0);
  await expect.poll(async () => (await music()).fadeOut).toBeGreaterThan(0);
  expect((await music()).fadeOut).toBeLessThanOrEqual(60);
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
  await page.mouse.move(point.x + 80, point.y - 12, { steps: 12 });
  await page.mouse.up();
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
    volume: 10 ** (6 / 20),
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
  const ppf = await page
    .locator(".tl-grid")
    .evaluate((grid: HTMLElement) =>
      Number(grid.style.getPropertyValue("--ppf")),
    );
  const edgeDrag = async (
    clipId: string,
    dx: number,
    edge: "start" | "end",
  ) => {
    const clip = page.locator(`[data-clip="${clipId}"]`);
    await expect
      .poll(() => clip.evaluate((element) => element.getAnimations().length))
      .toBe(0);
    const box = (await clip.boundingBox())!;
    const x = edge === "start" ? box.x + 1 : box.x + box.width - 1;
    const y = box.y + 12;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 12 });
    await page.mouse.up();
  };
  const evidence = [];
  for (const roll of [false, true]) {
    await page.keyboard.press(roll ? "t" : "a");
    await edgeDrag(roll ? "next" : "music", -60 * ppf, roll ? "start" : "end");
    await expect
      .poll(
        async () =>
          (await read()).clips.find((clip) => clip.id === "music")?.duration,
      )
      .toBe(180);
    const short = await read();
    expect(short.clips.find((clip) => clip.id === "music")).toMatchObject({
      fadeOut: 120,
      automation: null,
    });
    await page.screenshot({
      path: info.outputPath(`${roll ? "roll" : "trim"}-short.png`),
    });
    await edgeDrag(roll ? "next" : "music", 60 * ppf, roll ? "start" : "end");
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
  await writeFile(
    info.outputPath("edge-readback.json"),
    JSON.stringify(evidence, null, 2),
  );
});
