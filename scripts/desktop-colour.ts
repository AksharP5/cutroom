// Checks the desktop viewer's video colours on this machine's GPU. CI has no GPU, so run it
// locally after changing Electron, its switches, or the preview's video drawing:
//   bun scripts/desktop-colour.ts
// It opens a Cutroom window with its own data folder and ports, and exits non-zero on a mismatch.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { z } from "zod";

type Rgb = [number, number, number];
const root = resolve(import.meta.dir, "..");
const colours: Rgb[] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [192, 128, 96],
];
// Chromium's colour-managed drawing of each source, as in tests/export-colour.test.ts.
// BT.709 draws the bars unchanged. SMPTE 170M also converts the narrower gamut to sRGB, which
// the playing video does; the paused picture is a canvas copy that Chromium leaves unconverted.
const sources = [
  {
    name: "BT.709 1280x720",
    size: [1280, 720],
    encode:
      "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
    expected: { paused: colours, playing: colours },
  },
  {
    name: "SMPTE 170M 640x360",
    size: [640, 360],
    encode:
      "scale=out_color_matrix=bt601:out_range=tv,format=yuv420p,setparams=colorspace=smpte170m:color_primaries=smpte170m:color_trc=smpte170m:range=tv",
    expected: {
      paused: colours,
      playing: [
        [248, 36, 0],
        [63, 251, 0],
        [26, 34, 254],
        [187, 128, 93],
      ] satisfies Rgb[],
    },
  },
] as const;
// 4:2:0 encoding and Chromium's rounding move flat bars by up to 3. The fault this guards
// against, BT.709 drawn with the BT.601 matrix, moves them by 20 or more.
const tolerance = 6;

async function run(args: string[], stdin?: Uint8Array) {
  const child = Bun.spawn(args, {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [bytes, error, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args[0]} failed: ${error}`);
  return new Uint8Array(bytes);
}

function freePort() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const { port } = server;
  void server.stop(true);
  return port;
}

async function waitFor<T>(attempt: () => Promise<T | undefined>, what: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const value = await attempt().catch(() => undefined);
    if (value) return value;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

await run([process.execPath, join(root, "scripts/desktop.ts"), "--build-only"]);
const work = await mkdtemp(join(tmpdir(), "cutroom-desktop-colour-"));
const port = freePort();
const debugPort = freePort();
const base = `http://127.0.0.1:${port}`;
const electron = Bun.spawn(
  [
    join(root, "node_modules/electron/dist/electron"),
    `--remote-debugging-port=${debugPort}`,
    join(root, "dist-desktop/main.cjs"),
  ],
  {
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      CUTROOM_ROOT: root,
      CUTROOM_BUN_PATH: process.execPath,
      CUTROOM_DATA_DIR: join(work, "data"),
      CUTROOM_PORT: String(port),
      CUTROOM_MUTE_AUDIO: "1",
      ELECTRON_RUN_AS_NODE: undefined,
    },
  },
);

let failed = false;
try {
  await waitFor(async () => (await fetch(`${base}/health`)).ok, "the server");
  const browser = await waitFor(
    () => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`),
    "the desktop window",
  );
  const page = await waitFor(
    async () =>
      browser
        .contexts()[0]
        ?.pages()
        .find((p) => p.url().startsWith(base)),
    "the editor",
  );
  const capture = await page.evaluate(
    () =>
      typeof Reflect.get(
        CanvasRenderingContext2D.prototype,
        "drawElementImage",
      ) === "function" &&
      typeof Reflect.get(HTMLCanvasElement.prototype, "requestPaint") ===
        "function",
  );
  if (!capture)
    throw new Error("Electron's adjustment grade capture is unavailable.");
  // This check exercises Chromium's native video uploads and the desktop colour switch.
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("cutroom.footagePipeline", "false");
  });
  for (const source of sources) {
    const response = await fetch(`${base}/api/cutroom/projects`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ name: `Colour ${source.name}` }),
    });
    if (!response.ok) throw new Error(await response.text());
    const project = z
      .object({ id: z.string(), path: z.string() })
      .parse(await response.json());
    const [width, height] = source.size;
    const bars = colours
      .map(
        (rgb, at) =>
          `color=c=0x${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}:s=${width / colours.length}x${height}:d=4[c${at}]`,
      )
      .join(";");
    await run([
      "ffmpeg",
      ...["-v", "error", "-nostdin", "-f", "lavfi", "-i"],
      `${bars};${colours.map((_, at) => `[c${at}]`).join("")}hstack=inputs=${colours.length},format=rgb24`,
      ...["-r", "30", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "8"],
      ...["-vf", source.encode, join(project.path, "bars.mp4")],
    ]);
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head><body><main data-composition-id="main" data-width="${width}" data-height="${height}" data-fps="30" data-duration="4" style="position:relative;overflow:hidden;width:${width}px;height:${height}px"><video id="bars" src="bars.mp4" muted data-start="0" data-duration="4" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video></main></body></html>`,
    );
    await page.goto(`${base}/#project/${project.id}`);
    await page.waitForFunction(
      () =>
        document.querySelector(".edit-stage")?.getAttribute("data-handoff") ===
        "showing",
      null,
      { timeout: 60_000 },
    );
    const frame = page.frames().find((f) => f.url().includes("/api/isolated/"));
    const box = await (await frame?.frameElement())?.boundingBox();
    if (!box) throw new Error("The viewer has no preview frame.");
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    // The screenshot is the window's composited output, the picture the editor shows.
    const sample = async () => {
      const pixels = await run(
        [
          "ffmpeg",
          "-v",
          "error",
          "-i",
          "-",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-",
        ],
        await page.screenshot(),
      );
      return colours.map((_, at) => {
        const x = Math.round(box.x + ((at + 0.5) * box.width) / colours.length);
        const y = Math.round(box.y + box.height / 2);
        const offset = (y * viewport.width + x) * 3;
        return [...pixels.subarray(offset, offset + 3)];
      });
    };
    await page.waitForTimeout(1500);
    const paused = await sample();
    await page.keyboard.press("Space");
    await page.waitForTimeout(1200);
    const playing = await sample();
    await page.keyboard.press("k");
    for (const [state, drawn] of [
      ["paused", paused],
      ["playing", playing],
    ] as const) {
      const expected = source.expected[state];
      const worst = Math.max(
        ...drawn.flatMap((rgb, at) =>
          rgb.map((v, c) => Math.abs(v - expected[at][c])),
        ),
      );
      const ok = worst <= tolerance;
      failed ||= !ok;
      console.log(
        `${ok ? "ok  " : "FAIL"} ${source.name} ${state}: off by ${worst}. drew ${JSON.stringify(drawn)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }
  await browser.close();
} finally {
  electron.kill("SIGTERM");
  await electron.exited;
  await rm(work, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
