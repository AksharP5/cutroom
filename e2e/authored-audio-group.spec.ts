import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

test("Inspector changes an authored group's live and exported gain, and Undo restores it", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Authored audio group", duration: 8 },
      })
    ).json(),
  );
  const source = `<!doctype html><html><body><main data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-fps="30" data-duration="8"><hf-audio-group id="dialogue" data-volume="0.8" data-automation='{"version":1,"lanes":[]}'></hf-audio-group><audio id="one" src="voice.wav" data-start="0" data-duration="4" data-track-index="1" data-audio-group="dialogue"></audio><audio id="two" src="voice.wav" data-start="4" data-duration="4" data-track-index="2" data-audio-group="dialogue"></audio></main></body></html>`;
  const path = join(project.path, "index.html");
  await writeFile(path, source);
  // A quiet sine leaves headroom, so the master limiter cannot hide a difference.
  const rate = 48_000;
  const amplitude = 0.125;
  const volume = 10 ** (-6 / 20);
  const wav = Buffer.alloc(44 + rate * 4 * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < rate * 4; i++)
    wav.writeInt16LE(
      Math.round(32768 * amplitude * Math.sin((2 * Math.PI * 440 * i) / rate)),
      44 + i * 2,
    );
  await writeFile(join(project.path, "voice.wav"), wav);
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="one"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const gain = inspector.getByRole("textbox", {
    name: "Group gain",
    exact: true,
  });
  await expect(gain).toBeVisible();
  const stage = page.locator(".edit-stage");
  await expect(stage).toHaveAttribute("data-preview-ready");
  const token = await stage.getAttribute("data-preview-ready");
  const play = async (volume: number) => {
    await page
      .getByRole("button", { name: "First frame", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Play forward", exact: true })
      .click();
    let peak = 0;
    await expect
      .poll(async () => {
        peak = await page
          .frameLocator("iframe[data-live]")
          .locator("main")
          .evaluate(() => {
            const runtime = window as Window & {
              __hf?: { audioMeter?: { read(): { master: { r: number } } } };
            };
            return runtime.__hf?.audioMeter?.read().master.r ?? 0;
          });
        return peak;
      })
      .toBeCloseTo(amplitude * volume, 2);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    return peak;
  };
  const before = await play(0.8);
  await inspector.screenshot({ path: info.outputPath("bus-before.png") });
  await gain.fill("-6 dB");
  await gain.press("Enter");
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  await expect
    .poll(async () => (await read()).timeline.authoredAudioGroups)
    .toEqual([{ id: "dialogue", volume }]);
  expect(await readFile(path, "utf8")).toBe(
    source.replace('data-volume="0.8"', `data-volume="${volume}"`),
  );
  await expect(stage).toHaveAttribute("data-preview-ready");
  await expect(stage).not.toHaveAttribute("data-preview-ready", token!);
  const after = await play(volume);
  await inspector.screenshot({ path: info.outputPath("bus-after.png") });

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  await page.getByRole("button", { name: "Export MP4", exact: true }).click();
  const { outputPath } = z
    .object({ outputPath: z.string() })
    .parse(await (await started).json());
  const dialog = page.getByRole("dialog", { name: "Export" });
  await expect(dialog).toContainText("Export complete.", { timeout: 40_000 });
  // Check both non-overlapping members in the produced file. Stereo panning and AAC make peak
  // amplitude differ slightly, so compare within 1 dB rather than by raw PCM bytes.
  const exported = [];
  for (const time of [0.5, 4.5]) {
    const { stdout } = await promisify(execFile)(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        String(time),
        "-i",
        outputPath,
        "-t",
        "0.5",
        "-map",
        "0:a:0",
        "-ac",
        "2",
        "-f",
        "f32le",
        "-",
      ],
      { encoding: "buffer" },
    );
    expect(stdout.byteLength).toBeGreaterThan(0);
    let peak = 0;
    for (let i = 0; i < stdout.byteLength; i += 8)
      peak = Math.max(peak, Math.abs(stdout.readFloatLE(i)));
    expect(Math.abs(20 * Math.log10(peak / (amplitude * volume)))).toBeLessThan(
      1,
    );
    exported.push({ time, peak });
  }
  await writeFile(
    info.outputPath("gain.json"),
    JSON.stringify({ preview: { before, after }, exported }, null, 2),
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => readFile(path, "utf8")).toBe(source);
});

