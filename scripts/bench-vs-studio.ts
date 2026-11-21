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
 * --scale 100 or --scale 1000 runs the numbered 1080p60 dialogue project. It compares
 * ruler drags, 1x playback, ripple deletion and browser memory.
 * --grade puts a colour grade on every shot, to compare against the same project ungraded.
 * --pipeline enables GPU footage playback. --pipeline-compatible removes the root's empty
 * timeline script, uses the vendored GSAP URL and omits the videos' CSS class so the pipeline
 * can classify them. The footage, cuts, titles and scenes are the same.
 * --footage-only runs just opens, ruler drag, playback and memory. --slider also measures
 * the time from a Colour Exposure slider drag to the composited viewer picture. --bus plays the
 * music bed through a bus with a compressor, and --mixer opens Cutroom's mixer before measuring.
 *
 * Runs under Node, not Bun: Playwright's library loses its browser under Bun. Each invocation
 * starts the editor's own server on a private port, copies the project for it, launches one
 * browser, and stops both before it exits. See docs/performance.md, "Cutroom vs HyperFrames
 * Studio".
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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
  fps as studioFps,
  makeProject,
  mediaStart,
  scaleFps,
  scaleShots,
} from "./bench-vs-studio-project.ts";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    editor: { type: "string" },
    scale: { type: "string" },
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
    "pipeline-compatible": { type: "boolean", default: false },
    pipeline: { type: "boolean", default: false },
    "footage-only": { type: "boolean", default: false },
    "ripple-only": { type: "boolean", default: false },
    grade: { type: "boolean", default: false },
    slider: { type: "boolean", default: false },
    bus: { type: "boolean", default: false },
    mixer: { type: "boolean", default: false },
  },
});

type Editor = "cutroom" | "studio";
type Box = { x: number; y: number; width: number; height: number };
type Picture = { time: number; number: number | null; tone?: number };
type CastFrame = { time: number; data: string; deviceWidth: number };

const viewport = { width: 1720, height: 1050 };
const scale =
  options.scale === "1000" ? 1000 : options.scale === "100" ? 100 : null;
const shots = scale && scaleShots(scale);
const fps = scale ? scaleFps : studioFps;
const editsAt = scale
  ? [4, 12, scale === 1000 ? 400 : 38]
  : [22, 23, 24, 27, 28];
const sourceFrame = (index: number) =>
  (shots && shots[index]?.source) || Math.round(mediaStart(index) * fps);
const shotFrames = (index: number) => {
  const shot = shots && shots[index];
  return shot ? shot.end - shot.start : clipSeconds * fps;
};

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
        page.evaluate((fps) => {
          const text = document.querySelector(
            "[aria-label^='Current time']",
          )!.textContent!;
          const [h, m, s, f] = text.split(":").map(Number);
          return ((h! * 60 + m!) * 60 + s!) * fps + f!;
        }, fps),
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
  const frames: CastFrame[] = [];
  const onFrame = ({
    data,
    metadata,
    sessionId,
  }: {
    data: string;
    metadata: { timestamp?: number; deviceWidth: number };
    sessionId: number;
  }) => {
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (metadata.timestamp === undefined) return;
    frames.push({
      time: metadata.timestamp * 1000,
      data,
      deviceWidth: metadata.deviceWidth,
    });
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
  frames: CastFrame[],
  box: Box,
  readTone = false,
): Promise<Picture[]> {
  return decoder.evaluate(
    async ({ frames, box, readTone }) => {
      const canvas = new OffscreenCanvas(1, 1);
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const decoded: Picture[] = [];
      for (const { time, data, deviceWidth } of frames) {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes]));
        const scale = image.width / deviceWidth;
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
        // testsrc2's left bar is red on every frame; titles and scenes never cover it.
        const anchor = luma(0.05, 0.5);
        let number: number | null = 0;
        if (!(anchor.r > 150 && anchor.g < 100 && anchor.b < 100))
          number = null;
        for (let bit = 0; number !== null && bit < 16; bit++) {
          const { l } = luma((bit + 0.5) / 16, 27 / 1080);
          if (l > 60 && l < 190) number = null;
          else if (l >= 190) number |= 1 << bit;
        }
        const tone = readTone
          ? [0.22, 0.42, 0.62, 0.82].reduce(
              (sum, x) => sum + luma(x, 0.4).l,
              0,
            ) / 4
          : undefined;
        decoded.push({ time, number, tone });
      }
      return decoded;
    },
    { frames, box, readTone },
  );
}

