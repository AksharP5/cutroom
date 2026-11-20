import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

const amplitude = 0.125;

/** A1 plays a tone for two seconds on track mixing, then A2's tone plays through Voices for six. */
async function bench(request: APIRequestContext, name: string) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name, duration: 8 },
      })
    ).json(),
  );
  const source = `<!doctype html><html><body><main data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-fps="30" data-duration="8"><hf-audio-group id="voices" data-label="Voices" data-volume="1"></hf-audio-group><audio id="a" src="a.wav" data-start="0" data-duration="2" data-track-index="1"></audio><audio id="b" src="b.wav" data-start="2" data-duration="6" data-track-index="2" data-audio-group="voices"></audio></main></body></html>`;
  await writeFile(join(project.path, "index.html"), source);
  for (const [file, frequency, seconds] of [
    ["a.wav", 1000, 2],
    ["b.wav", 440, 6],
  ] as const)
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=${amplitude}*sin(2*PI*${frequency}*t):s=48000:d=${seconds}`,
      join(project.path, file),
    ]);
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline;
  return { project, source, read };
}

async function openMixer(page: Page, id: string) {
  await page.goto(`/#project/${id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  await page.getByRole("button", { name: "Mixer", exact: true }).click();
  return page.getByRole("region", { name: "Mixer" });
}

/** The post-fader peak HyperFrames measures for a bus, as the strip's meter shows it. */
const busPeak = (page: Page, id: string) =>
  page
    .frameLocator("iframe[data-live]")
    .locator("main")
    .first()
    .evaluate((_, id) => {
      const runtime = window as Window & {
        __hf?: {
          audioMeter?: {
            read(): { groups: Record<string, { l: number; r: number }> };
          };
        };
      };
      return runtime.__hf?.audioMeter?.read().groups[id]?.r ?? 0;
    }, id);

test("the mixer shows each track and bus, and a bus fader is heard while it moves and saves once on release", async ({
  page,
  request,
}) => {
  const { project, source, read } = await bench(request, "Mixer fader");
  const mixer = await openMixer(page, project.id);
  const voices = mixer.getByRole("group", { name: "Voices" });
  await expect(mixer.getByRole("group", { name: "A1 Audio 1" })).toBeVisible();
  const a2 = mixer.getByRole("group", { name: "A2 Audio 2" });
  // A2's only clip plays through Voices: the strip says where it goes, and its fader is off.
  await expect(a2.locator(".mixer-members")).toHaveText("Voices");
  await expect(a2.getByRole("slider")).toHaveAttribute("aria-disabled", "true");
  await expect(voices.locator(".mixer-members")).toHaveText("1 clip");
  await expect(mixer.getByRole("group", { name: "Main" })).toBeVisible();

  await seekFrame(page, 60);
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  // While B plays, Voices carries it at unity.
  await expect.poll(() => busPeak(page, "voices")).toBeCloseTo(amplitude, 2);

  const live = page.frameLocator("iframe[data-live]").locator("main").first();
  const origin = await live.evaluate(() => performance.timeOrigin);
  const cap = voices.getByRole("slider");
  const box = (await cap.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Shift is 0.1 dB a pixel: 60 px down is -6 dB.
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, {
    steps: 6,
  });
  await expect(voices.locator(".mixer-value")).toHaveText("-6.0");
  // Heard before anything is saved.
  await expect
    .poll(() => busPeak(page, "voices"))
    .toBeCloseTo(amplitude * 10 ** (-6 / 20), 2);
  expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(source);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect
    .poll(async () => (await read()).authoredAudioGroups?.[0]?.volume)
    .toBeCloseTo(10 ** (-6 / 20), 4);
  // The saved level reaches the playing document in place: no reload, no gap in the sound.
  await expect(
    page.frameLocator("iframe[data-live]").locator("hf-audio-group#voices"),
  ).toHaveAttribute("data-volume", String(10 ** (-6 / 20)));
  expect(await live.evaluate(() => performance.timeOrigin)).toBe(origin);
  // One undo step puts the bus back, and the cap with it.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(() => readFile(join(project.path, "index.html"), "utf8"))
    .toBe(source);
  await expect(voices.locator(".mixer-value")).toHaveText("0.0");

  await mixer.getByRole("button", { name: "Mixer", exact: true }).click();
  await expect(mixer).toBeHidden();
  await expect(
    page.getByRole("group", { name: "Stereo output levels, dBFS" }),
  ).toBeVisible();
});

