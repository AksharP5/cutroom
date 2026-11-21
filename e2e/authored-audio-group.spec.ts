import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

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
    name: "Bus gain",
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
    return (await previewPeaks(page, amplitude * volume)).r;
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
    .toMatchObject([{ id: "dialogue", volume }]);
  expect(await readFile(path, "utf8")).toBe(
    source.replace('data-volume="0.8"', `data-volume="${volume}"`),
  );
  await expect(stage).toHaveAttribute("data-preview-ready");
  await expect(stage).not.toHaveAttribute("data-preview-ready", token!);
  const after = await play(volume);
  await inspector.screenshot({ path: info.outputPath("bus-after.png") });

  const outputPath = await exportMp4(page);
  // Check both non-overlapping members in the produced file. Stereo panning and AAC make peak
  // amplitude differ slightly, so compare within 1 dB rather than by raw PCM bytes.
  const exported = [];
  for (const time of [0.5, 4.5]) {
    const peak = (await encodedPeaks(outputPath, time)).l;
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
  const group = inspector.getByRole("combobox", { name: "Bus" });
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
  await page.getByRole("option", { name: "New bus..." }).click();
  const form = inspector.getByRole("form", { name: "New bus" });
  await form.getByRole("textbox", { name: "Bus name" }).fill("Dialogue");
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
    name: "Bus gain",
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

  const outputPath = await exportMp4(page);
  const amplitudes = [
    (await encodedPeaks(outputPath, 0.5)).l,
    (await encodedPeaks(outputPath, 2.5)).l,
  ];
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

  const intercepted = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  await page.route(
    `/api/cutroom/projects/${project.id}/commands`,
    async (route) => {
      intercepted.resolve();
      await resume.promise;
      await route.continue();
    },
    { times: 1 },
  );
  await group.click();
  await page.getByRole("option", { name: "New bus..." }).click();
  await form.getByRole("textbox", { name: "Bus name" }).fill("Pickup");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await intercepted.promise;
  try {
    await expect(group).toHaveText("Dialogue");
    await expect(gain).toBeDisabled();
  } finally {
    resume.resolve();
  }
  await expect(group).toHaveText("Pickup");
  await expect(gain).toBeEnabled();
});

