import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { ExportJobSchema } from "../src/shared/export";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { test, expect } from "./fixtures";
import { seekFrame } from "./position-helpers";
import { waitForPreview } from "./preview-ready";

const ffmpeg = promisify(execFile);
const width = 640;
const height = 360;
const at = 45;
const points = [
  [0.5, 0.5], // Both dissolving pictures.
  [0.12, 0.13], // The title beneath the adjustment.
  [0.88, 0.13], // The title above it.
] as const;

async function projectWithAdjustment(
  request: APIRequestContext,
  lowerTitle = true,
  dissolve = true,
) {
  const response = await request.post("/api/cutroom/projects", {
    data: { name: "Adjustment grade", width, height, duration: 3 },
  });
  const project = ProjectSchema.parse(await response.json());
  await Promise.all(
    [
      ["a", "d84b49"],
      ["b", "405ac5"],
    ].map(([name, colour]) =>
      ffmpeg("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=0x" + colour + ":s=640x360:r=30:d=4",
        "-vf",
        "format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        "veryfast",
        join(project.path, name + ".mp4"),
      ]),
    ),
  );
  await writeFile(
    join(project.path, "index.html"),
    "<!doctype html><html><head><style>html,body{margin:0;background:#000}main{position:relative;width:640px;height:360px}</style></head><body>" +
      '<main data-composition-id="main" data-width="640" data-height="360" data-duration="3" data-fps="30">' +
      '<video id="a" muted src="a.mp4" data-start="0" data-duration="1.5" data-media-start="1" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" data-color-grading=\'{"adjust":{"temperature":0.2}}\'></video>' +
      '<video id="b" muted src="b.mp4" data-start="1.5" data-duration="1.5" data-media-start="1" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>' +
      (lowerTitle
        ? '<div id="lower" class="clip" data-start="0" data-duration="3" data-track-index="1" style="position:absolute;top:0;left:0;width:140px;height:90px;background:#90d030">Lower title</div>'
        : "") +
      '<div id="look" class="clip" data-cutroom-adjustment data-start="0.5" data-duration="2" data-track-index="2" data-color-grading=\'{"adjust":{"exposure":-1}}\'></div>' +
      '<div id="upper" class="clip" data-start="0" data-duration="3" data-track-index="3" style="position:absolute;top:0;right:0;width:140px;height:90px;background:#ec40a0">Upper title</div>' +
      "</main></body></html>",
  );
  if (!dissolve) return project;
  const route = "/api/cutroom/projects/" + project.id;
  const view = TimelineViewSchema.parse(
    await (await request.get(route + "/timeline")).json(),
  );
  const change = await request.post(route + "/commands", {
    data: {
      expectedRevision: view.revision,
      commands: [
        {
          type: "setTransition",
          from: "a",
          to: "b",
          transition: {
            kind: "dissolve",
            alignment: "center",
            duration: 12,
          },
        },
      ],
    },
  });
  expect(change.ok(), await change.text()).toBe(true);
  return project;
}

type SamplePoints = readonly (readonly [number, number])[];

async function viewerPixels(page: Page, samplePoints: SamplePoints = points) {
  const png = await page.locator(".edit-picture").screenshot();
  return page.evaluate(
    async ({ source, points }) => {
      const image = new Image();
      image.src = "data:image/png;base64," + source;
      await image.decode();
      const context = new OffscreenCanvas(image.width, image.height).getContext(
        "2d",
      )!;
      context.drawImage(image, 0, 0);
      return points.map(([x, y]) => [
        ...context
          .getImageData(
            Math.round(image.width * x),
            Math.round(image.height * y),
            1,
            1,
          )
          .data.slice(0, 3),
      ]);
    },
    { source: png.toString("base64"), points: samplePoints },
  );
}

function disableNativeAdjustment() {
  Object.defineProperty(
    CanvasRenderingContext2D.prototype,
    "drawElementImage",
    { value: undefined },
  );
  Object.defineProperty(HTMLCanvasElement.prototype, "requestPaint", {
    value: undefined,
  });
  if (self === top) localStorage.setItem("cutroom.footagePipeline", "true");
}

const browserPath =
  process.env.CUTROOM_BROWSER_PATH ??
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

test.use({
  launchOptions: {
    executablePath: browserPath,
    args: [
      "--no-sandbox",
      "--mute-audio",
      "--enable-blink-features=CanvasDrawElement",
    ],
  },
});

async function exportedPixels(
  request: APIRequestContext,
  project: { id: string; path: string },
  frame: number,
  samplePoints: SamplePoints,
) {
  const result = await request.post("/api/projects/" + project.id + "/export", {
    data: {
      format: "mp4",
      quality: "high",
      range: { start: frame, end: frame + 1 },
      directory: project.path,
      filename: "grade.mp4",
    },
  });
  expect(result.ok(), await result.text()).toBe(true);
  const { jobId } = await result.json();
  await request.get("/api/render/" + jobId + "/progress");
  const job = ExportJobSchema.parse(
    await (await request.get("/api/render/" + jobId)).json(),
  );
  expect(job.status, job.error ?? "MP4").toBe("complete");
  const { stdout } = await ffmpeg(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      join(project.path, "grade.mp4"),
      "-frames:v",
      "1",
      "-vf",
      "scale=in_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 1024 ** 2 },
  );
  return samplePoints.map(([x, y]) => {
    const offset = (Math.round(y * height) * width + Math.round(x * width)) * 3;
    return [...stdout.subarray(offset, offset + 3)];
  });
}

