import { execFile } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CommandInput } from "../src/shared/timeline/schema";
import type { APIRequestContext } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectDocumentSchema, ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);
const db = (level: number) => 10 ** (level / 20);
/** ffmpeg's `sine` source peaks at an eighth of full scale. */
const SINE_PEAK = 0.125;

/** A voice on A1's left channel and, on A2's right, a music bed that a ripple has cut in two. */
async function mixProject(request: APIRequestContext, name: string) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name, width: 320, height: 240, duration: 8 },
      })
    ).json(),
  );
  for (const [file, frequency, channel] of [
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
      join(project.path, `${file}.wav`),
    ]);
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><body><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-duration="8" data-fps="30"><audio id="voice" src="Voice.wav" data-start="0" data-duration="8" data-track-index="1" data-volume="0.5"></audio><audio id="bed-1" src="Music.wav" data-start="0" data-duration="4" data-track-index="2"></audio><audio id="bed-2" src="Music.wav" data-start="4" data-duration="4" data-media-start="4" data-track-index="2"></audio></main></body></html>',
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  return { project, api, read };
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

test("a track's gain turns a split music bed down once, and preview, meters and export play it alike", async ({
  page,
  request,
  baseURL,
}, info) => {
  test.setTimeout(180_000);
  const { project, api, read } = await mixProject(request, "Track gain");
  const track = async (index: number) =>
    (await read()).timeline.tracks.find((item) => item.index === index);
  const own = async () =>
    Object.fromEntries(
      (await read()).timeline.clips.map((clip) => [clip.id, clip.volume]),
    );
  await page.goto(`/#project/${project.id}`);
  const live = page.frameLocator("iframe[data-live]");
  await expect(live.locator("#bed-1")).toBeAttached();
  const gain = page.getByRole("button", { name: "Gain A2", exact: true });
  await expect(gain).toHaveText("0.0");
  const initial = (await read()).timeline;
  const box = (await gain.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const dragBy = async (dy: number, end: "release" | "Escape" = "release") => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + dy, { steps: 6 });
    if (end === "Escape") await page.keyboard.press("Escape");
    await page.mouse.up();
  };

  // Shift is a tenth of a dB per pixel. One drag is one undo step for the whole bed.
  await page.keyboard.down("Shift");
  await dragBy(30);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await track(2))?.volume).toBe(db(-3));
  await expect(gain).toHaveText("-3.0");
  expect(await own()).toEqual({ voice: 0.5, "bed-1": null, "bed-2": null });
  await expect(
    live.locator('hf-audio-group[data-cutroom-track="2"]'),
  ).toHaveAttribute("data-volume", String(db(-3)));
  for (const id of ["bed-1", "bed-2"]) {
    await expect(live.locator(`#${id}`)).not.toHaveAttribute("data-volume");
    await expect(live.locator(`#${id}`)).toHaveAttribute(
      "data-audio-group",
      /cutroom-/,
    );
  }
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read()).timeline).toEqual(initial);
  await expect(gain).toHaveText("0.0");
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await track(2))?.volume).toBe(db(-3));

  // Esc gives the drag up, and Alt-click returns the track to 0 dB.
  const turnedDown = (await read()).revision;
  await dragBy(10, "Escape");
  await expect(gain).toHaveText("-3.0");
  expect((await read()).revision).toBe(turnedDown);
  await page.keyboard.down("Alt");
  await gain.click();
  await page.keyboard.up("Alt");
  await expect.poll(async () => (await track(2))?.volume).toBe(1);

  // A plain drag reads the scale of the gain line on the track's clips: 6 px down from 0 dB is -6 dB.
  await dragBy(6);
  await expect.poll(async () => (await track(2))?.volume).toBe(db(-6));

  await gain.dblclick();
  const field = page.getByRole("textbox", { name: "Gain A2 in dB" });
  await expect(field).toHaveValue("-6.0");
  await field.fill("-12");
  await field.press("Enter");
  await expect.poll(async () => (await track(2))?.volume).toBe(db(-12));
  await expect(gain).toHaveText("-12.0");

  // An agent sets a track's gain with setTrack, and a clip's own gain still rides on top.
  const client = new Client({ name: "track-gain-agent", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const result = z.object({
      structuredContent: z.object({ result: TimelineViewSchema }),
    });
    const view = result.parse(
      await client.callTool({
        name: "timeline_read",
        arguments: { projectId: project.id },
      }),
    ).structuredContent.result;
    expect(view.timeline.tracks.find((item) => item.index === 2)?.volume).toBe(
      db(-12),
    );
    result.parse(
      await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: view.revision,
          commands: [
            { type: "setTrack", index: 1, volume: db(-6) },
            { type: "setClip", clipId: "bed-2", volume: db(6) },
          ],
        },
      }),
    );
  } finally {
    await client.close();
  }
  await expect(page.getByRole("button", { name: "Gain A1" })).toHaveText(
    "-6.0",
  );
  expect(await own()).toEqual({ voice: 0.5, "bed-1": null, "bed-2": db(6) });
  await expect(live.locator("#bed-2")).toHaveAttribute(
    "data-volume",
    String(db(6)),
  );
  await page.screenshot({ path: info.outputPath("track-gain.png") });

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
  const output = info.outputPath("track-gain.mp4");
  const exported = await request.get(`/api/render/${jobId}/download`);
  expect(exported.ok()).toBeTruthy();
  await writeFile(output, await exported.body());
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("region", { name: "Viewer", exact: true }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  // The header meters draw what this tap reads.
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
  // Voice: -6 dB clip on a -6 dB track. Bed: a -12 dB track, with +6 dB on its second piece.
  const evidence = [];
  for (const [target, voice, bed] of [
    [2, -12, -12],
    [6, -12, -6],
  ] as const) {
    const sample = samples.reduce((best, next) =>
      Math.abs(next.time - target) < Math.abs(best.time - target) ? next : best,
    );
    const file = await peaks(output, sample.time);
    const preview = [sample.l, sample.r];
    const expected = [SINE_PEAK * db(voice), SINE_PEAK * db(bed)];
    const report = { time: sample.time, expected, preview, export: file };
    for (const index of [0, 1]) {
      const toDb = (level: number) => 20 * Math.log10(level / expected[index]!);
      expect(Math.abs(toDb(file[index]!)), JSON.stringify(report)).toBeLessThan(
        1,
      );
      expect(
        Math.abs(toDb(preview[index]!)),
        JSON.stringify(report),
      ).toBeLessThan(1);
    }
    evidence.push(report);
  }
  await writeFile(
    info.outputPath("levels.json"),
    JSON.stringify(evidence, null, 2),
  );
});