test("one group control routes linked partners without changing a later pickup in the parent mix", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Linked audio partners", duration: 4 },
      })
    ).json(),
  );
  const parent = `<main data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-duration="4"><div id="scene-host" data-composition-id="scene" data-composition-src="scene.html" data-start="0" data-duration="2" data-track-index="0" data-width="320" data-height="240"></div></main>`;
  const lead = `<template><main data-composition-id="scene" data-no-timeline data-width="320" data-height="240" data-duration="2"><audio id="one" src="left.wav" data-link="partners" data-start="0" data-duration="2" data-track-index="1"></audio><audio id="two" src="right.wav" data-link="partners" data-start="0" data-duration="2" data-track-index="2"></audio></main></template>`;
  const pickup = `<template><main data-composition-id="pickup" data-no-timeline data-width="320" data-height="240" data-duration="2"><audio id="pickup" src="voice.wav" data-start="0" data-duration="2" data-track-index="1" data-audio-group="dialogue"></audio></main></template>`;
  await writeFile(join(project.path, "index.html"), parent);
  await writeFile(join(project.path, "scene.html"), lead);
  await writeFile(join(project.path, "pickup.html"), pickup);
  // Give each partner a channel so their measured gains are independent of playback phase.
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.125*sin(2*PI*440*t):s=48000:d=2",
    join(project.path, "voice.wav"),
    "-af",
    "pan=stereo|FL=c0|FR=0*c0",
    join(project.path, "left.wav"),
    "-af",
    "pan=stereo|FL=0*c0|FR=c0",
    join(project.path, "right.wav"),
  ]);
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="scene-host"]').dblclick();
  await page.locator('[data-clip="one"]').click({ position: { x: 25, y: 5 } });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(
    inspector.getByRole("textbox", { name: "Gain", exact: true }),
  ).toHaveCount(2);
  const group = inspector.getByRole("combobox", { name: "Bus" });
  await expect(group).toHaveCount(1);
  await group.click();
  await page.getByRole("option", { name: "New bus..." }).click();
  const form = inspector.getByRole("form", { name: "New bus" });
  await form.getByRole("textbox", { name: "Bus name" }).fill("Dialogue");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(group).toHaveText("Dialogue");
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(
          `/api/cutroom/projects/${project.id}/timeline?composition=scene.html`,
        )
      ).json(),
    ).timeline;
  const timeline = await read();
  const groupId = timeline.authoredAudioGroups?.find(
    ({ label }) => label === "Dialogue",
  )?.id;
  expect(groupId).toBeDefined();
  expect(
    timeline.clips.map(({ authoredAudioGroupId }) => authoredAudioGroupId),
  ).toEqual([groupId, groupId]);
  const gain = inspector.getByRole("textbox", {
    name: "Bus gain",
    exact: true,
  });
  await gain.fill("-12 dB");
  await gain.press("Enter");
  await expect
    .poll(async () => (await read()).authoredAudioGroups?.[0]?.volume)
    .toBeCloseTo(10 ** (-12 / 20));
  await inspector.screenshot({ path: info.outputPath("linked-group.png") });

  const api = `/api/cutroom/projects/${project.id}`;
  const root = TimelineViewSchema.parse(
    await (await request.get(`${api}/timeline`)).json(),
  );
  const placed = await request.post(`${api}/commands`, {
    data: {
      expectedRevision: root.revision,
      commands: [
        {
          type: "insert",
          track: 0,
          at: 60,
          clip: { kind: "composition", src: "pickup.html", duration: 60 },
        },
      ],
    },
  });
  expect(placed.ok(), await placed.text()).toBe(true);
  await page
    .getByRole("navigation", { name: "Composition" })
    .getByRole("button", { name: "Linked audio partners" })
    .click();
  const stage = page.locator(".edit-stage");
  const level = 10 ** (-12 / 20);
  await seekFrame(page, 15);
  await expect(stage).toHaveAttribute("data-preview-ready");
  const previewLead = await previewPeaks(page, 0.125 * level, ["l", "r"]);
  await seekFrame(page, 75);
  await expect(stage).toHaveAttribute("data-preview-ready");
  const previewPickup = await previewPeaks(page, 0.125, ["l", "r"]);

  const outputPath = await exportMp4(page);
  const encodedLead = await encodedPeaks(outputPath, 0.5);
  const encodedPickup = await encodedPeaks(outputPath, 2.5);
  for (const channel of ["l", "r"] as const) {
    expect(
      Math.abs(20 * Math.log10(encodedLead[channel] / (0.125 * level))),
    ).toBeLessThan(1);
    expect(
      Math.abs(20 * Math.log10(encodedPickup[channel] / 0.125)),
    ).toBeLessThan(1);
  }
  await writeFile(
    info.outputPath("parent-mix.json"),
    JSON.stringify(
      {
        preview: { lead: previewLead, pickup: previewPickup },
        mp4: { lead: encodedLead, pickup: encodedPickup, outputPath },
      },
      null,
      2,
    ),
  );

  await page.keyboard.press("Escape");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await undo.click();
  await expect
    .poll(() => readFile(join(project.path, "index.html"), "utf8"))
    .toBe(parent);
  await undo.click();
  await expect
    .poll(async () => (await read()).authoredAudioGroups?.[0]?.volume)
    .toBe(1);
  await undo.click();
  await expect
    .poll(() => readFile(join(project.path, "scene.html"), "utf8"))
    .toBe(lead);
});

async function previewPeaks(
  page: Page,
  expected: number,
  channels: ("l" | "r")[] = ["r"],
) {
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  let peaks = { l: 0, r: 0 };
  await expect
    .poll(async () => {
      peaks = await page
        .frameLocator("iframe[data-live]")
        .locator("main")
        .first()
        .evaluate(() => {
          const runtime = window as Window & {
            __hf?: {
              audioMeter?: { read(): { master: { l: number; r: number } } };
            };
          };
          return runtime.__hf?.audioMeter?.read().master ?? { l: 0, r: 0 };
        });
      return channels.map((channel) => peaks[channel]);
    })
    .toEqual(channels.map(() => expect.closeTo(expected, 2)));
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  return peaks;
}

async function exportMp4(page: Page) {
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
  return outputPath;
}

async function encodedPeaks(path: string, time: number) {
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
  const peaks = { l: 0, r: 0 };
  for (let at = 0; at < stdout.byteLength; at += 8) {
    peaks.l = Math.max(peaks.l, Math.abs(stdout.readFloatLE(at)));
    peaks.r = Math.max(peaks.r, Math.abs(stdout.readFloatLE(at + 4)));
  }
  return peaks;
}
