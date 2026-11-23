import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

test("a looping clip in a trimmed mount plays from its in-point where the mount opens, as export does", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Loop mount", width: 640, height: 360, duration: 7 },
      })
    ).json(),
  );
  const scenes = join(project.path, "scenes");
  await mkdir(scenes, { recursive: true });
  // Four seconds whose left channel names its own sample, quietly.
  const samples = 4 * 48_000;
  const wav = Buffer.alloc(44 + samples * 4);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 4, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(192_000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 4, 40);
  for (let n = 0; n < samples; n++) wav.writeInt16LE(n % 4096, 44 + n * 4);
  await writeFile(join(scenes, "index.wav"), wav);
  await writeFile(
    join(scenes, "bed.html"),
    `<template><main id="bed-scene" data-composition-id="bed-scene" data-width="640" data-height="360" data-fps="30" data-duration="10">
      <audio id="bed" class="clip" src="index.wav" loop data-start="0" data-duration="10" data-media-start="1" data-track-index="0"></audio>
    </main></template>`,
  );
  // The scene's origin is 0.5 s. Export restarts the loop at its 1 s in-point where the mount
  // opens at 2 s, so timeline second t plays source second t - 1 until the loop wraps at 5 s.
  await writeFile(
    join(project.path, "index.html"),
    `<main id="main" data-composition-id="main" data-fps="30" data-width="640" data-height="360" data-duration="7">
      <div id="mount" data-composition-id="bed-scene" data-composition-src="scenes/bed.html" data-start="2" data-duration="5" data-media-start="1.5" data-track-index="0"></div>
    </main>`,
  );
  await page.goto(`/#project/${project.id}`);
  const stage = page.locator(".edit-stage");
  await expect(stage).toHaveAttribute("data-preview-ready");
  await seekFrame(page, 60);
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  const readings = await page
    .frameLocator("iframe[data-live]")
    .locator("#bed")
    .evaluate(async (element) => {
      const { __player: player } = window as Window & {
        __player?: { getTime(): number };
      };
      if (!player) throw new Error("The playback runtime is missing.");
      const media = element as HTMLAudioElement;
      const readings: { time: number; source: number }[] = [];
      while (readings.length < 40) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        const time = player.getTime();
        if (time > 2.2 && time < 4.8 && !media.paused)
          readings.push({ time, source: media.currentTime });
      }
      return readings;
    });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await writeFile(
    info.outputPath("loop-readings.json"),
    JSON.stringify(readings, null, 2),
  );
  const drift = Math.max(
    ...readings.map(({ time, source }) => Math.abs(source - (time - 1))),
  );
  expect(drift).toBeLessThan(0.06);
});
