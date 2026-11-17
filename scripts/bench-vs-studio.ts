/**
 * Times the same edits in Cutroom and in HyperFrames Studio on one synthetic project, as a user
 * sees them: headed Chromium, real input, and the viewer's picture read back from frame numbers
 * burned into the footage. A manual benchmark, not run in CI.
 *
 *   bun run build
 *   node scripts/bench-vs-studio.ts --editor cutroom --throttle 4 --runs 3 --out cutroom-4x.json
 *   node scripts/bench-vs-studio.ts --editor studio  --throttle 4 --runs 3 --out studio-4x.json
 *   node scripts/bench-vs-studio.ts --summary cutroom-1x.json studio-1x.json ...
 *
 * Runs under Node, not Bun: Playwright's library loses its browser under Bun. Each invocation
 * starts the editor's own server on a private port, copies the project for it, launches one
 * browser, and stops both before it exits. See docs/performance.md, "Cutroom vs HyperFrames
 * Studio".
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
} from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  clipSeconds,
  fps,
  makeProject,
  mediaStart,
} from "./bench-vs-studio-project.ts";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    editor: { type: "string" },
    throttle: { type: "string", default: "1" },
    runs: { type: "string", default: "3" },
    port: { type: "string", default: "4961" },
    dir: {
      type: "string",
      default: join(homedir(), ".cache/cutroom-vs-studio-bench"),
    },
    out: { type: "string" },
    browser: { type: "string", default: "/usr/lib/chromium/chromium" },
    summary: { type: "boolean", default: false },
  },
});

type Editor = "cutroom" | "studio";
type Box = { x: number; y: number; width: number; height: number };
type Picture = { time: number; number: number | null };

const viewport = { width: 1720, height: 1050 };
const editsAt = [22, 23, 24, 27, 28] as const;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const median = (values: number[]) => quantile(values, 0.5);
function quantile(values: number[], q: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}
const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]!);

/** Starts a server in its own process group, so stopping it also stops what it spawned. */
function start(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env, HYPERFRAMES_NO_TELEMETRY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout!.on("data", (chunk) => (log += chunk));
  child.stderr!.on("data", (chunk) => (log += chunk));
  return { child, log: () => log };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  process.kill(-child.pid!, "SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) process.kill(-child.pid!, "SIGKILL");
}

async function waitFor(url: string, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const ok = await fetch(url)
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`${url} did not answer.`);
    await sleep(200);
  }
}

/** Proportional set size of a process and everything under it, in MB. */
async function treePss(root: number) {
  const parents = new Map<number, number>();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (ppid) parents.set(Number(entry), ppid);
  }
  const tree = new Set([root]);
  for (let grown = true; grown;) {
    grown = false;
    for (const [pid, ppid] of parents)
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid);
        grown = true;
      }
  }
  let kb = 0;
  for (const pid of tree) {
    const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8").catch(
      () => "",
    );
    kb += Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0);
  }
  return Math.round(kb / 1024);
}

async function browserPid(marker: string) {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(
      () => "",
    );
    if (cmdline.includes(marker) && !cmdline.includes("--type="))
      return Number(entry);
  }
  throw new Error("The browser process is missing.");
}

const studioPreview = (page: Page) =>
  page.frames().find((frame) => frame.url().includes("/preview"));

/** The two editors, reduced to what the operations need. */
function adapter(editor: Editor) {
  if (editor === "cutroom")
    return {
      clip: (page: Page, id: string) => page.locator(`[data-clip="${id}"]`),
      clips: (page: Page) => page.locator("[data-clip]"),
      pictureBox: async (page: Page) =>
        (await page.locator(".edit-picture").boundingBox())!,
      rulerY: async (page: Page) => {
        const ruler = (await page.locator(".tl-ruler").boundingBox())!;
        return ruler.y + ruler.height / 2;
      },
      wheelTarget: ".tl-scroll",
      fit: async (page: Page) => {
        await page
          .getByRole("slider", { name: "Zoom", exact: true })
          .dblclick();
        await page.getByRole("region", { name: "Viewer", exact: true }).click();
      },
      razor: "e",
      rippleDelete: "Delete",
      undo: "Control+z",
      play: "Space",
      playhead: (page: Page) =>
        page.evaluate(() => {
          const text = document.querySelector(
            "[aria-label^='Current time']",
          )!.textContent!;
          const [h, m, s, f] = text.split(":").map(Number);
          return ((h! * 60 + m!) * 60 + s!) * 30 + f!;
        }),
    };
  return {
    clip: (page: Page, id: string) =>
      page.locator(`[data-el-id="index.html#${id}"]`),
    clips: (page: Page) => page.locator('[data-clip="true"]'),
    pictureBox: async (page: Page) => {
      const frame = studioPreview(page)!;
      return (await (await frame.frameElement()).boundingBox())!;
    },
    // The ruler sits 26 px above the first track's clips; it has no role or label of its own.
    rulerY: async (page: Page) =>
      (await page.locator('[data-clip="true"]').first().boundingBox())!.y - 26,
    wheelTarget: "[data-timeline-scroll-viewport]",
    fit: async (page: Page) => {
      await page.getByRole("button", { name: "Fit timeline to width" }).click();
    },
    razor: "s",
    rippleDelete: "Delete",
    undo: "Control+z",
    play: "Space",
    playhead: (page: Page) =>
      page.evaluate(() =>
        Math.round(
          Number(new URLSearchParams(location.hash.split("?")[1]).get("t")) *
            30,
        ),
      ),
  };
}
type Adapter = ReturnType<typeof adapter>;

