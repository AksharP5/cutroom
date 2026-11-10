import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);

/** A real Media-panel drag, including dragstart's protected data and the dragover preview. */
async function drop(
  page: Page,
  file: string,
  destination: () => Promise<{ x: number; y: number }>,
) {
  const row = page
    .getByRole("region", { name: "Media", exact: true })
    .getByRole("listitem")
    .filter({ hasText: file });
  await expect(row).toHaveAttribute("draggable", "true");
  const point = await destination();
  await row.hover();
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".tl-ghost")).toBeVisible();
  await page.mouse.up();
}

async function makeMedia(directory: string) {
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x180:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(directory, "Picture.mp4"),
  ]);
  for (const [name, frequency] of [
    ["Voice", 660],
    ["Music", 880],
  ] as const)
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=2`,
      join(directory, `${name}.wav`),
    ]);
}

async function exportAudio(page: Page, path: string) {
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await (await download).saveAs(path);
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      "0.25",
      "-i",
      path,
      "-t",
      "1",
      "-vn",
      "-af",
      "pan=mono|c0=c0",
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
  const levels = [440, 660, 880].map((frequency) => {
    let sin = 0,
      cos = 0;
    for (const [index, sample] of samples.entries()) {
      const angle = (2 * Math.PI * frequency * index) / 48000;
      sin += sample * Math.sin(angle);
      cos += sample * Math.cos(angle);
    }
    return (2 * Math.hypot(sin, cos)) / samples.length;
  });
  return { path, levels };
}

test("build and mix picture, voice and music with track drops, then export exactly what is audible", async ({
  page,
  request,
}, info) => {
  test.setTimeout(180_000);
  const created = await request.post("/api/cutroom/projects", {
    data: { name: "Tracks to mix on", width: 320, height: 240, duration: 2 },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const project = ProjectSchema.parse(await created.json());
  // An unknown root duration forces the producer through browser media discovery.
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><head><style>html,body{margin:0;background:#000}main{position:relative;width:320px;height:180px}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="0" data-fps="30"></main></body></html>',
  );
  await makeMedia(project.path);
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  const lanes = page.locator(".tl-lanes");
  const point = async (selector: string, offset = 0) => {
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(`No bounds for ${selector}`);
    return { x: box.x + 2, y: box.y + offset };
  };
  // Above V1 creates V2. Sound gets the first free audio track, without a second UI action.
  await drop(page, "Picture.mp4", () => point(".tl-lanes", 7));
  await expect.poll(async () => (await read()).clips.length).toBe(2);
  const picture = (await read()).clips.find((clip) => clip.kind === "video")!;
  const sound = (await read()).clips.find((clip) => clip.kind === "audio")!;
  expect(picture.hasAudio).toBe(false);
  expect(sound.link).toBe(picture.link);
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => [
      (await read()).clips.length,
      (await read()).tracks.length,
    ])
    .toEqual([0, 0]);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await read()).clips.length).toBe(2);
  const below = async () => {
    const box = await lanes.boundingBox();
    if (!box) throw new Error("No lanes");
    const y = await page
      .locator(".tl-lane.audio")
      .last()
      .evaluate((row) => row.getBoundingClientRect().bottom);
    return { x: box.x + 2, y: y + 7 };
  };
  await drop(page, "Voice.wav", below);
  await expect.poll(async () => (await read()).clips.length).toBe(3);
  await drop(page, "Music.wav", below);
  await expect.poll(async () => (await read()).clips.length).toBe(4);
  const name = page.getByRole("textbox", { name: "Name A3", exact: true });
  await name.fill("Music");
  await name.press("Enter");
  await expect
    .poll(async () => (await read()).tracks.at(-1)?.name)
    .toBe("Music");
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read()).tracks.at(-1)?.name).toBeNull();
  await page.keyboard.press("Control+Shift+z");
  await expect
    .poll(async () => (await read()).tracks.at(-1)?.name)
    .toBe("Music");
  // A header context menu also adds an empty track in one undo step.
  await page.locator(".tl-head.audio").last().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add audio track" }).click();
  await expect(
    page.getByRole("button", { name: "Solo A4", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(
    page.getByRole("button", { name: "Solo A4", exact: true }),
  ).toHaveCount(0);

  const all = await exportAudio(page, info.outputPath("all.mp4"));
  for (const level of all.levels) expect(level).toBeCloseTo(0.125, 2);
  // M and S are live while the transport is playing, and export uses that same mix.
  await page.keyboard.press("Space");
  const mute = page.getByRole("button", { name: "Mute A3", exact: true });
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await read()).tracks.at(-1)?.muted).toBe(true);
  await expect(
    page.frameLocator("iframe[data-live]").locator('audio[src="Music.wav"]'),
  ).toHaveAttribute("data-hidden", "");
  await expect
    .poll(() =>
      page
        .frameLocator("iframe[data-live]")
        .locator('audio[src="Music.wav"]')
        .evaluate((audio: HTMLAudioElement) => audio.volume),
    )
    .toBe(0);
  await page.keyboard.press("k");
  const muted = await exportAudio(page, info.outputPath("music-muted.mp4"));
  expect(muted.levels[0]).toBeCloseTo(all.levels[0], 2);
  expect(muted.levels[1]).toBeCloseTo(all.levels[1], 2);
  expect(muted.levels[2]).toBeLessThan(0.001);
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Solo A2", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await read()).tracks.find((track) => track.index === sound.track)
          ?.solo,
    )
    .toBe(false);
  await expect(
    page.frameLocator("iframe[data-live]").locator(`audio[id="${sound.id}"]`),
  ).toHaveAttribute("data-hidden", "");
  await expect
    .poll(() =>
      page
        .frameLocator("iframe[data-live]")
        .locator(`audio[id="${sound.id}"]`)
        .evaluate((audio: HTMLAudioElement) => audio.volume),
    )
    .toBe(0);
  await expect
    .poll(() =>
      page
        .frameLocator("iframe[data-live]")
        .locator('audio[src="Voice.wav"]')
        .evaluate((audio: HTMLAudioElement) => audio.volume),
    )
    .toBe(1);
  await page.keyboard.press("k");
  await page.getByRole("button", { name: "Enable V2", exact: true }).click();
  const solo = await exportAudio(page, info.outputPath("voice-solo.mp4"));
  expect(solo.levels[0]).toBeLessThan(0.001);
  expect(solo.levels[1]).toBeCloseTo(all.levels[1], 2);
  expect(solo.levels[2]).toBeLessThan(0.001);
  const { stdout: pixel } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      solo.path,
      "-frames:v",
      "1",
      "-vf",
      "scale=1:1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  expect([...pixel].every((channel) => channel < 5)).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Solo A2", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(name).toHaveValue("Music");
});

test("browser-probed exports honor mute and solo for authored video sound while keeping its picture", async ({
  page,
  request,
}, info) => {
  test.setTimeout(180_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Embedded video sound",
          width: 320,
          height: 240,
          duration: 2,
        },
      })
    ).json(),
  );
  await makeMedia(project.path);
  // The producer must probe the browser to resolve a zero root duration.
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#000}main{position:relative;width:320px;height:180px}video{width:100%;height:100%}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="0" data-fps="30">
    <video id="picture" src="Picture.mp4" data-start="0" data-duration="2" data-track-index="0" data-has-audio="true"></video>
    <audio id="voice" src="Voice.wav" data-start="0" data-duration="2" data-track-index="1"></audio>
    <audio id="music" src="Music.wav" data-start="0" data-duration="2" data-track-index="2"></audio>
  </main></body></html>`,
  );
  const edit = async (commands: CommandInput[]) => {
    const view = TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
    const response = await request.post(
      `/api/cutroom/projects/${project.id}/commands`,
      { data: { expectedRevision: view.revision, commands } },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const edited = TimelineViewSchema.parse(await response.json());
    expect(
      edited.timeline.clips.find((clip) => clip.id === "picture"),
    ).toMatchObject({ enabled: true, hasAudio: true });
    return edited;
  };
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  const normal = await exportAudio(
    page,
    info.outputPath("embedded-normal.mp4"),
  );
  for (const level of normal.levels) expect(level).toBeCloseTo(0.125, 2);
  await edit([{ type: "setTrack", index: 0, muted: true }]);
  await expect(
    page.frameLocator("iframe[data-live]").locator("#picture"),
  ).toHaveAttribute("muted", "");
  await expect(
    page.frameLocator("iframe[data-live]").locator("#picture"),
  ).not.toHaveAttribute("data-hidden");
  const muted = await exportAudio(page, info.outputPath("embedded-muted.mp4"));
  expect(muted.levels[0]).toBeLessThan(0.001);
  expect(muted.levels[1]).toBeCloseTo(normal.levels[1], 2);
  expect(muted.levels[2]).toBeCloseTo(normal.levels[2], 2);
  const { stdout: pixel } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      muted.path,
      "-frames:v",
      "1",
      "-vf",
      "scale=1:1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  expect(pixel[0]).toBeGreaterThan(200);
  expect(pixel[1]).toBeLessThan(5);
  expect(pixel[2]).toBeLessThan(5);
  await edit([
    { type: "setTrack", index: 0, muted: false },
    { type: "setTrack", index: 1, solo: true },
  ]);
  const solo = await exportAudio(page, info.outputPath("embedded-solo.mp4"));
  expect(solo.levels[0]).toBeLessThan(0.001);
  expect(solo.levels[1]).toBeCloseTo(normal.levels[1], 2);
  expect(solo.levels[2]).toBeLessThan(0.001);
});
