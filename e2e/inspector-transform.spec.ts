import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  afterPaint,
  createPositionProject,
  positionField,
  seekFrame,
  waitFrames,
} from "./position-helpers";

const box = `<!doctype html><html><head><style>html,body{margin:0;background:#000}#box{position:absolute;left:220px;top:130px;width:200px;height:100px;background:#00ff00}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="2"><div id="box" class="clip" data-start="0" data-duration="2"></div></main></body></html>`;

/** The painted picture, read back as pixels: green where the clip draws, black elsewhere. */
async function green(page: Page, points: [number, number][]) {
  const png = await page.locator("iframe[data-live]").screenshot();
  return page.evaluate(
    async ({ data, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      // The viewer may fit the 640x360 composition at another size.
      const scale = image.width / 640;
      return points.map(([x, y]) => {
        const [r, g, b] = context.getImageData(
          Math.round(x * scale),
          Math.round(y * scale),
          1,
          1,
        ).data;
        return g! > 200 && r! < 60 && b! < 60;
      });
    },
    { data: png.toString("base64"), points },
  );
}

test("Scale, Rotation and Crop draw live while dragged, Esc restores, and release saves one undo step", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(
    request,
    { name: "Transform fields", width: 640, height: 360, duration: 2 },
    box,
  );
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="box"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const scaleX = positionField(page, "Scale X");
  const scaleY = positionField(page, "Scale Y");
  await expect(scaleX).toHaveValue("100%");
  const commands: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/commands"))
      commands.push(r.postData()!);
  });
  const rect = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#box")
      .evaluate((el) => {
        const { width, height } = el.getBoundingClientRect();
        return { width, height };
      });
  await expect.poll(rect).toEqual({ width: 200, height: 100 });

  // A label drag scales both axes from the centre with nothing sent until release.
  const label = inspector.locator("label").filter({ hasText: /^Scale X$/ });
  const at = (await label.boundingBox())!;
  await page.mouse.move(at.x + 10, at.y + 5);
  await page.mouse.down();
  for (let i = 1; i <= 25; i++) {
    await page.mouse.move(at.x + 10 + i * 2, at.y + 5);
    await waitFrames(page, 1);
  }
  await expect.poll(rect).toEqual({ width: 300, height: 150 });
  expect(
    await green(page, [
      [175, 180],
      [465, 180],
      [320, 110],
    ]),
  ).toEqual([true, true, true]);
  expect(commands).toHaveLength(0);
  await page.mouse.up();
  await expect(scaleX).toHaveValue("150%");
  await expect(scaleY).toHaveValue("150%");
  await expect.poll(() => commands.length).toBe(1);
  expect(JSON.parse(commands[0]!).commands).toEqual([
    { type: "setClip", clipId: "box", scale: 1.5 },
  ]);
  await expect
    .poll(async () => readFile(join(project.path, "index.html"), "utf8"))
    .toContain('style="scale: 1.5"');

  // Esc during a drag puts the saved scale back.
  await page.mouse.move(at.x + 10, at.y + 5);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y + 5);
  await expect.poll(rect).toEqual({ width: 400, height: 200 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(rect).toEqual({ width: 300, height: 150 });
  expect(commands).toHaveLength(1);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(scaleX).toHaveValue("100%");
  await expect.poll(rect).toEqual({ width: 200, height: 100 });

  // Unlinked, one axis scales alone.
  await inspector.getByRole("button", { name: "Link scale axes" }).click();
  await scaleY.fill("50%");
  await scaleY.press("Enter");
  await expect.poll(rect).toEqual({ width: 200, height: 50 });
  await expect(scaleX).toHaveValue("100%");

  const rotation = positionField(page, "Rotation");
  await afterPaint(page, async () => {
    await rotation.fill("90");
    await rotation.press("Enter");
  });
  await expect(rotation).toHaveValue("90°");
  await expect.poll(rect).toEqual({ width: 50, height: 200 });

  // Crop trims the drawn picture without moving or resizing the clip's box.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(rect).toEqual({ width: 200, height: 100 });
  const left = positionField(page, "Crop Left");
  await afterPaint(page, async () => {
    await left.fill("50");
    await left.press("Enter");
  });
  await expect.poll(rect).toEqual({ width: 200, height: 100 });
  expect(
    await green(page, [
      [240, 180],
      [290, 180],
      [410, 180],
    ]),
  ).toEqual([false, true, true]);
  expect(JSON.parse(commands.at(-1)!).commands).toEqual([
    { type: "setClip", clipId: "box", crop: { left: 50 } },
  ]);

  await page.getByRole("button", { name: "Reset transform" }).click();
  await expect(left).toHaveValue("0 px");
  expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(box);
});