/** Records every composited frame of the tab, with its swap time on the wall clock. */
async function screencast(cdp: CDPSession) {
  const frames: { time: number; data: string }[] = [];
  const onFrame = ({
    data,
    metadata,
    sessionId,
  }: {
    data: string;
    metadata: { timestamp?: number };
    sessionId: number;
  }) => {
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    frames.push({ time: metadata.timestamp! * 1000, data });
  };
  cdp.on("Page.screencastFrame", onFrame);
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 85,
    everyNthFrame: 1,
    maxWidth: viewport.width / 2,
    maxHeight: viewport.height / 2,
  });
  return {
    frames,
    async stop() {
      await cdp.send("Page.stopScreencast");
      cdp.off("Page.screencastFrame", onFrame);
      return frames;
    },
  };
}

/**
 * Reads the frame number in the sixteen blocks along the top of each screencast frame, in a
 * separate page so decoding never competes with the editor's renderer. A frame with no
 * readable number (black, a placeholder, a half-drawn picture) reads null.
 */
async function decode(
  decoder: Page,
  frames: { time: number; data: string }[],
  box: Box,
): Promise<Picture[]> {
  return decoder.evaluate(
    async ({ frames, box, width }) => {
      const canvas = new OffscreenCanvas(1, 1);
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const decoded: Picture[] = [];
      for (const { time, data } of frames) {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes]));
        const scale = image.width / width;
        canvas.width = image.width;
        canvas.height = image.height;
        context.drawImage(image, 0, 0);
        image.close();
        const luma = (x: number, y: number) => {
          const [r, g, b] = context.getImageData(
            Math.round((box.x + x * box.width) * scale),
            Math.round((box.y + y * box.height) * scale),
            1,
            1,
          ).data;
          return { r: r!, g: g!, b: b!, l: (r! + g! + b!) / 3 };
        };
        // testsrc2's left bar is red on every frame; titles and scenes never cover it. Its moving
        // diagonal line crosses any one point of the bar now and then, so three points are read.
        let number: number | null = [0.3, 0.5, 0.7].some((y) => {
          const { r, g, b } = luma(0.05, y);
          return r > 150 && g < 100 && b < 100;
        })
          ? 0
          : null;
        for (let bit = 0; number !== null && bit < 16; bit++) {
          const { l } = luma((bit + 0.5) / 16, 27 / 1080);
          if (l > 60 && l < 190) number = null;
          else if (l >= 190) number |= 1 << bit;
        }
        decoded.push({ time, number });
      }
      return decoded;
    },
    { frames, box, width: viewport.width },
  );
}

async function main() {
  if (options.summary) return summarize(positionals);
  const editor = options.editor;
  if (editor !== "cutroom" && editor !== "studio")
    throw new Error("Pass --editor cutroom or --editor studio.");
  return measure(editor);
}

async function measure(editor: Editor) {
  const throttle = Number(options.throttle);
  const runs = Number(options.runs);
  const port = Number(options.port);
  const dir = resolve(options.dir!);
  const master = join(dir, "master");
  if (!existsSync(join(master, "index.html"))) {
    console.log("Making the project…");
    await makeProject(master);
  }
  const results = [];
  for (let run = 0; run < runs; run++) {
    console.log(`${editor} ${throttle}x, run ${run + 1} of ${runs}`);
    results.push(await session(editor, run, throttle, port, dir, master));
  }
  const output: Output = {
    editor,
    throttle,
    runs,
    date: new Date().toISOString(),
    browser: options.browser,
    viewport,
    results,
  };
  if (options.out)
    await writeFile(options.out, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(summaryOf(output), null, 2));
}

