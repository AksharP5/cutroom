import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

test("a looping music bed keeps playing from its in-point after it wraps, as export does", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Loop wrap", width: 640, height: 360, duration: 7 },
      })
    ).json(),
  );
  // Four seconds of quiet audio. From its 1 s in-point the loop is 3 s long, so timeline
  // second t plays source second 1 + (t mod 3), and the first wrap is at 3 s.
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
  await writeFile(join(project.path, "bed.wav"), wav);
  await writeFile(
    join(project.path, "index.html"),
    `<main id="main" data-composition-id="main" data-fps="30" data-width="640" data-height="360" data-duration="7">
      <audio id="bed" class="clip" src="bed.wav" loop data-start="0" data-duration="7" data-media-start="1" data-track-index="0"></audio>
    </main>`,
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  await seekFrame(page, 75);
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
      const readings: { time: number; source: number; paused: boolean }[] = [];
      for (;;) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        const time = player.getTime();
        if (time >= 4.2) return readings;
        if (time > 2.6)
          readings.push({
            time,
            source: media.currentTime,
            paused: media.paused,
          });
      }
    });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await writeFile(
    info.outputPath("loop-wrap-readings.json"),
    JSON.stringify(readings, null, 2),
  );
  // The runtime corrects the native wrap within a frame or two; judge the rest.
  const settled = readings.filter(({ time }) => Math.abs(time - 3) > 0.1);
  expect(settled.filter(({ time }) => time > 3).length).toBeGreaterThan(20);
  expect(settled.filter(({ paused }) => paused)).toEqual([]);
  const drift = Math.max(
    ...settled.map(({ time, source }) => Math.abs(source - (1 + (time % 3)))),
  );
  expect(drift).toBeLessThan(0.06);
});
