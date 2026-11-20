import { execFile } from "node:child_process";
import { link, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Browser, Locator, Page } from "@playwright/test";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ExportJobSchema } from "../src/shared/export";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";

const run = promisify(execFile);
const takes = [
  { name: "Take 1", src: "interview.mp4", color: "red", hz: 440 },
  { name: "Take 2", src: "cam-b.mp4", color: "lime", hz: 880 },
  { name: "Wide", src: "wide.mp4", color: "blue", hz: 0 },
  { name: "Short cue", src: "short.mp4", color: "yellow", hz: 0 },
];

const comparison = process.env.CUTROOM_VERSION_EVIDENCE;
const DecoderCountsSchema = z.object({
  opened: z.number(),
  closed: z.number(),
  live: z.number(),
});

async function stageColour(page: Page, stage: Locator) {
  const png = await stage.screenshot({ animations: "disabled" });
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, image.width / 2, image.height / 2, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return r! > 170 && g! < 80
      ? "red"
      : g! > 170 && r! < 80
        ? "lime"
        : b! > 170 && r! < 80
          ? "blue"
          : "other";
  }, png.toString("base64"));
}

async function recordComparison(page: Page, evidence: string) {
  const cdp = await page.context().newCDPSession(page);
  const directory = join(evidence, "frames");
  await mkdir(directory, { recursive: true });
  const frames: { time: number; path: string }[] = [];
  const writes: Promise<unknown>[] = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (!metadata.timestamp) return;
    const path = join(directory, `${frames.length}.jpg`);
    frames.push({ time: metadata.timestamp, path });
    writes.push(writeFile(path, Buffer.from(data, "base64")));
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    maxWidth: 1440,
    quality: 85,
  });
  return async () => {
    await cdp.send("Page.stopScreencast");
    await cdp.detach();
    await Promise.all(writes);
    if (frames.length < 2) return;
    const list = join(directory, "frames.txt");
    await writeFile(
      list,
      frames
        .map(
          ({ time, path }, i) =>
            `file '${path}'\nduration ${i === 0 ? 1 : Math.max(1 / 60, Math.min(0.8, (frames[i + 1]?.time ?? time + 0.8) - time))}`,
        )
        .join("\n"),
    );
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-safe",
      "0",
      "-f",
      "concat",
      "-i",
      list,
      "-vf",
      "fps=25,scale=720:-2",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-movflags",
      "+faststart",
      join(evidence, "clip-versions.mp4"),
    ]);
  };
}

async function browserMemory(browser: Browser) {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    const memory = await Promise.all(
      processInfo.map(async ({ id }) => {
        const status = await readFile(`/proc/${id}/smaps_rollup`, "utf8").catch(
          () => "",
        );
        return Number(status.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0);
      }),
    );
    return Math.round(memory.reduce((sum, kb) => sum + kb, 0) / 1024);
  } finally {
    await cdp.detach();
  }
}