/** One fresh server, project copy and browser; every operation once or a few times. */
async function session(
  editor: Editor,
  run: number,
  throttle: number,
  port: number,
  dir: string,
  master: string,
) {
  const origin = `http://127.0.0.1:${port}`;
  const work = join(dir, editor);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const project = join(work, "bench");
  await cp(master, project, { recursive: true });
  const server =
    editor === "studio"
      ? start(
          process.execPath,
          [
            resolve("node_modules/hyperframes/bin/hyperframes.mjs"),
            "preview",
            project,
            "--port",
            String(port),
            "--no-open",
            "--foreground",
            "--force-new",
          ],
          {},
        )
      : start("bun", ["src/server/index.ts"], {
          CUTROOM_PORT: String(port),
          CUTROOM_DATA_DIR: join(work, "data"),
          CUTROOM_PROJECTS_DIR: join(work, "projects"),
        });
  const marker = `cutroom-vs-studio-${process.pid}-${run}`;
  let context: BrowserContext | undefined;
  try {
    await waitFor(`${origin}/${editor === "cutroom" ? "health" : ""}`);
    let url = `${origin}/#project/${basename(project)}`;
    let mcp: Client | undefined;
    if (editor === "cutroom") {
      const response = await fetch(`${origin}/api/cutroom/projects/import`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ path: project, name: "bench" }),
      });
      const { id } = (await response.json()) as { id: string };
      url = `${origin}/#project/${id}`;
      mcp = new Client({ name: "bench-vs-studio", version: "1" });
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", origin), {
          requestInit: { headers: { origin } },
        }),
      );
      Object.assign(mcp, { projectId: id });
    }
    const userData = join(work, "browser");
    context = await chromium.launchPersistentContext(userData, {
      headless: false,
      executablePath: options.browser,
      viewport,
      args: [
        "--mute-audio",
        "--ozone-platform=x11",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        `--class=${marker}`,
      ],
    });
    const decoder = await context.newPage();
    await decoder.goto("about:blank");
    const ui = adapter(editor);
    const opens = [];
    let page: Page | undefined;
    for (let open = 0; open < 3; open++) {
      await page?.close();
      page = await context.newPage();
      opens.push(await openToPicture(page, ui, url, decoder));
    }
    console.log(`  opens: ${JSON.stringify(opens)}`);
    page = page!;
    const cdp = await page.context().newCDPSession(page);
    const throttled = await throttleAll(page, cdp, throttle);
    const result = {
      run,
      opens,
      throttledTargets: throttled,
      scrub: await step("scrub", () => scrub(page, ui, cdp, decoder)),
      playback: await step("playback", () => playback(page, ui, cdp, decoder)),
      zoom: await step("zoom", () => zoom(page, ui)),
      razor: await step("razor", () => edits(page, ui, cdp, decoder, "razor")),
      rippleDelete: await step("rippleDelete", () =>
        edits(page, ui, cdp, decoder, "ripple"),
      ),
      trim: await step("trim", () => drag(page, ui, cdp, decoder, "trim")),
      move: await step("move", () => drag(page, ui, cdp, decoder, "move")),
      agentFile: await step("agentFile", () =>
        agentEdits(page, ui, cdp, decoder, project, "file"),
      ),
      agentMcp: mcp
        ? await step("agentMcp", () =>
            agentEdits(page, ui, cdp, decoder, project, "mcp", mcp),
          )
        : null,
      memory: {
        browserMB: await treePss(await browserPid(marker)),
        serverMB: await treePss(server.child.pid!),
      },
    };
    await mcp?.close();
    return result;
  } catch (error) {
    console.error(server.log().slice(-2000));
    throw error;
  } finally {
    await context?.close();
    await stop(server.child);
  }
}

async function step<T>(name: string, measure: () => Promise<T>) {
  const value = await measure();
  console.log(`  ${name}: ${JSON.stringify(value).slice(0, 400)}`);
  return value;
}

/** Applies CPU throttling to the editor and to an out-of-process preview, if it has one. */
async function throttleAll(page: Page, cdp: CDPSession, rate: number) {
  if (rate === 1) return 0;
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  let targets = 1;
  for (const frame of page.frames().slice(1)) {
    const session = await page
      .context()
      .newCDPSession(frame)
      .catch(() => null);
    if (!session) continue;
    await session.send("Emulation.setCPUThrottlingRate", { rate });
    targets++;
  }
  return targets;
}

