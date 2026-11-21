import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
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

/**
 * The post-fader level HyperFrames measures for a bus, or for Main without an id, in dB against
 * the tones' level: what the strip's meter shows.
 */
const level = (page: Page, id?: string) =>
  page
    .frameLocator("iframe[data-live]")
    .locator("main")
    .first()
    .evaluate(
      (_, [id, amplitude]) => {
        const runtime = window as Window & {
          __hf?: {
            audioMeter?: {
              read(): {
                master: { r: number };
                groups: Record<string, { l: number; r: number }>;
              };
            };
          };
        };
        const read = runtime.__hf?.audioMeter?.read();
        const peak = (id ? read?.groups[id]?.r : read?.master.r) ?? 0;
        return peak > 0 ? 20 * Math.log10(peak / amplitude) : -Infinity;
      },
      [id, amplitude] as const,
    );

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
  await expect.poll(() => level(page, "voices")).toBeCloseTo(0, 1);

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
  await expect.poll(() => level(page, "voices")).toBeCloseTo(-6, 1);
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
  expect(db).toBeCloseTo(-6, 1);
});

test("switching compositions discards a pending keyboard fader change", async ({
  page,
  request,
}) => {
  const { project, source } = await bench(request, "Mixer composition switch");
  const index = join(project.path, "index.html");
  const child = join(project.path, "child.html");
  const rootSource = source.replace(
    "</main>",
    '<div id="child-host" class="clip" data-composition-id="child" data-composition-src="child.html" data-start="0" data-duration="2" data-track-index="0"></div></main>',
  );
  const childSource =
    '<template><main data-composition-id="child" data-no-timeline data-width="320" data-height="240" data-duration="2"></main></template>';
  await writeFile(index, rootSource);
  await writeFile(child, childSource);
  const mixer = await openMixer(page, project.id);
  await page.locator('[data-clip="child-host"]').dblclick();
  const path = page.getByRole("navigation", { name: "Composition" });
  await expect(path).toHaveText(/child/);
  const main = mixer.getByRole("group", { name: "Main" });
  await expect(main.getByRole("slider")).toBeVisible();

  // Issue the key and switch in the same browser task so even a slow runner beats the debounce.
  const drafted = await page.evaluate(() => {
    const strip = document.querySelector('[data-strip="main"]')!;
    const cap = strip.querySelector('[role="slider"]')!;
    cap.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    const value = strip.querySelector(".mixer-value")?.textContent;
    document.querySelector<HTMLButtonElement>(".edit-path-step")!.click();
    return value;
  });
  expect(drafted).toBe("-1.0");
  await expect(path).toBeHidden();
  // The old debounce would have fired by now, saving the gain onto the new composition.
  await page.waitForTimeout(450);
  await expect(main.locator(".mixer-value")).toHaveText("0.0");
  expect(await readFile(index, "utf8")).toBe(rootSource);
  expect(await readFile(child, "utf8")).toBe(childSource);
});