test("the inspector's Gain sets every selected audio clip in one undo step", async ({
  page,
  request,
}) => {
  const { project, read } = await mixProject(request, "Gain on a selection");
  const own = async () =>
    Object.fromEntries(
      (await read()).timeline.clips.map((clip) => [clip.id, clip.volume]),
    );
  await page.goto(`/#project/${project.id}`);
  await page
    .locator('[data-clip="voice"]')
    .click({ position: { x: 40, y: 7 } });
  for (const id of ["bed-1", "bed-2"])
    await page
      .locator(`[data-clip="${id}"]`)
      .click({ position: { x: 40, y: 7 }, modifiers: ["Control"] });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector).toContainText("3 clips selected");
  const gain = inspector.getByRole("textbox", { name: "Gain", exact: true });
  await expect(gain).toHaveValue("Mixed");
  await gain.fill("-6");
  await gain.press("Enter");
  await expect
    .poll(own)
    .toEqual({ voice: db(-6), "bed-1": db(-6), "bed-2": db(-6) });
  await expect(gain).toHaveValue("-6.0 dB");
  await page.keyboard.press("Control+z");
  await expect.poll(own).toEqual({ voice: 0.5, "bed-1": null, "bed-2": null });
  await expect(gain).toHaveValue("Mixed");
});