/** Navigation to the first readable picture of frame 0, and to the timeline showing its clips. */
async function openToPicture(
  page: Page,
  ui: Adapter,
  url: string,
  decoder: Page,
) {
  const cdp = await page.context().newCDPSession(page);
  const cast = await screencast(cdp);
  const start = Date.now();
  await page.goto(url);
  await ui.clips(page).nth(99).waitFor({ state: "attached", timeout: 60_000 });
  const timeline = await page.evaluate(
    () => performance.timeOrigin + performance.now(),
  );
  let picture: number | null = null;
  let box: Box | undefined;
  const deadline = Date.now() + 60_000;
  while (picture === null && Date.now() < deadline) {
    await sleep(500);
    box ??= await ui.pictureBox(page).catch(() => undefined);
    if (!box) continue;
    const decoded = await decode(decoder, cast.frames, box);
    picture = decoded.find((p) => p.number === 0)?.time ?? null;
  }
  await cast.stop();
  await cdp.detach();
  if (picture === null) throw new Error("The first picture never showed.");
  return { picture: picture - start, timeline: timeline - start };
}

/** Seeks by clicking the ruler over a shot, then waits for its picture. */
async function seekToShot(
  page: Page,
  ui: Adapter,
  cdp: CDPSession,
  decoder: Page,
  shot: number,
  fraction = 0.5,
) {
  const box = (await ui.clip(page, `shot-${shot}`).boundingBox())!;
  const cast = await screencast(cdp);
  await page.mouse.click(box.x + box.width * fraction, await ui.rulerY(page));
  const first = Math.round(mediaStart(shot) * fps);
  const inShot = (n: number | null) =>
    n !== null && n >= first && n < first + clipSeconds * fps;
  const picture = await waitPicture(page, ui, cast, decoder, inShot, 10_000);
  await cast.stop();
  if (!picture) throw new Error(`Seeking into shot ${shot} showed no picture.`);
  await sleep(400);
  return picture.number!;
}

async function waitPicture(
  page: Page,
  ui: Adapter,
  cast: Awaited<ReturnType<typeof screencast>>,
  decoder: Page,
  match: (n: number | null) => boolean,
  timeout: number,
  after = 0,
) {
  const box = await ui.pictureBox(page);
  const deadline = Date.now() + timeout;
  let seen = 0;
  const decoded: Picture[] = [];
  while (Date.now() < deadline) {
    await sleep(250);
    const fresh = cast.frames.slice(seen);
    seen += fresh.length;
    decoded.push(...(await decode(decoder, fresh, box)));
    const hit = decoded.find((p) => p.time >= after && match(p.number));
    if (hit) return hit;
  }
  return null;
}

/** A 3 s ruler drag from shot 10 to shot 40 at Fit, about 60 pointer moves a second. */
async function scrub(page: Page, ui: Adapter, cdp: CDPSession, decoder: Page) {
  await ui.fit(page);
  await sleep(800);
  await seekToShot(page, ui, cdp, decoder, 10, 0.1);
  const from = (await ui.clip(page, "shot-10").boundingBox())!;
  const to = (await ui.clip(page, "shot-40").boundingBox())!;
  const y = await ui.rulerY(page);
  const cast = await screencast(cdp);
  await page.mouse.move(from.x + from.width * 0.1, y);
  await page.mouse.down();
  await sleep(300);
  const start = Date.now();
  const ms = 3000;
  while (Date.now() - start < ms) {
    await page.mouse.move(
      from.x + from.width * 0.1 + ((Date.now() - start) / ms) * (to.x - from.x),
      y,
    );
    await sleep(16);
  }
  const end = Date.now();
  await sleep(1000);
  await page.mouse.up();
  const frames = await cast.stop();
  const pictures = await decode(decoder, frames, await ui.pictureBox(page));
  const during = pictures.filter(
    (p) => p.time >= start && p.time <= end && p.number !== null,
  );
  const changes = during.filter(
    (p, i) => i === 0 || p.number !== during[i - 1]!.number,
  );
  const times = [start, ...changes.map((p) => p.time), end];
  return {
    seconds: (end - start) / 1000,
    newPictures: changes.length,
    picturesPerSecond: changes.length / ((end - start) / 1000),
    gapP95: quantile(gaps(times), 0.95),
    gapMax: Math.max(...gaps(times)),
  };
}

/**
 * Ten seconds of 1x play from shot 22, counted as new source frames in the tab's composited
 * frames, as the viewer showed them. A preview's `requestVideoFrameCallback` times are not
 * used: they are when its main thread ran the callback, a display frame before or after the
 * picture whenever that thread starts its frame just as the compositor presents one.
 */
