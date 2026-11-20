import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { GradeSchema } from "../src/shared/timeline/grade";
import type { GradeEdit } from "../src/shared/timeline/grade";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";
import { waitForPreview } from "./preview-ready";

const HistorySchema = z.object({
  entries: z.array(z.object({ undone: z.boolean() })),
});
const GradesSchema = z.object({
  timeline: z.object({
    clips: z.array(
      z.object({
        id: z.string(),
        grade: z.record(z.string(), z.unknown()).nullable(),
      }),
    ),
  }),
});

/** Two shots of one mid-grey picture, so a grade's colour shift is plain to read. */
async function gradeProject(
  request: APIRequestContext,
  filters: string[] = [],
  pipeline = false,
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Grade", width: 640, height: 360, duration: 4 },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    ...[
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=0x808080:s=640x360:r=30:d=4",
    ],
    "-vf",
    [
      ...filters,
      "format=yuv420p",
      ...(pipeline
        ? [
            "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
          ]
        : []),
    ].join(","),
    "-c:v",
    "libx264",
    "-preset",
    pipeline ? "medium" : "ultrafast",
    join(project.path, "grey.mp4"),
  ]);
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      /<main([^>]*)>[\s\S]*<\/main>/,
      (_match, attributes: string) =>
        `<main${attributes}>\n<video id="a"${pipeline ? "" : ' class="clip"'} muted src="grey.mp4" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" data-start="0" data-duration="2" data-track-index="0" data-label="Shot A"></video>\n<video id="b"${pipeline ? "" : ' class="clip"'} muted src="grey.mp4" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" data-start="2" data-duration="2" data-media-start="2" data-track-index="0" data-label="Shot B"></video>\n</main>`,
    ),
  );
  const steps = async () =>
    HistorySchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/history`)
      ).json(),
    ).entries.filter((entry) => !entry.undone).length;
  const grade = async (id: string) =>
    GradesSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline.clips.find((clip) => clip.id === id)?.grade ?? null;
  return { project, steps, grade };
}

async function picturePixels(page: Page, columns: number[]) {
  const picture = await page.locator(".edit-picture").boundingBox();
  if (!picture) throw new Error("The viewer picture is not visible.");
  // Chromium's cropped capture can round a channel differently from the visible viewer.
  const png = await page.screenshot({ scale: "css" });
  return page.evaluate(
    async ({ data, columns, picture }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return columns.map((column) => {
        const [red, green, blue] = context.getImageData(
          Math.round(picture.x + picture.width * column),
          Math.round(picture.y + picture.height / 2),
          1,
          1,
        ).data;
        return { red: red!, green: green!, blue: blue!, warmth: red! - blue! };
      });
    },
    { data: png.toString("base64"), columns, picture },
  );
}

async function centrePixel(page: Page) {
  return (await picturePixels(page, [0.5]))[0]!;
}

/** Red minus blue at the picture's centre: positive is warm. */
async function warmth(page: Page) {
  return (await centrePixel(page)).warmth;
}

test("cancelling a grade restores the paused source colours", async ({
  page,
  request,
}, info) => {
  const { project, steps } = await gradeProject(request, [
    "drawbox=x=0:y=0:w=iw/2:h=ih:color=lime:t=fill",
    "drawbox=x=iw/2:y=0:w=iw/2:h=ih:color=blue:t=fill",
    "drawbox=x=0:y=0:w=iw/2:h=ih:color=blue:t=fill:enable='gte(t,2)'",
    "drawbox=x=iw/2:y=0:w=iw/2:h=ih:color=lime:t=fill:enable='gte(t,2)'",
  ]);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  await seekFrame(page, 29);
  await page.locator('.tl-lanes [data-clip="a"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();
  const exposure = inspector.locator("label", { hasText: /^Exposure$/ });
  const { x, y, width, height } = (await exposure.boundingBox())!;
  const picture = page.locator(".edit-picture");
  const frame = page.frameLocator("iframe[data-live]");
  const source = frame.locator("video#a");
  const swatches = async (name?: string) => {
    const png = await picture.screenshot(
      name ? { path: info.outputPath(`${name}.png`) } : undefined,
    );
    return page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return [0.25, 0.75].map((position) =>
        Array.from(
          context.getImageData(
            Math.round(image.width * position),
            Math.round(image.height / 2),
            1,
            1,
          ).data,
        ).slice(0, 3),
      );
    }, png.toString("base64"));
  };
  const history = await steps();
  await expect(source).toHaveAttribute("data-cutroom-held", "");
  const before = await swatches("source");
  expect(before[0]![1]).toBeGreaterThan(230);
  expect(before[1]![2]).toBeGreaterThan(230);
  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + width / 2 - 20, y + height / 2, { steps: 8 });
  await expect.poll(async () => (await swatches())[0]![1]).toBeLessThan(110);
  const draft = await swatches("draft");

  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(source).not.toHaveAttribute("data-color-grading", /./);
  await expect(source).toHaveAttribute("data-cutroom-held", "");
  const after = await swatches("after-escape");
  await info.attach("source swatches", {
    body: JSON.stringify({ before, draft, after }),
    contentType: "application/json",
  });
  expect(after).toEqual(before);
  expect(await steps()).toBe(history);

  await seekFrame(page, 75);
  await expect.poll(() => swatches()).toEqual([...before].reverse());
  await expect(source).not.toHaveAttribute("data-cutroom-held", "");
  const holds = frame.locator("canvas[data-cutroom-video-hold]");
  await expect(holds).toHaveCount(1);
  await page.getByRole("button", { name: "Play forward" }).click();
  await expect(holds).toHaveCount(0);
});

test("a video grade and a clip zoom compose while dragging and switching between Aim and Result", async ({
  page,
  request,
}) => {
  const { project, steps } = await gradeProject(request, [
    "drawbox=x=400:y=80:w=140:h=100:color=white:t=fill",
  ]);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  await seekFrame(page, 40);
  await page.locator('.tl-lanes [data-clip="a"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();

  await page.keyboard.press("h");
  await page.getByRole("radio", { name: "Clip", exact: true }).click();
  const picture = (await page.locator(".edit-picture").boundingBox())!;
  const at = (x: number, y: number) =>
    page.mouse.move(
      picture.x + x * picture.width,
      picture.y + y * picture.height,
    );
  await at(0.6, 0.2);
  await page.mouse.down();
  await at(0.85, 0.45);
  await page.mouse.up();
  await expect(page.locator(".edit-region-box")).toBeVisible();
  await page.getByRole("radio", { name: "Result" }).click();
  await expect
    .poll(async () => (await centrePixel(page)).green)
    .toBeGreaterThan(200);

  const history = await steps();
  const frame = page.locator("iframe[data-live]");
  const src = await frame.getAttribute("src");
  const exposureSlider = inspector.getByRole("slider", { name: "Exposure" });
  await exposureSlider.scrollIntoViewIfNeeded();
  const exposure = (await exposureSlider.boundingBox())!;
  await page.mouse.move(
    exposure.x + exposure.width / 2,
    exposure.y + exposure.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    exposure.x + exposure.width * 0.25,
    exposure.y + exposure.height / 2,
  );
  await expect
    .poll(async () => (await centrePixel(page)).green)
    .toBeLessThan(200);
  await expect
    .poll(async () => (await centrePixel(page)).green)
    .toBeGreaterThan(95);
  expect(await steps()).toBe(history);
  await expect(frame).toHaveAttribute("src", src!);
  const beforeGradeSave = await page
    .locator(".edit-stage")
    .getAttribute("data-preview-ready");
  await page.mouse.up();
  await expect.poll(steps).toBe(history + 1);
  await waitForPreview(page, { after: beforeGradeSave });

  await page.getByRole("radio", { name: "Aim" }).click();
  await expect
    .poll(async () => (await centrePixel(page)).green)
    .toBeLessThan(90);
  await expect(page.locator(".edit-region-box")).toBeVisible();
  const aimSrc = await frame.getAttribute("src");
  const box = page.locator(".edit-region-box");
  const savedBox = await box.boundingBox();
  await at(0.725, 0.325);
  await page.mouse.down();
  await at(0.55, 0.6);
  await expect
    .poll(async () => (await box.boundingBox())?.x)
    .toBeLessThan(savedBox!.x - 20);
  expect(await steps()).toBe(history + 1);
  await expect(frame).toHaveAttribute("src", aimSrc!);
  await page.mouse.up();
  await expect.poll(steps).toBe(history + 2);
});

test("Colour drafts a grade into the viewer while a slider moves and saves one undo step when it lets go", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  const { project, steps, grade } = await gradeProject(request);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await page.locator('.tl-lanes [data-clip="a"]').click();
  const colour = inspector.locator("details", {
    has: page.locator("summary", { hasText: /^Colour/ }),
  });
  await colour.locator("summary").click();
  const neutral = await warmth(page);
  expect(Math.abs(neutral)).toBeLessThan(6);

  // Mid drag, the viewer is already warmer, from the same document, with nothing saved.
  const before = await steps();
  const document = await page.locator("iframe[data-live]").getAttribute("src");
  const slider = inspector.getByRole("slider", { name: "Temperature" });
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, {
    steps: 6,
  });
  await expect.poll(() => warmth(page)).toBeGreaterThan(neutral + 20);
  expect(await steps()).toBe(before);
  expect(await page.locator("iframe[data-live]").getAttribute("src")).toBe(
    document,
  );
  await page.mouse.up();
  await expect.poll(steps).toBe(before + 1);
  const saved = await grade("a");
  expect(saved).toMatchObject({ adjust: { temperature: expect.any(Number) } });
  await expect.poll(() => warmth(page)).toBeGreaterThan(neutral + 20);

  // Shift+D shows the source until it is pressed again; the grade stays saved.
  await page.keyboard.press("Shift+D");
  await expect(colour.getByText("Bypassed")).toBeVisible();
  await expect.poll(() => warmth(page)).toBeLessThan(neutral + 6);
  await page.keyboard.press("Shift+D");
  await expect(colour.getByText("Bypassed")).toHaveCount(0);
  await expect.poll(() => warmth(page)).toBeGreaterThan(neutral + 20);

  // Arrow keys on a focused slider step it, and a run of presses saves once.
  const contrast = inspector.getByRole("slider", { name: "Contrast" });
  const stepping = await steps();
  await contrast.focus();
  for (let press = 0; press < 3; press++) await contrast.press("ArrowRight");
  await expect
    .poll(async () => (await grade("a"))?.adjust)
    .toMatchObject({
      contrast: 0.03,
    });
  expect(await steps()).toBe(stepping + 1);

  // Double-clicking a label resets that control in one step.
  const reset = await steps();
  await inspector.locator("label", { hasText: /^Temperature$/ }).dblclick();
  await expect.poll(steps).toBe(reset + 1);
  await expect
    .poll(async () => (await grade("a"))?.adjust)
    .toEqual({
      contrast: 0.03,
    });

  // A .cube from disk becomes the look.
  const cube = info.outputPath("Warm Film.cube");
  await writeFile(
    cube,
    `LUT_3D_SIZE 2\n${[0, 1]
      .flatMap((b) =>
        [0, 1].flatMap((g) => [0, 1].map((r) => `${r} ${g} ${b * 0.8}`)),
      )
      .join("\n")}\n`,
  );
  await inspector.getByRole("combobox", { name: "Look", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("option", { name: "Import .cube…" }).click();
  await (await chooser).setFiles(cube);
  await expect
    .poll(async () => (await grade("a"))?.lut)
    .toEqual({ src: "luts/warm-film.cube", intensity: 1 });
  await expect(
    inspector.getByRole("combobox", { name: "Look", exact: true }),
  ).toHaveText("Warm Film");

  // Copy the grade from A and paste it onto B, in one step.
  await page.locator('.tl-lanes [data-clip="a"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy grade" }).click();
  await page.locator('.tl-lanes [data-clip="b"]').click({ button: "right" });
  const pasting = await steps();
  await page.getByRole("menuitem", { name: "Paste grade" }).click();
  await expect.poll(steps).toBe(pasting + 1);
  expect(await grade("b")).toEqual(await grade("a"));
});

test("the footage pipeline draws a grade draft and bypass from the same paused frame", async ({
  page,
  request,
}) => {
  const { project, steps } = await gradeProject(request, [], true);
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("cutroom.footagePipeline", "true");
  });
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  const stage = page.locator(".edit-stage");
  await expect(stage).toHaveAttribute("data-pipeline", "on");
  const neutral = await warmth(page);
  const before = await steps();
  const frame = page.locator("iframe[data-live]");
  const src = await frame.getAttribute("src");
  await page.locator('.tl-lanes [data-clip="a"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();
  const slider = inspector.getByRole("slider", { name: "Temperature" });
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
  await expect.poll(() => warmth(page)).toBeGreaterThan(neutral + 20);
  await expect(stage).toHaveAttribute("data-pipeline", "on");
  await expect(frame).toHaveAttribute("src", src!);
  expect(await steps()).toBe(before);
  await page.mouse.up();
  await expect.poll(steps).toBe(before + 1);
  await expect.poll(() => warmth(page)).toBeGreaterThan(neutral + 20);

  await page.keyboard.press("Shift+D");
  await expect.poll(() => warmth(page)).toBeLessThan(neutral + 5);
  await page.keyboard.press("Shift+D");
  await expect.poll(() => warmth(page)).toBeGreaterThan(neutral + 20);

  await seekFrame(page, 75);
  await expect(page.locator(".edit-pipeline")).toHaveAttribute(
    "data-frame",
    "75",
  );
  await expect.poll(() => warmth(page)).toBeLessThan(neutral + 5);
  await seekFrame(page, 15);
  await expect(page.locator(".edit-pipeline")).toHaveAttribute(
    "data-frame",
    "15",
  );
  await expect.poll(() => warmth(page)).toBeGreaterThan(neutral + 20);

  await expect(
    page
      .locator("iframe[data-live]")
      .contentFrame()
      .locator("[data-hf-color-grading-canvas]"),
  ).toHaveCount(0);
});

test("the pipeline's 33-point grade matches export on swatches and a luma ramp", async ({
  page,
  request,
}) => {
  const swatches = [
    "303030",
    "c0c0c0",
    "842c91",
    "c04048",
    "be9f53",
    "489e65",
    "4387ac",
    "753969",
  ];
  const { project } = await gradeProject(
    request,
    [
      ...swatches.map(
        (colour, index) =>
          `drawbox=x=${index * 80}:y=0:w=80:h=360:color=0x${colour}:t=fill`,
      ),
      "geq=lum='if(lt(Y,120),16+219*X/(W-1),lum(X,Y))':cb='if(lt(Y,60),128,cb(X,Y))':cr='if(lt(Y,60),128,cr(X,Y))'",
    ],
    true,
  );
  const file = join(project.path, "index.html");
  const grade = {
    adjust: { temperature: 0.25, contrast: 0.16, exposure: 0.05 },
    curves: {
      master: [
        [0, 0],
        [0.25, 0.18],
        [0.72, 0.8],
        [1, 1],
      ],
    },
    lut: { src: "look.cube", intensity: 0.8 },
  };
  const look = [0, 1].flatMap((b) =>
    [0, 1].flatMap((g) =>
      [0, 1].map(
        (r) => `${r * 0.9 + 0.04} ${g * 0.92} ${b * 0.8 + 0.1 * (1 - r)}`,
      ),
    ),
  );
  await writeFile(
    join(project.path, "look.cube"),
    `LUT_3D_SIZE 2\n${look.join("\n")}\n`,
  );
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      '<video id="a"',
      `<video id="a" data-color-grading='${JSON.stringify(grade)}'`,
    ),
  );
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("cutroom.footagePipeline", "true");
  });
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  await seekFrame(page, 15);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-pipeline",
    "on",
  );
  await expect(page.locator(".edit-pipeline")).toHaveAttribute(
    "data-frame",
    "15",
  );
  const swatchPoints = swatches.map((_, index) => ({
    x: index * 80 + 40,
    y: 180,
  }));
  const rampPoints = Array.from({ length: 16 }, (_, index) => ({
    x: index * 40 + 20,
    y: 60,
  }));
  const points = [...swatchPoints, ...rampPoints];
  const png = await page.locator(".edit-picture").screenshot();
  const preview = await page.evaluate(
    async ({ data, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return points.map(({ x, y }) =>
        Array.from(
          context
            .getImageData(
              Math.floor((x * image.width) / 640),
              Math.floor((y * image.height) / 360),
              1,
              1,
            )
            .data.slice(0, 3),
        ),
      );
    },
    { data: png.toString("base64"), points },
  );
  const response = await request.post(`/api/projects/${project.id}/export`, {
    data: {
      range: { start: 0, end: 1 },
      quality: "high",
      directory: project.path,
      filename: "graded.mp4",
    },
  });
  const { jobId } = z
    .object({ jobId: z.string() })
    .parse(await response.json());
  expect(
    await (await request.get(`/api/render/${jobId}/progress`)).text(),
  ).toContain('"status":"complete"');
  const { stdout } = await promisify(execFile)(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      join(project.path, "graded.mp4"),
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-vf",
      "scale=in_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=rgb24",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 1024 * 1024 },
  );
  const offsets = (from: number, to: number) =>
    points
      .slice(from, to)
      .flatMap(({ x, y }, index) =>
        preview[from + index]!.map((value, channel) =>
          Math.abs(value - stdout[(y * 640 + x) * 3 + channel]!),
        ),
      );

  for (const [name, errors] of [
    // Test both independently so one pattern cannot average out the other.
    ["swatches", offsets(0, swatchPoints.length)],
    ["luma ramp", offsets(swatchPoints.length, points.length)],
  ] as const) {
    const mean = errors.reduce((sum, delta) => sum + delta, 0) / errors.length;
    const max = Math.max(...errors);
    console.log(
      `Grade ${name} differ from export by ${mean.toFixed(2)} levels on average, max ${max}.`,
    );
    expect(mean, `${name} mean colour error, max ${max}`).toBeLessThan(1.6);
    expect(
      max,
      `${name} max colour error, mean ${mean.toFixed(2)}`,
    ).toBeLessThanOrEqual(6);
  }
});
test("Curves add, move and remove points on each channel, drafting while they move", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { project, steps, grade } = await gradeProject(request);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await page.locator('.tl-lanes [data-clip="a"]').click();
  await inspector
    .locator("details", {
      has: page.locator("summary", { hasText: /^Colour/ }),
    })
    .locator("summary")
    .click();
  const plot = inspector.getByRole("group", { name: "Master curve" });
  await plot.scrollIntoViewIfNeeded();
  const box = (await plot.boundingBox())!;
  const brightness = async () => {
    const png = await page.locator("iframe[data-live]").screenshot();
    return page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return context.getImageData(image.width >> 1, image.height >> 1, 1, 1)
        .data[1]!;
    }, png.toString("base64"));
  };
  const grey = await brightness();

  // Pressing the line at mid grey adds a point there; dragging it up brightens the picture.
  const before = await steps();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3, {
    steps: 5,
  });
  await expect.poll(brightness).toBeGreaterThan(grey + 25);
  expect(await steps()).toBe(before);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    "**/api/cutroom/projects/*/commands",
    async (route) => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    await page.mouse.up();
    await expect.poll(steps).toBe(before + 1);
    const master = (await grade("a"))?.curves as { master: number[][] };
    expect(master.master).toHaveLength(3);
    expect(master.master[1]![1]).toBeGreaterThan(0.6);

    // Remove the point before the editor receives the answer for adding it.
    await inspector.getByRole("slider", { name: "Master point 2" }).dblclick();
  } finally {
    release();
  }
  await expect.poll(steps).toBe(before + 2);
  await expect.poll(async () => (await grade("a"))?.curves ?? null).toBeNull();

  // The red channel's curve is its own.
  await inspector.getByRole("radio", { name: "Red" }).click();
  const red = inspector.getByRole("group", { name: "Red curve" });
  const redBox = (await red.boundingBox())!;
  await page.mouse.move(
    redBox.x + redBox.width / 2,
    redBox.y + redBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    redBox.x + redBox.width / 2,
    redBox.y + redBox.height * 0.6,
    {
      steps: 3,
    },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Object.keys((await grade("a"))?.curves ?? {}))
    .toEqual(["red"]);
});

test("colour wheels draft, cancel and save independently for each tonal range", async ({
  page,
  request,
}, info) => {
  const { project, steps, grade } = await gradeProject(request);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  await page.locator('.tl-lanes [data-clip="a"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();
  const wheel = inspector.getByRole("group", { name: "Midtones colour wheel" });
  await wheel.scrollIntoViewIfNeeded();
  const { x, y, width, height } = (await wheel.boundingBox())!;
  const drag = async () => {
    await page.mouse.move(x + width / 2, y + height / 2);
    await page.mouse.down();
    await page.mouse.move(x + width * 0.85, y + height / 2, { steps: 5 });
  };
  const before = await steps();
  const grey = await warmth(page);
  await page.screenshot({ path: info.outputPath("neutral.png") });
  await drag();
  await expect.poll(() => warmth(page)).toBeGreaterThan(grey + 20);
  expect(await grade("a")).toBeNull();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(() => warmth(page)).toBeLessThan(grey + 6);
  expect(await steps()).toBe(before);

  await drag();
  await page.mouse.up();
  await expect.poll(steps).toBe(before + 1);
  await expect.poll(() => warmth(page)).toBeGreaterThan(grey + 20);
  const midtones = z
    .object({
      hue: z.number(),
      amount: z.number(),
      level: z.number().optional(),
    })
    .parse(
      z.object({ midtones: z.unknown() }).parse((await grade("a"))?.wheels)
        .midtones,
    );
  expect(midtones.amount).toBeCloseTo(0.7, 1);
  expect(midtones.hue < 2 || midtones.hue > 358).toBe(true);
  await page.screenshot({ path: info.outputPath("midtones.png") });
  await inspector.getByRole("combobox", { name: "Colour wheels" }).click();
  await page.getByRole("option", { name: "Highlights" }).click();
  const hue = inspector.getByRole("textbox", { name: "Hue", exact: true });
  const amount = inspector.getByRole("textbox", {
    name: "Amount",
    exact: true,
  });
  await hue.fill("220°");
  await hue.press("Enter");
  await amount.fill("25%");
  await amount.press("Enter");
  await expect
    .poll(async () => (await grade("a"))?.wheels)
    .toEqual({
      midtones,
      highlights: { hue: 220, amount: 0.25 },
    });
  await inspector
    .getByRole("button", { name: "Reset highlights wheel" })
    .click();
  await expect
    .poll(async () => (await grade("a"))?.wheels)
    .toEqual({ midtones });
  await expect(hue).toHaveValue("0°");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(async () => (await grade("a"))?.wheels)
    .toEqual({
      midtones,
      highlights: { hue: 220, amount: 0.25 },
    });
});

test("a wheel preserves concurrent fields and cancels if the Inspector closes", async ({
  page,
  request,
}) => {
  const { project, grade, steps } = await gradeProject(request);
  const api = `/api/cutroom/projects/${project.id}`;
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  await page.locator('.tl-lanes [data-clip="a"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();
  const wheel = inspector.getByRole("group", { name: "Midtones colour wheel" });
  const drag = async () => {
    await wheel.scrollIntoViewIfNeeded();
    const bounds = (await wheel.boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width * 0.82,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
  };
  await drag();
  const level = inspector.getByRole("textbox", { name: "Level", exact: true });
  const revision = z
    .object({ revision: z.string() })
    .parse(await (await request.get(`${api}/timeline`)).json()).revision;
  const external = await request.post(`${api}/commands`, {
    data: {
      expectedRevision: revision,
      commands: [
        {
          type: "setClip",
          clipId: "a",
          grade: {
            wheels: { midtones: { level: 0.42 } },
          },
        },
      ],
    },
  });
  expect(external.ok(), await external.text()).toBe(true);
  await expect(level).toHaveValue("42%");
  await page.mouse.up();
  await expect
    .poll(async () => (await grade("a"))?.wheels)
    .toMatchObject({
      midtones: { amount: expect.any(Number), level: 0.42 },
    });

  const beforeClose = await steps();
  const saved = await grade("a");
  await drag();
  await inspector
    .getByRole("button", { name: "Close inspector" })
    .press("Enter");
  await expect(inspector).toBeHidden();
  await page.mouse.up();
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(wheel).toBeVisible();
  expect(await steps()).toBe(beforeClose);
  expect(await grade("a")).toEqual(saved);

  await inspector.getByRole("button", { name: "Reset midtones wheel" }).click();
  await expect.poll(() => grade("a")).toBeNull();
  const arrived = Promise.withResolvers<void>();
  const continueSave = Promise.withResolvers<void>();
  await page.route(
    "**/commands",
    async (route) => {
      arrived.resolve();
      await continueSave.promise;
      await route.continue();
    },
    { times: 1 },
  );
  const amount = inspector.getByRole("textbox", {
    name: "Amount",
    exact: true,
  });
  const hue = inspector.getByRole("textbox", { name: "Hue", exact: true });
  try {
    await amount.fill("25%");
    await amount.press("Enter");
    await arrived.promise;
    await hue.fill("220°");
    await hue.press("Enter");
  } finally {
    continueSave.resolve();
  }
  await expect
    .poll(async () => (await grade("a"))?.wheels)
    .toEqual({
      midtones: { hue: 220, amount: 0.25 },
    });
});

test("a wheel keeps a typed hue across a level edit and skips an unchanged drag", async ({
  page,
  request,
}) => {
  const { project, grade, steps } = await gradeProject(request);
  const api = `/api/cutroom/projects/${project.id}`;
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  await page.locator('.tl-lanes [data-clip="a"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();
  const wheel = inspector.getByRole("group", { name: "Midtones colour wheel" });
  const hue = inspector.getByRole("textbox", { name: "Hue", exact: true });
  const level = inspector.getByRole("textbox", { name: "Level", exact: true });
  const setLevel = async (level: number) => {
    const revision = z
      .object({ revision: z.string() })
      .parse(await (await request.get(`${api}/timeline`)).json()).revision;
    const response = await request.post(`${api}/commands`, {
      data: {
        expectedRevision: revision,
        commands: [
          {
            type: "setClip",
            clipId: "a",
            grade: {
              wheels: { midtones: { level } },
            },
          },
        ],
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };

  await hue.fill("220°");
  await hue.press("Enter");
  await setLevel(0.42);
  await expect(level).toHaveValue("42%");
  const amount = inspector.getByRole("textbox", {
    name: "Amount",
    exact: true,
  });
  await amount.fill("50%");
  await amount.press("Enter");
  await expect
    .poll(async () => (await grade("a"))?.wheels)
    .toEqual({
      midtones: { hue: 220, amount: 0.5, level: 0.42 },
    });
  await expect.poll(() => warmth(page)).toBeLessThan(-10);

  await wheel.scrollIntoViewIfNeeded();
  const box = (await wheel.boundingBox())!;
  const at = { x: box.x + box.width * 0.85, y: box.y + box.height / 2 };
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => warmth(page)).toBeGreaterThan(20);
  await expect
    .poll(async () => (await grade("a"))?.wheels)
    .toMatchObject({
      midtones: { hue: 0, amount: expect.closeTo(0.7, 1) },
    });
  const before = await steps();
  let writes = 0;
  page.on("request", (event) => {
    if (event.method() === "POST" && event.url().endsWith(`${api}/commands`))
      writes++;
  });
  await page.mouse.click(at.x, at.y);
  await setLevel(0.27);
  await expect(level).toHaveValue("27%");
  expect(writes).toBe(0);
  expect(await steps()).toBe(before + 1);
});

test("an HSL correction changes only the qualified colour and saves once", async ({
  page,
  request,
}, info) => {
  const { project, grade, steps } = await gradeProject(request, [
    "drawbox=x=0:y=0:w=iw/2:h=ih:color=lime:t=fill",
    "drawbox=x=iw/2:y=0:w=iw/2:h=ih:color=blue:t=fill",
    "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
  ]);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  await page.locator('.tl-lanes [data-clip="a"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();
  const secondaries = inspector.getByRole("region", { name: "HSL secondary" });
  await secondaries.getByRole("button", { name: "Add secondary" }).click();
  await expect
    .poll(async () => (await grade("a"))?.secondaries)
    .toEqual([{ key: {}, correction: {} }]);
  for (const [name, value] of [
    ["Hue center", "120°"],
    ["Hue range", "30°"],
    ["Saturation minimum", "60%"],
  ] as const) {
    const field = secondaries.getByRole("textbox", { name, exact: true });
    await field.fill(value);
    await field.press("Enter");
  }
  const key = { hue: { center: 120, range: 30 }, saturation: { min: 0.6 } };
  await expect
    .poll(async () => (await grade("a"))?.secondaries)
    .toEqual([{ key, correction: {} }]);

  const shift = secondaries.getByText("Hue shift", { exact: true });
  await secondaries
    .getByRole("textbox", { name: "Tint", exact: true })
    .scrollIntoViewIfNeeded();
  const before = await picturePixels(page, [0.25, 0.75]);
  expect(before[0]!.green - before[0]!.red).toBeGreaterThan(120);
  expect(before[1]!.blue - before[1]!.red).toBeGreaterThan(120);
  // Chromium can round decoded video and the grade canvas one RGB level apart.
  const restoredDifference = async () =>
    Math.max(
      ...(await picturePixels(page, [0.25, 0.75])).flatMap(
        ({ red, green, blue }, i) => [
          Math.abs(red - before[i]!.red),
          Math.abs(green - before[i]!.green),
          Math.abs(blue - before[i]!.blue),
        ],
      ),
    );
  await page.screenshot({ path: info.outputPath("before-hsl.png") });
  const history = await steps();
  const box = (await shift.boundingBox())!;
  const scrub = async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, {
      steps: 12,
    });
  };
  await scrub();
  await expect
    .poll(async () => (await picturePixels(page, [0.25]))[0]!.red)
    .toBeGreaterThan(before[0]!.red + 120);
  const drafted = (await picturePixels(page, [0.75]))[0]!;
  expect(drafted).toMatchObject({
    red: expect.closeTo(before[1]!.red, -1),
    green: expect.closeTo(before[1]!.green, -1),
    blue: expect.closeTo(before[1]!.blue, -1),
  });
  expect(await steps()).toBe(history);
  await page.mouse.up();
  await expect.poll(steps).toBe(history + 1);
  await expect
    .poll(async () => (await grade("a"))?.secondaries)
    .toEqual([{ key, correction: { hueShift: -120 } }]);
  await expect
    .poll(async () => (await picturePixels(page, [0.25]))[0]!.red)
    .toBeGreaterThan(before[0]!.red + 120);
  await page.screenshot({ path: info.outputPath("after-hsl.png") });

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(restoredDifference).toBeLessThanOrEqual(1);
  const beforeCancel = await steps();
  await scrub();
  await expect
    .poll(async () => (await picturePixels(page, [0.25]))[0]!.red)
    .toBeGreaterThan(before[0]!.red + 120);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(restoredDifference).toBeLessThanOrEqual(1);
  expect(await steps()).toBe(beforeCancel);
  await expect
    .poll(async () => (await grade("a"))?.secondaries)
    .toEqual([{ key, correction: {} }]);
});

test("HSL edits preserve other stages and refuse a replaced selection", async ({
  page,
  request,
}) => {
  const { project, grade, steps } = await gradeProject(request);
  const api = `/api/cutroom/projects/${project.id}`;
  const write = async (grade: GradeEdit) => {
    const revision = z
      .object({ revision: z.string() })
      .parse(await (await request.get(`${api}/timeline`)).json()).revision;
    const response = await request.post(`${api}/commands`, {
      data: {
        expectedRevision: revision,
        commands: [{ type: "setClip", clipId: "a", grade }],
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const lime = { key: { hue: { center: 120, range: 20 } }, correction: {} };
  const blue = {
    key: { hue: { center: 240, range: 20 } },
    correction: { luma: 0.25 },
  };
  await write({ secondaries: [lime, blue] });
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  await page.locator('.tl-lanes [data-clip="a"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();
  const secondaries = inspector.getByRole("region", { name: "HSL secondary" });
  const center = secondaries.getByRole("textbox", { name: "Hue center" });
  const shift = secondaries.getByRole("textbox", { name: "Hue shift" });
  await expect(center).toHaveValue("120°");
  await expect(
    secondaries.getByRole("textbox", { name: "Luma softness" }),
  ).toHaveValue("5%");
  await shift.fill("-60°");
  await write({ adjust: { contrast: 0.25 } });
  await expect(
    inspector.getByRole("textbox", { name: "Contrast" }),
  ).toHaveValue("25");
  await shift.press("Enter");
  await expect
    .poll(() => grade("a"))
    .toEqual({
      adjust: { contrast: 0.25 },
      secondaries: [{ ...lime, correction: { hueShift: -60 } }, blue],
    });

  const luma = secondaries.getByText("Luma", { exact: true }).last();
  await luma.scrollIntoViewIfNeeded();
  await shift.fill("-70°");
  const box = (await luma.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 10, box.y + box.height / 2);
  await page.mouse.up();
  await expect
    .poll(async () => (await grade("a"))?.secondaries)
    .toEqual([{ ...lime, correction: { hueShift: -70, luma: -0.1 } }, blue]);

  const saturationMax = secondaries.getByRole("textbox", {
    name: "Saturation maximum",
  });
  await saturationMax.fill("0.08%");
  await saturationMax.press("Enter");
  const saturationMin = secondaries.getByRole("textbox", {
    name: "Saturation minimum",
  });
  await saturationMin.fill("0.07%");
  await saturationMin.press("Enter");
  await expect
    .poll(async () => (await grade("a"))?.secondaries)
    .toEqual([
      {
        key: { ...lime.key, saturation: { min: 0.0007, max: 0.0008 } },
        correction: { hueShift: -70, luma: -0.1 },
      },
      blue,
    ]);

  await shift.fill("-90°");
  await write({ secondaries: [blue, lime] });
  await expect(center).toHaveValue("240°");
  const history = await steps();
  await secondaries.getByText("Tint", { exact: true }).click();
  await expect(
    page.getByText("The HSL selections changed. Try the edit again."),
  ).toBeVisible();
  expect(await steps()).toBe(history);
  await expect
    .poll(async () => (await grade("a"))?.secondaries)
    .toEqual([blue, lime]);

  await secondaries.getByRole("combobox", { name: "HSL selection" }).click();
  await page.getByRole("option", { name: "Selection 2" }).click();
  await expect(center).toHaveValue("120°");
  await secondaries.getByRole("button", { name: "Remove secondary" }).click();
  await expect(center).toHaveValue("240°");
  await expect
    .poll(() => grade("a"))
    .toEqual({
      adjust: { contrast: 0.25 },
      secondaries: [blue],
    });
});

test("hue curves change the selected hue in the viewer and save by channel", async ({
  page,
  request,
}, info) => {
  const { project, steps, grade } = await gradeProject(request, [
    "drawbox=x=0:y=0:w=iw:h=ih:color=lime:t=fill",
  ]);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  await page.locator('.tl-lanes [data-clip="a"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();
  const plot = inspector.getByRole("group", { name: "Hue vs hue curve" });
  await plot.scrollIntoViewIfNeeded();
  const { x, y, width, height } = (await plot.boundingBox())!;
  const before = await centrePixel(page);
  expect(before.green).toBeGreaterThan(230);
  await page.screenshot({ path: info.outputPath("neutral-hue.png") });
  const history = await steps();
  const turnGreenTowardRed = async () => {
    await page.mouse.move(x + width / 3, y + height / 2);
    await page.mouse.down();
    await page.mouse.move(x + width / 3, y + height * 0.833, { steps: 6 });
    await expect.poll(() => warmth(page)).toBeGreaterThan(100);
  };
  await turnGreenTowardRed();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect
    .poll(async () => (await centrePixel(page)).green)
    .toBeGreaterThan(230);
  expect(await steps()).toBe(history);
  await turnGreenTowardRed();
  expect(await steps()).toBe(history);
  await page.mouse.up();
  await expect.poll(steps).toBe(history + 1);
  await expect.poll(() => warmth(page)).toBeGreaterThan(100);
  const shifted = GradeSchema.parse(await grade("a"));
  expect(shifted.hueCurves).toMatchObject({
    hueVsHue: [
      [0, 0],
      [expect.closeTo(120, 0), expect.closeTo(-120, -1)],
      [240, 0],
    ],
  });
  await page.screenshot({ path: info.outputPath("rotated-hue.png") });

  const channels = inspector.getByRole("combobox", { name: "Hue curves" });
  await channels.click();
  await page.getByRole("option", { name: "Hue vs saturation" }).click();
  await inspector
    .getByRole("slider", { name: "Hue vs saturation point 2" })
    .press("Shift+ArrowDown");
  await expect.poll(steps).toBe(history + 2);
  expect((await grade("a"))?.hueCurves).toMatchObject({
    hueVsHue: shifted.hueCurves?.hueVsHue,
    hueVsSaturation: [
      [0, 0],
      [120, expect.closeTo(-0.2, 6)],
      [240, 0],
    ],
  });
  await inspector
    .getByRole("button", { name: "Reset Hue vs saturation curve" })
    .click();
  await expect
    .poll(async () => (await grade("a"))?.hueCurves)
    .toEqual(shifted.hueCurves);
});

test("a hue drag leaves a newer edit to that curve intact", async ({
  page,
  request,
}) => {
  const { project, grade, steps } = await gradeProject(request);
  const api = `/api/cutroom/projects/${project.id}`;
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  await page.locator('.tl-lanes [data-clip="a"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.locator("summary", { hasText: /^Colour/ }).click();
  const plot = inspector.getByRole("group", { name: "Hue vs hue curve" });
  await plot.scrollIntoViewIfNeeded();
  const { x, y, width, height } = (await plot.boundingBox())!;
  const before = await steps();
  await page.mouse.move(x + width / 3, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + width / 3, y + height * 0.75);
  const point = plot.getByRole("slider", { name: "Hue vs hue point 2" });
  await expect(point).toHaveAttribute("aria-valuenow", "-90");

  const revision = z
    .object({ revision: z.string() })
    .parse(await (await request.get(`${api}/timeline`)).json()).revision;
  const external = {
    hueVsHue: [
      [0, 0],
      [120, 45],
      [240, 0],
    ],
  };
  const response = await request.post(`${api}/commands`, {
    data: {
      expectedRevision: revision,
      commands: [
        { type: "setClip", clipId: "a", grade: { hueCurves: external } },
      ],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await expect(
    inspector.getByRole("button", { name: "Reset Hue vs hue curve" }),
  ).toBeEnabled();
  await page.mouse.up();
  await expect(point).toHaveAttribute("aria-valuenow", "45");
  expect(await steps()).toBe(before + 1);
  expect((await grade("a"))?.hueCurves).toEqual(external);
});