test("bus solo and Main gain are saved, named in the export notice and heard in the MP4", async ({
  page,
  request,
}) => {
  const { project, read } = await bench(request, "Mixer solo");
  const mixer = await openMixer(page, project.id);
  await mixer
    .getByRole("group", { name: "Voices" })
    .getByRole("button", { name: "Solo Voices" })
    .click();
  const main = mixer.getByRole("group", { name: "Main" });
  await main.locator(".mixer-value").dblclick();
  await main.getByRole("textbox").fill("-6");
  await main.getByRole("textbox").press("Enter");
  await expect
    .poll(async () => {
      const timeline = await read();
      return [timeline.authoredAudioGroups?.[0]?.solo, timeline.main?.volume];
    })
    .toEqual([true, expect.closeTo(0.501187, 5)]);
  // A1 is silent because Voices is soloed: its meter dims.
  await expect(
    mixer.getByRole("group", { name: "A1 Audio 1" }),
  ).toHaveAttribute("data-quiet");

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
  await expect(dialog).toContainText("Voices soloed, other audio is silent.");
  await expect(dialog).toContainText("Export complete.", { timeout: 40_000 });
  // A1 plays on a track only the solo silences; B plays through Voices and Main at -6 dB.
  expect(await encodedPeak(outputPath, 0.5)).toBeLessThan(0.001);
  const db = 20 * Math.log10((await encodedPeak(outputPath, 2.5)) / amplitude);
  expect(db).toBeCloseTo(-6, 0);
});

test("New bus routes the selection, a clip dropped on a strip joins it, and Delete bus returns them", async ({
  page,
  request,
}) => {
  const { project, read } = await bench(request, "Mixer buses");
  const mixer = await openMixer(page, project.id);
  const newBus = mixer.getByRole("button", { name: "New bus" });
  await expect(newBus).toBeDisabled();
  await expect(mixer).toContainText("Select clips with sound");
  await page.locator('[data-clip="a"]').click({ position: { x: 20, y: 5 } });
  await newBus.click();
  const name = mixer.getByRole("textbox", { name: "Bus name" });
  await expect(name).toHaveValue("Bus 1");
  await name.fill("Music");
  await name.press("Enter");
  const bus = mixer.getByRole("group", { name: "Music" });
  await expect(bus.locator(".mixer-members")).toHaveText("1 clip");

  // Drag B from the timeline onto Music: it leaves Voices and joins Music, in place.
  const clip = (await page.locator('[data-clip="b"]').boundingBox())!;
  const strip = (await bus.boundingBox())!;
  await page.mouse.move(clip.x + 20, clip.y + clip.height / 2);
  await page.mouse.down();
  await page.mouse.move(clip.x + 40, clip.y + clip.height / 2, { steps: 4 });
  await page.mouse.move(strip.x + 30, strip.y + strip.height / 2, {
    steps: 8,
  });
  await expect(bus).toHaveAttribute("data-drop");
  await page.mouse.up();
  await expect(bus.locator(".mixer-members")).toHaveText("2 clips");
  const timeline = await read();
  const music = timeline.authoredAudioGroups?.find(
    ({ label }) => label === "Music",
  );
  expect(
    timeline.clips.map(({ id, start, authoredAudioGroupId }) => [
      id,
      start,
      authoredAudioGroupId,
    ]),
  ).toEqual([
    ["a", 0, music?.id],
    ["b", 60, music?.id],
  ]);

  await bus.locator(".mixer-name").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete bus" }).click();
  await expect(bus).toBeHidden();
  await expect
    .poll(async () =>
      (await read()).clips.map(
        ({ authoredAudioGroupId }) => authoredAudioGroupId,
      ),
    )
    .toEqual([undefined, undefined]);
});

async function encodedPeak(path: string, time: number) {
  const { stdout } = await promisify(execFile)(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(time),
      "-i",
      path,
      "-t",
      "1",
      "-map",
      "0:a:0",
      // The left channel alone: a downmix would sum both sides of mono sound.
      "-af",
      "pan=mono|c0=c0",
      "-f",
      "f32le",
      "-",
    ],
    { encoding: "buffer" },
  );
  let peak = 0;
  for (let at = 0; at < stdout.byteLength; at += 4)
    peak = Math.max(peak, Math.abs(stdout.readFloatLE(at)));
  return peak;
}
