import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

for (const mode of ["separate audio", "embedded audio", "mounted scene"])
  test(`preview warms a ramp with ${mode} without interrupting playback`, async ({
    page,
    request,
  }, info) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: "Ramp preview", width: 640, height: 360, duration: 6 },
        })
      ).json(),
    );
    const embedded = mode === "embedded audio";
    const nested = mode === "mounted scene";
    const folder = nested ? join(project.path, "scenes") : project.path;
    await mkdir(folder, { recursive: true });
    const name = "Tone # 1.mp4";
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=0x1648c9:s=320x180:r=30:d=8",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=0.12*sin(2*PI*440*t)|0.12*sin(2*PI*440*t):s=48000:d=8",
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
    const timing = `src="Tone%20%23%201.mp4" data-start="0" data-duration="6" data-playback-start="0.25" data-audio-group="dialogue" data-automation='${ramp}'`;
    const id = nested ? "dialogue-scene" : "main";
    const content = `<style>body{margin:0}video{position:absolute;inset:0;width:100%;height:100%;}</style>
      <main id="${id}" data-composition-id="${id}" data-no-timeline data-width="640" data-height="360" data-fps="30" data-duration="6">
      <hf-audio-group id="dialogue" data-volume="0.5"></hf-audio-group>
      <video id="picture" class="clip" ${timing} ${embedded ? 'data-has-audio="true"' : "muted"} data-track-index="0"></video>
      ${embedded ? "" : `<audio id="sound" ${timing} data-track-index="1"></audio>`}
      </main>`;
    const html = nested
      ? `<template>${content}</template>`
      : `<!doctype html><html><body>${content}</body></html>`;
    const source = join(folder, nested ? "dialogue.html" : "index.html");
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
    try {
      await page.goto(`/#project/${project.id}`);
      const stage = page.locator(".edit-stage");
      await expect(stage).toHaveAttribute("data-preview-ready");
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
      await stop.click();
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
      const samples = await audio.evaluate(
        async (element, hostStart) => {
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
        },
        nested ? 1 : 0,
      );
      const peak = Math.max(...samples.map(({ level }) => level));
      expect(peak).toBeGreaterThan(0.047);
      expect(peak).toBeLessThan(0.073);
      expect(Math.max(...samples.map(({ drift }) => drift))).toBeLessThan(0.06);
      await writeFile(
        info.outputPath("audio-clock.json"),
        JSON.stringify({ mode, peak, samples }, null, 2),
      );
      await stop.click();
      expect(await readFile(source, "utf8")).toBe(html);
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
      }
    } finally {
      release.resolve();
    }
  });