test("with GSAP loaded, a Scale drag draws exactly over the folded saved scale and only a scale tween warns", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(request, {
    name: "Transform GSAP",
    width: 640,
    height: 360,
    duration: 2,
  });
  await mkdir(join(project.path, "assets/vendor"), { recursive: true });
  await copyFile(
    fileURLToPath(import.meta.resolve("gsap/dist/gsap.min.js")),
    join(project.path, "assets/vendor/gsap.min.js"),
  );
  // The runtime primes GSAP for a Position edit, which folds the saved scale into GSAP's
  // own transform. A tween at 1 s then sets scale absolutely.
  await writeFile(
    join(project.path, "index.html"),
    box
      .replace(
        "</style>",
        '</style><script src="assets/vendor/gsap.min.js"></script>',
      )
      .replace(
        'data-duration="2"></div>',
        'data-duration="2" style="scale: 1.5" data-x="10" data-hf-edit-base-x="0" data-y="0" data-hf-edit-base-y="0"></div>',
      )
      .replace(
        "</main>",
        '</main><script>window.__timelines={};const tl=gsap.timeline({paused:true});tl.to("#box",{scale:0.5,duration:0.5},1);window.__timelines.main=tl;</script>',
      ),
  );
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="box"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(positionField(page, "Scale X")).toHaveValue("150%");
  const rect = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#box")
      .evaluate((el) => {
        const { width, height } = el.getBoundingClientRect();
        return { width, height, folded: el.style.scale === "none" };
      });
  await expect.poll(rect).toEqual({ width: 300, height: 150, folded: true });
  const label = inspector.locator("label").filter({ hasText: /^Scale X$/ });
  const at = (await label.boundingBox())!;
  await page.mouse.move(at.x + 10, at.y + 5);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y + 5);
  await expect.poll(rect).toEqual({ width: 400, height: 200, folded: false });
  await page.mouse.up();
  await expect(positionField(page, "Scale X")).toHaveValue("200%");
  await expect.poll(rect).toEqual({ width: 400, height: 200, folded: true });
  const warning = inspector.locator(".inspector-warning");
  await expect(warning).toHaveCount(0);
  await seekFrame(page, 45);
  await expect(warning).toHaveText(
    "This clip's animation overrides Scale at 00:00:01:15.",
  );
});

test("a paused video's held picture is cropped and rotated like the video, with no warning", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(
    request,
    { name: "Transform video", width: 640, height: 360, duration: 2 },
    box.replace(
      '<div id="box" class="clip" data-start="0" data-duration="2"></div>',
      '<video id="box" class="clip" src="picture.mp4" muted data-start="0" data-duration="2"></video>',
    ),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=0x00ff00:s=200x100:r=30:d=2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    join(project.path, "picture.mp4"),
  ]);
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="box"]').click();
  // The browser reports equal left and right crops in its short form, inset(20px 50px 0px).
  for (const [name, value] of [
    ["Crop Left", "50"],
    ["Crop Right", "50"],
    ["Crop Top", "20"],
    ["Rotation", "90"],
  ] as const) {
    const field = positionField(page, name);
    await field.fill(value);
    await afterPaint(page, () => field.press("Enter"));
  }
  const preview = page.frameLocator("iframe[data-live]");
  await expect(
    preview.locator("canvas[data-cutroom-video-hold]"),
  ).toBeVisible();
  // Cropping leaves x 270 to 370 and y 150 to 230. A quarter turn clockwise about the
  // clip's centre (320, 180) turns that into x 270 to 350 and y 130 to 230.
  expect(
    await green(page, [
      [300, 180],
      [320, 140],
      [360, 180],
      [260, 180],
    ]),
  ).toEqual([true, true, false, false]);
  await waitFrames(page, 30);
  await expect(
    page
      .getByRole("complementary", { name: "Inspector" })
      .locator(".inspector-warning"),
  ).toHaveCount(0);
});