test("GSAP silence and independent boosted stages agree in preview meters and export", async ({
  page,
  request,
  baseURL,
}, info) => {
  test.setTimeout(180_000);
  const { project, api, read } = await mixProject(
    request,
    "Independent track stages",
  );
  await copyFile(
    join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
    join(project.path, "gsap.min.js"),
  );
  await exec("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=8",
    "-af",
    "volume=0.25,pan=stereo|c0=0*c0|c1=c0",
    join(project.path, "Music.wav"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:s=320x240:r=30:d=8",
    "-i",
    join(project.path, "Voice.wav"),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "Embedded.mp4"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-duration="8" data-fps="30">
  <audio id="tween" src="Voice.wav" data-start="0" data-duration="8" data-track-index="1" data-volume="0.4"></audio>
  <audio id="boost" src="Music.wav" data-start="0" data-duration="4" data-track-index="2" data-volume="${db(12)}"></audio>
  <video id="embedded" src="Embedded.mp4" data-start="4" data-duration="4" data-track-index="0"></video>
  <hf-audio-group id="authored" data-volume="${db(18)}"></hf-audio-group>
  <audio id="authored-member" src="Music.wav" data-start="4" data-duration="4" data-track-index="2" data-audio-group="authored"></audio>
  </main><script>window.__timelines={main:gsap.timeline({paused:true}).fromTo('#tween',{volume:0.5},{volume:0.5,duration:8,ease:'none'},0)};</script></body></html>`,
  );
  const before = await read();
  const client = new Client({ name: "track-stage-agent", version: "1.0.0" });
  const result = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  const view = await (async () => {
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
          requestInit: { headers: { origin: baseURL! } },
        }),
      );
      const changed = result.parse(
        await client.callTool({
          name: "timeline_edit",
          arguments: {
            projectId: project.id,
            expectedRevision: before.revision,
            commands: [
              { type: "setTrack", index: 1, volume: 0 },
              { type: "setTrack", index: 2, volume: db(6) },
              { type: "setTrack", index: 0, volume: 0.5 },
            ],
          },
        }),
      ).structuredContent.result;
      const readback = result.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: project.id },
        }),
      ).structuredContent.result;
      expect(readback.timeline).toEqual(changed.timeline);
      return changed;
    } finally {
      await client.close();
    }
  })();
  expect(view.timeline.clips.find((clip) => clip.id === "tween")?.volume).toBe(
    0.4,
  );
  expect(
    view.timeline.clips.find((clip) => clip.id === "authored-member")
      ?.trackGainWarning,
  ).toContain('authored audio group "authored"');
  const rejected = await request.post(`${api}/commands`, {
    data: {
      expectedRevision: view.revision,
      commands: [{ type: "setTrack", index: 2, volume: db(18) }],
    },
  });
  expect(rejected.ok()).toBe(false);
  await page.goto(`/#project/${project.id}`);
  const live = page.frameLocator("iframe[data-live]");
  await expect(live.locator("#tween")).toHaveAttribute("data-volume", "0.4");
  await expect(
    live.locator('hf-audio-group[data-cutroom-track="1"]'),
  ).toHaveAttribute("data-volume", "0");
  await page
    .locator('[data-clip="authored-member"]')
    .click({ position: { x: 40, y: 7 } });
  await expect(
    page.getByRole("complementary", { name: "Inspector" }),
  ).toContainText("Track gain does not apply to this clip");
  await page.screenshot({
    path: info.outputPath("authored-group-warning.png"),
  });
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
  const output = info.outputPath("independent-stages.mp4");
  await writeFile(
    output,
    await (await request.get(`/api/render/${jobId}/download`)).body(),
  );
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
        const samples: { time: number; l: number; r: number }[] = [];
        const take = () => {
          const time = win.__player?.getTime() ?? 0;
          if (time > 0.5)
            samples.push({
              time,
              ...(win.__hf?.audioMeter?.read().master ?? { l: 0, r: 0 }),
            });
          if (time >= 7) resolve(samples);
          else requestAnimationFrame(take);
        };
        take();
      }),
  );
  await page.keyboard.press("k");
  // The authored bus asks for +18 dB; the pinned preview and exporter cap that single stage at +12 dB.
  const evidence = [];
  for (const [time, expected] of [
    [2, [0, SINE_PEAK * 0.25 * db(18)]],
    [6, [SINE_PEAK * 0.5, SINE_PEAK * 0.25 * db(12)]],
  ] as const) {
    const sample = samples.reduce((best, next) =>
      Math.abs(next.time - time) < Math.abs(best.time - time) ? next : best,
    );
    const exported = await peaks(output, time);
    for (const [channel, preview] of [sample.l, sample.r].entries()) {
      const target = expected[channel]!;
      if (target === 0) {
        expect(preview).toBeLessThan(0.00001);
        expect(exported[channel]!).toBeLessThan(0.00001);
      } else {
        expect(Math.abs(20 * Math.log10(preview / target))).toBeLessThan(0.5);
        expect(
          Math.abs(20 * Math.log10(exported[channel]! / target)),
        ).toBeLessThan(0.5);
      }
    }
    evidence.push({ time, expected, preview: [sample.l, sample.r], exported });
  }
  await writeFile(
    info.outputPath("independent-stages.json"),
    JSON.stringify(evidence, null, 2),
  );
});

