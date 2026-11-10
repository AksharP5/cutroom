import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
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
    .toEqual({ duration: 60, fadeOut: 0 });
  await drag(page, '[data-clip-mix="music"] [data-mix="fadeOut"]', -35, 0);
  await expect.poll(async () => (await music()).fadeOut).toBeGreaterThan(0);
  expect((await music()).fadeOut).toBeLessThanOrEqual(60);
  await page.screenshot({ path: info.outputPath("trimmed-envelope.png") });
});
