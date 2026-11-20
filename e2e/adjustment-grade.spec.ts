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

async function viewerPixels(page: Page) {
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
    { source: png.toString("base64"), points },
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
  const result = await request.post("/api/projects/" + project.id + "/export", {
    data: {
      format: "mp4",
      quality: "high",
      range: { start: at, end: at + 1 },
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
  const errors = points.flatMap(([x, y], i) => {
    const offset = (Math.round(y * height) * width + Math.round(x * width)) * 3;
    return graded[i]!.map((value, channel) =>
      Math.abs(value - stdout[offset + channel]!),
    );
  });
  const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length;
  console.log("Adjustment layer RGB error", {
    mean,
    max: Math.max(...errors),
  });
  expect(mean).toBeLessThanOrEqual(3);
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