test("selected clips can make a named group, return to track mixing, and export those levels", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Dialogue routing", duration: 4 },
      })
    ).json(),
  );
  const source = `<!doctype html><html><body><main data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-fps="30" data-duration="4"><audio id="one" src="voice.wav" data-start="0" data-duration="2" data-track-index="1"></audio><audio id="two" src="voice.wav" data-start="2" data-duration="2" data-track-index="2"></audio></main></body></html>`;
  await writeFile(join(project.path, "index.html"), source);
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.125*sin(2*PI*440*t):s=48000:d=2",
    join(project.path, "voice.wav"),
  ]);
  await page.goto(`/#project/${project.id}`);
  const clips = (id: string) => page.locator(`[data-clip="${id}"]`);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const group = inspector.getByRole("combobox", { name: "Audio group" });
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline;
  await clips("one").click({ position: { x: 25, y: 5 } });
  await clips("two").click({
    position: { x: 25, y: 5 },
    modifiers: ["Control"],
  });
  await expect(group).toHaveText("Track mixing");
  await inspector.screenshot({ path: info.outputPath("before-group.png") });
  await group.click();
  await page.getByRole("option", { name: "New group…" }).click();
  const form = inspector.getByRole("form", { name: "New audio group" });
  await form
    .getByRole("textbox", { name: "Audio group name" })
    .fill("Dialogue");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(group).toHaveText("Dialogue");
  await expect
    .poll(async () => {
      const timeline = await read();
      const bus = timeline.authoredAudioGroups?.[0];
      return (
        bus && {
          label: bus.label,
          members: timeline.clips
            .filter(
              ({ authoredAudioGroupId }) => authoredAudioGroupId === bus.id,
            )
            .map(({ id }) => id),
        }
      );
    })
    .toEqual({ label: "Dialogue", members: ["one", "two"] });
  await inspector.screenshot({ path: info.outputPath("after-group.png") });

  const gain = inspector.getByRole("textbox", {
    name: "Group gain",
    exact: true,
  });
  await gain.fill("-12 dB");
  await gain.press("Enter");
  await expect
    .poll(async () => (await read()).authoredAudioGroups?.[0]?.volume)
    .toBeCloseTo(10 ** (-12 / 20));
  await clips("one").click({ position: { x: 25, y: 5 } });
  await group.click();
  await page.getByRole("option", { name: "Track mixing", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await read()).clips.find(({ id }) => id === "one")
          ?.authoredAudioGroupId,
    )
    .toBeUndefined();

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  await page.getByRole("button", { name: "Export MP4", exact: true }).click();
  const { outputPath } = z
    .object({ outputPath: z.string() })
    .parse(await (await started).json());
  await expect(page.getByRole("dialog", { name: "Export" })).toContainText(
    "Export complete.",
    { timeout: 40_000 },
  );
  const amplitudes: number[] = [];
  for (const time of ["0.5", "2.5"]) {
    const { stdout } = await promisify(execFile)(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        time,
        "-i",
        outputPath,
        "-t",
        "0.5",
        "-ac",
        "2",
        "-f",
        "f32le",
        "-",
      ],
      { encoding: "buffer" },
    );
    expect(stdout.byteLength).toBeGreaterThan(0);
    let peak = 0;
    for (let i = 0; i < stdout.byteLength; i += 8)
      peak = Math.max(peak, Math.abs(stdout.readFloatLE(i)));
    amplitudes.push(peak);
  }
  expect(
    Math.abs(20 * Math.log10(amplitudes[0]! / amplitudes[1]!) - 12),
  ).toBeLessThan(1);
  await writeFile(
    info.outputPath("routed-peaks.json"),
    JSON.stringify(amplitudes),
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(group).toHaveText("Dialogue");
});