async function playback(
  page: Page,
  ui: Adapter,
  cdp: CDPSession,
  decoder: Page,
) {
  const firstShot = 22;
  await seekToShot(page, ui, cdp, decoder, firstShot, 0.1);
  const editorFrames = page.evaluate(async () => {
    const times: number[] = [];
    const end = performance.now() + 10_500;
    while (performance.now() < end)
      times.push(
        await new Promise<number>((done) =>
          requestAnimationFrame(() => done(performance.now())),
        ),
      );
    return times;
  });
  const cast = await screencast(cdp);
  await page.keyboard.press(ui.play);
  await sleep(500);
  const start = Date.now();
  await sleep(10_000);
  const end = Date.now();
  const frames = await cast.stop();
  await page.keyboard.press(ui.play);
  const editor = gaps(await editorFrames);
  const composited = (
    await decode(decoder, frames, await ui.pictureBox(page))
  ).filter((p) => p.time >= start && p.time <= end);
  const shown = composited.filter((p) => p.number !== null);
  const changes = shown.filter(
    (p, i) => i === 0 || p.number !== shown[i - 1]!.number,
  );
  // A picture stays up for whole display frames; the capture times jitter by a few ms.
  const display = median(gaps(composited.map((p) => p.time)))!;
  const held = gaps(changes.map((p) => p.time)).map(
    (gap) => Math.max(1, Math.round(gap / display)) * display,
  );
  // These five source ranges do not overlap. A skipped source frame stays
  // within its shot; treating any jump over four frames as a cut mislabeled decoder stalls.
  const shots = Array.from({ length: 5 }, (_, index) => {
    const shot = firstShot + index;
    return {
      shot,
      first: mediaStart(shot) * fps,
      end: (mediaStart(shot) + clipSeconds) * fps,
    };
  });
  const shotNumbers = changes.map(({ number }) => {
    const shot = shots.find(
      ({ first, end }) => number! >= first && number! < end,
    );
    if (!shot)
      throw new Error(
        `Playback read source frame ${number} outside the benchmark's shot ranges.`,
      );
    return shot.shot;
  });
  const steps = changes.slice(1).map((_, i) => ({
    held: held[i]!,
    cut: shotNumbers[i] !== shotNumbers[i + 1],
  }));
  // How long the outgoing shot's last picture and the incoming shot's first stayed up.
  const atCuts = steps.flatMap((step, i) =>
    step.cut && steps[i + 1] ? [step.held, steps[i + 1]!.held] : [],
  );
  return {
    composited: composited.length,
    displayFrame: display,
    cuts: steps.filter((step) => step.cut).length,
    cutHoldMax: atCuts.length ? Math.max(...atCuts) : null,
    pictures: changes.length,
    picturesPerSecond: changes.length / ((end - start) / 1000),
    dropped: Math.max(
      0,
      Math.round(((end - start) / 1000) * fps) - changes.length,
    ),
    gapP95: quantile(held, 0.95),
    gapMax: held.length ? Math.max(...held) : null,
    // A 30 fps picture held for a display frame longer than it should be.
    lateGaps: held.filter((gap) => gap > 2 * display).length,
    editorFrameP95: quantile(editor, 0.95),
    editorLateFrames: editor.filter((gap) => gap > 25).length,
  };
}

/** Sixteen Ctrl+wheel steps in, one per displayed frame, then back to Fit. */
async function zoom(page: Page, ui: Adapter) {
  await ui.fit(page);
  await sleep(800);
  const box = (await page.locator(ui.wheelTarget).first().boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + 60);
  const frames = page.evaluate(async () => {
    const times: number[] = [];
    const end = performance.now() + 1500;
    while (performance.now() < end)
      times.push(
        await new Promise<number>((done) =>
          requestAnimationFrame(() => done(performance.now())),
        ),
      );
    return times;
  });
  await page.keyboard.down("Control");
  for (let step = 0; step < 16; step++) {
    await page.mouse.wheel(0, -60);
    await sleep(16);
  }
  await page.keyboard.up("Control");
  const intervals = gaps(await frames);
  await ui.fit(page);
  await sleep(800);
  return {
    frameP50: quantile(intervals, 0.5),
    frameP95: quantile(intervals, 0.95),
    frameMax: Math.max(...intervals),
    lateFrames: intervals.filter((gap) => gap > 25).length,
    frames: intervals.length,
  };
}