test("closing the mixer keeps the Main meter while strip samples stop", async ({
  page,
  request,
}) => {
  const { project } = await bench(request, "Mixer meter subscription");
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  const html = page.locator("html");
  await page.evaluate(() => {
    window.addEventListener("message", ({ data }) => {
      if (data?.source !== "cutroom-preview" || data.type !== "levels") return;
      if (!data.playing || data.r <= 0) return;
      document.documentElement.dataset.mixerLevels =
        data.strips?.["bus:voices"]?.r > 0 ? "strips" : "main";
    });
  });
  await seekFrame(page, 60);
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  await expect(html).toHaveAttribute("data-mixer-levels", "main");

  const toggle = page.getByRole("button", { name: "Mixer", exact: true });
  await toggle.click();
  await expect(html).toHaveAttribute("data-mixer-levels", "strips");
  await toggle.click();
  await expect(html).toHaveAttribute("data-mixer-levels", "main");

  await toggle.click();
  const mixer = page.getByRole("region", { name: "Mixer" });
  const solo = mixer.getByRole("button", { name: "Solo A2" });
  await solo.click();
  await expect(solo).toHaveAttribute("aria-pressed", "true");
  await expect(
    mixer.getByRole("group", { name: "Voices" }),
  ).not.toHaveAttribute("data-quiet");
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

/** Presses a fader's cap and moves it down with Shift held: 0.1 dB a pixel. */
async function grab(page: Page, strip: Locator, pixels: number) {
  const box = (await strip.getByRole("slider").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(x, y + pixels, { steps: 6 });
  return async () => {
    await page.mouse.up();
    await page.keyboard.up("Shift");
  };
}

test("Main's fader is heard while it moves, Esc puts a drag back, and a refused save restores what plays", async ({
  page,
  request,
}) => {
  const { project, source, read } = await bench(request, "Mixer refusals");
  const index = join(project.path, "index.html");
  const mixer = await openMixer(page, project.id);
  const main = mixer.getByRole("group", { name: "Main" });
  const voices = mixer.getByRole("group", { name: "Voices" });
  await seekFrame(page, 60);
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  await expect.poll(() => level(page)).toBeCloseTo(0, 1);

  // Main is heard at -6 dB as it moves, and Esc returns it to 0 dB without saving.
  const release = await grab(page, main, 60);
  await expect(main.locator(".mixer-value")).toHaveText("-6.0");
  await expect.poll(() => level(page)).toBeCloseTo(-6, 1);
  await page.keyboard.press("Escape");
  await expect(main.locator(".mixer-value")).toHaveText("0.0");
  await expect.poll(() => level(page)).toBeCloseTo(0, 1);
  await release();
  expect(await readFile(index, "utf8")).toBe(source);

  // The server refuses the save: the strip and what plays both go back to the saved 0 dB.
  await page.route("**/api/cutroom/projects/*/commands", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "The timeline changed. Read it again.",
        code: "stale_revision",
      }),
    }),
  );
  const drop = await grab(page, voices, 60);
  await expect.poll(() => level(page, "voices")).toBeCloseTo(-6, 1);
  await drop();
  await expect(voices.locator(".mixer-value")).toHaveText("0.0");
  await expect.poll(() => level(page, "voices")).toBeCloseTo(0, 1);
  await page.unroute("**/api/cutroom/projects/*/commands");
  expect((await read()).authoredAudioGroups?.[0]?.volume).toBe(1);

  // A saved Main drag is what the next document plays, with nothing left over from the drag.
  const save = await grab(page, main, 60);
  await save();
  await expect
    .poll(async () => (await read()).main?.volume)
    .toBeCloseTo(10 ** (-6 / 20), 4);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await seekFrame(page, 60);
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  await expect.poll(() => level(page)).toBeCloseTo(-6, 1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

test("a strip's rack stays open while an effect is chosen from its menu, and closes on a press outside", async ({
  page,
  request,
}) => {
  const { project, read } = await bench(request, "Mixer rack");
  const mixer = await openMixer(page, project.id);
  const voices = mixer.getByRole("group", { name: "Voices" });
  await voices.hover();
  await voices.getByRole("button", { name: "Add effect" }).click();
  const rack = page.getByRole("dialog", { name: "Voices effects" });
  await expect(rack).toBeVisible();
  await page.getByRole("menuitem", { name: "Compressor", exact: true }).click();
  await expect(voices.locator(".mixer-fx")).toHaveText("Compressor");
  await expect(rack).toBeVisible();
  await expect
    .poll(async () =>
      (await read()).authoredAudioGroups?.[0]?.fx.map(({ type }) => type),
    )
    .toEqual(["compressor"]);
  // Opening the effect's knobs keeps the rack too; a press on the timeline closes it.
  await rack.getByRole("button", { name: "Compressor", exact: true }).click();
  await expect(rack.getByText("Threshold")).toBeVisible();
  await page.locator(".tl-lanes").click({ position: { x: 5, y: 5 } });
  await expect(rack).toBeHidden();
});

test("track solo and bus solo add together, and the strips they silence dim", async ({
  page,
  request,
}) => {
  const { project, source } = await bench(request, "Mixer solos");
  // C plays on A3 with track mixing, beside A1's track and A2's bus.
  await writeFile(
    join(project.path, "index.html"),
    source.replace(
      "</main>",
      '<audio id="c" src="a.wav" data-start="0" data-duration="2" data-track-index="3"></audio></main>',
    ),
  );
  const mixer = await openMixer(page, project.id);
  const strip = (name: string) => mixer.getByRole("group", { name });
  const quiet = async () =>
    Object.fromEntries(
      await Promise.all(
        ["A1 Audio 1", "A2 Audio 2", "A3 Audio 3", "Voices"].map(
          async (name) =>
            [
              name,
              (await strip(name).getAttribute("data-quiet")) !== null,
            ] as const,
        ),
      ),
    );
  await strip("A1 Audio 1").getByRole("button", { name: "Solo A1" }).click();
  await strip("Voices").getByRole("button", { name: "Solo Voices" }).click();
  // A1's track and A2's clip through Voices sound; only A3 is silenced.
  await expect.poll(quiet).toEqual({
    "A1 Audio 1": false,
    "A2 Audio 2": false,
    "A3 Audio 3": true,
    Voices: false,
  });
  await strip("A1 Audio 1").getByRole("button", { name: "Solo A1" }).click();
  await expect.poll(quiet).toEqual({
    "A1 Audio 1": true,
    "A2 Audio 2": false,
    "A3 Audio 3": true,
    Voices: false,
  });
});

test("a strip that reaches 0 dBFS lights its clip mark until it is clicked", async ({
  page,
  request,
}) => {
  const { project } = await bench(request, "Mixer clipping");
  const { revision } = TimelineViewSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/timeline`)
    ).json(),
  );
  // +12 dB on Voices and on Main take B's -18 dBFS tone past full scale.
  const response = await request.post(
    `/api/cutroom/projects/${project.id}/commands`,
    {
      data: {
        expectedRevision: revision,
        commands: [
          { type: "setAudioGroup", group: "voices", volume: 10 ** (12 / 20) },
          { type: "setMaster", volume: 10 ** (12 / 20) },
        ],
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  const mixer = await openMixer(page, project.id);
  const main = mixer.getByRole("group", { name: "Main" });
  // Unlit, the mark is hidden, so it is found by its place rather than its name.
  const mark = main.locator(".mixer-clip").first();
  await expect(mark).toBeDisabled();
  await seekFrame(page, 60);
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  await expect(mark).toBeEnabled();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  // It stays lit after a stop, as the meter column's does, until it is clicked.
  await expect(mark).toBeEnabled();
  await mark.click();
  await expect(mark).toBeDisabled();
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
