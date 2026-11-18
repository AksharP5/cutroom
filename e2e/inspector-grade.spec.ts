import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
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
async function gradeProject(request: APIRequestContext) {
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
    ...["-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast"],
    join(project.path, "grey.mp4"),
  ]);
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      /<main([^>]*)>[\s\S]*<\/main>/,
      (_match, attributes: string) =>
        `<main${attributes}>\n<video id="a" class="clip" muted src="grey.mp4" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" data-start="0" data-duration="2" data-track-index="0" data-label="Shot A"></video>\n<video id="b" class="clip" muted src="grey.mp4" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" data-start="2" data-duration="2" data-media-start="2" data-track-index="0" data-label="Shot B"></video>\n</main>`,
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

/** Red minus blue at the picture's centre: positive is warm. */
async function warmth(page: Page) {
  const png = await page.locator("iframe[data-live]").screenshot();
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const [r, , b] = context.getImageData(
      Math.round(image.width / 2),
      Math.round(image.height / 2),
      1,
      1,
    ).data;
    return r! - b!;
  }, png.toString("base64"));
}

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