test("track membership follows splits, moves, clipboard snapshots and history; compact headers can set gain", async ({
  page,
  request,
}, info) => {
  const { project, api, read } = await mixProject(request, "Track membership");
  const source = join(project.path, "index.html");
  const edit = async (commands: CommandInput[]) => {
    const response = await request.post(`${api}/commands`, {
      data: { expectedRevision: (await read()).revision, commands },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return TimelineViewSchema.parse(await response.json());
  };
  const membership = async (id: string) => {
    const html = await readFile(source, "utf8");
    const tag = html.match(new RegExp(`<audio[^>]*id="${id}"[^>]*>`))?.[0];
    return tag?.match(/data-audio-group="([^"]+)"/)?.[1];
  };
  await edit([
    { type: "setTrack", index: 1, volume: 0.5 },
    { type: "setTrack", index: 2, volume: 0.25 },
  ]);
  const copyResponse = await request.post(`${api}/timeline/copy`, {
    data: { expectedRevision: (await read()).revision, clipIds: ["bed-1"] },
  });
  const copy = z.object({ id: z.string() }).parse(await copyResponse.json());
  await edit([
    { type: "split", at: 60, clipIds: ["bed-1"], ids: { "bed-1": ["split"] } },
  ]);
  expect(await membership("split")).toBe(await membership("bed-1"));
  await edit([{ type: "move", clipIds: ["split"], trackBy: -1 }]);
  expect(await membership("split")).toBe(await membership("voice"));
  const moved = await readFile(source, "utf8");
  await edit([
    { type: "setTrack", index: 2, volume: 0.1 },
    {
      type: "paste",
      clipboardId: copy.id,
      at: 240,
      ids: { "bed-1": ["pasted"] },
    },
  ]);
  expect(await membership("pasted")).toBe(await membership("bed-1"));
  expect(
    (await read()).timeline.clips.find((clip) => clip.id === "pasted")?.volume,
  ).toBeNull();
  const pasted = await readFile(source, "utf8");
  expect((await request.post(`${api}/history/undo`)).ok()).toBeTruthy();
  expect(await readFile(source, "utf8")).toBe(moved);
  expect((await request.post(`${api}/history/redo`)).ok()).toBeTruthy();
  expect(await readFile(source, "utf8")).toBe(pasted);
  await edit([{ type: "remove", clipIds: ["pasted"] }]);
  expect(await membership("pasted")).toBeUndefined();
  await writeFile(
    join(project.path, "scene.html"),
    '<main id="scene" data-composition-id="scene" data-duration="8" data-fps="30"></main>',
  );
  const scene = TimelineViewSchema.parse(
    await (await request.get(`${api}/timeline?composition=scene.html`)).json(),
  );
  const across = await request.post(`${api}/commands`, {
    data: {
      composition: "scene.html",
      expectedRevision: scene.revision,
      commands: [
        { type: "setTrack", index: 2, kind: "audio", volume: 0.1 },
        {
          type: "paste",
          clipboardId: copy.id,
          at: 0,
          ids: { "bed-1": ["across"] },
        },
      ],
    },
  });
  expect(across.ok(), await across.text()).toBeTruthy();
  expect(await readFile(join(project.path, "scene.html"), "utf8")).toContain(
    'data-audio-group="cutroom-scene-track-2"',
  );
  await edit([{ type: "setTrack", index: 2, locked: true }]);
  await page.goto(`/#project/${project.id}`);
  const head = page.getByRole("group", { name: "A2: Audio 2", exact: true });
  await head.click({ button: "right" });
  await page
    .getByRole("menuitemradio", { name: "Compact", exact: true })
    .click();
  await head.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Set gain...", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Set .*gain/ });
  await dialog.getByRole("textbox", { name: "Track gain in dB" }).fill("-18");
  await page.screenshot({ path: info.outputPath("compact-gain-dialog.png") });
  await dialog.getByRole("button", { name: "Set gain", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await read()).timeline.tracks.find((track) => track.index === 2)
          ?.volume,
    )
    .toBe(db(-18));
  const settingsPath = join(project.path, "cutroom.json");
  const settings = ProjectDocumentSchema.parse(
    JSON.parse(await readFile(settingsPath, "utf8")),
  );
  settings.timelines["index.html"]!.tracks = settings.timelines[
    "index.html"
  ]!.tracks.map((track) => ({ ...track, volume: 1 }));
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  await expect(
    page
      .frameLocator("iframe[data-live]")
      .locator('hf-audio-group[data-cutroom-track="2"]'),
  ).toHaveAttribute("data-volume", "1");
});

test("@performance a gain edit changes one group attribute and reaches the preview at 500 clips", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  const { project, api, read } = await mixProject(
    request,
    "500 clips track gain",
  );
  await exec("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=60",
    "-af",
    "pan=stereo|c0=0*c0|c1=c0",
    join(project.path, "Music.wav"),
  ]);
  const source = join(project.path, "index.html");
  await writeFile(
    source,
    `<!doctype html><html><body><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-fps="30" data-duration="160">${Array.from({ length: 500 }, (_, i) => `<audio id="clip-${i}" src="Music.wav" data-track-index="1" data-start="${i === 0 ? 0 : 60 + (i - 1) / 5}" data-duration="${i === 0 ? 60 : 0.2}" data-volume="0.4"></audio>`).join("")}</main></body></html>`,
  );
  const set = async (volume: number) =>
    request.post(`${api}/commands`, {
      data: {
        expectedRevision: (await read()).revision,
        commands: [{ type: "setTrack", index: 1, volume }],
      },
    });
  await page.goto(`/#project/${project.id}`);
  const bus = page
    .frameLocator("iframe[data-live]")
    .locator('hf-audio-group[data-cutroom-track="1"]');
  await expect(bus).toHaveAttribute("data-volume", "1");
  await page.getByRole("region", { name: "Viewer", exact: true }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  const previewSample = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("main")
      .evaluate(() => {
        const win = window as Window & {
          __hf?: { audioMeter?: { read(): { master: { r: number } } } };
        };
        return {
          peak: win.__hf?.audioMeter?.read().master.r ?? 0,
          volume: document
            .querySelector('hf-audio-group[data-cutroom-track="1"]')
            ?.getAttribute("data-volume"),
          origin: performance.timeOrigin,
        };
      });
  // Check actual playback and first use from unity before measuring subsequent one-attribute edits.
  const levelMatches = async (volume: number) => {
    const sample = await previewSample();
    return (
      sample.volume === String(volume) &&
      (volume === 0
        ? sample.peak < 0.00001
        : Math.abs(20 * Math.log10(sample.peak / (SINE_PEAK * 0.4 * volume))) <
          1)
    );
  };
  await expect
    .poll(() => levelMatches(1), { intervals: [10, 20, 50] })
    .toBe(true);
  const origin = (await previewSample()).origin;
  expect((await set(0.5)).ok()).toBeTruthy();
  await expect
    .poll(() => levelMatches(0.5), { intervals: [10, 20, 50] })
    .toBe(true);
  expect((await previewSample()).origin).toBe(origin);
  const measurements = [];
  let previous = 0.5;
  for (const volume of [0.25, 0, 0.125, 0.5]) {
    const before = await readFile(source, "utf8");
    const start = Date.now();
    const response = await set(volume);
    const responseMs = Date.now() - start;
    expect(response.ok(), await response.text()).toBeTruthy();
    await expect
      .poll(() => levelMatches(volume), { intervals: [10, 20, 50] })
      .toBe(true);
    const previewMs = Date.now() - start;
    expect((await previewSample()).origin).toBe(origin);
    const after = await readFile(source, "utf8");
    expect(after).toBe(
      before.replace(
        `data-cutroom-track="1" data-volume="${previous}"`,
        `data-cutroom-track="1" data-volume="${volume}"`,
      ),
    );
    measurements.push({
      clips: 500,
      changedClipAttributes: 0,
      changedGroupAttributes: 1,
      responseMs,
      previewMs,
    });
    previous = volume;
  }
  await page.keyboard.press("k");
  await writeFile(
    info.outputPath("500-clips-track-gain.json"),
    JSON.stringify(measurements, null, 2),
  );
  console.log("500 clips track gain", JSON.stringify(measurements));
});