async function main() {
  if (options.summary) return summarize(positionals);
  const editor = options.editor;
  if (editor !== "cutroom" && editor !== "studio")
    throw new Error("Pass --editor cutroom or --editor studio.");
  if (options.scale && (!scale || editor !== "cutroom"))
    throw new Error("Pass --scale 100 or --scale 1000 with --editor cutroom.");
  return measure(editor);
}

async function measure(editor: Editor) {
  const throttle = Number(options.throttle);
  const runs = Number(options.runs);
  const port = Number(options.port);
  const dir = resolve(options.dir!);
  const master = join(
    dir,
    [
      "master",
      scale,
      options.grade && "graded",
      options["pipeline-compatible"] && "pipeline",
      options.bus && "bus",
    ]
      .filter(Boolean)
      .join("-"),
  );
  if (!existsSync(join(master, "index.html"))) {
    console.log("Making the project…");
    if (scale)
      execFileSync(
        "bun",
        ["scripts/scale-performance-project.ts", master, String(scale)],
        {
          stdio: "inherit",
        },
      );
    else
      await makeProject(master, options.grade, options["pipeline-compatible"]);
    if (options.bus) {
      const index = join(master, "index.html");
      const html = await readFile(index, "utf8");
      await writeFile(
        index,
        html.replace(
          '<audio id="music" class="clip"',
          `<hf-audio-group id="bed" data-label="Bed" data-volume="0.8" data-fx-chain='{"version":1,"nodes":[{"id":"n1","type":"compressor","params":{}}]}'></hf-audio-group>\n<audio id="music" data-audio-group="bed" class="clip"`,
        ),
      );
    }
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
    scale,
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
        `--ozone-platform=${process.env.WAYLAND_DISPLAY ? "wayland" : "x11"}`,
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        `--class=${marker}`,
      ],
    });
    if (editor === "cutroom") {
      await context.addInitScript((enabled) => {
        if (window === window.top)
          localStorage.setItem("cutroom.footagePipeline", String(enabled));
      }, options.pipeline === true);
    }
    if (options.mixer) {
      await context.addInitScript(() => {
        if (window === window.top)
          sessionStorage.setItem("cutroom.mixer", "true");
      });
    }
    const decoder = await context.newPage();
    await decoder.goto("about:blank");
    const ui = adapter(editor);
    const opens = [];
    let page: Page | undefined;
    for (let open = 0; open < (scale ? 1 : 3); open++) {
      await page?.close();
      page = await context.newPage();
      opens.push(await openToPicture(page, ui, url, decoder));
    }
    console.log(`  opens: ${JSON.stringify(opens)}`);
    page = page!;
    await page.bringToFront();
    const cdp = await page.context().newCDPSession(page);
    const throttled = await throttleAll(page, cdp, throttle);
    const footage = {
      pipeline:
        editor === "cutroom"
          ? await page.locator(".edit-stage").getAttribute("data-pipeline")
          : null,
      run,
      opens,
      throttledTargets: throttled,
      scrub: await step("scrub", () => scrub(page, ui, cdp, decoder)),
      playback: await step("playback", () =>
        playback(page, ui, cdp, decoder, scale === 100 ? 11 : 22),
      ),
      playbackLater: scale
        ? await step("playbackLater", () =>
            playback(page, ui, cdp, decoder, scale === 100 ? 37 : 259),
          )
        : null,
    };
    const full = !scale && !options["footage-only"] && !options["ripple-only"];
    const result = {
      ...footage,
      zoom: full ? await step("zoom", () => zoom(page, ui)) : null,
      razor: full
        ? await step("razor", () => edits(page, ui, cdp, decoder, "razor"))
        : null,
      rippleDelete: options["footage-only"]
        ? null
        : await step("rippleDelete", () =>
            edits(page, ui, cdp, decoder, "ripple"),
          ),
      trim: full
        ? await step("trim", () => drag(page, ui, cdp, decoder, "trim"))
        : null,
      move: full
        ? await step("move", () => drag(page, ui, cdp, decoder, "move"))
        : null,
      agentFile: full
        ? await step("agentFile", () =>
            agentEdits(page, ui, cdp, decoder, project, "file"),
          )
        : null,
      agentMcp:
        full && mcp
          ? await step("agentMcp", () =>
              agentEdits(page, ui, cdp, decoder, project, "mcp", mcp),
            )
          : null,
      memory: {
        browserMB: await treePss(await browserPid(marker)),
        serverMB: await treePss(server.child.pid!),
      },
    };
    const slider =
      editor === "cutroom" && options.slider
        ? await step("slider", () => gradeSlider(page, ui, cdp, decoder)).catch(
            (error: unknown) => {
              console.warn("The grade slider measurement failed.", error);
              return null;
            },
          )
        : null;
    // The tab that reads screencast JPEGs can retain hundreds of MiB. Take
    // another sample after its renderer has had time to exit.
    await decoder.close();
    await sleep(500);
    const browserAfterCaptureMB = await treePss(await browserPid(marker));
    await mcp?.close();
    return {
      ...result,
      memory: { ...result.memory, browserAfterCaptureMB },
      slider,
    };
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
    picture = decoded.find((p) => p.number === sourceFrame(0))?.time ?? null;
  }
  await cast.stop();
  await cdp.detach();
  if (picture === null) throw new Error("The first picture never showed.");
  return { picture: picture - start, timeline: timeline - start };
}

