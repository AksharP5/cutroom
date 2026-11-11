import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);

test("linked inspector audio edits, fades, undo, MCP acceptance and preview/export levels", async ({
  page,
  request,
  baseURL,
}, info) => {
  test.setTimeout(180_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Inspector audio", width: 320, height: 240, duration: 8 },
      })
    ).json(),
  );
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x240:r=30:d=8",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=8",
    "-af",
    "pan=stereo|c0=c0|c1=0*c0",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    join(project.path, "Picture.mp4"),
  ]);
  for (const [name, channel] of [
    ["Music", 1],
    ["Voice", 0],
  ] as const)
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${channel ? 220 : 660}:duration=8`,
      "-af",
      `pan=stereo|c0=${channel ? "0*c0" : "c0"}|c1=${channel ? "c0" : "0*c0"}`,
      join(project.path, `${name}.wav`),
    ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0}video{width:320px;height:240px}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-fps="30" data-duration="8"><video id="picture" data-label="Picture" src="Picture.mp4" muted data-link="pair" data-start="0" data-duration="8" data-track-index="0"></video><audio id="sound" src="Picture.mp4" data-link="pair" data-start="0" data-duration="8" data-track-index="1"></audio><audio id="music" src="Music.wav" data-start="0" data-duration="8" data-track-index="2" data-volume="0.3"></audio><audio id="voice" src="Voice.wav" data-start="4" data-duration="4" data-track-index="3" data-volume="0.2"></audio></main></body></html>`,
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  const sound = async () =>
    (await read()).timeline.clips.find((clip) => clip.id === "sound")!;
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="picture"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const gain = inspector.getByRole("textbox", { name: "Gain", exact: true });
  await expect(inspector.locator(".inspector-clip strong")).toHaveText(
    "Picture",
  );
  await expect(gain).toHaveValue("0.0 dB");
  await page.locator('[data-clip="sound"]').click();
  await expect(inspector.locator(".inspector-clip strong")).toHaveText(
    "Picture",
  );
  await page.locator('[data-clip="music"]').click({ modifiers: ["Control"] });
  await expect(inspector).toContainText("3 clips selected");
  await expect(gain).toHaveCount(0);
  await page.locator('[data-clip="picture"]').click();
  const set = async (label: string, value: string, finish = "Enter") => {
    const field = inspector.getByRole("textbox", { name: label, exact: true });
    await field.fill(value);
    await field.press(finish);
  };
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  const curve = page.locator('[data-clip-mix="sound"] .tl-gain');
  const originalCurve = await curve.getAttribute("d");
  // Every field and every whole gesture has a single history entry.
  for (const [label, text, property, value] of [
    ["Gain", "-6 dB", "volume", 10 ** (-6 / 20)],
    ["Fade in", "1s", "fadeIn", 30],
    ["Fade out", "00:00:02:00", "fadeOut", 60],
  ] as const) {
    const before = (await read()).timeline;
    await set(label, text);
    await expect.poll(async () => (await sound())[property]).toBe(value);
    const after = (await read()).timeline;
    await undo.click();
    await expect.poll(async () => (await read()).timeline).toEqual(before);
    await redo.click();
    await expect.poll(async () => (await read()).timeline).toEqual(after);
  }
  expect(await curve.getAttribute("d")).not.toBe(originalCurve);
  await expect(curve).toContainText("Gain -6.0 dB");
  for (const [field, percent] of [
    ["fadeIn", 12.5],
    ["fadeOut", 25],
  ] as const)
    await expect(
      page.locator(`[data-clip-mix="sound"] [data-mix="${field}"]`),
    ).toHaveAttribute("style", `--fade: ${percent}%;`);
  // Authored fades survive proportional clamping, and the effective length is explicit.
  await set("Fade in", "12s");
  await expect.poll(async () => (await sound()).fadeIn).toBe(360);
  await expect(inspector.locator(".inspector-field-hint")).toHaveCount(2);
  await expect(
    inspector.locator(".inspector-field-hint").first(),
  ).toContainText("Effective 00:00:06:26");
  await expect(inspector.getByLabel("Fade in", { exact: true })).toHaveValue(
    "00:00:12:00",
  );
  await undo.click();
  await expect(inspector.locator(".inspector-field-hint")).toHaveCount(0);
  const beforeKeys = (await read()).timeline;
  await gain.focus();
  await gain.press("ArrowUp");
  await gain.press("Alt+ArrowDown");
  await expect(gain).toHaveValue("-5.1 dB");
  await gain.press("Enter");
  await expect
    .poll(async () => (await sound()).volume)
    .toBeCloseTo(10 ** (-5.1 / 20), 10);
  await undo.click();
  await expect.poll(async () => (await read()).timeline).toEqual(beforeKeys);
  // The server can finish undo before the client has read its answer. Wait for the shown value before typing.
  await expect(gain).toHaveValue("-6.0 dB");
  await set("Gain", "-inf");
  await expect(gain).toHaveValue("-∞ dB");
  await expect.poll(async () => (await sound()).volume).toBe(0);
  await undo.click();
  await expect(gain).toHaveValue("-6.0 dB");
  await set("Gain", "+13");
  await expect(page.locator(".toast")).toContainText(
    "Gain must be between -∞ dB and +12.0 dB",
  );
  await gain.fill("jkln");
  await gain.press("Escape");
  await expect(gain).toHaveValue("-6.0 dB");
  await expect(
    page.getByRole("button", { name: "Play forward", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await gain.fill("-9 dB");
  await page.locator('[data-clip="music"]').click();
  await expect.poll(async () => (await sound()).volume).toBe(10 ** (-9 / 20));
  await expect(inspector.locator("summary")).toHaveText([
    "Changes",
    "Audio",
    "Timing",
  ]);
  await page.locator('[data-clip="picture"]').click();
  await undo.click();
  await expect(gain).toHaveValue("-6.0 dB");
  const label = inspector.locator("label").filter({ hasText: /^Gain$/ });
  const box = (await label.boundingBox())!;
  const beforeScrub = (await read()).timeline;
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 5 });
  // Scrubbing is a local draft until release.
  expect((await read()).timeline).toEqual(beforeScrub);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect(gain).toHaveValue("-5.0 dB");
  await undo.click();
  await expect.poll(async () => (await read()).timeline).toEqual(beforeScrub);
  // Esc during a scrub cancels it: release commits nothing, and the key goes no further.
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(gain).toHaveValue("-6.0 dB");
  expect((await read()).timeline).toEqual(beforeScrub);
  await expect(gain).toBeVisible();

  const client = new Client({
    name: "inspector-audio-agent",
    version: "1.0.0",
  });
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
    result.parse(
      await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: view.revision,
          label: "Set gain to +6.0 dB",
          commands: [
            { type: "setClip", clipId: "sound", volume: 10 ** (6 / 20) },
          ],
        },
      }),
    );
    await expect(gain).toHaveValue("+6.0 dB");
    const row = inspector
      .getByRole("listitem")
      .filter({ hasText: "Set gain to +6.0 dB" });
    await row.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(row).toContainText("Accepted");
  } finally {
    await client.close();
  }
  // Export the inspector's boosted gain and both fades, then measure actual decoded audio.
  await expect(
    page.frameLocator("iframe[data-live]").locator("#sound"),
  ).toHaveAttribute("data-volume", String(10 ** (6 / 20)));
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
  const output = info.outputPath("inspector-audio.mp4");
  await writeFile(
    output,
    await (await request.get(`/api/render/${jobId}/download`)).body(),
  );
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  const mutations = page.locator("#clip-inspector").evaluate(
    (root) =>
      new Promise<number>((resolve) => {
        let count = 0;
        const observer = new MutationObserver(
          (records) => (count += records.length),
        );
        observer.observe(root, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        });
        setTimeout(() => {
          observer.disconnect();
          resolve(count);
        }, 2500);
      }),
  );
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
  expect(await mutations).toBe(0);
  const evidence = [];
  for (const target of [1.5, 5, 6.5]) {
    const sample = samples.reduce((best, next) =>
      Math.abs(next.time - target) < Math.abs(best.time - target) ? next : best,
    );
    const { stdout } = await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        String(sample.time - 0.05),
        "-i",
        output,
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
      { encoding: "buffer" },
    );
    const pcm = new Float32Array(
      stdout.buffer,
      stdout.byteOffset,
      stdout.byteLength / 4,
    );
    const peaks = [0, 0];
    for (let i = 0; i < pcm.length; i++)
      peaks[i % 2] = Math.max(peaks[i % 2]!, Math.abs(pcm[i]!));
    const differenceDb = [sample.l, sample.r].map(
      (level, i) => 20 * Math.log10(level / peaks[i]!),
    );
    for (const difference of differenceDb)
      expect(Math.abs(difference)).toBeLessThan(1);
    evidence.push({
      time: sample.time,
      preview: [sample.l, sample.r],
      export: peaks,
      differenceDb,
    });
  }
  await writeFile(
    info.outputPath("levels.json"),
    JSON.stringify(evidence, null, 2),
  );
  await page.screenshot({ path: info.outputPath("inspector-audio.png") });
});