test("the inspector shows uncapped combined static gain without changing clip gain", async ({
  page,
  request,
}, info) => {
  const { project, api, read } = await mixProject(
    request,
    "Combined static gain",
  );
  const source = join(project.path, "index.html");
  await writeFile(
    source,
    (await readFile(source, "utf8"))
      .replace('id="bed-2"', 'id="bed-2" data-audio-group="authored"')
      .replace(
        "</main>",
        '<hf-audio-group id="authored" data-volume="0.5"></hf-audio-group></main>',
      ),
  );
  const edit = async (commands: CommandInput[]) => {
    const response = await request.post(`${api}/commands`, {
      data: { expectedRevision: (await read()).revision, commands },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  await edit([
    { type: "setTrack", index: 2, volume: db(12) },
    { type: "setClip", clipId: "bed-1", volume: db(12) },
    { type: "setClip", clipId: "bed-2", volume: db(12) },
  ]);
  await page.goto(`/#project/${project.id}`);
  const select = (id: string, add = false) =>
    page.locator(`[data-clip="${id}"]`).click({
      position: { x: 40, y: 7 },
      modifiers: add ? ["Control"] : [],
    });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const combined = inspector.getByRole("status", {
    name: "Combined static gain",
  });
  const gain = inspector.getByRole("textbox", { name: "Gain", exact: true });
  await select("bed-1");
  await expect(gain).toHaveValue("+12.0 dB");
  await expect(combined).toHaveText("+24.0 dB");
  await page.screenshot({ path: info.outputPath("combined-static-gain.png") });
  await edit([{ type: "setTrack", index: 2, volume: 0 }]);
  await expect(combined).toHaveText("-∞ dB");
  await expect(gain).toHaveValue("+12.0 dB");
  expect((await request.post(`${api}/history/undo`)).ok()).toBe(true);
  await expect(combined).toHaveText("+24.0 dB");
  await select("bed-2");
  await expect(inspector).toContainText(
    "Track gain does not apply to this clip",
  );
  await expect(combined).toHaveCount(0);
  await select("bed-1", true);
  await expect(combined).toHaveText("+24.0 dB");
  await edit([{ type: "setTrack", index: 1, volume: 0.5 }]);
  await select("voice");
  await expect(combined).toHaveText("-12.0 dB");
  await select("bed-1", true);
  await expect(combined).toHaveText("Mixed");
});
