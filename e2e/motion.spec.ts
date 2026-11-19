import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "./fixtures";
import type { APIRequestContext } from "@playwright/test";
import {
  createPositionProject,
  seekFrame,
  waitFrames,
} from "./position-helpers";
import { MotionSnapshotSchema } from "../src/shared/motion";

const exec = promisify(execFile);
const authored = `<!doctype html><html><head><style>html,body{margin:0;background:#11151b}#card{position:absolute;left:60px;top:100px;width:100px;height:80px;background:#00ff00}#other{position:absolute;left:40px;top:230px;width:80px;height:40px;background:#5577dd}</style><script src="assets/vendor/gsap.min.js"></script></head><body>
<main id="root" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="3">
<div id="card" class="clip" data-start="0" data-duration="3" data-track-index="0" data-label="Moving card"></div>
<div id="other" class="clip" data-start="0" data-duration="3" data-track-index="1" data-label="Other card"></div>
</main><script>
const tl = gsap.timeline({paused:true});
tl.fromTo('#card', { x: 0 }, { x: 200 /* preserve this */, duration: 2, ease: 'none', onComplete: () => {} }, 0);
window.__timelines ??= {};
window.__timelines['main'] = tl;
</script></body></html>`;

test("motion fields keep native Tab focus while a save and fresh source read settle", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(
    request,
    { name: "Motion keyboard editing", width: 640, height: 360, duration: 3 },
    authored,
  );
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="card"]').click();
  const x = page.getByRole("textbox", { name: "Motion 1 to x", exact: true });
  const start = page.getByRole("textbox", {
    name: "Motion 1 position",
    exact: true,
  });
  const duration = page.getByRole("textbox", {
    name: "Motion 1 duration",
    exact: true,
  });
  const ease = page.getByRole("combobox", {
    name: "Motion 1 ease",
    exact: true,
  });
  await expect(x).toHaveValue("200");
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/projects/${project.id}/motion`, async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  try {
    await x.fill("400");
    await x.press("Tab");
    await expect(start).toBeFocused();
    await expect(start).not.toBeEditable();
    await page.keyboard.press("Tab");
    await expect(duration).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(start).toBeFocused();
  } finally {
    release!();
  }
  await expect(start).toBeEditable();
  await expect(start).toBeFocused();
  await start.fill("0.5");
  await start.press("Tab");
  await expect(duration).toBeEditable();
  await expect(duration).toBeFocused();
  await duration.fill("3");
  await duration.press("Tab");
  await expect(ease).toBeFocused();
  await expect(duration).toBeEditable();
  await expect(ease).toBeFocused();
  await expect(x).toHaveValue("400");
  expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
    authored
      .replace("x: 200", "x: 400")
      .replace("duration: 2", "duration: 3")
      .replace("}, 0);", "}, 0.5);"),
  );
});

function greenBox(rgb: Buffer) {
  let left = 640,
    top = 360,
    right = -1,
    bottom = -1;
  for (let y = 0; y < 360; y++)
    for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 3;
      if (rgb[i + 1]! > 180 && rgb[i]! < 70 && rgb[i + 2]! < 70) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  expect(right).toBeGreaterThan(left);
  return { left, top, right, bottom };
}

async function renderMotion(request: APIRequestContext, projectId: string) {
  const response = await request.post(`/api/projects/${projectId}/export`, {
    data: { quality: "draft", filename: "motion.mp4", gpu: false },
  });
  expect(response.ok()).toBe(true);
  const job = z
    .object({ jobId: z.string(), outputPath: z.string() })
    .parse(await response.json());
  await expect
    .poll(
      async () => {
        const state = z
          .object({ status: z.string(), error: z.string().nullish() })
          .parse(await (await request.get(`/api/render/${job.jobId}`)).json());
        if (state.status === "failed")
          throw new Error(state.error ?? "Export failed");
        return state.status;
      },
      { timeout: 100_000 },
    )
    .toBe("complete");
  return job;
}

test("authored motion edits the picture, uses shared Undo/Redo and matches actual MP4 frames", async ({
  page,
  request,
}, info) => {
  test.setTimeout(150_000);
  const project = await createPositionProject(
    request,
    { name: "Authored motion", width: 640, height: 360, duration: 3 },
    authored,
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const evidence =
    process.env.CUTROOM_MOTION_EVIDENCE ?? info.outputPath("evidence");
  await mkdir(evidence, { recursive: true });
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="card"]').click();
  const x = page.getByRole("textbox", { name: "Motion 1 to x", exact: true });
  const left = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#card")
      .evaluate((node) => node.getBoundingClientRect().left);
  await expect(x).toHaveValue("200");
  await seekFrame(page, 30);
  await expect.poll(left).toBe(160);
  await page.screenshot({ path: join(evidence, "before.png") });
  await writeFile(
    join(evidence, "before.html"),
    await readFile(join(project.path, "index.html"), "utf8"),
  );
  await x.fill("400");
  await x.press("Enter");
  await expect(x).toHaveValue("400");
  await expect.poll(left).toBe(260);
  await page.screenshot({ path: join(evidence, "after.png") });
  expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
    authored.replace("x: 200", "x: 400"),
  );
  await writeFile(
    join(evidence, "after.html"),
    await readFile(join(project.path, "index.html"), "utf8"),
  );
  await page.keyboard.press("Control+z");
  await expect(x).toHaveValue("200");
  await expect.poll(left).toBe(160);
  await page.keyboard.press("Control+Shift+z");
  await expect(x).toHaveValue("400");
  await expect.poll(left).toBe(260);
  await page.reload();
  await page.locator('[data-clip="card"]').click();
  await expect(x).toHaveValue("400");
  const frames = [15, 30, 45];
  const preview = new Map<number, ReturnType<typeof greenBox>>();
  for (const frame of frames) {
    await seekFrame(page, frame);
    await expect.poll(left).toBe(60 + (400 * frame) / 60);
    const png = await page.locator("iframe[data-live]").screenshot();
    const decoding = exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        "pipe:0",
        "-vf",
        "scale=640:360",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer" },
    );
    decoding.child.stdin!.end(png);
    preview.set(frame, greenBox((await decoding).stdout));
  }
  const job = await renderMotion(request, project.id);
  const comparison = [];
  for (const frame of frames) {
    const { stdout } = await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        job.outputPath,
        "-vf",
        `select=eq(n\\,${frame})`,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer" },
    );
    const exported = greenBox(stdout);
    const shown = preview.get(frame)!;
    for (const edge of ["left", "top", "right", "bottom"] as const)
      expect(Math.abs(exported[edge] - shown[edge])).toBeLessThanOrEqual(1);
    comparison.push({ frame, preview: shown, exported });
  }
  await exec("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    job.outputPath,
    "-vf",
    "select=eq(n\\,30)",
    "-frames:v",
    "1",
    join(evidence, "export-frame30.png"),
  ]);
  await writeFile(
    join(evidence, "parity.json"),
    JSON.stringify({ project, job, comparison }, null, 2),
  );
});

test("the first scene fade follows its host and matches the exported picture", async ({
  page,
  request,
}, info) => {
  test.setTimeout(150_000);
  const project = await createPositionProject(
    request,
    {
      name: "Scene fade",
      width: 640,
      height: 360,
      duration: 6,
    },
    `<!doctype html><html><head><style>html,body{margin:0;background:#11151b}</style><script src="assets/vendor/gsap.min.js"></script></head><body>
<main data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-fps="30" data-duration="6">
<div id="intro" class="clip" data-composition-id="intro" data-composition-src="compositions/intro.html" data-start="1" data-duration="3" data-track-index="0" data-width="640" data-height="360" data-label="Intro scene"></div>
</main></body></html>`,
  );
  const scene = `<template><div data-composition-id="intro" data-width="640" data-height="360" data-fps="30" data-duration="3" style="position:absolute;inset:0;background:#11151b">
<div id="card" class="clip" data-start="0.5" data-duration="2.5" data-track-index="0" data-label="Scene card" style="position:absolute;left:60px;top:100px;width:100px;height:80px;background:#00ff00"></div>
<script>
const tl = gsap.timeline({ paused: true });
window.__timelines ??= {};
window.__timelines.intro = tl;
</script></div></template>`;
  const file = join(project.path, "compositions", "intro.html");
  await mkdir(join(project.path, "compositions"));
  await writeFile(file, scene);
  const evidence =
    process.env.CUTROOM_FADE_EVIDENCE ?? info.outputPath("evidence");
  await mkdir(evidence, { recursive: true });
  await page.goto(`/#project/${project.id}`);
  const host = page.locator('[data-clip="intro"]');
  await host.dblclick();
  await page.locator('[data-clip="card"]').click();
  const fade = page.getByRole("button", { name: "Add fade in", exact: true });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const frame = page.locator("iframe[data-live]");
  const card = page
    .frameLocator("iframe[data-live]")
    .locator('[data-label="Scene card"]');
  const opacity = () =>
    card.evaluate((element) => Number(getComputedStyle(element).opacity));
  await seekFrame(page, 0);
  await expect(fade).toBeDisabled();
  await seekFrame(page, 36);
  await expect(fade).toBeEnabled();
  await expect.poll(opacity).toBe(1);
  await page.screenshot({ path: join(evidence, "before.png") });
  await seekFrame(page, 30);
  await fade.click();
  await expect(
    inspector.getByRole("textbox", { name: "Motion 1 position" }),
  ).toHaveValue("1 s");
  await expect.poll(opacity).toBe(0);
  const after = scene.replace(
    "window.__timelines ??= {};",
    'tl.from("#card", { opacity: 0, duration: 0.5, ease: "none", immediateRender: false }, 1);\nwindow.__timelines ??= {};',
  );
  expect(await readFile(file, "utf8")).toBe(after);
  await seekFrame(page, 29);
  await expect.poll(opacity).toBe(1);
  await seekFrame(page, 36);
  await expect.poll(opacity).toBeCloseTo(0.4, 2);
  await page.screenshot({ path: join(evidence, "after.png") });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(fade).toBeEnabled();
  await expect.poll(opacity).toBe(1);
  expect(await readFile(file, "utf8")).toBe(scene);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(fade).toBeDisabled();
  await expect.poll(opacity).toBeCloseTo(0.4, 2);
  expect(await readFile(file, "utf8")).toBe(after);

  await page
    .getByRole("navigation", { name: "Composition" })
    .getByRole("button", { name: "Scene fade", exact: true })
    .click();
  await host.click();
  await seekFrame(page, 66);
  await expect.poll(opacity).toBeCloseTo(0.4, 2);
  const start = inspector.getByRole("textbox", { name: "Start", exact: true });
  await start.fill("2s");
  await start.press("Enter");
  await expect(start).toHaveValue("00:00:02:00");
  await seekFrame(page, 96);
  await expect.poll(opacity).toBeCloseTo(0.4, 2);
  expect(await readFile(file, "utf8")).toBe(after);
  await page.screenshot({ path: join(evidence, "after-host-move.png") });

  const sample = async (input: Buffer | string, filter = "") => {
    const decoding = exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        typeof input === "string" ? input : "pipe:0",
        "-vf",
        `${filter}scale=640:360,crop=2:2:100:126`,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer" },
    );
    if (typeof input !== "string") decoding.child.stdin!.end(input);
    const { stdout } = await decoding;
    expect(stdout.length).toBe(12);
    return [...stdout.subarray(0, 3)];
  };
  const shown = await sample(await frame.screenshot());
  expect(shown[1]).toBeGreaterThan(105);
  expect(shown[1]).toBeLessThan(140);
  const job = await renderMotion(request, project.id);
  const select = "select=eq(n\\,96)";
  const exportPixel = await sample(job.outputPath, `${select},`);
  for (const [index, value] of shown.entries())
    expect(Math.abs(value - exportPixel[index]!)).toBeLessThanOrEqual(6);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    job.outputPath,
    "-vf",
    select,
    "-frames:v",
    "1",
    join(evidence, "export-frame96.png"),
  ]);
  await writeFile(
    join(evidence, "pixels.json"),
    JSON.stringify({ frame: 96, shown, export: exportPixel }, null, 2),
  );
});

