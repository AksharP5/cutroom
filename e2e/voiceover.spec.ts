import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { voiceoverWav } from "../src/shared/voiceover";
import { referenceMicrophone } from "./microphone-reference";
import { parseTimecode } from "../src/shared/timeline/timecode";

const input = join(
  process.env.CUTROOM_E2E_DIR ?? tmpdir(),
  "cutroom-voiceover-input.wav",
);
const rate = 48000;
const run = promisify(execFile);
let createdInput = false;
test.use({
  permissions: ["microphone"],
  launchOptions: {
    executablePath:
      process.env.CUTROOM_BROWSER_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    args: [
      "--mute-audio",
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${input}`,
    ],
  },
});

test.beforeAll(async () => {
  let seed = 7123;
  let low = 0;
  const samples = Int16Array.from({ length: rate * 12 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    low += (seed / 2147483648 - low) * 0.12;
    return Math.round(
      18000 * low +
        5000 *
          Math.sin(2 * Math.PI * ((330 * i) / rate + 90 * (i / rate) ** 2)),
    );
  });
  await mkdir(resolve(input, ".."), { recursive: true });
  await writeFile(
    input,
    new Uint8Array(
      voiceoverWav([{ frame: 0, samples }], 0, samples.length, rate).bytes,
    ),
    { flag: "wx" },
  );
  createdInput = true;
});
test.afterAll(async () => {
  if (createdInput) await rm(input);
});

async function pcm(path: string) {
  const { stdout } = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(rate),
      "-f",
      "s16le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: rate * 2 * 30 },
  );
  return Int16Array.from({ length: stdout.length / 2 }, (_, i) =>
    stdout.readInt16LE(i * 2),
  );
}

/** Locate real captured/encoded samples in the known input, then refine to one audio sample. */
function correlate(
  reference: Int16Array,
  sample: Int16Array,
  first: number,
  last: number,
) {
  const length = Math.min(sample.length, 7200);
  const score = (offset: number) => {
    let dot = 0,
      a = 0,
      b = 0;
    for (let i = 0; i < length; i += 4) {
      const x = reference[offset + i] ?? 0,
        y = sample[i]!;
      dot += x * y;
      a += x * x;
      b += y * y;
    }
    return dot / Math.sqrt(a * b || 1);
  };
  let offset = first,
    best = -1;
  for (let at = first; at <= last; at += 8) {
    const value = score(at);
    if (value > best) {
      best = value;
      offset = at;
    }
  }
  const coarse = offset;
  for (
    let at = Math.max(first, coarse - 8);
    at <= Math.min(last, coarse + 8);
    at++
  ) {
    const value = score(at);
    if (value > best) {
      best = value;
      offset = at;
    }
  }
  return { offset, correlation: best };
}

test("fake microphone records over the cut, preserves audio, undoes once, and exports in sync", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await referenceMicrophone(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: true,
        skills: [],
        models: [],
        mcpServers: [],
      },
    }),
  );
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Voiceover proof", width: 640, height: 360, duration: 8 },
      })
    ).json(),
  );
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=48000:duration=8",
    "-af",
    "volume=0.1",
    join(project.path, "assets/cut.wav"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><head><meta charset="UTF-8"><style>html,body{margin:0;background:#111;color:#ededed}main{position:relative;width:640px;height:360px}.clip{position:absolute;inset:0;display:grid;place-items:center;font:32px sans-serif}.first{background:#263530}.second{background:#302b38}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="8"><div id="shot-one" class="clip first" data-start="0" data-duration="4" data-track-index="0" data-label="First shot">First shot</div><div id="shot-two" class="clip second" data-start="4" data-duration="4" data-track-index="0" data-label="Second shot">Second shot</div><audio id="cut-audio" src="assets/cut.wav" data-start="0" data-duration="8" data-track-index="1" data-label="Cut audio"></audio></main></body></html>',
  );
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator(".edit-stage iframe").first()).toBeAttached();
  await page.getByRole("button", { name: "Arm A1", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Arm A1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () =>
      Number(
        await page
          .getByRole("meter", { name: "Microphone input level" })
          .getAttribute("aria-valuenow"),
      ),
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("armed.png") });
  await page.getByRole("button", { name: "Microphone input A1" }).click();
  const panel = page.locator(".vo-input-panel:popover-open");
  await expect(panel).toContainText("Input delay 10 ms");
  const timing = await panel.innerText();
  await page.screenshot({ path: info.outputPath("input.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("0100");
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "Record voiceover", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop voiceover" }),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath("recording.png") });
  await page.keyboard.press("Space");
  const stoppedFrame = parseTimecode(
    (
      await page.getByRole("button", { name: /^Current time/ }).innerText()
    ).replace(/\D/g, ""),
    { num: 30, den: 1 },
  );
  expect(stoppedFrame).not.toBeNull();
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.filter(
          (clip) => clip.kind === "voiceover",
        ).length,
    )
    .toBe(1);
  const recorded = await read();
  const take = recorded.timeline.clips.find(
    (clip) => clip.kind === "voiceover",
  )!;
  expect(take).toMatchObject({
    start: 30,
    track: 2,
    hasAudio: true,
    mediaStart: 0,
  });
  expect(
    Math.abs(take.start + take.duration - stoppedFrame!),
  ).toBeLessThanOrEqual(1);
  expect(
    recorded.timeline.clips.find((clip) => clip.id === "cut-audio"),
  ).toMatchObject({ start: 0, duration: 240, track: 1 });
  expect(take.src).toMatch(/^assets\/voiceover\/voiceover-.*\.wav$/);
  const takePath = join(project.path, take.src!);
  const inputBlocks = await page.evaluate(() => window.microphoneReference);
  const firstInputFrame = inputBlocks[0]!.frame;
  const lastInputBlock = inputBlocks.at(-1)!;
  const rawInput = new Int16Array(
    lastInputBlock.frame + lastInputBlock.samples.length - firstInputFrame,
  );
  for (const block of inputBlocks) {
    rawInput.set(
      block.samples.map((sample) =>
        Math.max(-32768, Math.min(32767, Math.trunc(sample * 32768))),
      ),
      block.frame - firstInputFrame,
    );
  }
  await writeFile(
    info.outputPath("raw-input.json"),
    JSON.stringify(inputBlocks),
  );
  await writeFile(info.outputPath("take.wav"), await readFile(takePath));
  // Wait for actual peaks, not a flat clip placeholder.
  await expect
    .poll(async () =>
      (
        await request.get(
          `/api/cutroom/projects/${project.id}/media/peaks?path=${encodeURIComponent(take.src!)}&level=0&start=0&end=2`,
        )
      ).status(),
    )
    .toBe(200);
  const colour = await page
    .locator("canvas.tl-bodies")
    .evaluate((canvas) =>
      getComputedStyle(canvas).getPropertyValue("--wave-vo").trim(),
    );
  const waveColour = [1, 3, 5].map((at) =>
    parseInt(colour.slice(at, at + 2), 16),
  );
  await expect
    .poll(() =>
      page.locator("canvas.tl-bodies").evaluate((canvas, channels) => {
        if (!(canvas instanceof HTMLCanvasElement))
          throw new Error("The waveform canvas is missing.");
        const context = canvas.getContext("2d")!;
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i] === channels[0] &&
            pixels[i + 1] === channels[1] &&
            pixels[i + 2] === channels[2] &&
            pixels[i + 3]! > 0
          )
            count++;
        return count;
      }, waveColour),
    )
    .toBeGreaterThan(100);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({ path: info.outputPath("take.png") });
  const { stdout: screenshot } = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      info.outputPath("take.png"),
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 1720 * 1050 * 3 },
  );
  let visibleWave = 0;
  for (let i = 0; i < screenshot.length; i += 3)
    if (
      screenshot[i] === waveColour[0] &&
      screenshot[i + 1] === waveColour[1] &&
      screenshot[i + 2] === waveColour[2]
    )
      visibleWave++;
  expect(visibleWave).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.filter(
          (clip) => clip.kind === "voiceover",
        ).length,
    )
    .toBe(0);
  expect((await readFile(takePath)).length).toBeGreaterThan(44);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.filter(
          (clip) => clip.kind === "voiceover",
        ).length,
    )
    .toBe(1);
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
  await expect(dialog).toContainText("Export complete.", { timeout: 60_000 });
  const exported = info.outputPath("voiceover.mp4");
  const download = await request.get(`/api/render/${jobId}/download`);
  expect(download.ok()).toBeTruthy();
  await writeFile(exported, await download.body());
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  const [source, captured, rendered] = await Promise.all([
    pcm(input),
    pcm(takePath),
    pcm(exported),
  ]);
  // Chromium's file microphone can insert startup silence under CPU load. Compare every
  // saved sample with an independent raw-input tap so that artifact cannot mask a Cutroom dropout.
  const captureMatch = correlate(
    rawInput,
    captured,
    0,
    rawInput.length - captured.length,
  );
  expect(captureMatch.correlation).toBeGreaterThan(0.9999);
  let maxSampleError = 0;
  for (let i = 0; i < captured.length; i++)
    maxSampleError = Math.max(
      maxSampleError,
      Math.abs(captured[i]! - rawInput[captureMatch.offset + i]!),
    );
  expect(maxSampleError).toBeLessThanOrEqual(1);
  // Still verify the fake device supplies our file, beyond its startup artifact.
  const stableInput = rawInput.subarray(rate);
  const sourceMatch = correlate(
    source,
    stableInput,
    0,
    source.length - stableInput.length,
  );
  expect(sourceMatch.correlation).toBeGreaterThan(0.95);
  const expected = (take.start / 30) * rate;
  const exportMatch = correlate(
    rendered,
    captured,
    expected - 1600,
    expected + 1600,
  );
  expect(exportMatch.correlation).toBeGreaterThan(0.9);
  const offsetMs = ((exportMatch.offset - expected) * 1000) / rate;
  expect(Math.abs(offsetMs)).toBeLessThan(1000 / 30);
  await writeFile(
    info.outputPath("timing.json"),
    JSON.stringify(
      {
        timing,
        clipStartFrame: take.start,
        clipEndFrame: take.start + take.duration,
        stoppedFrame,
        sourceOffsetSamples: sourceMatch.offset,
        sourceCorrelation: sourceMatch.correlation,
        captureCorrelation: captureMatch.correlation,
        captureStartInputFrame: firstInputFrame + captureMatch.offset,
        maxSampleError,
        exportCorrelation: exportMatch.correlation,
        exportOffsetMs: offsetMs,
      },
      null,
      2,
    ),
  );
  expect(errors).toEqual([]);

  // Esc discards without creating either a media file or a history entry.
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("0100");
  await page.keyboard.press("Enter");
  const files = await request
    .get(`/api/projects/${project.id}/files`)
    .then((response) => response.json());
  await page
    .getByRole("button", { name: "Record voiceover", exact: true })
    .click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  const discard = page.getByRole("dialog", { name: "Discard voiceover take?" });
  await expect(discard).toBeVisible();
  await discard
    .getByRole("button", { name: "Discard take", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeEnabled();
  expect((await read()).timeline).toEqual(recorded.timeline);
  expect(
    await request
      .get(`/api/projects/${project.id}/files`)
      .then((response) => response.json()),
  ).toEqual(files);
});

test("arming is exclusive, device choice persists, and microphone denial is explained", async ({
  page,
  request,
  context,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Arm voiceover" },
      })
    ).json(),
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const view = TimelineViewSchema.parse(
    await (await request.get(`${base}/timeline`)).json(),
  );
  await request.post(`${base}/commands`, {
    data: {
      expectedRevision: view.revision,
      commands: [
        { type: "setTrack", index: 3, kind: "audio" },
        { type: "setTrack", index: 4, kind: "audio" },
      ],
    },
  });
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Arm A1", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Arm A2", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Arm A1", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Microphone input A2" }).click();
  const inputPicker = page
    .getByRole("combobox", { name: "Voiceover input device", exact: true })
    .last();
  await inputPicker.click();
  await page
    .getByRole("option", { name: "Fake Audio Input 1", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeEnabled();
  const chosen = await inputPicker.getAttribute("value");
  await page.reload();
  await page.getByRole("button", { name: "Microphone input A2" }).click();
  await expect(inputPicker).toHaveAttribute("value", chosen!);
  await page.keyboard.press("Escape");
  let uploads = 0;
  await page.route("**/upload?dir=assets/voiceover", async (route) => {
    uploads++;
    if (uploads === 1)
      await route.fulfill({ status: 503, json: { error: "Unavailable" } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Arm A2", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Control+Alt+Shift+V");
  await expect(
    page.getByRole("button", { name: "Stop voiceover" }),
  ).toBeVisible();
  await page.waitForTimeout(250);
  await page.keyboard.press("Control+Alt+Shift+V");
  await expect(page.locator(".toast")).toContainText(
    "could not be saved (503)",
  );
  await page.getByRole("button", { name: "Microphone input A2" }).click();
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeEnabled();
  expect(uploads).toBe(2);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Arm A2", exact: true }).click();
  const cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  await cdp.send("Browser.setPermission", {
    permission: { name: "microphone" },
    setting: "denied",
    origin: new URL(page.url()).origin,
    browserContextId: targetInfo.browserContextId,
  });
  expect(
    await page.evaluate(
      'navigator.permissions.query({name:"microphone"}).then(permission => permission.state)',
    ),
  ).toBe("denied");
  await page.getByRole("button", { name: "Arm A1", exact: true }).click();
  await expect(page.locator(".toast")).toContainText(
    "Microphone permission denied",
  );
  await expect(
    page.getByRole("button", { name: "Arm A1", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("project switches and reload refuse to abandon a recording or a failed save", async ({
  page,
  request,
}, info) => {
  const create = async (name: string) =>
    ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", { data: { name } })
      ).json(),
    );
  const first = await create("Keep this take");
  const second = await create("Next project");
  const read = async (id: string) =>
    TimelineViewSchema.parse(
      await (await request.get(`/api/cutroom/projects/${id}/timeline`)).json(),
    );
  await page.goto(`/#project/${first.id}`);
  await page.getByRole("button", { name: "Arm A1", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Shift+R");
  await expect(
    page.getByRole("button", { name: "Stop voiceover" }),
  ).toHaveCount(0);
  await page.keyboard.press("Control+Alt+Shift+V");
  await expect(
    page.getByRole("button", { name: "Stop voiceover" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cutroom projects" }).click();
  await page.getByRole("button", { name: new RegExp(second.name) }).click();
  await expect(page.locator(".toast")).toContainText("Save or discard");
  await expect(page).toHaveURL(new RegExp(first.id));
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(
    page.getByRole("button", { name: "Stop voiceover" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("switch-refused.png") });

  // Browser history and direct project links must use the same guard as the picker.
  await page.evaluate((id) => {
    location.hash = `project/${id}`;
  }, second.id);
  await expect(page).toHaveURL(new RegExp(first.id));
  const reload = page.waitForEvent("dialog");
  await page.evaluate(() => {
    window.setTimeout(() => location.reload(), 0);
  });
  const warning = await reload;
  expect(warning.type()).toBe("beforeunload");
  await warning.dismiss();
  await expect(
    page.getByRole("button", { name: "Stop voiceover" }),
  ).toBeVisible();

  let releaseUpload = () => {};
  const uploading = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route("**/upload?dir=assets/voiceover", async (route) => {
    await uploading;
    await route.fulfill({ status: 503, json: { error: "Unavailable" } });
  });
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Cutroom projects" }).click();
  await page.getByRole("button", { name: new RegExp(second.name) }).click();
  await expect(page.locator(".toast")).toContainText("finish saving");
  releaseUpload();
  await expect(page.locator(".toast")).toContainText(
    "could not be saved (503)",
  );
  await page.getByRole("button", { name: new RegExp(second.name) }).click();
  await expect(page.locator(".toast")).toContainText("Save or discard");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.unroute("**/upload?dir=assets/voiceover");
  await page.getByRole("button", { name: "Microphone input A1" }).click();
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeEnabled();
  const take = (await read(first.id)).timeline.clips.find(
    (clip) => clip.kind === "voiceover",
  )!;
  expect((await readFile(join(first.path, take.src!))).length).toBeGreaterThan(
    44,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Cutroom projects" }).click();
  await page.getByRole("button", { name: new RegExp(second.name) }).click();
  await expect(page).toHaveURL(new RegExp(second.id));
  expect(
    (await read(second.id)).timeline.clips.some(
      (clip) => clip.kind === "voiceover",
    ),
  ).toBe(false);
});

test("playback click times survive capture alignment and a latency change after arming", async ({
  page,
  request,
}, info) => {
  // Replace only the microphone's signal with sample-scheduled impulses. The real AudioContext,
  // worklet, WAV writer, upload and placement still run. Generate the clicks from later playback
  // observations, independently of the first advancing frame used to align the take.
  await page.addInitScript(() => {
    if (window !== top) return;
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        const context = this;
        Object.defineProperty(context, "outputLatency", {
          get: () =>
            document.documentElement.dataset.recordLatency ? 0.037 : 0.011,
        });
        const signal = context.createGain();
        const silence = context.createConstantSource();
        silence.offset.value = 0;
        silence.connect(signal);
        silence.start();
        Object.defineProperty(context, "createMediaStreamSource", {
          value: () => signal,
        });
        let scheduled = false;
        let observedFrame = 30;
        let advancingFrames = 0;
        window.addEventListener("message", (event: MessageEvent<unknown>) => {
          if (scheduled || !event.data || typeof event.data !== "object")
            return;
          const clock = event.data;
          if (
            !("source" in clock) ||
            clock.source !== "cutroom-preview" ||
            !("type" in clock) ||
            clock.type !== "clock" ||
            !("time" in clock) ||
            typeof clock.time !== "number" ||
            clock.time <= 1 ||
            !("at" in clock) ||
            typeof clock.at !== "number"
          )
            return;
          const frame = Math.floor(clock.time * 30);
          if (frame <= observedFrame) return;
          observedFrame = frame;
          // The next advancing frame is independent of the take's anchor. Keep the reads
          // close so output-device timestamp drift is not mistaken for a crop error.
          if (++advancingFrames < 2) return;
          scheduled = true;
          const buffer = context.createBuffer(
            1,
            context.sampleRate,
            context.sampleRate,
          );
          const samples = buffer.getChannelData(0);
          for (const at of [0.125, 0.375, 0.625, 0.875])
            samples[Math.round(at * context.sampleRate)] = 1;
          const clicks = context.createBufferSource();
          clicks.buffer = buffer;
          clicks.connect(signal);
          // Emulate the microphone's reported 10 ms input delay and current output pipeline.
          const timestamp = context.getOutputTimestamp();
          if (timestamp.contextTime === undefined || !timestamp.performanceTime)
            throw new Error("The test input's output clock is not ready.");
          const clickTime =
            timestamp.contextTime +
            (clock.at - performance.timeOrigin - timestamp.performanceTime) /
              1000 +
            1.5 -
            clock.time;
          clicks.start(
            clickTime + 0.01 + context.baseLatency + context.outputLatency,
          );
        });
      }
    };
  });
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Playback clicks", duration: 5 },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  await page.getByRole("button", { name: "Arm A1", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("0100");
  await page.keyboard.press("Enter");
  await page.evaluate(() => {
    document.documentElement.dataset.recordLatency = "changed";
  });
  await page.keyboard.press("Control+Alt+Shift+V");
  await page.waitForTimeout(1800);
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("button", { name: "Record voiceover", exact: true }),
  ).toBeEnabled();
  const view = TimelineViewSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/timeline`)
    ).json(),
  );
  const take = view.timeline.clips.find((clip) => clip.kind === "voiceover")!;
  expect(take.start).toBe(30);
  const samples = await pcm(join(project.path, take.src!));
  const clicks = Array.from(samples, (sample, i) =>
    sample > 1000 &&
    sample > (samples[i - 1] ?? 0) &&
    sample >= (samples[i + 1] ?? 0)
      ? i
      : -1,
  ).filter((at) => at >= 0);
  expect(clicks).toHaveLength(4);
  const errors = clicks.map((sample, i) => sample - (0.625 + i * 0.25) * rate);
  await writeFile(
    info.outputPath("playback-alignment.json"),
    JSON.stringify(
      {
        expectedTimelineSeconds: [1.625, 1.875, 2.125, 2.375],
        savedSamples: clicks,
        errorsSamples: errors,
        errorsMs: errors.map((n) => (n * 1000) / rate),
        boundSamples: 144,
      },
      null,
      2,
    ),
  );
  // Three milliseconds at 48 kHz: well under a frame, with headroom for timestamp estimation on a
  // loaded host. The 26 ms negative control still fails this bound.
  for (const error of errors) expect(Math.abs(error)).toBeLessThanOrEqual(144);
});

for (const disconnectAt of ["save-failed", "saving"] as const) {
  test(`a microphone disconnect during ${disconnectAt} preserves the take and its navigation guard`, async ({
    page,
    request,
  }, info) => {
    await page.addInitScript(() => {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await getUserMedia(constraints);
        window.addEventListener(
          "test-microphone-ended",
          () => stream.getAudioTracks()[0]!.dispatchEvent(new Event("ended")),
          { once: true },
        );
        return stream;
      };
    });
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: "Disconnected take" },
        })
      ).json(),
    );
    await page.goto(`/#project/${project.id}`);
    await page.getByRole("button", { name: "Arm A1", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Record voiceover", exact: true }),
    ).toBeEnabled();
    const uploading = Promise.withResolvers<void>();
    const releaseUpload = Promise.withResolvers<void>();
    await page.route("**/upload?dir=assets/voiceover", async (route) => {
      uploading.resolve();
      if (disconnectAt === "saving") await releaseUpload.promise;
      await route.fulfill({ status: 503, json: { error: "Unavailable" } });
    });
    await page
      .getByRole("button", { name: "Record voiceover", exact: true })
      .click();
    await page.waitForTimeout(350);
    await page.keyboard.press("Space");
    await uploading.promise;
    if (disconnectAt === "save-failed")
      await expect(page.locator(".toast")).toContainText(
        "could not be saved (503)",
      );
    await page.getByRole("button", { name: "Microphone input A1" }).click();
    if (disconnectAt === "save-failed") {
      await expect(
        page.getByRole("button", { name: "Retry save", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Download take", exact: true }),
      ).toBeVisible();
    }
    await page.evaluate(() =>
      window.dispatchEvent(new Event("test-microphone-ended")),
    );
    await expect(page.locator(".toast")).toContainText("disconnected");
    releaseUpload.resolve();
    await expect(
      page.getByRole("button", { name: "Retry save", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download take", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("disconnected-take.png") });
    const downloading = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download take", exact: true })
      .click();
    const download = await downloading;
    await download.saveAs(info.outputPath("recovered.wav"));
    expect(
      (await readFile(info.outputPath("recovered.wav"))).length,
    ).toBeGreaterThan(44);
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      location.hash = "";
    });
    await expect(page).toHaveURL(new RegExp(project.id));
    await expect(page.locator(".toast")).toContainText("Save or discard");
    const reloading = page.waitForEvent("dialog");
    await page.evaluate(() => window.setTimeout(() => location.reload(), 0));
    const warning = await reloading;
    expect(warning.type()).toBe("beforeunload");
    await warning.dismiss();
    await page.getByRole("button", { name: "Microphone input A1" }).click();
    await page.unroute("**/upload?dir=assets/voiceover");
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Arm A1", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    const view = TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
    const take = view.timeline.clips.find((clip) => clip.kind === "voiceover")!;
    expect(await readFile(join(project.path, take.src!))).toEqual(
      await readFile(info.outputPath("recovered.wav")),
    );
  });
}

test("recording and failed-save controls stay visible through recovery", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Voiceover controls", duration: 8 },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  await page.getByRole("button", { name: "Arm A1", exact: true }).click();
  const record = page.getByRole("button", { name: /^Record voiceover/ });
  await expect(record).toBeEnabled();
  const alignment = await page.evaluate(() =>
    Object.fromEntries(
      ["V1", "A1"].map((id) => {
        const head = document
          .querySelector(`input[aria-label="Name ${id}"]`)!
          .closest(".tl-head")!;
        return [
          id,
          {
            name: head.querySelector("input")!.getBoundingClientRect().x,
            lock: head
              .querySelector(".tl-track-button")!
              .getBoundingClientRect().x,
            buttons: head.querySelectorAll(".tl-head-buttons button").length,
          },
        ];
      }),
    ),
  );
  expect(alignment.A1).toEqual({
    name: alignment.V1!.name,
    lock: alignment.V1!.lock,
    buttons: 5,
  });
  expect(alignment.A1!.name).toBe(alignment.A1!.lock);
  await writeFile(
    info.outputPath("alignment.json"),
    JSON.stringify(alignment, null, 2),
  );
  await page.screenshot({ path: info.outputPath("armed.png") });
  await page.route("**/upload?dir=assets/voiceover", (route) =>
    route.fulfill({ status: 503, json: { error: "Unavailable" } }),
  );
  const header = page.locator(".tl-head.audio").first();
  const headBox = (await header.boundingBox())!;
  const armBox = (await header
    .getByRole("button", { name: "Arm A1", exact: true })
    .boundingBox())!;
  const micBox = (await header
    .getByRole("button", { name: "Microphone input A1" })
    .boundingBox())!;
  expect(
    headBox.x + headBox.width - armBox.x - armBox.width,
  ).toBeGreaterThanOrEqual(4);
  expect(
    headBox.x + headBox.width - micBox.x - micBox.width,
  ).toBeGreaterThanOrEqual(4);
  const clock = page.getByRole("button", { name: /^Current time/ });
  const idle = (await clock.boundingBox())!.x;
  await record.click();
  const stopButton = page.getByRole("button", { name: "Stop voiceover" });
  await stopButton.hover();
  await expect(stopButton).toHaveCSS("color", "rgb(255, 122, 107)");
  await page.waitForTimeout(1200);
  await expect(
    page.getByRole("status").filter({ hasText: "Recording" }),
  ).toBeVisible();
  // The record mark sits after the clock, so a take never moves the timecode.
  expect((await clock.boundingBox())!.x).toBe(idle);
  await expect(
    page.getByRole("button", { name: "Arm A1", exact: true }),
  ).toHaveCSS("opacity", "1");
  const region = page.getByLabel("Recording voiceover take");
  const firstWidth = (await region.boundingBox())!.width;
  expect(firstWidth).toBeGreaterThan(0);
  await page.waitForTimeout(200);
  expect((await region.boundingBox())!.width).toBeGreaterThan(firstWidth);
  const edgeError = await page.evaluate(() =>
    Math.abs(
      document.querySelector(".vo-take-region")!.getBoundingClientRect().right -
        document.querySelector(".tl-playhead")!.getBoundingClientRect().left,
    ),
  );
  expect(edgeError).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("recording.png") });
  await page.keyboard.press("Space");
  await expect(region).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText(
    "could not be saved (503)",
  );
  await expect(page.locator(".toast")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("failed-save.png") });
  const panel = page.locator(".vo-input-panel:popover-open");
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Retry save", exact: true }),
  ).toBeFocused();
  await clock.click();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  const recovery = page.getByRole("button", { name: "Microphone input A1" });
  await expect(recovery).toHaveCSS("color", "rgb(255, 122, 107)");
  await recovery.click();
  await expect(
    panel.getByRole("button", { name: "Retry save", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Control+Alt+Shift+V");
  await expect(page.locator(".toast")).toContainText(
    "Save failed. Retry or download",
  );
  const discardButton = panel.getByRole("button", {
    name: "Discard take",
    exact: true,
  });
  await discardButton.click();
  const discard = page.getByRole("dialog", { name: "Discard voiceover take?" });
  await expect(discard).toBeVisible();
  await expect(
    discard.getByRole("button", { name: "Keep take" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    discard.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    discard.getByRole("button", { name: "Discard take", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    discard.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(discard).toHaveCount(0);
  await expect(discardButton).toBeFocused();
  await expect(
    panel.getByRole("button", { name: "Retry save", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("recovery-panel.png") });
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download take", exact: true })
    .click();
  const download = await downloading;
  await download.saveAs(info.outputPath("recovered.wav"));
  await page.unroute("**/upload?dir=assets/voiceover");
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(record).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: info.outputPath("recovered.png") });
  await page.getByRole("button", { name: "Lock A1", exact: true }).click();
  await page.getByRole("button", { name: "Arm A1", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Arm A1", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("a dropped microphone block stays silent without losing or shifting the take", async ({
  page,
  request,
}, info) => {
  await referenceMicrophone(page);
  await page.addInitScript(() => {
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(
        context: BaseAudioContext,
        name: string,
        options?: AudioWorkletNodeOptions,
      ) {
        super(context, name, options);
        if (name !== "cutroom-voiceover") return;
        this.port.addEventListener(
          "message",
          (event: MessageEvent<{ frame: number; samples: Int16Array }>) => {
            if (document.documentElement.dataset.dropAudio !== "next") return;
            document.documentElement.dataset.dropAudio = String(
              event.data.frame,
            );
            event.stopImmediatePropagation();
          },
        );
      }
    };
  });
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Dropped block", duration: 8 },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  await page.getByRole("button", { name: "Arm A1", exact: true }).click();
  const record = page.getByRole("button", {
    name: "Record voiceover",
    exact: true,
  });
  await expect(record).toBeEnabled();
  await record.click();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.documentElement.dataset.dropAudio = "next";
  });
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-drop-audio",
    "next",
  );
  await page.waitForTimeout(400);
  await page.keyboard.press("Space");
  await expect(record).toBeEnabled();
  await expect(page.locator(".toast")).toContainText(
    "43 ms of microphone audio dropped",
  );
  const view = TimelineViewSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/timeline`)
    ).json(),
  );
  const take = view.timeline.clips.find((clip) => clip.kind === "voiceover")!;
  expect(take).toBeDefined();
  const samples = await pcm(join(project.path, take.src!));
  const { blocks, droppedFrame } = await page.evaluate(() => ({
    blocks: window.microphoneReference,
    droppedFrame: Number(document.documentElement.dataset.dropAudio),
  }));
  const first = blocks[0]!.frame;
  const last = blocks.at(-1)!;
  const inputSamples = new Int16Array(last.frame + last.samples.length - first);
  for (const block of blocks)
    inputSamples.set(
      block.samples.map((sample) =>
        Math.max(
          -32768,
          Math.min(32767, Math.round(sample * (sample < 0 ? 32768 : 32767))),
        ),
      ),
      block.frame - first,
    );
  const match = correlate(
    inputSamples,
    samples.subarray(0, 4096),
    0,
    inputSamples.length - samples.length,
  );
  expect(match.correlation).toBeGreaterThan(0.9999);
  const droppedAt = droppedFrame - first - match.offset;
  expect(droppedAt).toBeGreaterThan(4096);
  expect(droppedAt + 2048).toBeLessThan(samples.length);
  let maxSampleError = 0;
  for (let i = 0; i < samples.length; i++) {
    const expected =
      i >= droppedAt && i < droppedAt + 2048
        ? 0
        : inputSamples[match.offset + i]!;
    maxSampleError = Math.max(maxSampleError, Math.abs(samples[i]! - expected));
  }
  expect(maxSampleError).toBeLessThanOrEqual(1);
  await expect(page.locator(".toast")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("dropped-block-kept.png") });
  await writeFile(
    info.outputPath("dropout.json"),
    JSON.stringify(
      {
        droppedAt,
        droppedSamples: 2048,
        totalSamples: samples.length,
        correlation: match.correlation,
      },
      null,
      2,
    ),
  );
});

test("the compact microphone meter shows and clears clipping after the input falls silent", async ({
  page,
  request,
}, info) => {
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        const createSource = this.createMediaStreamSource.bind(this);
        Object.defineProperty(this, "createMediaStreamSource", {
          value: (stream: MediaStream) => {
            const gain = this.createGain();
            gain.gain.value = 20;
            createSource(stream).connect(gain);
            window.addEventListener("test-quiet-input", () => {
              gain.gain.value = 0;
            });
            return gain;
          },
        });
      }
    };
  });
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Input clipping" },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Arm A1", exact: true }).click();
  const meter = page.getByRole("meter", { name: "Microphone input level" });
  await expect(meter.locator('[data-clipping="true"]')).toBeVisible();
  await page.getByRole("button", { name: "Microphone input A1" }).click();
  const panel = page.locator(".vo-input-panel:popover-open");
  await expect(
    panel.getByRole("meter").locator('[data-clipping="true"]'),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("test-quiet-input")),
  );
  await expect(meter.first()).toHaveAttribute("aria-valuenow", "0");
  await expect(meter.first().locator(".tl-meter-channel")).toHaveCSS(
    "background-color",
    "rgb(255, 79, 58)",
  );
  const clear = meter
    .first()
    .getByRole("button", { name: "Clear microphone clipping indicator" });
  expect((await clear.boundingBox())!.height).toBeGreaterThanOrEqual(16);
  await page.screenshot({ path: info.outputPath("clipping.png") });
  await panel
    .getByRole("button", { name: "Clear microphone clipping indicator" })
    .click();
  await expect(
    panel.getByRole("meter").locator('[data-clipping="true"]'),
  ).toHaveCount(0);
});

test("occupied takes preview their destination and reuse A2 until the growing range overlaps", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Reusable voiceover lane", duration: 12 },
      })
    ).json(),
  );
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=48000:duration=12",
    join(project.path, "assets/music.wav"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="12"><div id="picture" class="clip" data-start="0" data-duration="12" data-track-index="0">Picture</div><audio id="music" src="assets/music.wav" data-start="0" data-duration="12" data-track-index="1"></audio></main></body></html>',
  );
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  await page.getByRole("button", { name: "Arm A1", exact: true }).click();
  const record = page.getByRole("button", {
    name: "Record voiceover",
    exact: true,
  });
  await expect(record).toBeEnabled();
  const seek = async (time: string) => {
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page.getByLabel("Go to time").pressSequentially(time);
    await page.keyboard.press("Enter");
  };
  const region = page.getByLabel("Recording voiceover take");
  for (const [i, time] of ["0100", "0400", "0700"].entries()) {
    await seek(time);
    await record.click();
    await expect(region).toBeVisible();
    await page.waitForTimeout(350);
    const row =
      i === 0
        ? page.getByLabel("New audio lane A2")
        : page.locator(".tl-head.audio").nth(1);
    const top = (await row.boundingBox())!.y;
    expect((await region.boundingBox())!.y).toBe(top);
    const bed = (await page.locator('[data-clip="music"]').boundingBox())!;
    expect((await region.boundingBox())!.y).toBeGreaterThanOrEqual(
      bed.y + bed.height,
    );
    await page.keyboard.press("Space");
    await expect(record).toBeEnabled();
    const view = await read();
    const takes = view.timeline.clips.filter(
      (clip) => clip.kind === "voiceover",
    );
    expect(takes).toHaveLength(i + 1);
    expect(takes.map((clip) => clip.track)).toEqual(Array(i + 1).fill(2));
    await expect
      .poll(
        async () =>
          (await page
            .locator(`[data-clip="${takes.at(-1)!.id}"]`)
            .boundingBox())!.y,
      )
      .toBeCloseTo(top + 1, 0);
  }
  const before = await read();
  expect(
    before.timeline.tracks.filter((track) => track.kind === "audio"),
  ).toHaveLength(2);
  expect(
    before.timeline.clips.find((clip) => clip.id === "music"),
  ).toMatchObject({ track: 1, start: 0, duration: 360 });
  await seek("0315");
  await record.click();
  const a2 = page.locator(".tl-head.audio").nth(1);
  await expect(region).toBeVisible();
  expect((await region.boundingBox())!.y).toBe((await a2.boundingBox())!.y);
  await expect(page.getByLabel("New audio lane A3")).toBeVisible();
  const destination = (await page
    .getByLabel("New audio lane A3")
    .boundingBox())!.y;
  expect((await region.boundingBox())!.y).toBe(destination);
  await page.keyboard.press("Space");
  await expect(record).toBeEnabled();
  const after = await read();
  const take = after.timeline.clips
    .filter((clip) => clip.kind === "voiceover")
    .at(-1)!;
  expect(take.track).toBe(3);
  expect(after.timeline.clips.filter((clip) => clip.id !== take.id)).toEqual(
    before.timeline.clips,
  );
});

test("recording clears its resolved error and a clean save preserves an unrelated toast", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Voiceover toast ownership", duration: 8 },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  await page.locator(".tl-clip").first().click();
  const opacity = page.getByRole("textbox", { name: "Opacity", exact: true });
  await expect(opacity).toBeVisible();
  await page.getByRole("button", { name: "Arm A1", exact: true }).click();
  const record = page.getByRole("button", {
    name: "Record voiceover",
    exact: true,
  });
  await expect(record).toBeEnabled();
  await page.getByRole("button", { name: "Lock A1", exact: true }).click();
  await record.click();
  await expect(page.locator(".toast")).toContainText(
    "Unlock an audio track before recording.",
  );
  await page.getByRole("button", { name: "Lock A1", exact: true }).click();
  await record.click();
  await expect(
    page.getByRole("button", { name: "Stop voiceover" }),
  ).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
  let finishUpload = () => {};
  const upload = new Promise<void>((resolve) => {
    finishUpload = resolve;
  });
  await page.route("**/upload?dir=assets/voiceover", async (route) => {
    await upload;
    await route.continue();
  });
  await page.waitForTimeout(350);
  await page.keyboard.press("Space");
  await expect(record).toBeDisabled();
  await opacity.fill("150%");
  await opacity.press("Enter");
  await expect(page.locator(".toast")).toContainText(
    "Opacity must be between 0% and 100%.",
  );
  finishUpload();
  await expect(record).toBeEnabled();
  await expect(page.locator(".toast")).toContainText(
    "Opacity must be between 0% and 100%.",
  );
  // Cancelling the recording discard saves the take and restores focus to Record.
  await record.click();
  await page.waitForTimeout(250);
  await page.keyboard.press("Escape");
  const discard = page.getByRole("dialog", { name: "Discard voiceover take?" });
  await expect(
    discard.getByRole("button", { name: "Save take" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(discard).toHaveCount(0);
  await expect(record).toBeEnabled();
  await expect(record).toBeFocused();
  const view = TimelineViewSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/timeline`)
    ).json(),
  );
  expect(
    view.timeline.clips.filter((clip) => clip.kind === "voiceover"),
  ).toHaveLength(2);
});