test("an export draws scale, rotation, crop and position where the preview does", async ({
  page,
  request,
}, info) => {
  test.slow();
  const project = await createPositionProject(
    request,
    { name: "Transform export", width: 320, height: 240, duration: 1 },
    `<!doctype html><html><head><style>html,body{margin:0;background:#000}video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}#pip{position:absolute;left:80px;top:75px;width:160px;height:90px;background:linear-gradient(90deg,#606060,#e0e0e0)}</style></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="1"><video id="shot" class="clip" src="shot.mp4" muted data-start="0" data-duration="1" data-track-index="0"></video><div id="pip" class="clip" data-start="0" data-duration="1" data-track-index="1"></div></main></body></html>`,
  );
  const exec = promisify(execFile);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:size=320x240:rate=30:duration=1",
    "-vf",
    "drawbox=x=30:y=30:w=90:h=70:color=white:t=fill,drawbox=x=210:y=150:w=70:h=60:color=white:t=fill",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    join(project.path, "shot.mp4"),
  ]);
  await page.goto(`/#project/${project.id}`);
  const stage = page.locator(".edit-stage[data-preview-ready]");
  await expect(stage).toBeVisible();
  await waitFrames(page, 4);
  const plain = info.outputPath("plain.png");
  await page.locator("iframe[data-live]").screenshot({ path: plain });
  const path = `/api/cutroom/projects/${project.id}`;
  const revision = async () =>
    (await (await request.get(`${path}/timeline`)).json()).revision as string;
  await afterPaint(page, async () => {
    const edit = await request.post(`${path}/commands`, {
      data: {
        expectedRevision: await revision(),
        commands: [
          { type: "setClip", clipId: "shot", scale: 1.25, rotation: 8 },
          {
            type: "setClip",
            clipId: "pip",
            x: 70,
            y: -30,
            scaleX: 0.6,
            scaleY: 0.8,
            rotation: -15,
            crop: { left: 30, top: 10 },
          },
        ],
      },
    });
    expect(edit.ok()).toBe(true);
  });
  await waitFrames(page, 4);
  const shown = info.outputPath("preview.png");
  await page.locator("iframe[data-live]").screenshot({ path: shown });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  await dialog.getByRole("button", { name: "Export MP4" }).click();
  const { jobId } = (await (await started).json()) as { jobId: string };
  await expect(dialog).toContainText("Export complete.", { timeout: 60_000 });
  const file = info.outputPath("transform.mp4");
  await writeFile(
    file,
    await (await request.get(`/api/render/${jobId}/download`)).body(),
  );
  // Both pictures at the composition's size, as grey levels. The content is grey so that
  // H.264's subsampled colour cannot hide or fake a difference in where things are drawn.
  const pixels = async (input: string[]) =>
    (
      await exec(
        "ffmpeg",
        [
          "-v",
          "error",
          ...input,
          "-frames:v",
          "1",
          "-vf",
          "scale=320:240:flags=area,format=gray",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { encoding: "buffer", maxBuffer: 1 << 24 },
      )
    ).stdout;
  const exported = await pixels(["-i", file]);
  const difference = async (png: string) => {
    const preview = await pixels(["-i", png]);
    let total = 0;
    for (let i = 0; i < exported.length; i++)
      total += Math.abs(exported[i]! - preview[i]!);
    return total / exported.length;
  };
  const matched = await difference(shown);
  const untransformed = await difference(plain);
  info.annotations.push({
    type: "mean absolute difference",
    description: `transformed preview ${matched.toFixed(2)}, untransformed ${untransformed.toFixed(2)}`,
  });
  // Measured at 0.35 against 66.8 for the untransformed picture.
  expect(matched).toBeLessThan(3);
  expect(untransformed).toBeGreaterThan(30);
});
