import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { agentSessionSchema } from "../src/shared/agent";

const appArgument = process.argv.indexOf("--app");
const appRoot = resolve(
  appArgument < 0
    ? import.meta.dir + "/.."
    : (process.argv[appArgument + 1] ?? ""),
);
const outputArgument = process.argv.indexOf("--output");
const output = resolve(
  outputArgument < 0
    ? "artifacts/ui-performance.json"
    : (process.argv[outputArgument + 1] ?? ""),
);
const port = Number(process.env.CUTROOM_BENCH_PORT ?? 4324);
const origin = `http://127.0.0.1:${port}`;
const root = await mkdtemp(join(tmpdir(), "cutroom-bench-"));
const dataDir = join(root, "data");
const bundledBun = join(appRoot, "../runtime/bin/bun");
const bun = (await Bun.file(bundledBun).exists())
  ? bundledBun
  : process.execPath;
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);
let backend: ReturnType<typeof Bun.spawn> | undefined;
async function startBackend() {
  backend = Bun.spawn([bun, join(appRoot, "src/server/index.ts")], {
    cwd: appRoot,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...environment,
      CUTROOM_PORT: String(port),
      CUTROOM_DATA_DIR: dataDir,
      CUTROOM_PROJECTS_DIR: join(root, "projects"),
      HYPERFRAMES_NO_TELEMETRY: "1",
    },
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null)
      throw new Error(`Benchmark backend exited with ${backend.exitCode}.`);
    if (
      await fetch(`${origin}/health`).then(
        (response) => response.ok,
        () => false,
      )
    )
      return;
    await Bun.sleep(50);
  }
  throw new Error("Benchmark server did not start.");
}
async function stopBackend() {
  if (!backend) return;
  backend.kill("SIGTERM");
  const timeout = setTimeout(() => backend?.kill("SIGKILL"), 10_000);
  await backend.exited;
  clearTimeout(timeout);
  backend = undefined;
}
async function request(path: string, body?: unknown, method = "POST") {
  const response = await fetch(
    `${origin}/api/cutroom${path}`,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
  return response.json();
}
const browser = await chromium.launch({
  executablePath: process.env.CUTROOM_BROWSER_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--mute-audio"],
});
try {
  await startBackend();
  const project = ProjectSchema.parse(
    await request("/projects", {
      name: "Large editing session",
      duration: 600,
    }),
  );
  const source = SourceSchema.parse(
    await request(`/projects/${project.id}/source`),
  );
  const audio =
    '<audio id="speech" class="clip" src="assets/speech.wav" data-start="0" data-duration="600" data-track-index="4" muted></audio>';
  const clips = Array.from(
    { length: 100 },
    (_, index) =>
      `<div id="clip-${index}" class="clip" data-start="${index * 5}" data-duration="5" data-track-index="3" style="position:absolute;left:9%;top:65%;font-size:28px">Scene ${index + 1}</div>`,
  ).join("");
  await request(
    `/projects/${project.id}/source`,
    {
      path: "index.html",
      expectedVersion: source.version,
      content: source.content.replace("</main>", `${audio}${clips}</main>`),
    },
    "PUT",
  );
  await mkdir(join(project.path, "assets"), { recursive: true });
  const ffmpeg = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono",
      "-t",
      "1",
      "-y",
      join(project.path, "assets/speech.wav"),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if ((await ffmpeg.exited) !== 0)
    throw new Error(await new Response(ffmpeg.stderr).text());
  await request(`/projects/${project.id}/transcripts/import`, {
    sourceFile: "index.html",
    mediaPath: "assets/speech.wav",
    elementId: "speech",
    language: "en",
    words: Array.from({ length: 10_000 }, (_, index) => ({
      id: `word-${index}`,
      text: `word${index}`,
      start: index * 0.05,
      end: index * 0.05 + 0.04,
    })),
  });
  await stopBackend();
  const now = new Date().toISOString();
  const session = agentSessionSchema.parse({
    id: crypto.randomUUID(),
    provider: "codex",
    projectId: project.id,
    title: "A representative edit session",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    messages: Array.from({ length: 200 }, (_, index) => ({
      id: crypto.randomUUID(),
      role: index % 2 ? "assistant" : "user",
      text:
        index % 2
          ? `Updated scene ${index}.\n\n${"The composition uses timed clips and a clear sequence. ".repeat(12)}\n\n- Preview remains local.\n- Source media is preserved.`
          : `Please refine the timing and layout of scene ${index}.`,
      createdAt: now,
      status: "complete",
    })),
  });
  await writeFile(
    join(dataDir, "agents.json"),
    JSON.stringify({ version: 1, sessions: [session] }),
  );
  await startBackend();
  const results = [];
  for (let run = 0; run < 3; run++) {
    const context = await browser.newContext({
      viewport: { width: 1720, height: 1050 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let phase = "initial";
    const requests: { phase: string; path: string; bytes: number }[] = [];
    const reads: Promise<void>[] = [];
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (
        !/\/api\/cutroom\/projects\/[^/]+\/(document|notebook|transcripts|media)$/.test(
          path,
        )
      )
        return;
      const at = phase;
      reads.push(
        response
          .body()
          .then((body) => {
            requests.push({
              phase: at,
              path: path.split("/").at(-1) ?? path,
              bytes: body.length,
            });
          })
          .catch(() => {}),
      );
    });
    const started = performance.now();
    await page.goto(`${origin}/#project/${project.id}?v=1&rc=1&tv=1`);
    await expect(
      page
        .frameLocator("hyperframes-player iframe")
        .last()
        .locator("#headline"),
    ).toHaveText(project.name);
    await expect(page.locator(".chat-message")).toHaveCount(200);
    const readyMs = performance.now() - started;
    phase = "drawing";
    await page.getByRole("button", { name: "Draw (D)", exact: true }).click();
    const drawing = page.getByLabel("Draw on the composition");
    const bounds = await drawing.boundingBox();
    if (!bounds) throw new Error("The drawing surface is unavailable.");
    await page.mouse.move(bounds.x + 20, bounds.y + 20);
    await page.mouse.down();
    const draw = await page.evaluate(async () => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        ".editor-review-canvas",
      );
      if (!canvas) throw new Error("The drawing canvas is missing.");
      let backingResizes = 0;
      const observer = new MutationObserver((records) => {
        backingResizes += records.length;
      });
      observer.observe(canvas, {
        attributes: true,
        attributeFilter: ["width", "height"],
      });
      const box = canvas.getBoundingClientRect();
      const start = performance.now();
      for (let index = 0; index < 1000; index++)
        canvas.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerId: 1,
            pointerType: "mouse",
            buttons: 1,
            clientX: box.x + 20 + (index % Math.max(1, box.width - 40)),
            clientY: box.y + 20 + (index % Math.max(1, box.height - 40)),
          }),
        );
      const eventsMs = performance.now() - start;
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      observer.disconnect();
      return { eventsMs, paintMs: performance.now() - start, backingResizes };
    });
    await page.mouse.up();
    await page
      .getByRole("button", { name: "Cancel note", exact: true })
      .click();
    await page.getByLabel("Message your agent").fill("A short draft");
    phase = "note-update";
    const updated = page.waitForResponse((response) =>
      /\/projects\/[^/]+\/(document|notebook)$/.test(
        new URL(response.url()).pathname,
      ),
    );
    const updateStart = performance.now();
    await request(`/projects/${project.id}/annotations`, {
      kind: "comment",
      body: `Review ${run}`,
      time: 0,
    });
    await updated;
    await expect(
      page.getByText(`Review ${run}`, { exact: true }),
    ).toBeVisible();
    const noteUpdateMs = performance.now() - updateStart;
    phase = "script-open";
    const scriptStart = performance.now();
    await page.getByRole("button", { name: "Script", exact: true }).click();
    const words = page.locator(".transcript-words button");
    await expect(words.first()).toHaveText("word0");
    const scriptOpenMs = performance.now() - scriptStart;
    phase = "selection";
    await words.first().click();
    const selectStart = performance.now();
    await expect(words.last()).toHaveText("word9999");
    await words.last().click({ modifiers: ["Shift"] });
    await expect(page.locator(".word-selected")).toHaveCount(10_000);
    const selectAllMs = performance.now() - selectStart;
    phase = "typing";
    const composer = page.getByLabel("Message your agent");
    await composer.fill("");
    const typingStart = performance.now();
    const text =
      "Give the opening more room. Keep the caption clear and bring the scene in a little later.";
    const inputFrames = page.evaluate(
      (count) =>
        new Promise<number[]>((done) => {
          const input = document.querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="Message your agent"]',
          );
          if (!input) throw new Error("Composer missing.");
          const times: number[] = [];
          const finish = () => {
            clearTimeout(timer);
            input.removeEventListener("input", record);
            done(times);
          };
          const record = () => {
            const start = performance.now();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                times.push(performance.now() - start);
                if (times.length === count) finish();
              }),
            );
          };
          const timer = setTimeout(finish, 10_000);
          input.addEventListener("input", record);
        }),
      text.length,
    );
    await composer.pressSequentially(text);
    await expect(composer).toHaveValue(text);
    const typingMs = performance.now() - typingStart;
    const typingFrameMs = await inputFrames;
    expect(typingFrameMs).toHaveLength(text.length);
    await Promise.all(reads);
    results.push({
      readyMs,
      draw,
      noteUpdateMs,
      scriptOpenMs,
      selectAllMs,
      typingMs,
      typingFrameMs,
      requests,
      errors,
    });
    if (errors.length) throw new Error(errors.join("\n"));
    await context.close();
  }
  const report = {
    date: new Date().toISOString(),
    appRoot,
    runtime: Bun.version,
    workload: { clips: 100, words: 10_000, messages: 200, runs: 3 },
    results,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  await stopBackend();
  await rm(root, { recursive: true, force: true });
}