/** Wall-clock time in the page when `condition` first holds and a frame has been drawn. */
function watchTimeline(page: Page, condition: string) {
  return page.evaluate(async (condition) => {
    const holds = new Function(`return (${condition})`) as () => boolean;
    await new Promise<void>((done) => {
      if (holds()) return done();
      const observer = new MutationObserver(() => {
        if (!holds()) return;
        observer.disconnect();
        done();
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      setTimeout(() => {
        observer.disconnect();
        done();
      }, 15_000);
    });
    await new Promise((done) => requestAnimationFrame(done));
    return holds() ? performance.timeOrigin + performance.now() : null;
  }, condition);
}

/**
 * Razor or ripple delete the shot under the playhead, then undo. Razor is timed to the timeline
 * showing the cut (the picture does not change); ripple delete and undo to the viewer showing the
 * next shot's frame and then the original frame again.
 */
async function edits(
  page: Page,
  ui: Adapter,
  cdp: CDPSession,
  decoder: Page,
  kind: "razor" | "ripple",
) {
  await ui.fit(page);
  await sleep(800);
  const samples = [];
  for (const shot of editsAt) {
    const before = await seekToShot(page, ui, cdp, decoder, shot);
    await ui.clip(page, `shot-${shot}`).click();
    await sleep(300);
    const count = await ui.clips(page).count();
    const selector = await selectorOf(ui, page, `shot-${shot}`);
    const clipsSelector = await ui
      .clips(page)
      .first()
      .evaluate((e) =>
        e.getAttribute("data-clip") === "true"
          ? '[data-clip="true"]'
          : "[data-clip]",
      );
    const condition =
      kind === "razor"
        ? `document.querySelectorAll('${clipsSelector}').length !== ${count}`
        : `!document.querySelector('${selector}')`;
    const cast = await screencast(cdp);
    const ui1 = watchTimeline(page, condition);
    const pressed = Date.now();
    await page.keyboard.press(kind === "razor" ? ui.razor : ui.rippleDelete);
    const shown = await ui1;
    const expected =
      before + Math.round((mediaStart(shot + 1) - mediaStart(shot)) * fps);
    const picture =
      kind === "ripple"
        ? await waitPicture(
            page,
            ui,
            cast,
            decoder,
            (n) => n === expected,
            8000,
            pressed,
          )
        : null;
    await sleep(500);
    const undoCondition =
      kind === "razor"
        ? `document.querySelectorAll('${clipsSelector}').length === ${count}`
        : `!!document.querySelector('${selector}')`;
    const ui2 = watchTimeline(page, undoCondition);
    const undone = Date.now();
    await page.keyboard.press(ui.undo);
    const restored = await ui2;
    const undoPicture =
      kind === "ripple"
        ? await waitPicture(
            page,
            ui,
            cast,
            decoder,
            (n) => n === before,
            8000,
            undone,
          )
        : null;
    await cast.stop();
    samples.push({
      shot,
      timeline: shown === null ? null : shown - pressed,
      picture: picture ? picture.time - pressed : null,
      undoTimeline: restored === null ? null : restored - undone,
      undoPicture: undoPicture ? undoPicture.time - undone : null,
    });
    await sleep(800);
  }
  return samples;
}

/**
 * Drags a trim (shot 30's end, 60 px left) or a move (title 6, 80 px right) zoomed in so the clip
 * is wide enough to grab, 40 moves at about 60 Hz, then undoes it. Reports the editor's frame
 * pacing during the drag, pictures the viewer showed while dragging, and release to the timeline
 * showing the result.
 */
async function drag(
  page: Page,
  ui: Adapter,
  cdp: CDPSession,
  decoder: Page,
  kind: "trim" | "move",
) {
  const id = kind === "trim" ? "shot-30" : "title-6";
  await zoomTo(page, ui, ui.clip(page, id));
  const samples = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = (await ui.clip(page, id).boundingBox())!;
    const y = box.y + box.height / 2;
    const x0 = kind === "trim" ? box.x + box.width - 2 : box.x + box.width / 2;
    const dx = kind === "trim" ? -60 : 80;
    const selector = await selectorOf(ui, page, id);
    const cast = await screencast(cdp);
    await page.mouse.move(x0, y);
    await sleep(200);
    await page.mouse.down();
    const frames = page.evaluate(async () => {
      const times: number[] = [];
      const end = performance.now() + 900;
      while (performance.now() < end)
        times.push(
          await new Promise<number>((done) =>
            requestAnimationFrame(() => done(performance.now())),
          ),
        );
      return times;
    });
    const start = Date.now();
    for (let step = 1; step <= 40; step++) {
      await page.mouse.move(x0 + (dx * step) / 40, y);
      await sleep(16);
    }
    const end = Date.now();
    const intervals = gaps(await frames);
    await page.mouse.up();
    await sleep(600);
    const after = await page.locator(selector).boundingBox();
    const changed = (b: Box | null) =>
      !!b &&
      (kind === "trim"
        ? Math.abs(b.width - box.width) > 20
        : Math.abs(b.x - box.x) > 20);
    const frames2 = await cast.stop();
    const pictures = await decode(decoder, frames2, await ui.pictureBox(page));
    const during = pictures.filter(
      (p) => p.time >= start && p.time <= end + 100 && p.number !== null,
    );
    const changes = during.filter(
      (p, i) => i > 0 && p.number !== during[i - 1]!.number,
    );
    await page.keyboard.press(ui.undo);
    await sleep(1200);
    const restored = !changed(await page.locator(selector).boundingBox());
    samples.push({
      frameP95: quantile(intervals, 0.95),
      frameMax: Math.max(...intervals),
      lateFrames: intervals.filter((gap) => gap > 25).length,
      picturesWhileDragging: changes.length,
      shownFrames: changes.map((p) => p.number),
      applied: changed(after),
      restored,
    });
  }
  await ui.fit(page);
  await sleep(800);
  return samples;
}

async function selectorOf(ui: Adapter, page: Page, id: string) {
  return ui
    .clip(page, id)
    .evaluate((e) =>
      e.hasAttribute("data-el-id")
        ? `[data-el-id="${e.getAttribute("data-el-id")}"]`
        : `[data-clip="${e.getAttribute("data-clip")}"]`,
    );
}

/** Ctrl+wheel over the clip until it is at least 160 px wide. */
async function zoomTo(page: Page, ui: Adapter, clip: Locator) {
  await ui.fit(page);
  await sleep(800);
  for (let step = 0; step < 60; step++) {
    const box = await clip.boundingBox();
    if (box && box.width >= 160) break;
    if (box)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -60);
    await page.keyboard.up("Control");
    await sleep(80);
  }
  await sleep(800);
  const box = await clip.boundingBox();
  if (!box || box.width < 160)
    throw new Error("Could not zoom in on the clip.");
}