async function timePicture(
  page: Page,
  row: string,
  color: "red" | "lime" | "blue",
  action: "hover" | "switch" = "hover",
  open?: () => Promise<void>,
) {
  const stage = (await page.locator(".edit-stage").boundingBox())!;
  const viewport = page.viewportSize()!;
  const target = page.getByRole("menuitemradio", { name: new RegExp(row) });
  await page.evaluate(
    ({ eventName, row }) => {
      document.documentElement.removeAttribute("data-measure-pointer");
      const mark = (event: Event) => {
        if (
          !(event.target instanceof Element) ||
          !new RegExp(row).test(
            event.target.closest("[data-version]")?.textContent ?? "",
          )
        )
          return;
        document.removeEventListener(eventName, mark, true);
        document.documentElement.setAttribute(
          "data-measure-pointer",
          String(performance.timeOrigin + event.timeStamp),
        );
      };
      document.addEventListener(eventName, mark, true);
    },
    { eventName: action === "hover" ? "pointerover" : "click", row },
  );
  const cdp = await page.context().newCDPSession(page);
  const samples: { time: number; data: string }[] = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (metadata.timestamp)
      samples.push({ time: metadata.timestamp * 1000, data });
  });
  try {
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      maxWidth: 640,
      quality: 75,
    });
    await open?.();
    if (action === "hover") await target.hover({ force: Boolean(open) });
    else await target.dispatchEvent("click");
    await page.waitForTimeout(800);
    await cdp.send("Page.stopScreencast");
  } finally {
    await cdp.detach();
  }
  // Inspect the frames after capture so JPEG decoding cannot hold up the preview under test.
  const latency = await page.evaluate(
    async ({ samples, x, y, color }) => {
      const start = Number(
        document.documentElement.getAttribute("data-measure-pointer"),
      );
      const menuOpen = Number(document.documentElement.dataset.measureMenuOpen);
      if (!start || !menuOpen)
        throw new Error("The gesture or menu opening was not recorded.");
      const menuAgeMs = Math.round((start - menuOpen) * 10) / 10;
      const canvas = new OffscreenCanvas(1, 1);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const index = { red: 0, lime: 1, blue: 2 }[color];
      for (const { data, time } of samples) {
        if (time < start) continue;
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(
          new Blob([bytes], { type: "image/jpeg" }),
        );
        ctx.drawImage(
          image,
          Math.floor(x * image.width),
          Math.floor(y * image.height),
          1,
          1,
          0,
          0,
          1,
          1,
        );
        image.close();
        const pixel = ctx.getImageData(0, 0, 1, 1).data;
        if (
          pixel[index]! > 170 &&
          [...pixel.slice(0, 3)].every(
            (value, channel) => channel === index || value < 80,
          )
        )
          return {
            pictureMs: Math.round((time - start) * 10) / 10,
            menuAgeMs,
          };
      }
      return { pictureMs: null, menuAgeMs };
    },
    {
      samples,
      x: (stage.x + stage.width / 2) / viewport.width,
      y: (stage.y + stage.height / 2) / viewport.height,
      color,
    },
  );
  // Preserve a missed capture as a timing result, but still verify that the editor switched.
  if (latency.pictureMs === null)
    await expect
      .poll(() => stageColour(page, page.locator(".edit-stage")))
      .toBe(color);
  return latency;
}

const longProject = process.env.CUTROOM_VERSION_SCALE === "100";
const playbackModes = comparison
  ? (["record", "native", "gpu"] as const)
  : (["native"] as const);