test("motion follows external edits and selection; dirty code blocks writes and stale UI responses are discarded", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(
    request,
    { name: "Motion conflicts", width: 640, height: 360, duration: 3 },
    authored,
  );
  const path = join(project.path, "index.html");
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="card"]').click();
  const x = page.getByRole("textbox", { name: "Motion 1 to x", exact: true });
  await expect(x).toHaveValue("200");
  await page.getByRole("button", { name: "Open motion source" }).click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n<!-- buffer -->");
  await expect(x).toBeDisabled();
  const changed = authored.replace("x: 200", "x: 250");
  await writeFile(path, changed);
  await expect(
    page.getByText("Save or discard code changes before editing motion."),
  ).toBeVisible();
  await expect(x).toHaveValue("250");
  expect(await readFile(path, "utf8")).toBe(changed);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(x).toBeEnabled();
  // Delay one old clip's read, then move to another before it can answer.
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route(`**/motion?**`, async (route) => {
    if (
      !intercepted &&
      new URL(route.request().url()).searchParams.get("clipId") === "card"
    ) {
      intercepted = true;
      await held;
    }
    await route.continue();
  });
  await writeFile(path, changed.replace("x: 250", "x: 275"));
  await expect.poll(() => intercepted).toBe(true);
  const otherRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/motion") &&
      url.searchParams.get("clipId") === "other"
    );
  });
  await page.locator('[data-clip="other"]').click();
  release!();
  await (await otherRead).finished();
  await waitFrames(page);
  await expect(page.locator(".inspector-motion")).toHaveCount(0);
  await expect(x).toHaveCount(0);
  await page.locator('[data-clip="card"]').click();
  await expect(x).toHaveValue("275");
  const result = await request.get(
    `/api/cutroom/projects/${project.id}/motion?clipId=card`,
  );
  expect(
    MotionSnapshotSchema.parse(await result.json()).animations[0]!.to.x,
  ).toBe(275);
});

test("a motion edit waits for a queued timeline edit and refuses its stale source instead of overwriting it", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(
    request,
    { name: "Queued motion", width: 640, height: 360, duration: 3 },
    authored,
  );
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="card"]').click();
  const motion = page.getByRole("textbox", {
    name: "Motion 1 to x",
    exact: true,
  });
  await expect(motion).toHaveValue("200");
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route(`**/projects/${project.id}/commands`, async (route) => {
    held = true;
    await gate;
    await route.continue();
  });
  const position = page.getByRole("textbox", {
    name: "Position X",
    exact: true,
  });
  await position.fill("10");
  await position.press("Enter");
  await expect.poll(() => held).toBe(true);
  await motion.fill("300");
  await motion.press("Enter");
  release!();
  await expect(
    page.getByText("The source changed. Inspect motion again before editing.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(motion).toHaveValue("200");
  await expect(position).toHaveValue("10 px");
  await expect(motion).toBeEnabled();
  await motion.fill("300");
  await motion.press("Enter");
  await expect(motion).toHaveValue("300");
  await expect(position).toHaveValue("10 px");
  const source = await readFile(join(project.path, "index.html"), "utf8");
  expect(source).toContain("x: 300 /* preserve this */");
});
