import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { ExportJobSchema } from "../src/shared/export";
import { ProjectSchema } from "../src/shared/project";
import { test, expect } from "./fixtures";
import { seekFrame } from "./position-helpers";
import { waitForPreview } from "./preview-ready";

const ffmpeg = promisify(execFile);
const width = 640;
const height = 360;
const at = 30;
/** Inside the subject, on its background, and the frame's corner. */
const points = [
  [0.5, 0.5],
  [0.15, 0.5],
  [0.9, 0.85],
] as const;
const lower: [number, number, number] = [64, 160, 192];
const subject: [number, number, number] = [230, 180, 60];

/**
 * A plain colour on V1 and, on V2, a yellow disc over a dark checked background: the stub model
 * keeps bright red, so the disc is the subject.
 */
async function projectWithSubject(
  request: APIRequestContext,
  { behind = false } = {},
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Remove background", width, height, duration: 2 },
      })
    ).json(),
  );
  const encode = (input: string, output: string) =>
    ffmpeg("ffmpeg", [
      ...["-v", "error", "-f", "lavfi", "-i", input],
      ...[
        "-vf",
        "format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
      ],
      ...[
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        "veryfast",
        "-crf",
        "12",
      ],
      join(project.path, output),
    ]);
  const disc = "lt(hypot(X-320\\,Y-180)\\,100)";
  await Promise.all([
    encode("color=0x40a0c0:s=640x360:r=30:d=4", "lower.mp4"),
    encode(
      `color=black:s=640x360:r=30:d=4,format=rgb24,geq=r='if(${disc}\\,230\\,40+20*mod(floor(X/40)+floor(Y/40)\\,2))':g='if(${disc}\\,180\\,40)':b='if(${disc}\\,60\\,70)'`,
      "subject.mp4",
    ),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    "<!doctype html><html><head><style>html,body{margin:0;background:#000}main{position:relative;width:640px;height:360px}</style></head><body>" +
      '<main data-composition-id="main" data-width="640" data-height="360" data-duration="2" data-fps="30">' +
      '<video id="lower" muted src="lower.mp4" data-start="0" data-duration="2" data-media-start="1" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>' +
      (behind
        ? // Words on V2, behind the cutout on V3: a red band across the disc's left half.
          '<div id="words" class="clip" data-start="0" data-duration="2" data-track-index="1" style="position:absolute;left:100px;top:150px;width:300px;height:60px;background:#e04040"></div>' +
          '<video id="subject" muted src="subject.mp4" data-start="0" data-duration="2" data-media-start="1" data-track-index="2" data-cutroom-matte="shrink:1;soften:1" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>'
        : '<video id="subject" muted src="subject.mp4" data-start="0" data-duration="2" data-media-start="1" data-track-index="1" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>') +
      "</main></body></html>",
  );
  return project;
}

type Points = readonly (readonly [number, number])[];

async function viewerPixels(page: Page, samples: Points = points) {
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
    { source: png.toString("base64"), points: samples },
  );
}

async function exportedPixels(
  request: APIRequestContext,
  project: { id: string; path: string },
  samples: Points = points,
) {
  const result = await request.post("/api/projects/" + project.id + "/export", {
    data: {
      format: "mp4",
      quality: "high",
      range: { start: at, end: at + 1 },
      directory: project.path,
      filename: "cutout.mp4",
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
      ...["-v", "error", "-i", join(project.path, "cutout.mp4")],
      ...["-frames:v", "1", "-vf"],
      "scale=in_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=rgb24",
      ...["-f", "rawvideo", "pipe:1"],
    ],
    { encoding: "buffer", maxBuffer: 1024 ** 2 },
  );
  return samples.map(([x, y]) => {
    const offset = (Math.round(y * height) * width + Math.round(x * width)) * 3;
    return [...stdout.subarray(offset, offset + 3)];
  });
}

const near = (pixel: number[], colour: readonly number[], within = 8) =>
  pixel.every((value, channel) => Math.abs(value - colour[channel]!) <= within);

test("removes a clip's background in the viewer and the MP4, and keeps it again", async ({
  page,
  request,
}) => {
  const project = await projectWithSubject(request);
  await page.goto("/#project/" + project.id);
  await waitForPreview(page, { timing: true });
  await seekFrame(page, at);
  await expect
    .poll(async () => near((await viewerPixels(page))[0]!, subject))
    .toBe(true);
  // The subject's own background covers V1.
  expect(near((await viewerPixels(page))[1]!, lower, 30)).toBe(false);

  await page.locator('.tl-clip[data-clip="subject"]').click();
  const background = page.getByRole("radiogroup", { name: "Background" });
  await expect(background.getByRole("radio", { name: "Keep" })).toBeChecked();
  await background.getByRole("radio", { name: "Remove" }).click();
  await expect(background.getByRole("radio", { name: "Remove" })).toBeChecked();
  // The job shows in the row, along the clip and in the status bar while it runs.
  await expect(
    page.locator(".matte-status").getByText(/^(Waiting|Removing \d+%)$/),
  ).toBeVisible();
  await expect(page.locator(".status-bar .matte-job")).toContainText(
    /Removing background \d+%/,
  );
  await expect(
    page.locator('[data-matte-progress="subject"]').first(),
  ).toBeAttached();

  // Once the whole matte is made the viewer shows V1 around the subject, at once.
  await expect
    .poll(async () => near((await viewerPixels(page))[1]!, lower), {
      timeout: 30_000,
    })
    .toBe(true);
  await expect(page.locator(".matte-status")).toHaveCount(0);
  await expect(page.locator("[data-matte-progress]")).toHaveCount(0);
  const viewer = await viewerPixels(page);
  expect(near(viewer[0]!, subject)).toBe(true);
  expect(near(viewer[2]!, lower)).toBe(true);

  const exported = await exportedPixels(request, project);
  const errors = viewer.flatMap((pixel, i) =>
    pixel.map((value, channel) => Math.abs(value - exported[i]![channel]!)),
  );
  console.log("Remove background RGB error", {
    viewer,
    exported,
    max: Math.max(...errors),
  });
  expect(Math.max(...errors)).toBeLessThanOrEqual(6);

  await background.getByRole("radio", { name: "Keep" }).click();
  await expect
    .poll(async () => near((await viewerPixels(page))[1]!, lower, 30))
    .toBe(false);
});

test("text behind a cutout: the title on V2 shows around the subject on V3, in the viewer and the MP4", async ({
  page,
  request,
}) => {
  const project = await projectWithSubject(request, { behind: true });
  // On the subject over the words, on the words beside it, and on V1.
  const samples = [
    [0.55, 0.5],
    [0.22, 0.5],
    [0.9, 0.85],
  ] as const;
  const words: [number, number, number] = [224, 64, 64];
  await page.goto("/#project/" + project.id);
  await waitForPreview(page, { timing: true });
  await seekFrame(page, at);
  await expect
    .poll(
      async () => {
        const [subjectPixel, wordsPixel, lowerPixel] = await viewerPixels(
          page,
          samples,
        );
        return (
          near(subjectPixel!, subject) &&
          near(wordsPixel!, words) &&
          near(lowerPixel!, lower)
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-pipeline",
    "on",
  );
  const viewer = await viewerPixels(page, samples);
  const exported = await exportedPixels(request, project, samples);
  const errors = viewer.flatMap((pixel, i) =>
    pixel.map((value, channel) => Math.abs(value - exported[i]![channel]!)),
  );
  console.log("Text behind subject RGB error", { viewer, exported });
  expect(Math.max(...errors)).toBeLessThanOrEqual(8);
});