for (const mode of playbackModes)
  test(`footage versions audition in place, keep linked sound in sync and undo exactly (${mode})`, async ({
    page,
    browser,
    baseURL,
    request,
  }, testInfo) => {
    test.setTimeout(longProject ? 240_000 : 120_000);
    const client = new Client({ name: "media-versions", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: new URL(baseURL!).origin } },
      }),
    );
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const result = async <T>(
      schema: z.ZodType<T>,
      name: string,
      args: Record<string, unknown>,
    ) => {
      const value = await call(name, args);
      expect(value.isError, JSON.stringify(value)).not.toBe(true);
      return z
        .object({ structuredContent: z.object({ result: schema }) })
        .parse(value).structuredContent.result;
    };
    let finishRecording: (() => Promise<void>) | undefined;
    try {
      const project = await result(ProjectSchema, "project_create", {
        name: "Media takes",
        duration: 12,
      });
      const projectId = project.id;
      for (const [index, take] of takes.entries()) {
        if (longProject && index === 3) continue;
        const duration = index === 3 ? 1 : 6;
        await run("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=${take.color}:s=1920x1080:r=30:d=${duration}`,
          ...(take.hz
            ? [
                "-f",
                "lavfi",
                "-i",
                `sine=frequency=${take.hz}:sample_rate=48000:duration=${duration}`,
                "-c:a",
                "aac",
              ]
            : []),
          "-c:v",
          "libx264",
          "-threads",
          "2",
          "-preset",
          "ultrafast",
          "-g",
          "15",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          join(project.path, take.src),
        ]);
      }
      const read = async () =>
        TimelineViewSchema.parse(
          await (
            await request.get(`/api/cutroom/projects/${projectId}/timeline`)
          ).json(),
        );
      const edit = async (commands: unknown[]) =>
        result(z.unknown(), "timeline_edit", {
          projectId,
          expectedRevision: (await read()).revision,
          commands,
        });
      const starter = (await read()).timeline.clips.map(({ id }) => id);
      const more = [];
      if (longProject) {
        for (let i = 1; i < 100; i++) {
          const src = `cut-${(i - 1) % 15}.mp4`;
          if (i <= 15)
            await link(join(project.path, "wide.mp4"), join(project.path, src));
          const clipId = `cut-${i}`;
          more.push({
            type: "insert",
            track: 3,
            at: 30 + i * 90,
            clip: { id: clipId, kind: "video", src, duration: 90, muted: true },
          });
          if (i > 9) continue;
          const versions = [{ name: "Cut", src }];
          for (let j = 1; j <= 3; j++) {
            const alternate = `alt-${i}-${j}.mp4`;
            await link(
              join(project.path, takes[j % 3]!.src),
              join(project.path, alternate),
            );
            versions.push({ name: `Take ${j + 1}`, src: alternate });
          }
          more.push({ type: "setVersions", clipId, versions });
        }
      }
      await edit([
        ...(starter.length ? [{ type: "remove", clipIds: starter }] : []),
        {
          type: "insert",
          track: 3,
          at: 30,
          linkedAudio: { id: "sound" },
          clip: {
            id: "interview",
            kind: "video",
            src: takes[0]!.src,
            duration: 90,
            mediaStart: 0,
          },
        },
        ...more,
      ]);
      const measure =
        longProject ||
        Boolean(comparison && mode !== "record") ||
        process.env.CUTROOM_VERSION_MEASURE === "1";
      const evidence = mode === "record" ? comparison : undefined;
      const gpu = mode === "gpu" || process.env.CUTROOM_VERSION_GPU === "1";
      await page.addInitScript(
        ({ gpu, measure }) => {
          if (window !== window.top) return;
          localStorage.setItem("cutroom.footagePipeline", String(gpu));
          if (!measure) return;
          document.addEventListener(
            "beforetoggle",
            (event) => {
              if (
                event instanceof ToggleEvent &&
                event.newState === "open" &&
                event.target instanceof Element &&
                event.target.matches(".versions-menu")
              )
                document.documentElement.dataset.measureMenuOpen = String(
                  performance.timeOrigin + event.timeStamp,
                );
            },
            true,
          );
          if (!gpu) return;
          const configured = new WeakSet<VideoDecoder>();
          let opened = 0;
          let closed = 0;
          const publish = () => {
            document.documentElement.dataset.measureDecoders = JSON.stringify({
              opened,
              closed,
              live: opened - closed,
            });
          };
          const configure = VideoDecoder.prototype.configure;
          VideoDecoder.prototype.configure = function (config) {
            configure.call(this, config);
            if (configured.has(this)) return;
            configured.add(this);
            opened++;
            publish();
          };
          const close = VideoDecoder.prototype.close;
          VideoDecoder.prototype.close = function () {
            close.call(this);
            if (!configured.delete(this)) return;
            closed++;
            publish();
          };
        },
        { gpu, measure },
      );
      await page.goto(`/#project/${projectId}`);
      const stage = page.locator(".edit-stage");
      const badge = page.locator('[data-clip-label="interview"] .tl-versions');
      await seekFrame(page, 50);
      await expect(badge).toHaveCount(0);
      if (evidence) {
        await page.screenshot({ path: join(evidence, "before.png") });
        finishRecording = await recordComparison(page, evidence);
      }
      const configured = await result(
        z.object({
          warnings: z.array(z.object({ warning: z.string() })).optional(),
        }),
        "clip_versions_set",
        {
          projectId,
          clipId: "interview",
          versions: [
            ...takes
              .slice(0, longProject ? 3 : takes.length)
              .map(({ name, src }, i) => ({
                name,
                src,
                sourceIn: i === 1 ? 70 : 0,
              })),
            ...(measure
              ? [{ name: "Closer", src: "interview.mp4", sourceIn: 24 }]
              : []),
          ],
        },
      );
      if (!longProject) {
        expect(configured.warnings?.[0]?.warning).toContain(
          "Short cue is 2:00 shorter",
        );
        const refused = await call("clip_version_show", {
          projectId,
          clipId: "interview",
          version: "Short cue",
        });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.content)).toContain("2:00 shorter");
      }
      const count = measure && !longProject ? "5" : "4";
      if (longProject) {
        const zoom = page.getByRole("button", { name: "Zoom in", exact: true });
        for (let i = 0; i < 6; i++) await zoom.click();
      }
      await expect(badge).toHaveText(count);
      const baseline = measure ? await browserMemory(browser) : 0;
      const decoderCounts = async () => {
        const counts = await page
          .locator("html")
          .getAttribute("data-measure-decoders");
        return counts === null
          ? null
          : DecoderCountsSchema.parse(JSON.parse(counts));
      };
      const decodersBefore = measure && gpu ? await decoderCounts() : null;
      const cold = measure
        ? await timePicture(page, "Wide", "blue", "hover", () => badge.click())
        : null;
      if (!measure) await badge.click();
      const menu = page.getByRole("menu", {
        name: "Versions of interview.mp4",
      });
      const second = menu.getByRole("menuitemradio", { name: /Take 2/ });
      const wide = menu.getByRole("menuitemradio", { name: /Wide/ });
      const preview = page.frameLocator("iframe[data-live]");
      await expect(second).toContainText("+2:10");
      if (!longProject)
        await expect(
          menu.getByRole("menuitemradio", { name: /Short cue/ }),
        ).toBeDisabled();
      await expect(preview.locator("video[data-cutroom-version]")).toHaveCount(
        measure ? 4 : 3,
      );
      await expect(preview.locator("audio[data-cutroom-version]")).toHaveCount(
        measure ? 3 : 2,
      );
      if (evidence)
        await page.screenshot({ path: join(evidence, "footage.png") });

      const picture = () => stageColour(page, stage);

      const iframe = await page
        .locator("iframe[data-live]")
        .getAttribute("src");
      if (measure) {
        if (gpu) await expect(stage).toHaveAttribute("data-pipeline", "on");
        await page.mouse.move(4, 1045);
        await expect.poll(picture).toBe("red");
        await page.waitForTimeout(300);
        const samples = [];
        for (let i = 0; i < 3; i++) {
          samples.push(await timePicture(page, "Take 2", "lime"));
          samples.push(await timePicture(page, "Wide", "blue"));
          samples.push(await timePicture(page, "Take 1", "red"));
        }
        const nonAdjacent = [];
        for (let i = 0; i < 3; i++) {
          nonAdjacent.push(await timePicture(page, "Wide", "blue"));
          nonAdjacent.push(await timePicture(page, "Take 2", "lime"));
          nonAdjacent.push(await timePicture(page, "Take 1", "red"));
        }
        await timePicture(page, "Take 2", "lime");
        await page.waitForTimeout(300);
        const open = await browserMemory(browser);
        const decodersOpen = gpu ? await decoderCounts() : null;
        await page.mouse.move(4, 1045);
        // Time the saved switch only after the preview has returned to the shown take.
        await expect.poll(picture).toBe("red");
        const switches = [
          await timePicture(page, "Take 2", "lime", "switch"),
          await timePicture(page, "Wide", "blue", "switch"),
          await timePicture(page, "Take 1", "red", "switch"),
        ];
        await second.hover();
        const routed = preview.locator('audio[data-cutroom-version="1"]');
        await expect
          .poll(() =>
            routed.evaluate((audio: HTMLAudioElement) => {
              const win = audio.ownerDocument.defaultView as Window & {
                __cutroomAuditionGains?: WeakMap<HTMLMediaElement, GainNode>;
              };
              const node = win.__cutroomAuditionGains?.get(audio);
              return Boolean(
                node &&
                node.context.state === "running" &&
                node.gain.value === 1 &&
                !audio.paused,
              );
            }),
          )
          .toBe(true);
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect(preview.locator("[data-cutroom-version]")).toHaveCount(0);
        await expect(stage).toHaveAttribute("data-handoff", "showing");
        await expect.poll(picture).toBe("red");
        await page.waitForTimeout(300);
        const decodersClosed = gpu ? await decoderCounts() : null;
        const reopenedDecoders = [];
        if (gpu) {
          for (let i = 0; i < 3; i++) {
            await badge.click();
            await expect(
              preview.locator("video[data-cutroom-version]"),
            ).toHaveCount(4);
            await expect(stage).toHaveAttribute("data-handoff", "showing");
            await wide.hover();
            await expect(wide).toHaveAttribute("data-hovered", "true");
            await expect.poll(picture).toBe("blue");
            const open = await decoderCounts();
            await page.keyboard.press("Escape");
            await expect(menu).toBeHidden();
            await expect(preview.locator("[data-cutroom-version]")).toHaveCount(
              0,
            );
            await expect(stage).toHaveAttribute("data-handoff", "showing");
            await expect.poll(picture).toBe("red");
            reopenedDecoders.push({ open, closed: await decoderCounts() });
          }
        }
        const stats = {
          mode: gpu ? "gpu" : "native",
          cuts: longProject ? 100 : 1,
          cold,
          samples,
          nonAdjacent,
          switches,
          decoders: {
            before: decodersBefore,
            open: decodersOpen,
            closed: decodersClosed,
            reopened: reopenedDecoders,
          },
          baselineMiB: baseline,
          openMiB: open,
          closedMiB: await browserMemory(browser),
        };
        console.log(JSON.stringify(stats));
        if (comparison)
          await writeFile(
            join(comparison, `${mode}.json`),
            JSON.stringify(stats),
          );
        return;
      }
      await second.hover();
      await expect.poll(picture).toBe("lime");
      await expect(
        preview.locator('audio[data-cutroom-version="1"][data-cutroom-shown]'),
      ).toHaveCount(1);
      const saved = join(project.path, "index.html");
      const beforeSwitch = await readFile(saved, "utf8");
      await second.click();
      const pair = async () =>
        (await read()).timeline.clips.filter(
          ({ id }) => id === "interview" || id === "sound",
        );
      await expect
        .poll(async () => (await pair()).map(({ src }) => src))
        .toEqual(["cam-b.mp4", "cam-b.mp4"]);
      expect((await pair()).map(({ mediaStart }) => mediaStart)).toEqual([
        2.333333, 2.333333,
      ]);
      const afterSwitch = await readFile(saved, "utf8");
      await expect(stage).toHaveAttribute("data-handoff", "showing");
      expect(await page.locator("iframe[data-live]").getAttribute("src")).toBe(
        iframe,
      );

      const resolved = await result(
        z.object({ timeline: z.string(), summary: z.string() }),
        "export_start",
        {
          projectId,
          format: "resolve",
        },
      );
      const xml = await readFile(resolved.timeline, "utf8");
      expect(xml).toContain("cam-b.mp4");
      expect(xml).not.toMatch(/src="[^"]*interview\.mp4"/);
      expect(await readFile(resolved.summary, "utf8")).toContain(
        "Other versions: Take 1, Wide, Short cue",
      );

      await wide.hover();
      await expect.poll(picture).toBe("blue");
      await wide.click();
      await expect
        .poll(
          async () => (await pair()).find(({ id }) => id === "sound")?.hasAudio,
        )
        .toBe(false);
      await expect(
        menu.getByRole("menuitem", { name: "Keep Wide" }),
      ).toBeVisible();
      await menu.getByRole("menuitem", { name: "Keep Wide" }).click();
      await expect(badge).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (await pair()).find(({ id }) => id === "interview")?.versions,
        )
        .toBeUndefined();
      await result(z.unknown(), "history_undo", { projectId });
      await expect(badge).toHaveText(count);
      await finishRecording?.();
      finishRecording = undefined;
      await result(z.unknown(), "history_undo", { projectId });
      expect(await readFile(saved, "utf8")).toBe(afterSwitch);
      await result(z.unknown(), "history_undo", { projectId });
      expect(await readFile(saved, "utf8")).toBe(beforeSwitch);
      await result(z.unknown(), "history_redo", { projectId });
      expect(await readFile(saved, "utf8")).toBe(afterSwitch);
      const { jobId } = await result(
        z.object({ jobId: z.string() }),
        "export_start",
        {
          projectId,
          range: { start: 48, end: 54 },
          gpu: false,
        },
      );
      const status = () => result(ExportJobSchema, "export_status", { jobId });
      await expect
        .poll(async () => (await status()).status, { timeout: 45_000 })
        .toBe("complete");
      const { stdout } = await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          (await status()).outputPath,
          "-vf",
          "crop=40:40:940:520,scale=1:1:flags=area,format=rgb24",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-",
        ],
        { encoding: "buffer" },
      );
      expect(stdout[1]).toBeGreaterThan(170);
      const sound = await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          (await status()).outputPath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "48000",
          "-f",
          "f32le",
          "-",
        ],
        { encoding: "buffer" },
      );
      let crossings = 0;
      for (let at = 4; at < sound.stdout.length; at += 4)
        if (
          sound.stdout.readFloatLE(at - 4) < 0 &&
          sound.stdout.readFloatLE(at) >= 0
        )
          crossings++;
      expect(crossings / (sound.stdout.length / 4 / 48000)).toBeGreaterThan(
        820,
      );
      if (evidence)
        await testInfo.attach("comparison", {
          path: join(evidence, "footage.png"),
        });
    } finally {
      await finishRecording?.().catch(() => {});
      await client.close();
    }
  });

