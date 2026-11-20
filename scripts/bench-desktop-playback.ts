// Headed Linux playback measured at the Wayland compositor, including XWayland clients.
// See docs/performance.md for the prerequisites and the validation run.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium, type CDPSession, type Page } from "@playwright/test";
import { z } from "zod";
import {
  clipSeconds,
  desktop4kSourceSeconds,
  fps as defaultFps,
  mediaStart,
} from "./bench-vs-studio-project.ts";
import {
  formatTimecode,
  parseTimecode,
} from "../src/shared/timeline/timecode.ts";

const { values: options } = parseArgs({
  options: {
    dir: { type: "string" },
    host: { type: "string" },
    setting: { type: "string" },
    size: { type: "string", default: "1080p" },
    fps: { type: "string", default: String(defaultFps) },
    "editing-proxy": { type: "string" },
    "warm-media": { type: "boolean" },
    "expect-pipeline": { type: "string" },
    port: { type: "string", default: "4939" },
    debug: { type: "string", default: "4940" },
    out: { type: "string" },
    validate: { type: "boolean" },
    "desktop-main": { type: "string", default: "dist-desktop/main.cjs" },
    electron: {
      type: "string",
      default: "node_modules/electron/dist/electron",
    },
    chromium: { type: "string", default: "/usr/lib/chromium/chromium" },
  },
});
const host = z
  .enum(["wayland", "x11", "chromium", "chromium-wayland"])
  .parse(options.host);
const embedded = host === "wayland" || host === "x11";
const xwayland = host === "x11" || host === "chromium";
const size = z.enum(["1080p", "4k"]).parse(options.size);
const setting = z.enum(["on", "off"]).parse(options.setting);
const fps = Number(z.enum(["30", "60"]).parse(options.fps));
const editingProxy = options["editing-proxy"];
const warmMedia = options["warm-media"] === true;
const expectedPipeline =
  setting === "on"
    ? z
        .enum(["on", "off"])
        .parse(options["expect-pipeline"] ?? (size === "1080p" ? "on" : "off"))
    : null;
if (setting === "off" && options["expect-pipeline"])
  throw new Error("--expect-pipeline applies when --setting on.");
const directory = resolve(z.string().min(1).parse(options.dir));
const work = join(directory, `run-${process.pid}`);
const executable = resolve(options[embedded ? "electron" : "chromium"]!);
const privatePort = z.coerce.number().int().min(4800).max(4999);
const port = privatePort.parse(options.port);
const debugPort = privatePort.parse(options.debug);
if (port === debugPort)
  throw new Error("Use different server and debugging ports.");
const origin = `http://127.0.0.1:${port}`;
const debuggerUrl = `http://127.0.0.1:${debugPort}`;
const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();