/** Seeks into a shot, then waits for its source picture. */
async function seekToShot(
  page: Page,
  ui: Adapter,
  cdp: CDPSession,
  decoder: Page,
  shot: number,
  fraction = 0.5,
) {
  const cast = await screencast(cdp);
  const first = sourceFrame(shot);
  const end = first + shotFrames(shot);
  const layout = shots && shots[shot];
  const offset = Math.floor(shotFrames(shot) * fraction);
  let pressed = 0;
  if (layout) {
    // At Fit a shot can be narrower than two pixels. Enter the exact frame so the
    // click position or current ruler zoom cannot land on a different shot.
    const frame = layout.start + offset;
    const seconds = Math.floor(frame / fps);
    const digits = [0, Math.floor(seconds / 60), seconds % 60, frame % fps]
      .map((part) => String(part).padStart(2, "0"))
      .join("");
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page
      .getByRole("textbox", { name: "Go to time" })
      .pressSequentially(digits);
    pressed = Date.now();
    await page.keyboard.press("Enter");
  } else {
    const box = (await ui.clip(page, `shot-${shot}`).boundingBox())!;
    await page.mouse.click(box.x + box.width * fraction, await ui.rulerY(page));
  }
  const inShot = (number: number | null) =>
    layout
      ? number === first + offset
      : number !== null && number >= first && number < end;
  let picture = await waitPicture(
    page,
    ui,
    cast,
    decoder,
    inShot,
    10_000,
    pressed,
  );
  await cast.stop();
  if (!picture && layout) {
    // JPEG screencasts can lose a marker bit. Confirm the parked picture with a
    // full-size PNG before treating an exact seek as a missed frame.
    const pixels = (await page.screenshot()).toString("base64");
    const [parked] = await decode(
      decoder,
      [{ time: Date.now(), data: pixels, deviceWidth: viewport.width }],
      await ui.pictureBox(page),
    );
    if (parked && inShot(parked.number)) {
      console.warn(
        `Shot ${shot}: confirmed the parked picture in a full-size PNG.`,
      );
      picture = parked;
    }
  }
  if (!picture) {
    const shown = await decode(
      decoder,
      cast.frames.slice(-12),
      await ui.pictureBox(page),
    );
    const drawn = await page
      .locator(".edit-pipeline")
      .getAttribute("data-frame", { timeout: 300 })
      .catch(() => null);
    throw new Error(
      `Seeking into shot ${shot} (media frames ${first} to ${end - 1}) saw ${shown.map((frame) => frame.number).join(", ")}; playhead ${await ui.playhead(page)}, pipeline frame ${drawn}.`,
    );
  }
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

/** A 3 s ruler drag across cuts, about 60 pointer moves a second. */
async function scrub(page: Page, ui: Adapter, cdp: CDPSession, decoder: Page) {
  await ui.fit(page);
  await sleep(800);
  const first = ui.clip(page, scale ? "shot-6" : "shot-10");
  await seekToShot(page, ui, cdp, decoder, scale ? 6 : 10, 0.1);
  if (scale) {
    // At Fit seven cuts can be only a dozen pixels at 1,000 clips. Match the drag
    // distance at both sizes, using the playhead as the zoom anchor.
    for (let step = 0; step < 40; step++) {
      if (((await first.boundingBox())?.width ?? 0) >= 80) break;
      await page.keyboard.press("Control+=");
      await sleep(60);
    }
    await sleep(450);
  }
  const from = (await first.boundingBox())!;
  const to = (await ui
    .clip(page, scale ? "shot-13" : "shot-40")
    .boundingBox())!;
  if (scale && (from.width < 75 || to.x >= viewport.width))
    throw new Error("The ruler drag does not fit at the requested zoom.");
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
    distance: to.x - from.x,
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
  shot: number,
) {
  if (scale) await ui.fit(page);
  await seekToShot(
    page,
    ui,
    cdp,
    decoder,
    shot,
    scale && shot === 259 ? 12.5 / shotFrames(shot) : 0.1,
  );
  const initial = await ui.playhead(page);
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
  const final = await ui.playhead(page);
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
  return {
    composited: composited.length,
    timelineFramesPerSecond: (final - initial) / ((end - start + 500) / 1000),
    displayFrame: display,
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

/** Each input is timestamped before dispatch. The first composited colour change counts. */
async function gradeSlider(
  page: Page,
  ui: Adapter,
  cdp: CDPSession,
  decoder: Page,
) {
  await seekToShot(page, ui, cdp, decoder, 22, 0.1);
  await ui.clip(page, "shot-22").click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();
  const control = inspector.getByRole("slider", { name: "Exposure" });
  await control.scrollIntoViewIfNeeded();
  const box = (await control.boundingBox())!;
  const y = box.y + box.height / 2;
  const picture = await ui.pictureBox(page);
  const cast = await screencast(cdp);
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await sleep(300);
  const inputs: number[] = [];
  for (let i = 0; i < 12; i++) {
    inputs.push(Date.now());
    await page.mouse.move(box.x + box.width * (0.25 + 0.033 * i), y);
    await sleep(80);
  }
  const end = Date.now();
  const frames = await decode(decoder, await cast.stop(), picture, true);
  await page.mouse.up();
  return inputs.map((time, i) => {
    const before = frames.findLast((frame) => frame.time < time)?.tone;
    const next = inputs[i + 1] ?? end;
    const after = frames.find(
      (frame) =>
        frame.time >= time &&
        frame.time < next &&
        frame.tone !== undefined &&
        before !== undefined &&
        Math.abs(frame.tone - before) >= 2,
    );
    return after ? after.time - time : null;
  });
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
    const before = await seekToShot(page, ui, cdp, decoder, shot).catch(
      (error: unknown) => {
        if (!options["ripple-only"]) throw error;
        console.warn(error);
        return null;
      },
    );
    if (before === null) {
      samples.push({
        shot,
        timeline: null,
        picture: null,
        undoTimeline: null,
        undoPicture: null,
      });
      continue;
    }
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
    const expected = before + sourceFrame(shot + 1) - sourceFrame(shot);
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
    const expected = before + sourceFrame(shot + 1) - sourceFrame(shot);
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
  scale?: 100 | 1000 | null;
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
    scale: output.scale,
    pipeline: r[0]?.pipeline,
    firstOpenPicture: r[0]?.opens[0]?.picture,
    reopenPicture: stat(pick((x) => x.opens.slice(1).map((o) => o.picture))),
    reopenTimeline: stat(pick((x) => x.opens.slice(1).map((o) => o.timeline))),
    scrubPicturesPerSecond: stat(pick((x) => [x.scrub.picturesPerSecond])),
    scrubGapP95: stat(pick((x) => [x.scrub.gapP95])),
    playPicturesPerSecond: stat(pick((x) => [x.playback.picturesPerSecond])),
    playDropped: stat(pick((x) => [x.playback.dropped])),
    playGapP95: stat(pick((x) => [x.playback.gapP95])),
    playGapMax: stat(pick((x) => [x.playback.gapMax])),
    playLaterPicturesPerSecond: stat(
      pick((x) => [x.playbackLater?.picturesPerSecond]),
    ),
    playLaterGapMax: stat(pick((x) => [x.playbackLater?.gapMax])),
    playLateGaps: stat(pick((x) => [x.playback.lateGaps])),
    playEditorFrameP95: stat(pick((x) => [x.playback.editorFrameP95])),
    zoomFrameP95: stat(pick((x) => [x.zoom?.frameP95])),
    zoomLateFrames: stat(pick((x) => [x.zoom?.lateFrames])),
    razorTimeline: stat(pick((x) => (x.razor ?? []).map((s) => s.timeline))),
    razorUndoTimeline: stat(
      pick((x) => (x.razor ?? []).map((s) => s.undoTimeline)),
    ),
    rippleTimeline: stat(
      pick((x) => (x.rippleDelete ?? []).map((s) => s.timeline)),
    ),
    ripplePicture: stat(
      pick((x) => (x.rippleDelete ?? []).map((s) => s.picture)),
    ),
    undoTimeline: stat(
      pick((x) => (x.rippleDelete ?? []).map((s) => s.undoTimeline)),
    ),
    undoPicture: stat(
      pick((x) => (x.rippleDelete ?? []).map((s) => s.undoPicture)),
    ),
    trimFrameP95: stat(pick((x) => (x.trim ?? []).map((s) => s.frameP95))),
    trimPicturesWhileDragging: stat(
      pick((x) => (x.trim ?? []).map((s) => s.picturesWhileDragging)),
    ),
    moveFrameP95: stat(pick((x) => (x.move ?? []).map((s) => s.frameP95))),
    agentFilePicture: stat(
      pick((x) => (x.agentFile ?? []).map((s) => s.picture)),
    ),
    agentFileUndoPicture: stat(
      pick((x) => (x.agentFile ?? []).map((s) => s.undoPicture)),
    ),
    agentMcpPicture: stat(
      pick((x) => (x.agentMcp ?? []).map((s) => s.picture)),
    ),
    agentMcpUndoPicture: stat(
      pick((x) => (x.agentMcp ?? []).map((s) => s.undoPicture)),
    ),
    gradePointerToPicture: stat(pick((x) => x.slider ?? [])),
    browserMB: stat(pick((x) => [x.memory.browserMB])),
    browserAfterCaptureMB: stat(pick((x) => [x.memory.browserAfterCaptureMB])),
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