test("a GPU hover draws the take's source frame before the original index arrives", async ({
  page,
  request,
}, testInfo) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Cold take", width: 640, height: 360, duration: 4 },
      })
    ).json(),
  );
  const bits = Array.from(
    { length: 8 },
    (_, bit) =>
      `drawbox=x=${bit * 80}:y=90:w=80:h=180:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
  );
  for (const [file, source, rate] of [
    ["first.mp4", "red", 30],
    ["alternate.mp4", "black", 24],
  ] as const) {
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=${source}:s=640x360:r=${rate}:d=4`,
      ...(file === "alternate.mp4" ? ["-vf", bits.join(",")] : []),
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-preset",
      "ultrafast",
      "-movflags",
      "+faststart",
      join(project.path, file),
    ]);
  }
  const versions = JSON.stringify([
    { name: "First", src: "first.mp4", sourceIn: 0 },
    { name: "Alternate", src: "alternate.mp4", sourceIn: 24, sourceFps: 24 },
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="4" data-fps="30"><video id="shot" src="first.mp4" muted data-start="1" data-duration="2" data-track-index="0" data-cutroom-versions='${versions}' data-cutroom-version-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video></main></body></html>`,
  );
  // Have the existing proxy on disk while holding the original's browser range requests.
  await expect
    .poll(async () => {
      const response = await request.get(
        `/api/cutroom/projects/${project.id}/media/scrub?path=alternate.mp4`,
      );
      return response.status();
    })
    .toBe(200);
  const original = Promise.withResolvers<void>();
  let originalRequested = false;
  await page.route("**/media/source?path=alternate.mp4", async (route) => {
    originalRequested = true;
    await original.promise;
    await route.continue();
  });
  try {
    await page.addInitScript(() => {
      if (window === window.top)
        localStorage.setItem("cutroom.footagePipeline", "true");
    });
    await page.goto(`/#project/${project.id}`);
    await seekFrame(page, 50);
    const stage = page.locator(".edit-stage");
    const canvas = stage.locator(".edit-pipeline");
    await expect(stage).toHaveAttribute("data-pipeline", "on");
    await page.locator(".tl-versions").click();
    const rows = page.getByRole("menuitemradio");
    await expect(rows).toHaveText([/First/, /Alternate/]);
    await rows.nth(1).hover();
    await expect.poll(() => originalRequested).toBe(true);
    await expect(canvas).toHaveAttribute("data-standin", "true");
    await expect(canvas).toHaveAttribute("data-frame", "30");
    const png = await canvas.screenshot({
      path: testInfo.outputPath("source-frame-24.png"),
    });
    const sourceFrame = await page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const ctx = new OffscreenCanvas(8, 1).getContext("2d")!;
      for (let bit = 0; bit < 8; bit++)
        ctx.drawImage(
          image,
          Math.floor(((bit + 0.5) * image.width) / 8),
          Math.floor(image.height / 2),
          1,
          1,
          bit,
          0,
          1,
          1,
        );
      const pixels = ctx.getImageData(0, 0, 8, 1).data;
      let frame = 0;
      for (let bit = 0; bit < 8; bit++)
        if (pixels[bit * 4]! > 128) frame |= 1 << bit;
      return frame;
    }, png.toString("base64"));
    expect(sourceFrame).toBe(24);

    // The next row must draw even while the previous row's original is still in flight.
    await rows.nth(0).hover();
    await expect(canvas).toHaveAttribute("data-standin", "false");
    await expect.poll(() => stageColour(page, stage)).toBe("red");
    await rows.nth(1).hover();
    await expect(canvas).toHaveAttribute("data-standin", "true");
    original.resolve();
    await expect(canvas).toHaveAttribute("data-standin", "false");
    await page.keyboard.press("Escape");
    await expect(canvas).toHaveAttribute("data-frame", "50");
    await expect.poll(() => stageColour(page, stage)).toBe("red");
  } finally {
    original.resolve();
  }
});