type Box = { x: number; y: number; width: number; height: number };
type Picture = { time: number; number: number | null; row: number };
const windowSchema = z.object({
  address: z.string(),
  pid: z.number(),
  at: z.tuple([z.number(), z.number()]),
  size: z.tuple([z.number(), z.number()]),
  monitor: z.number(),
  xwayland: z.boolean(),
});
const monitorsSchema = z.array(
  z.object({
    id: z.number(),
    name: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    refreshRate: z.number(),
    scale: z.number(),
    transform: z.number(),
  }),
);
const calibrationBox = { x: 80, y: 80, width: 512, height: 12 };
const running = new Set<ChildProcess>();

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeout = 15_000,
) {
  const end = Date.now() + timeout;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await sleep(15);
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${what}.`);
}

async function checkPort(port: number) {
  const socket = createServer().listen(port, "127.0.0.1");
  await once(socket, "listening");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
}

function start(command: string, args: string[], env = process.env) {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  running.add(child);
  child.once("exit", () => running.delete(child));
  child.stderr.on("data", (data) => {
    if (process.env.CUTROOM_BENCH_DEBUG) process.stderr.write(data);
  });
  return child;
}

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, "exit");
  process.kill(-child.pid, "SIGTERM");
  await Promise.race([exited, sleep(3000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null)
    process.kill(-child.pid, "SIGKILL");
}

function hyprland(command: string) {
  return JSON.parse(
    execFileSync("hyprctl", ["-j", command], { encoding: "utf8" }),
  ) as unknown;
}

function screen(pid: number) {
  const window = windowSchema.parse(hyprland("activewindow"));
  if (window.pid !== pid || window.xwayland !== xwayland)
    throw new Error(
      `The benchmark window must be in front on ${host}: ${JSON.stringify(window)}.`,
    );
  const monitor = monitorsSchema
    .parse(hyprland("monitors"))
    .find((m) => m.id === window.monitor);
  if (!monitor || monitor.scale !== 1 || monitor.transform !== 0)
    throw new Error("Use an unrotated, scale-1 display.");
  const x = window.at[0] - monitor.x;
  const y = window.at[1] - monitor.y;
  if (
    x < 0 ||
    y < 0 ||
    x + window.size[0] > monitor.width ||
    y + window.size[1] > monitor.height
  )
    throw new Error(
      "The benchmark window must fit entirely on a single display.",
    );
  return { window, monitor, x, y };
}

function record(display: ReturnType<typeof screen>, box: Box) {
  const { monitor, x, y } = display;
  const { window } = display;
  if (
    box.x < 0 ||
    box.y < 0 ||
    box.x + box.width > window.size[0] ||
    box.y + box.height > window.size[1]
  )
    throw new Error("The capture strip must fit within the benchmark window.");
  const verify = () => {
    const current = screen(window.pid).window;
    if (JSON.stringify(current) !== JSON.stringify(window))
      throw new Error("The benchmark window moved during capture.");
  };
  verify();
  const child = spawn(
    join(directory, "screen"),
    [
      monitor.name,
      ...[x + box.x, y + box.y, box.width, box.height].map((n) =>
        String(Math.round(n)),
      ),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const samples: Picture[] = [];
  const controller = new AbortController();
  const socket = createConnection(
    join(
      process.env.XDG_RUNTIME_DIR!,
      "hypr",
      process.env.HYPRLAND_INSTANCE_SIGNATURE!,
      ".socket2.sock",
    ),
  );
  const focus = createInterface({ input: socket });
  focus.on("line", (line) => {
    if (
      line.startsWith("activewindowv2>>") &&
      `0x${line.slice(16)}` !== window.address
    ) {
      child.kill("SIGTERM");
      controller.abort(
        new Error("The benchmark window lost focus during capture."),
      );
    }
  });
  socket.on("error", (error) => controller.abort(error));
  let error = "";
  let closed = false;
  child.stderr.on("data", (data) => {
    error += data;
  });
  child.on("error", (reason) => {
    error += reason.message;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const [time, number, row] = line.split(" ").map(Number);
    samples.push({ time, number: number < 0 ? null : number, row });
  });
  return {
    samples,
    verify() {
      controller.signal.throwIfAborted();
      verify();
    },
    wait: (ms: number) => sleep(ms, undefined, { signal: controller.signal }),
    picture: (
      matches: (number: number) => boolean,
      after = 0,
      timeout = 15_000,
    ) =>
      until(
        () => {
          controller.signal.throwIfAborted();
          if (error || child.exitCode !== null)
            throw new Error(`Screen capture stopped. ${error}`);
          return samples.find(
            (p) => p.time >= after && p.number !== null && matches(p.number),
          );
        },
        "the expected screen picture",
        timeout,
      ),
    close: () => {
      if (closed) return;
      closed = true;
      child.kill("SIGTERM");
      lines.close();
      socket.destroy();
      focus.close();
    },
  };
}

function screenBox(picture: Box, inset: number): Box {
  return {
    x: picture.x,
    y: picture.y + inset + picture.height / 60,
    width: picture.width,
    height: Math.max(3, Math.floor(picture.height / 60)),
  };
}

function stats(
  samples: Picture[],
  start: number,
  end: number,
  refresh: number,
  rate = fps,
) {
  const window = samples.filter((p) => p.time >= start && p.time < end);
  const shown = window.filter((p) => p.number !== null);
  const changes = shown.filter(
    (p, i) => i === 0 || p.number !== shown[i - 1].number,
  );
  const gaps = changes.slice(1).map((p, i) => p.time - changes[i].time);
  const captureGaps = window.slice(1).map((p, i) => p.time - window[i].time);
  const tick = 1000 / refresh;
  const threshold = (Math.ceil(refresh / rate - 0.01) + 0.5) * tick;
  const shortestPicture = Math.max(1, Math.floor(refresh / rate));
  const picturesAtRisk = captureGaps.reduce((sum, gap) => {
    const missedRefreshes = Math.max(0, Math.round(gap / tick) - 1);
    return sum + Math.floor(missedRefreshes / shortestPicture);
  }, 0);
  const round = (value: number) => Number(value.toFixed(2));
  const duration = (end - start) / 1000;
  return {
    pictures: changes.length,
    picturesPerSecond: round(changes.length / duration),
    longHolds: gaps.filter((gap) => gap > threshold).length,
    maxHoldMs: round(Math.max(0, ...gaps)),
    trailingHoldMs: round(end - (changes.at(-1)?.time ?? start)),
    captureHz: round(window.length / duration),
    captureMaxGapMs: round(Math.max(0, ...captureGaps)),
    capturePicturesAtRisk: picturesAtRisk,
    unreadable: window.length - shown.length,
  };
}

async function calibration(
  page: Page,
  cdp: CDPSession,
  display: ReturnType<typeof screen>,
) {
  await page.evaluate(({ x, y, width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.id = "bench-frame-strip";
    canvas.width = width;
    canvas.height = height;
    canvas.style.cssText = `position:fixed;z-index:2147483647;left:${x}px;top:${y}px`;
    document.body.append(canvas);
    const paint = (number: number) => {
      const ctx = canvas.getContext("2d")!;
      for (let bit = 0; bit < 16; bit++) {
        ctx.fillStyle =
          bit === 15 ? "red" : number & (1 << bit) ? "white" : "black";
        ctx.fillRect((bit * width) / 16, 0, width / 16, height);
      }
    };
    paint(31645);
  }, calibrationBox);
  const locator = record(display, { ...calibrationBox, y: 0, height: 170 });
  let inset;
  try {
    inset = (await locator.picture((n) => n === 31645)).row - calibrationBox.y;
    locator.verify();
  } finally {
    locator.close();
  }
  if (inset < 0 || inset > 90)
    throw new Error(`Unexpected window inset: ${inset}.`);
  if (options.validate) {
    const refresh = display.monitor.refreshRate;
    // At 60 Hz a 60 fps browser animation can skip a frame even when screencopy saw every
    // refresh. Use a known 50 fps pattern there to validate capture at the display cadence.
    const validationRate = fps === 60 && refresh < fps * 1.25 ? 50 : fps;
    const cast: { time: number; data: string; width: number }[] = [];
    if (validationRate === 30)
      cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
        void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
        if (metadata.timestamp !== undefined)
          cast.push({
            time: metadata.timestamp * 1000,
            width: metadata.deviceWidth,
            data,
          });
      });
    const capture = record(display, {
      ...calibrationBox,
      y: calibrationBox.y + inset + 6,
      height: 1,
    });
    try {
      if (validationRate === 30)
        await cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: 80,
          everyNthFrame: 1,
          maxWidth: 960,
          maxHeight: 540,
        });
      const start = await page.evaluate(async (fps) => {
        const canvas =
          document.querySelector<HTMLCanvasElement>("#bench-frame-strip")!;
        const ctx = canvas.getContext("2d")!;
        const start = performance.now() + 300;
        return new Promise<number>((resolve) => {
          function draw(now: number) {
            if (now >= start + 6200) {
              resolve(performance.timeOrigin + start);
              return;
            }
            if (now >= start) {
              const frame = Math.floor(((now - start) * fps) / 1000);
              const slot = frame % fps;
              const number = frame - (slot >= 11 && slot <= 15 ? slot - 10 : 0);
              for (let bit = 0; bit < 15; bit++) {
                ctx.fillStyle = number & (1 << bit) ? "white" : "black";
                ctx.fillRect(
                  (bit * canvas.width) / 16,
                  0,
                  canvas.width / 16,
                  canvas.height,
                );
              }
            }
            requestAnimationFrame(draw);
          }
          requestAnimationFrame(draw);
        });
      }, validationRate);
      if (validationRate === 30) await cdp.send("Page.stopScreencast");
      const pictures = await page.evaluate(
        async ({ cast, box }) => {
          const canvas = new OffscreenCanvas(16, 1);
          const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
          return await Promise.all(
            cast.map(async ({ data, width, time }) => {
              const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
              const image = await createImageBitmap(new Blob([bytes]));
              const scale = image.width / width;
              let number = 0;
              for (let bit = 0; bit < 16; bit++) {
                const x = Math.round(
                  (box.x + (box.width * (bit + 0.5)) / 16) * scale,
                );
                const y = Math.round((box.y + box.height / 2) * scale);
                ctx.drawImage(image, x, y, 1, 1, bit, 0, 1, 1);
              }
              image.close();
              const px = ctx.getImageData(0, 0, 16, 1).data;
              if (px[60] < 150 || px[61] > 110 || px[62] > 110)
                return { time, number: null, row: 0 };
              for (let bit = 0; bit < 15; bit++)
                if (px[bit * 4] > 190) number |= 1 << bit;
              return { time, number, row: 0 };
            }),
          );
        },
        {
          cast: cast.filter((p) => p.time >= start && p.time < start + 6000),
          box: calibrationBox,
        },
      );
      capture.verify();
      const screenResult = stats(
        capture.samples,
        start,
        start + 6000,
        refresh,
        validationRate,
      );
      const castResult =
        validationRate === 30
          ? stats(pictures, start, start + 6000, refresh, validationRate)
          : undefined;
      const expectedPictures = (validationRate - 5) * 6;
      console.log(
        JSON.stringify({
          monitor: display.monitor.name,
          refresh,
          validationRate,
          expectedPictures,
          expectedHolds: 6,
          screen: screenResult,
          screencast: castResult,
        }),
      );
      // A capture may straddle the first or last sample, one display tick either way.
      if (
        Math.abs(screenResult.pictures - expectedPictures) > 1 ||
        screenResult.longHolds !== 6 ||
        (fps === 60 && screenResult.capturePicturesAtRisk !== 0) ||
        (castResult &&
          (Math.abs(screenResult.pictures - castResult.pictures) > 1 ||
            screenResult.longHolds !== castResult.longHolds))
      )
        throw new Error(
          "The compositor capture did not match the known pattern or its screencast reference.",
        );
    } finally {
      capture.close();
    }
  }
  await page
    .locator("#bench-frame-strip")
    .evaluate((canvas) => canvas.remove());
  return inset;
}

async function browserMemory(pid: number, exclude: number | undefined) {
  const pids = new Map<number, number>();
  await Promise.all(
    (await readdir("/proc"))
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(
          () => "",
        );
        if (stat)
          pids.set(
            Number(entry),
            Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]),
          );
      }),
  );
  const tree = new Set([pid]);
  for (const process of tree)
    for (const [child, parent] of pids)
      if (parent === process && child !== exclude) tree.add(child);
  const pss = await Promise.all(
    [...tree].map(async (child) =>
      Number(
        /^Pss:\s+(\d+)/m.exec(
          await readFile(`/proc/${child}/smaps_rollup`, "utf8").catch(() => ""),
        )?.[1] ?? 0,
      ),
    ),
  );
  if (!pss[0]) throw new Error("Cannot read the browser's memory.");
  return Math.round(pss.reduce((sum, kb) => sum + kb, 0) / 1024);
}

async function session() {
  const available = Number(
    /^MemAvailable:\s+(\d+)/m.exec(
      await readFile("/proc/meminfo", "utf8"),
    )?.[1],
  );
  if (!(available >= 4 * 1024 * 1024))
    throw new Error(
      "At least 4 GiB must be available before launching the benchmark.",
    );
  await Promise.all([checkPort(port), checkPort(debugPort)]);
  const project = join(work, "bench");
  if (!options.validate)
    await cp(join(directory, `master-${size}`), project, { recursive: true });
  const env = {
    ...process.env,
    CUTROOM_PORT: String(port),
    CUTROOM_DATA_DIR: join(work, "data"),
    CUTROOM_PROJECTS_DIR: join(work, "projects"),
    CUTROOM_ROOT: resolve("."),
    CUTROOM_BUN_PATH: bun,
    CUTROOM_MUTE_AUDIO: "1",
    ELECTRON_RUN_AS_NODE: undefined,
    HYPERFRAMES_NO_TELEMETRY: "1",
  };
  let server =
    !embedded || ((editingProxy || warmMedia) && !options.validate)
      ? start(bun, ["src/server/index.ts"], env)
      : undefined;
  let app: ChildProcess | undefined;
  try {
    const debug = `--remote-debugging-port=${debugPort}`;
    const desktopMain = join(work, "benchmark.cjs");
    if (embedded) {
      const main = resolve(options["desktop-main"]!);
      await Promise.all([
        cp(main, join(work, "main.cjs")),
        cp(join(dirname(main), "preload.cjs"), join(work, "preload.cjs")),
        writeFile(
          desktopMain,
          `
const { app } = require("electron");
app.once("browser-window-created", (_event, window) => window.setFullScreen(true));
require("./main.cjs");
`,
        ),
      ]);
    }
    if (server)
      await until(
        () =>
          fetch(`${origin}/health`).then(
            (r) => r.ok || undefined,
            () => undefined,
          ),
        "the server",
      );
    // Warm the proxy before opening the foreground window, so the timed open starts with it ready.
    const prepared =
      (editingProxy || warmMedia) && !options.validate
        ? await prepareProject(project)
        : null;
    if (embedded && server) {
      await stop(server);
      server = undefined;
      await checkPort(port);
    }
    app = !embedded
      ? start(executable, [
          debug,
          "--mute-audio",
          "--no-first-run",
          "--disable-session-crashed-bubble",
          `--ozone-platform=${xwayland ? "x11" : "wayland"}`,
          "--start-fullscreen",
          "--window-size=1640,1040",
          `--user-data-dir=${join(work, "chrome")}`,
          `--app=${origin}/`,
        ])
      : start(
          executable,
          [
            desktopMain,
            debug,
            ...(host === "x11" ? ["--ozone-platform=x11"] : []),
          ],
          env,
        );
    const pid = app.pid;
    if (!pid) throw new Error("The benchmark browser did not start.");
    await until(
      () =>
        fetch(`${debuggerUrl}/json/version`).then(
          (r) => r.ok || undefined,
          () => undefined,
        ),
      "browser debugging",
    );
    const browser = await chromium.connectOverCDP(debuggerUrl);
    let page: Page | undefined;
    try {
      page = await until(
        () =>
          browser
            .contexts()[0]
            ?.pages()
            .find((p) => p.url().startsWith(origin)),
        "Cutroom",
      );
      await page.waitForLoadState();
      await sleep(500);
      const display = screen(pid);
      if (display.monitor.refreshRate + 0.5 < fps)
        throw new Error(
          "The display refresh rate is lower than the source frame rate.",
        );
      if (
        display.window.size[0] !== display.monitor.width ||
        display.window.size[1] !== display.monitor.height
      )
        throw new Error(
          `The benchmark window must fill the display: ${JSON.stringify(display)}`,
        );
      if (process.env.CUTROOM_BENCH_DEBUG) {
        const diagnostics = await browser.newBrowserCDPSession();
        const { gpu } = await diagnostics.send("SystemInfo.getInfo");
        console.error({
          display,
          renderer: gpu.auxAttributes?.glRenderer,
          videoDecode: gpu.featureStatus?.video_decode,
        });
        await diagnostics.detach();
      }
      const cdp = await page.context().newCDPSession(page);
      const inset = await calibration(page, cdp, display);
      if (options.validate) return;
      const result = await benchmark(
        page,
        display,
        inset,
        pid,
        prepared ?? (await prepareProject(project)),
      );
      const output = {
        host,
        size,
        setting,
        browser: browser.version(),
        monitor: display.monitor.name,
        window: display.window.size,
        refresh: display.monitor.refreshRate,
        ...result,
      };
      if (options.out)
        await writeFile(options.out, JSON.stringify(output, null, 2) + "\n");
      console.log(JSON.stringify(output));
    } finally {
      if (page) {
        await page.close().catch(() => {});
        if (embedded && app.exitCode === null && app.signalCode === null)
          await Promise.race([
            once(app, "exit"),
            sleep(2000, undefined, { ref: false }),
          ]);
      }
      await browser.close();
    }
  } finally {
    if (app) await stop(app);
    if (server) await stop(server);
  }
}

async function prepareProject(project: string) {
  const importResult = await fetch(`${origin}/api/cutroom/projects/import`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ name: "Playback benchmark", path: project }),
  });
  if (!importResult.ok) throw new Error(await importResult.text());
  const { id } = z.object({ id: z.string() }).parse(await importResult.json());
  const mediaPath = encodeURIComponent(editingProxy ?? "footage.mp4");
  const waitForMedia = async (kind: "proxy" | "filmstrip" | "scrub") => {
    const url = `${origin}/api/cutroom/projects/${id}/media/${kind}?path=${mediaPath}`;
    await until(
      async () => {
        const response = await fetch(url, {
          headers: { origin, range: "bytes=0-0" },
        });
        await response.body?.cancel();
        if (response.ok && response.status !== 202) return true;
        if (response.status !== 202)
          throw new Error(`${kind} returned ${response.status}.`);
        await sleep(500);
      },
      `the finished ${kind}`,
      120_000,
    );
    return url;
  };
  const proxyStart = Date.now();
  const proxy = editingProxy ? await waitForMedia("proxy") : undefined;
  const proxyWaitMs = proxy ? Date.now() - proxyStart : undefined;
  const warmStart = Date.now();
  if (warmMedia) {
    await waitForMedia("filmstrip");
    await waitForMedia("scrub");
  }
  return {
    id,
    proxy,
    proxyWaitMs,
    warmMediaMs: warmMedia ? Date.now() - warmStart : undefined,
  };
}

async function benchmark(
  page: Page,
  display: ReturnType<typeof screen>,
  inset: number,
  pid: number,
  {
    id,
    proxy,
    proxyWaitMs,
    warmMediaMs,
  }: Awaited<ReturnType<typeof prepareProject>>,
) {
  await page.evaluate(
    (on) => localStorage.setItem("cutroom.footagePipeline", String(on)),
    setting === "on",
  );
  let proxyRequests = 0;
  if (proxy)
    page.on("request", (request) => {
      if (request.url() === proxy && request.frame() === page.mainFrame())
        proxyRequests++;
    });
  const stage = page.locator(".edit-stage");
  const picture = page.locator(".edit-picture");
  const open = Date.now();
  await page.goto(
    `${origin}/?desktop-bench#project/${encodeURIComponent(id)}`,
    { waitUntil: "commit" },
  );
  const firstBox = await until(async () => {
    const box = await picture.boundingBox({ timeout: 3000 }).catch(() => null);
    return box && box.width > 100 ? box : undefined;
  }, "the viewer's bounds");
  let area = screenBox(firstBox, inset);
  let capture = record(display, area);
  const settleCaptureArea = async () => {
    const box = await picture.boundingBox();
    if (!box) throw new Error("The viewer is off-screen.");
    const next = screenBox(box, inset);
    if (JSON.stringify(next) === JSON.stringify(area)) return;
    capture.verify();
    capture.close();
    capture = record(display, next);
    area = next;
  };
  try {
    const first = await capture.picture((n) => n === 0, open);
    const sawBlank = capture.samples.some(
      (p) => p.time < first.time && p.number === null,
    );
    const observedOpenMs = Math.round(first.time - open);
    await stage
      .locator(".edit-frame[data-live]")
      .waitFor({ state: "attached" });
    await until(
      async () =>
        (await stage.getAttribute("data-pipeline")) === expectedPipeline
          ? true
          : undefined,
      "the expected footage path",
    );
    await settleCaptureArea();
    await page.getByRole("slider", { name: "Zoom", exact: true }).dblclick();
    const ruler = await page.locator(".tl-ruler").boundingBox();
    if (!ruler) throw new Error("No timeline ruler.");
    const y = ruler.y + ruler.height / 2;
    const shot = (index: number) => page.locator(`[data-clip="shot-${index}"]`);
    async function bounds(index: number) {
      const box = await shot(index).boundingBox();
      if (!box) throw new Error(`Shot ${index} is off-screen.`);
      return box;
    }
    const sourceFrame = (index: number) =>
      mediaStart(index, size === "4k" ? desktop4kSourceSeconds : undefined) *
      fps;
    async function seek(index: number, offset: number) {
      const timecode = formatTimecode(index * clipSeconds * fps + offset, {
        num: fps,
        den: 1,
      });
      await page.getByRole("button", { name: /^Current time\./ }).click();
      const entry = page.getByRole("textbox", { name: "Go to time" });
      await entry.pressSequentially(timecode.replaceAll(":", ""));
      const sought = Date.now();
      await entry.press("Enter");
      const expected = sourceFrame(index) + offset;
      await capture
        .picture((n) => n === expected, sought)
        .catch((error: unknown) => {
          const recent = [
            ...new Set(capture.samples.slice(-30).map((p) => p.number)),
          ];
          throw new Error(
            `Seek to ${timecode} expected frame ${expected}, saw ${recent.join(", ")}.`,
            { cause: error },
          );
        });
    }
    // Let both paths use a finished scrub proxy. Proxy encoding would otherwise compete with playback.
    if (size === "1080p") {
      const proxy = `${origin}/api/cutroom/projects/${id}/media/scrub?path=footage.mp4`;
      await until(
        async () => {
          const response = await fetch(proxy, { headers: { origin } });
          await response.body?.cancel();
          if (response.status === 200) return true;
          if (response.status !== 202)
            throw new Error(`Scrub proxy returned ${response.status}.`);
          await sleep(500);
        },
        "the scrub proxy",
        60_000,
      );
    }
    if (fps !== 60) await seek(size === "4k" ? 1 : 22, 14);
    await sleep(300);
    await settleCaptureArea();
    await page
      .getByRole("button", { name: "Play forward", exact: true })
      .click();
    await sleep(500);
    const pathObserver = await stage.evaluateHandle((stage) => {
      const states = new Set([stage.getAttribute("data-pipeline")]);
      const observer = new MutationObserver((records) => {
        for (const record of records) states.add(record.oldValue);
        states.add(stage.getAttribute("data-pipeline"));
      });
      observer.observe(stage, {
        attributeFilter: ["data-pipeline"],
        attributeOldValue: true,
      });
      return { states, observer };
    });
    const timecode = page.getByRole("button", { name: /^Current time\./ });
    const playhead = async () => {
      const shown = (await timecode.textContent()) ?? "";
      const frame = parseTimecode(shown.replaceAll(":", ""), {
        num: fps,
        den: 1,
      });
      if (frame === null)
        throw new Error(`Cannot read the playhead at ${shown}.`);
      return frame / fps;
    };
    const clockStart = await playhead();
    const playbackLoad = loadavg()[0];
    const playStart = Date.now();
    await capture.wait(size === "4k" ? 30_000 : 10_000);
    const playEnd = Date.now();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const clockSeconds = (await playhead()) - clockStart;
    const states = await pathObserver.evaluate(({ states, observer }) => {
      observer.disconnect();
      return [...states];
    });
    await pathObserver.dispose();
    if (states.length !== 1 || states[0] !== expectedPipeline)
      throw new Error(
        `The footage path changed while playing: ${JSON.stringify(states)}.`,
      );
    const playback = stats(
      capture.samples,
      playStart,
      playEnd,
      display.monitor.refreshRate,
    );
    if (process.env.CUTROOM_BENCH_DEBUG)
      console.error({ observedOpenMs, sawBlank, playback });
    const captureRiskBudget = size === "4k" ? Math.floor(fps * 30 * 0.005) : 1;
    if (
      playback.captureHz < display.monitor.refreshRate * 0.9 ||
      playback.capturePicturesAtRisk > captureRiskBudget ||
      playback.unreadable / playback.captureHz > (size === "4k" ? 2 : 1)
    )
      throw new Error(
        `Insufficient compositor samples: ${JSON.stringify(playback)}.`,
      );
    const edits = [];
    let scrub;
    if (size === "1080p") {
      await seek(10, 9);
      const from = await bounds(10);
      const to = await bounds(40);
      const x0 = from.x + from.width * 0.1;
      await page.mouse.move(x0, y);
      await page.mouse.down();
      await sleep(300);
      const start = Date.now();
      for (let now = start; now - start < 3000; now = Date.now()) {
        await page.mouse.move(x0 + ((now - start) / 3000) * (to.x - x0), y);
        await sleep(16);
      }
      const end = Date.now();
      await page.mouse.up();
      scrub = stats(capture.samples, start, end, display.monitor.refreshRate);
      for (const index of [22, 24, 27]) {
        const offset = (clipSeconds * fps) / 2;
        const before = sourceFrame(index) + offset;
        const next = sourceFrame(index + 1) + offset;
        await shot(index).click();
        await seek(index, offset);
        const pressed = Date.now();
        await page.keyboard.press("Delete");
        await shot(index).waitFor({ state: "detached" });
        const ripple = await capture.picture((n) => n === next, pressed);
        await sleep(500);
        if (
          capture.samples.some(
            (p) => p.time > ripple.time && p.number === before,
          )
        )
          throw new Error(
            `Shot ${index} returned to frame ${before} after showing ${next}.`,
          );
        const undone = Date.now();
        await page.keyboard.press("Control+z");
        await shot(index).waitFor({ state: "attached" });
        const undo = await capture.picture((n) => n === before, undone);
        edits.push({
          shot: index,
          rippleMs: ripple.time - pressed,
          undoMs: undo.time - undone,
        });
        await sleep(400);
      }
    }
    if ((await stage.getAttribute("data-pipeline")) !== expectedPipeline)
      throw new Error("The footage path changed during measurement.");
    if (editingProxy && expectedPipeline === "on" && !proxyRequests)
      throw new Error(
        "The GPU path did not request the finished editing proxy.",
      );
    capture.verify();
    capture.close();
    const backend = !embedded
      ? undefined
      : Number(
          execFileSync("ps", ["--ppid", String(pid), "-o", "pid=,comm="], {
            encoding: "utf8",
          })
            .split("\n")
            .find((line) => /\bbun\s*$/.test(line))
            ?.trim()
            .split(/\s+/)[0],
        );
    return {
      openMs: sawBlank ? observedOpenMs : null,
      ...(sawBlank ? {} : { openUpperBoundMs: observedOpenMs }),
      fps,
      path: expectedPipeline === "on" ? "gpu" : "native",
      clockSeconds,
      ...(editingProxy ? { proxyWaitMs, proxyRequests } : {}),
      warmMediaMs,
      playback,
      playbackLoad,
      scrub,
      edits,
      browserPssMiB: await browserMemory(pid, backend),
    };
  } finally {
    capture.close();
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    for (const child of running) child.kill(signal);
  });
await mkdir(work);
try {
  await session();
} finally {
  await rm(work, { recursive: true, force: true });
}
