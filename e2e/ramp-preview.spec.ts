import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Locator } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

const masterPeak = (audio: Locator) =>
  audio.evaluate(async () => {
    const runtime = window as Window & {
      __hf?: { audioMeter: { read(): { master: { l: number } } } };
    };
    const meter = runtime.__hf?.audioMeter;
    if (!meter) throw new Error("The playback meter is missing.");
    let peak = 0;
    for (let index = 0; index < 25; index++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      peak = Math.max(peak, meter.read().master.l);
    }
    return peak;
  });

for (const mode of [
  "separate audio",
  "retained audio",
  "embedded audio",
  "mounted scene",
  "unavailable audio",
  "truncated WAV",
  "parked audio with blocked media",
  "parked audio with a truncated WAV",
  "Play during the swap",
])
  test(`preview handles a ramp with ${mode} without interrupting playback`, async ({
    page,
    request,
  }, info) => {
    const parked = mode.startsWith("parked");
    const duration = parked ? 18 : 6;
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: "Ramp preview", width: 640, height: 360, duration },
        })
      ).json(),
    );
    const embedded = mode === "embedded audio";
    const nested = mode === "mounted scene";
    const unavailable =
      mode === "unavailable audio" || mode.endsWith("blocked media");
    const truncated = mode.endsWith("truncated WAV");
    const playDuringSwap = mode === "Play during the swap";
    const folder = nested ? join(project.path, "scenes") : project.path;
    await mkdir(folder, { recursive: true });
    const name = parked ? "Tone.mp4" : "Tone # 1.mp4";
    const mediaLength = parked ? 18 : 8;
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=0x1648c9:s=320x180:r=30:d=${mediaLength}`,
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=0.12*sin(2*PI*440*t)|0.12*sin(2*PI*440*t):s=48000:d=${mediaLength}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      join(folder, name),
    ]);
    const ramp = JSON.stringify({
      version: 1,
      lanes: [
        {
          target: "rate",
          points: [
            { t: 0, v: 0.25 },
            { t: 6, v: 4 },
          ],
        },
      ],
    });
    const fx = JSON.stringify({
      version: 1,
      nodes: [{ id: "quieter", type: "gain", params: { gain: -6 } }],
    });
    const media = `src="${encodeURIComponent(name)}"`;
    const timing = `${media} data-start="${parked ? 12 : 0}" data-duration="6" data-playback-start="0.25" data-audio-group="dialogue" data-automation='${ramp}'`;
    const id = nested ? "dialogue-scene" : "main";
    const style = parked
      ? "<style>body{margin:0}</style>"
      : "<style>body{margin:0}video{position:absolute;inset:0;width:100%;height:100%;}</style>";
    const picture = parked
      ? `<video id="picture" class="clip" ${media} muted data-start="0" data-duration="18" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video>`
      : `<video id="picture" class="clip" ${timing} ${embedded ? `data-has-audio="true" data-fx-chain='${fx}'` : "muted"} data-track-index="0"></video>`;
    const content = `
      <main id="${id}" data-composition-id="${id}" data-no-timeline data-width="640" data-height="360" data-fps="30" data-duration="${duration}">
      <hf-audio-group id="dialogue" data-volume="0.5"></hf-audio-group>
      ${picture}
      ${embedded ? "" : `<audio id="sound" ${timing} ${parked ? 'preload="none"' : ""} data-track-index="1"></audio>`}
      </main>`;
    const html = nested
      ? `<template>${style}${content}</template>`
      : `<!doctype html><html><head>${style}</head><body>${content}</body></html>`;
    const source = join(folder, nested ? "dialogue.html" : "index.html");
    let savedSource = html;
    await writeFile(source, html);
    if (nested)
      await writeFile(
        join(project.path, "index.html"),
        `<main data-composition-id="main" data-fps="30" data-width="640" data-height="360" data-duration="6"><div id="mount" data-composition-id="${id}" data-composition-src="scenes/dialogue.html" data-start="1" data-duration="5" data-track-index="0"></div></main>`,
      );
    const release = Promise.withResolvers<void>();
    let prepared = false;
    await page.route(
      (url) => url.searchParams.get("cutroom-ramp") === "1",
      async (route) => {
        const response = await route.fetch();
        prepared = (await response.json()).ready === true;
        await release.promise;
        await route.fulfill({ response });
      },
    );
    if (parked)
      await page.addInitScript(() => {
        if (window === window.top)
          localStorage.setItem("cutroom.footagePipeline", "true");
      });
    if (playDuringSwap)
      await page.addInitScript(() => {
        if (window === parent) {
          addEventListener("message", (event) => {
            if (event.data === "held-ramp-paint")
              document.documentElement.dataset.heldRampPaint = "true";
          });
          return;
        }
        let paints = 0;
        addEventListener(
          "message",
          (event) => {
            if (
              event.source === parent &&
              event.data?.source === "cutroom-viewer" &&
              event.data.action === "paint" &&
              document.querySelector('audio[src*="/ramp-audio/"]') &&
              ++paints === 2
            ) {
              event.stopImmediatePropagation();
              parent.postMessage("held-ramp-paint", "*");
            }
          },
          true,
        );
      });
    try {
      await page.goto(`/#project/${project.id}`);
      const stage = page.locator(".edit-stage");
      await expect(stage).toHaveAttribute("data-preview-ready");
      if (parked) await expect(stage).toHaveAttribute("data-pipeline", "on");
      const live = page.locator("iframe[data-live]");
      const old = await live.getAttribute("src");
      const frame = page.frameLocator("iframe[data-live]");
      const audio = frame.locator('audio[src*="/ramp-audio/"]');
      await expect(audio).toHaveCount(0);
      await expect.poll(() => prepared).toBe(true);
      await page
        .getByRole("button", { name: "Play forward", exact: true })
        .click();
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      await expect(stop).toBeVisible();
      let navigations = 0;
      page.on("request", (request) => {
        if (
          request.isNavigationRequest() &&
          request.url().includes("/isolated-preview?")
        )
          navigations++;
      });
      const time = page.getByRole("button", {
        name: "Current time. Click to type a time.",
      });
      const beforeReady = (await time.textContent())?.trim();
      const reply = page.waitForResponse((response) =>
        response.request().url().includes("cutroom-ramp=1"),
      );
      release.resolve();
      await reply;
      await expect(time).not.toHaveText(beforeReady!);
      await expect(live).toHaveAttribute("src", old!);
      expect(navigations).toBe(0);
      if (unavailable || truncated) {
        if (unavailable)
          await page.route("**/ramp-audio/*.wav", (route) =>
            route.request().headers()["range"] === "bytes=0-43"
              ? route.continue()
              : route.abort(),
          );
        if (truncated) {
          const cache = join(project.path, ".cutroom/cache");
          let wrote = 0;
          for (const key of await readdir(cache)) {
            const path = join(cache, key, "ramp.wav");
            if (!(await readFile(path).catch(() => null))) continue;
            await truncate(path, 44);
            wrote++;
          }
          expect(wrote).toBe(1);
        }
        const mediaRequest = page.waitForRequest("**/ramp-audio/*.wav");
        await stop.click();
        const preparedMedia = await mediaRequest;
        expect(preparedMedia.resourceType()).toBe("media");
        const preparedUrl = preparedMedia.url();
        await expect(page.locator("iframe.edit-frame")).toHaveCount(1);
        await expect(stage).toHaveAttribute("data-preview-ready");
        await expect(live).toHaveAttribute("src", old!);
        await expect(audio).toHaveCount(0);
        const header = await request.get(preparedUrl, {
          headers: { Range: "bytes=0-43" },
        });
        expect(header.status()).toBe(206);
        expect((await header.body()).subarray(0, 4).toString()).toBe("RIFF");
        await page.reload();
        await expect(live).toHaveAttribute("src", /cutroom-native-ramp=1/);
        await expect(stage).toHaveAttribute("data-preview-ready");
        await expect(frame.locator("#sound")).toHaveAttribute("src", /Tone/);
        await seekFrame(page, parked ? 420 : 60);
        await page
          .getByRole("button", { name: "Play forward", exact: true })
          .click();
        const peak = await masterPeak(frame.locator("#sound"));
        expect(peak).toBeGreaterThan(0.047);
        expect(peak).toBeLessThan(0.073);
        await writeFile(
          info.outputPath("native-level.json"),
          JSON.stringify({ mode, peak }),
        );
        expect(await readFile(source, "utf8")).toBe(html);
        return;
      }
      await stop.click();
      if (playDuringSwap) {
        await expect(page.locator("html")).toHaveAttribute(
          "data-held-ramp-paint",
          "true",
        );
        await expect(live).toHaveAttribute("src", old!);
        const paused = (await time.textContent())?.trim();
        await page
          .getByRole("button", { name: "Play forward", exact: true })
          .click();
        await expect(time).not.toHaveText(paused!);
        await expect(page.locator("iframe.edit-frame")).toHaveCount(1);
        await expect(live).toHaveAttribute("src", old!);
        return;
      }
      await expect(audio).toHaveCount(1);
      await expect(live).not.toHaveAttribute("src", old!);
      await expect(frame.locator("#picture")).toHaveJSProperty("muted", true);
      const wav = await audio.getAttribute("src");
      const media = await request.get(wav!, {
        headers: { Origin: "null", Range: "bytes=0-43" },
      });
      expect(media.status()).toBe(206);
      expect(media.headers()["access-control-allow-origin"]).toBe("null");
      expect((await media.body()).subarray(0, 4).toString()).toBe("RIFF");
      const key = /\/([a-f0-9]{64})\.wav$/.exec(wav!)?.[1];
      expect(key).toBeDefined();
      await rm(join(project.path, ".cutroom/cache", key!, "ramp.wav"));
      // An active document may only request a parked clip once playback reaches it.
      expect(
        (
          await request.get(wav!, { headers: { Range: "bytes=0-43" } })
        ).status(),
      ).toBe(206);
      await seekFrame(page, 60);
      await page
        .getByRole("button", { name: "Play forward", exact: true })
        .click();
      const sampleClock = (hostStart: number) =>
        audio.evaluate(async (element, hostStart) => {
          const runtime = window as Window & {
            __player?: { getTime(): number };
            __hf?: { audioMeter: { read(): { master: { l: number } } } };
          };
          const media = element as HTMLAudioElement;
          const { __player: player, __hf: hf } = runtime;
          if (!player || !hf)
            throw new Error("The playback runtime is missing.");
          const times: { drift: number; level: number }[] = [];
          for (let index = 0; index < 25; index++) {
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
            times.push({
              drift: Math.abs(media.currentTime - player.getTime() + hostStart),
              level: hf.audioMeter.read().master.l,
            });
          }
          return times.slice(8);
        }, hostStart);
      const samples = await sampleClock(nested ? 1 : 0);
      const peak = Math.max(...samples.map(({ level }) => level));
      expect(peak).toBeGreaterThan(embedded ? 0.023 : 0.047);
      expect(peak).toBeLessThan(embedded ? 0.037 : 0.073);
      if (embedded) await expect(audio).toHaveAttribute("data-fx-chain", fx);
      expect(Math.max(...samples.map(({ drift }) => drift))).toBeLessThan(0.06);
      await writeFile(
        info.outputPath("audio-clock.json"),
        JSON.stringify({ mode, peak, samples }, null, 2),
      );
      if (mode === "retained audio") {
        await stop.click();
        const prepared = await live.getAttribute("src");
        await page.route(
          (url) => url.pathname.endsWith("/isolated-preview"),
          async (route) => {
            const navigation = route.request().isNavigationRequest();
            const native = new URL(route.request().url()).searchParams.has(
              "cutroom-native-ramp",
            );
            if (navigation && !native) {
              await route.fulfill({
                contentType: "text/html",
                body: "<p>Preview failed to start</p>",
              });
            } else await route.continue();
          },
        );
        savedSource = html.replace(
          "</main>",
          '<div id="new-layer" data-start="0" data-duration="6" data-track-index="2">New layer</div></main>',
        );
        await writeFile(source, savedSource);
        await expect(stage).toHaveAttribute("data-handoff", "loading");
        await expect(stage).toHaveAttribute("data-handoff", "showing", {
          timeout: 18_000,
        });
        await expect(live).toHaveAttribute("src", prepared!);
        await expect(audio).toHaveCount(1);
        await page
          .getByRole("button", { name: "Play forward", exact: true })
          .click();
        expect(await masterPeak(audio)).toBeGreaterThan(0.047);
      }
      if (mode === "separate audio" || mode === "retained audio") {
        // A new request can fail after the prepared document was already confirmed.
        const beforeFailure = Number(
          (await time.textContent())?.replaceAll(":", "").trim(),
        );
        await page.route("**/ramp-audio/*.wav", (route) => route.abort());
        const requested = page.waitForRequest("**/ramp-audio/*.wav");
        await audio.evaluate((element) => (element as HTMLAudioElement).load());
        await requested;
        await expect(live).toHaveAttribute("src", /cutroom-native-ramp=1/);
        await expect(stage).toHaveAttribute("data-preview-ready");
        if (mode === "retained audio")
          await expect(frame.locator("#new-layer")).toHaveText("New layer");
        const play = page.getByRole("button", {
          name: "Play forward",
          exact: true,
        });
        await expect(play).toBeVisible();
        const parked = (await time.textContent())?.trim();
        expect(Number(parked?.replaceAll(":", ""))).toBeGreaterThanOrEqual(
          beforeFailure,
        );
        await page.screenshot({ path: info.outputPath("native-recovery.png") });
        await play.click();
        await expect(time).not.toHaveText(parked!);
        const recovered = await masterPeak(frame.locator("#sound"));
        expect(recovered).toBeGreaterThan(0.047);
        expect(recovered).toBeLessThan(0.073);
        await writeFile(
          info.outputPath("resumed-level.json"),
          JSON.stringify({ peak: recovered }),
        );
      }
      await stop.click();
      expect(await readFile(source, "utf8")).toBe(savedSource);
      await page.screenshot({ path: info.outputPath("prepared-ramp.png") });
      if (embedded) {
        // Changing the real muted attribute would make this authored picture vanish.
        const ready = await live.getAttribute("src");
        await writeFile(
          source,
          html.replace("</style>", "video[muted]{opacity:0}</style>"),
        );
        await expect(live).not.toHaveAttribute("src", ready!);
        await expect(audio).toHaveCount(0);
        await expect(frame.locator("#picture")).not.toHaveAttribute("muted");
        await writeFile(
          source,
          html.replace(
            ramp,
            '{"version":1,"lanes":[{"target":"rate","points":null}]}',
          ),
        );
        const fallback = await request.get(
          `/api/projects/${project.id}/isolated-preview`,
        );
        expect(fallback.ok()).toBe(true);
        expect(await fallback.text()).toContain('id="picture"');
        await writeFile(
          source,
          html.replaceAll(
            "Tone%20%23%201.mp4",
            "Tone%20%23%201.mp4/missing.mp4",
          ),
        );
        expect(
          (
            await request.get(`/api/projects/${project.id}/isolated-preview`)
          ).ok(),
        ).toBe(true);
      }
      if (nested) {
        await stop.click();
        const mounted = join(project.path, "index.html");
        const ready = await live.getAttribute("src");
        await writeFile(
          mounted,
          (await readFile(mounted, "utf8")).replace(
            'data-start="1"',
            'data-start="1" data-playback-start="2"',
          ),
        );
        await expect(live).not.toHaveAttribute("src", ready!);
        await expect(stage).toHaveAttribute("data-preview-ready");
        await expect(audio).toHaveAttribute(
          "src",
          new RegExp(`/${key}\\.wav$`),
        );
        await seekFrame(page, 60);
        await page
          .getByRole("button", { name: "Play forward", exact: true })
          .click();
        const trimmed = await sampleClock(-1);
        const trimmedPeak = Math.max(...trimmed.map(({ level }) => level));
        expect(trimmedPeak).toBeGreaterThan(0.047);
        expect(trimmedPeak).toBeLessThan(0.073);
        expect(Math.max(...trimmed.map(({ drift }) => drift))).toBeLessThan(
          0.06,
        );
        await writeFile(
          info.outputPath("trimmed-audio-clock.json"),
          JSON.stringify({ peak: trimmedPeak, samples: trimmed }, null, 2),
        );
      }
    } finally {
      release.resolve();
    }
  });