test("a 4K alternate stays on native playback while a smaller take uses the GPU", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Mixed-size versions" },
      })
    ).json(),
  );
  for (const [file, size, colour] of [
    ["take.mp4", "640x360", "red"],
    ["wide.mp4", "3840x2160", "lime"],
  ] as const) {
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=${colour}:s=${size}:r=30:d=3`,
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-preset",
      "ultrafast",
      "-g",
      "15",
      "-movflags",
      "+faststart",
      join(project.path, file),
    ]);
  }
  const versions = JSON.stringify([
    { name: "Take", src: "take.mp4", sourceIn: 0 },
    { name: "Wide 4K", src: "wide.mp4", sourceIn: 0 },
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="2" data-fps="30"><video id="shot" src="take.mp4" muted data-start="0" data-duration="2" data-track-index="0" data-cutroom-versions='${versions}' data-cutroom-version-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video></main></body></html>`,
  );
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("cutroom.footagePipeline", "true");
    const configure = VideoDecoder.prototype.configure;
    VideoDecoder.prototype.configure = function (config) {
      if (config.codedHeight === 2160)
        document.documentElement.setAttribute("data-probed-4k-decoder", "");
      return configure.call(this, config);
    };
  });
  await page.goto(`/#project/${project.id}`);
  await seekFrame(page, 15);
  const stage = page.locator(".edit-stage");
  await expect(stage).toHaveAttribute("data-pipeline", "on");
  await page.locator(".tl-versions").click();
  const menu = page.getByRole("menu", { name: /Versions of/ });
  const wide = menu.getByRole("menuitemradio", { name: /Wide 4K/ });
  await wide.hover();
  await expect(stage).toHaveAttribute("data-pipeline", "off");
  await expect.poll(() => stageColour(page, stage)).toBe("lime");
  await menu.getByRole("menuitemradio", { name: /^Take/ }).hover();
  await expect(stage).toHaveAttribute("data-pipeline", "on");
  await expect.poll(() => stageColour(page, stage)).toBe("red");
  await expect(page.locator("html[data-probed-4k-decoder]")).toHaveCount(0);
});