test("grades the dissolve and lower title in native preview and MP4", async ({
  page,
  request,
}) => {
  const project = await projectWithAdjustment(request);
  await page.addInitScript(() => {
    if (self === top) localStorage.setItem("cutroom.footagePipeline", "false");
  });
  await page.goto("/#project/" + project.id);
  await waitForPreview(page, { timing: true });
  await seekFrame(page, at);
  await expect
    .poll(async () => (await viewerPixels(page))[1])
    .toEqual([72, 104, 24]);
  const graded = await viewerPixels(page);
  expect(graded[0]![0]).toBeGreaterThan(35);
  expect(graded[0]![2]).toBeGreaterThan(35);
  expect(graded[1]).toEqual([72, 104, 24]);
  expect(graded[2]).toEqual([236, 64, 160]);
  const exported = await exportedPixels(request, project, at, points);
  const errors = graded.flatMap((pixel, i) =>
    pixel.map((value, channel) => Math.abs(value - exported[i]![channel]!)),
  );
  const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length;
  console.log("Adjustment layer RGB error", {
    mean,
    max: Math.max(...errors),
  });
  expect(mean).toBeLessThanOrEqual(3);
  expect(Math.max(...errors)).toBeLessThanOrEqual(6);
});

test("a grade in a mounted scene composes with a parent grade", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Nested adjustment", width, height, duration: 2 },
      })
    ).json(),
  );
  await Promise.all([
    writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><body style="margin:0">
<main data-composition-id="main" data-no-timeline data-duration="2" data-fps="30" data-width="640" data-height="360" style="position:relative;width:640px;height:360px">
  <div id="base" class="clip" data-start="0" data-duration="2" data-track-index="0" style="position:absolute;inset:0;background:#40a0c0"></div>
  <div id="mount" class="clip" data-composition-id="nested" data-composition-src="nested.html" data-start="0.5" data-duration="1.5" data-track-index="1" data-width="320" data-height="180" style="position:absolute;top:0;left:0;width:320px;height:180px"></div>
  <div id="parent-look" class="clip" data-cutroom-adjustment data-start="0.8" data-duration="0.8" data-track-index="2" data-color-grading='{"adjust":{"exposure":-1}}'></div>
  <div id="top" class="clip" data-start="0" data-duration="2" data-track-index="3" style="position:absolute;top:0;right:0;width:130px;height:90px;background:#f0c050"></div>
</main></body></html>`,
    ),
    writeFile(
      join(project.path, "nested.html"),
      `<template><div data-composition-id="nested" data-no-timeline data-duration="1.5" data-fps="30" data-width="320" data-height="180" style="position:relative;width:320px;height:180px">
  <div id="nested-base" class="clip" data-start="0" data-duration="1.5" data-track-index="0" style="position:absolute;inset:0;background:#90d030"></div>
  <div id="nested-look" class="clip" data-cutroom-adjustment data-start="0.2" data-duration="0.6" data-track-index="1" data-color-grading='{"adjust":{"exposure":-1}}'></div>
  <div id="nested-top" class="clip" data-start="0" data-duration="1.5" data-track-index="2" style="position:absolute;top:0;right:0;width:115px;height:85px;background:#ec40a0"></div>
</div></template>`,
    ),
  ]);
  await page.addInitScript(() => {
    if (self === top) localStorage.setItem("cutroom.footagePipeline", "false");
  });
  await page.goto("/#project/" + project.id);
  await waitForPreview(page, { timing: true });

  const samples = [
    [0.1, 0.32],
    [0.42, 0.18],
    [0.75, 0.6],
    [0.85, 0.12],
  ] as const;
  const cases = [
    {
      frame: 20,
      pixels: [
        [144, 208, 48],
        [236, 64, 160],
        [64, 160, 192],
        [240, 192, 80],
      ],
    },
    {
      frame: 23,
      pixels: [
        [72, 104, 24],
        [236, 64, 160],
        [64, 160, 192],
        [240, 192, 80],
      ],
    },
    {
      frame: 30,
      pixels: [
        [36, 52, 12],
        [118, 32, 80],
        [32, 80, 96],
        [240, 192, 80],
      ],
    },
    {
      frame: 44,
      pixels: [
        [72, 104, 24],
        [118, 32, 80],
        [32, 80, 96],
        [240, 192, 80],
      ],
    },
  ];
  for (const { frame, pixels } of cases) {
    await seekFrame(page, frame);
    await expect.poll(() => viewerPixels(page, samples)).toEqual(pixels);
  }
  const exported = await exportedPixels(request, project, 30, samples);
  const errors = cases[2]!.pixels.flatMap((pixel, i) =>
    pixel.map((value, channel) => Math.abs(value - exported[i]![channel]!)),
  );
  expect(Math.max(...errors)).toBeLessThanOrEqual(6);
});

test("explains the unavailable preview and still opens the layer's Colour controls", async ({
  page,
  request,
}) => {
  const project = await projectWithAdjustment(request);
  await page.addInitScript(disableNativeAdjustment);
  await page.goto("/#project/" + project.id);
  await waitForPreview(page, { timing: true });
  await seekFrame(page, at);
  await expect(
    page.getByText(
      "This adjustment layer's grade appears in export and in the desktop app.",
    ),
  ).toBeVisible();
  await page.locator('.tl-lanes [data-clip="look"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();
  await expect(
    inspector.getByRole("slider", { name: "Exposure" }),
  ).toBeEnabled();
});

test("grades lower footage in the GPU pipeline without HTML-in-Canvas", async ({
  page,
  request,
}) => {
  const project = await projectWithAdjustment(request, false);
  await page.addInitScript(disableNativeAdjustment);
  await page.goto("/#project/" + project.id);
  await waitForPreview(page, { timing: true });
  await seekFrame(page, 60);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-pipeline",
    "on",
  );
  const graded = await viewerPixels(page);
  await page.keyboard.press("Shift+d");
  await expect
    .poll(async () => (await viewerPixels(page))[0]![2])
    .toBeGreaterThan(graded[0]![2]! + 60);
  const bypassed = await viewerPixels(page);
  const error = graded[0]!.map((value, i) =>
    Math.abs(value - bypassed[0]![i]! * 0.5),
  );
  expect(Math.max(...error)).toBeLessThanOrEqual(2);
  expect(graded[2]).toEqual(bypassed[2]!);
});

test("trims a title under an active grade within the same viewer document", async ({
  page,
  request,
}) => {
  const project = await projectWithAdjustment(request, true, false);
  const route = "/api/cutroom/projects/" + project.id;
  const trim = async (to: number) => {
    const view = TimelineViewSchema.parse(
      await (await request.get(route + "/timeline")).json(),
    );
    const edit = await request.post(route + "/commands", {
      data: {
        expectedRevision: view.revision,
        commands: [
          { type: "trim", clipId: "lower", edge: "end", to, ripple: false },
        ],
      },
    });
    expect(edit.ok(), await edit.text()).toBe(true);
  };
  // Put the track stylesheet in the initial document before measuring an edit.
  await trim(88);
  await page.addInitScript(() => {
    if (self === top) localStorage.setItem("cutroom.footagePipeline", "false");
  });
  await page.goto("/#project/" + project.id);
  await waitForPreview(page, { timing: true });
  await seekFrame(page, 30);
  await expect
    .poll(async () => (await viewerPixels(page))[1])
    .toEqual([72, 104, 24]);
  const frame = page.locator("iframe[data-live]");
  const document = await frame.getAttribute("src");
  const before = await page
    .locator(".edit-stage")
    .getAttribute("data-preview-ready");
  await trim(20);
  await waitForPreview(page, { after: before });
  await expect
    .poll(async () => {
      const [centre, title] = await viewerPixels(page);
      return JSON.stringify(centre) === JSON.stringify(title);
    })
    .toBe(true);
  expect(await frame.getAttribute("src")).toBe(document);
});

test("keeps a mounted scene graded over the GPU footage pipeline", async ({
  page,
  request,
}) => {
  const project = await projectWithAdjustment(request, false, false);
  await Promise.all([
    writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><head><style>html,body{margin:0;background:#000}main{position:relative;width:100%;height:100%}</style></head><body>
<main data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-duration="3" data-fps="30">
  <video id="a" muted src="a.mp4" data-start="0" data-duration="3" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
  <div id="nested" class="clip" data-composition-id="scene" data-composition-src="scene.html" data-start="0" data-duration="3" data-track-index="1" data-width="320" data-height="180" style="position:absolute;top:0;left:0;width:320px;height:180px"></div>
</main></body></html>`,
    ),
    writeFile(
      join(project.path, "scene.html"),
      `<template><div data-composition-id="scene" data-no-timeline data-duration="3" data-width="320" data-height="180" style="position:relative;width:320px;height:180px">
  <div id="scene-picture" class="clip" data-start="0" data-duration="3" data-track-index="0" style="position:absolute;inset:0;background:#90d030"></div>
  <div id="scene-look" class="clip" data-cutroom-adjustment data-start="0.5" data-duration="2" data-track-index="1" data-color-grading='{"adjust":{"exposure":-1}}'></div>
</div></template>`,
    ),
  ]);
  await page.addInitScript(() => {
    if (self === top) localStorage.setItem("cutroom.footagePipeline", "true");
  });
  await page.goto("/#project/" + project.id);
  await seekFrame(page, 30);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-pipeline",
    "on",
  );
  const sample = [[0.1, 0.1]] as const;
  await expect.poll(() => viewerPixels(page, sample)).toEqual([[72, 104, 24]]);
  await page.keyboard.press("Shift+d");
  await expect.poll(() => viewerPixels(page, sample)).toEqual([[144, 208, 48]]);
});