/**
 * The agent's edit: ripple delete the shot under the playhead by writing the composition file,
 * as an agent with file access does in either editor, or through Cutroom's MCP tool. Timed from
 * the write or the call to the viewer showing the next shot's frame. Undone by writing the file
 * back, or by undo in Cutroom.
 */
async function agentEdits(
  page: Page,
  ui: Adapter,
  cdp: CDPSession,
  decoder: Page,
  project: string,
  route: "file" | "mcp",
  mcp?: Client,
) {
  await ui.fit(page);
  await sleep(800);
  const file = join(project, "index.html");
  const samples = [];
  for (const shot of editsAt) {
    const before = await seekToShot(page, ui, cdp, decoder, shot);
    const expected =
      before + Math.round((mediaStart(shot + 1) - mediaStart(shot)) * fps);
    const original = await readFile(file, "utf8");
    const cast = await screencast(cdp);
    const started = Date.now();
    if (route === "file")
      await writeFile(file, rippleDeleteInSource(original, shot));
    else {
      const projectId = (mcp as unknown as { projectId: string }).projectId;
      const read = (await mcp!.callTool({
        name: "timeline_read",
        arguments: { projectId, to: 1 },
      })) as { structuredContent?: { result?: { revision?: string } } };
      const revision = read.structuredContent?.result?.revision;
      const editStart = Date.now();
      const reply = await mcp!.callTool({
        name: "timeline_edit",
        arguments: {
          projectId,
          expectedRevision: revision,
          commands: [
            { type: "remove", clipIds: [`shot-${shot}`], ripple: true },
          ],
        },
      });
      if (reply.isError) throw new Error(JSON.stringify(reply.content));
      Object.assign(cast, { editStart });
    }
    const from = (cast as { editStart?: number }).editStart ?? started;
    const picture = await waitPicture(
      page,
      ui,
      cast,
      decoder,
      (n) => n === expected,
      15_000,
      from,
    );
    await sleep(500);
    const undone = Date.now();
    if (route === "file") await writeFile(file, original);
    else await page.keyboard.press(ui.undo);
    const back = await waitPicture(
      page,
      ui,
      cast,
      decoder,
      (n) => n === before,
      15_000,
      undone,
    );
    await cast.stop();
    samples.push({
      shot,
      picture: picture ? picture.time - from : null,
      undoPicture: back ? back.time - undone : null,
    });
    await sleep(1500);
  }
  return samples;
}