test("audio versions can be added in the clip menu, Media and Source", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Music options", duration: 12 },
      })
    ).json(),
  );
  const base = `/api/cutroom/projects/${project.id}`;
  for (const [name, hz, duration] of [
    ["music", 440, 9],
    ["cue-b", 550, 9],
    ["cue-c", 660, 9],
    ["sting", 880, 1],
  ] as const)
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${hz}:duration=${duration}`,
      join(project.path, `${name}.wav`),
    ]);
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(base + "/timeline")).json(),
    );
  const edit = async (commands: unknown[]) => {
    const response = await request.post(base + "/commands", {
      data: { expectedRevision: (await read()).revision, commands },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const music = async () =>
    (await read()).timeline.clips.find(({ id }) => id === "music");
  await edit([
    {
      type: "insert",
      track: 3,
      at: 0,
      clip: { kind: "audio", id: "music", src: "music.wav", duration: 120 },
    },
  ]);
  await page.goto(`/#project/${project.id}`);
  const clip = page.locator('[data-clip="music"]');
  const badge = page.locator('[data-clip-label="music"] .tl-versions');

  await clip.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Add version", exact: true })
    .click();
  await expect(badge).toHaveText("2");
  await expect.poll(async () => (await music())?.versionIndex).toBe(1);

  const marks = await (
    await request.get(base + "/source-marks?path=cue-b.wav")
  ).json();
  const marked = await request.put(base + "/source-marks?path=cue-b.wav", {
    data: { ...marks, in: 0.4 },
  });
  expect(marked.ok()).toBe(true);
  const media = (name: string) =>
    page.locator(".media-row").filter({ hasText: name });
  await media("cue-b.wav").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Add as version of music.wav" })
    .click();
  await expect.poll(async () => (await music())?.mediaStart).toBe(0.4);

  await media("cue-c.wav").dblclick();
  const source = page.getByRole("group", { name: "Source", exact: true });
  await expect(
    source.getByRole("button", { name: "Add version" }),
  ).toBeEnabled();
  await source.getByRole("button", { name: "Add version" }).click();
  await expect.poll(async () => (await music())?.src).toBe("cue-c.wav");
  await source.getByRole("button", { name: "Close source" }).click();

  await media("sting.wav").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Add as version of music.wav" })
    .click();
  await expect(badge).toHaveText("5");
  await expect
    .poll(async () => (await music())?.versions?.at(-1)?.fits)
    .toBe(false);

  await badge.click();
  const menu = page.getByRole("menu", { name: "Versions of music.wav" });
  const sting = menu.getByRole("menuitemradio", { name: /sting/i });
  await expect(sting).toHaveAttribute(
    "title",
    "sting is 3:00 shorter than the clip.",
  );
  await expect(sting).toBeDisabled();
  const driving = menu.getByRole("menuitemradio", { name: /cue-b/ });
  await expect(driving).toContainText("+0:12");
  await driving.getByText("cue-b", { exact: true }).dblclick();
  const field = menu.getByRole("textbox", { name: "Version name" });
  await field.fill("Driving");
  await field.press("Enter");
  await expect
    .poll(async () => (await music())?.versions?.[2]?.name)
    .toBe("Driving");
  if (comparison)
    await page.screenshot({ path: join(comparison, "audio.png") });
});