test("the viewer plays the original prepared audio on both sides of a ramp split", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Ramp split audio",
          width: 640,
          height: 360,
          duration: 4,
        },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.12*sin(2*PI*440*t)|0.12*sin(2*PI*331*t)+0.12*sin(2*PI*2273*t):s=48000:d=6",
    "-c:a",
    "pcm_s16le",
    join(project.path, "sound.wav"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<main data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-fps="30" data-duration="4.1">
      <audio id="sound" src="sound.wav" data-start="0.012515625" data-duration="4" data-media-start="0.5" data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":0.25,"curve":1},{"t":4,"v":4}]}]}'></audio>
    </main>`,
  );
  await page.goto(`/#project/${project.id}`);
  const audio = page
    .frameLocator("iframe[data-live]")
    .locator('audio[src*="/ramp-audio/"]');
  const samples = async (element: Locator) => {
    const src = await element.getAttribute("src");
    const response = await request.get(src!);
    expect(response.status()).toBe(200);
    const wav = await response.body();
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(36, 40).toString()).toBe("data");
    return wav.subarray(44);
  };
  await expect(audio).toHaveCount(1);
  const before = await samples(audio);
  expect(before.length).toBe(192_000 * 4);

  await seekFrame(page, 60);
  const clip = page.locator('[data-clip="sound"]');
  await clip.click();
  await page.keyboard.press("e");
  await expect(audio).toHaveCount(2);
  const left = await samples(audio.nth(0));
  const right = await samples(audio.nth(1));
  // The authored start lies three-quarters of a sample past sample 600.
  expect(left.length).toBe((96_000 - 601) * 4);
  expect(right.length).toBe((96_000 + 601) * 4);
  expect(left.equals(before.subarray(0, left.length))).toBe(true);
  expect(right.equals(before.subarray(left.length))).toBe(true);

  await seekFrame(page, 55);
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  expect(await masterPeak(audio.nth(0))).toBeGreaterThan(0.08);
  expect(await masterPeak(audio.nth(1))).toBeGreaterThan(0.08);
});