/** Removes a shot from the source and pulls every later shot on its track 3 s earlier. */
function rippleDeleteInSource(html: string, shot: number) {
  return html
    .replace(
      new RegExp(`<video[^>]*id="shot-${shot}"[^>]*>\\s*</video>\\s*`),
      "",
    )
    .replace(/<video[^>]*id="shot-(\d+)"[^>]*>/g, (tag, index: string) =>
      Number(index) > shot
        ? tag.replace(
            /data-start="([\d.]+)"/,
            (_, start: string) => `data-start="${Number(start) - clipSeconds}"`,
          )
        : tag,
    );
}

type Result = Awaited<ReturnType<typeof session>>;
type Output = {
  editor: Editor;
  throttle: number;
  runs: number;
  date: string;
  browser: string | undefined;
  viewport: typeof viewport;
  results: Result[];
};

function summaryOf(output: Output) {
  const r = output.results;
  const pick = <T>(f: (result: Result) => T[]) => r.flatMap(f);
  const nums = (values: (number | null | undefined)[]) =>
    values.filter((v): v is number => typeof v === "number");
  const stat = (values: (number | null | undefined)[]) => {
    const v = nums(values);
    const missing = values.length - v.length;
    return {
      median: median(v),
      p95: quantile(v, 0.95),
      n: v.length,
      ...(missing ? { missing } : {}),
    };
  };
  return {
    editor: output.editor,
    throttle: output.throttle,
    firstOpenPicture: r[0]?.opens[0]?.picture,
    reopenPicture: stat(pick((x) => x.opens.slice(1).map((o) => o.picture))),
    reopenTimeline: stat(pick((x) => x.opens.slice(1).map((o) => o.timeline))),
    scrubPicturesPerSecond: stat(pick((x) => [x.scrub.picturesPerSecond])),
    scrubGapP95: stat(pick((x) => [x.scrub.gapP95])),
    playPicturesPerSecond: stat(pick((x) => [x.playback.picturesPerSecond])),
    playDropped: stat(pick((x) => [x.playback.dropped])),
    playGapP95: stat(pick((x) => [x.playback.gapP95])),
    playLateGaps: stat(pick((x) => [x.playback.lateGaps])),
    playCutHoldMax: stat(pick((x) => [x.playback.cutHoldMax])),
    playEditorFrameP95: stat(pick((x) => [x.playback.editorFrameP95])),
    zoomFrameP95: stat(pick((x) => [x.zoom.frameP95])),
    zoomLateFrames: stat(pick((x) => [x.zoom.lateFrames])),
    razorTimeline: stat(pick((x) => x.razor.map((s) => s.timeline))),
    razorUndoTimeline: stat(pick((x) => x.razor.map((s) => s.undoTimeline))),
    rippleTimeline: stat(pick((x) => x.rippleDelete.map((s) => s.timeline))),
    ripplePicture: stat(pick((x) => x.rippleDelete.map((s) => s.picture))),
    undoTimeline: stat(pick((x) => x.rippleDelete.map((s) => s.undoTimeline))),
    undoPicture: stat(pick((x) => x.rippleDelete.map((s) => s.undoPicture))),
    trimFrameP95: stat(pick((x) => x.trim.map((s) => s.frameP95))),
    trimPicturesWhileDragging: stat(
      pick((x) => x.trim.map((s) => s.picturesWhileDragging)),
    ),
    moveFrameP95: stat(pick((x) => x.move.map((s) => s.frameP95))),
    agentFilePicture: stat(pick((x) => x.agentFile.map((s) => s.picture))),
    agentFileUndoPicture: stat(
      pick((x) => x.agentFile.map((s) => s.undoPicture)),
    ),
    agentMcpPicture: stat(
      pick((x) => (x.agentMcp ?? []).map((s) => s.picture)),
    ),
    agentMcpUndoPicture: stat(
      pick((x) => (x.agentMcp ?? []).map((s) => s.undoPicture)),
    ),
    browserMB: stat(pick((x) => [x.memory.browserMB])),
    serverMB: stat(pick((x) => [x.memory.serverMB])),
  };
}

async function summarize(files: string[]) {
  for (const file of files)
    console.log(
      JSON.stringify(
        summaryOf(JSON.parse(await readFile(file, "utf8")) as Output),
        null,
        1,
      ),
    );
}

await main();
