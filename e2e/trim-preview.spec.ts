import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

/** Read the binary frame number burnt into the decoded picture, not the seek request. */
async function pictureFrames(page: Page) {
  const frame = page
    .frames()
    .find((frame) => frame.url().includes("/api/isolated/"));
  if (!frame) return [];
  return frame.evaluate(() => {
    const edit = document.querySelector<HTMLCanvasElement>(
      "[data-cutroom-edit-frame]",
    );
    const canvas =
      edit ??
      document.querySelector<HTMLCanvasElement>("[data-cutroom-video-hold]");
    if (!canvas) return [];
    const count = Number(edit?.dataset.count ?? 1);
    const context = canvas.getContext("2d")!;
    return Array.from({ length: count }, (_, side) => {
      const width = canvas.width / count;
      const scale = Math.min(width / 640, canvas.height / 360);
      const left = side * width + (width - 640 * scale) / 2;
      const top = (canvas.height - 360 * scale) / 2;
      let number = 0;
      for (let bit = 0; bit < 10; bit++) {
        const pixel = context.getImageData(
          Math.round(left + (20 + bit * 24) * scale),
          Math.round(top + 20 * scale),
          1,
          1,
        ).data;
        if (pixel[0]! > 128) number += 2 ** bit;
      }
      return number;
    });
  });
}

for (const operation of [
  "in",
  "out",
  "roll",
  "ripple-in",
  "ripple-out",
  "audio",
  "linked-audio",
] as const) {
  test(`${operation} shows source edge frames and restores the playhead`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: {
            name: `Edit frame ${operation}`,
            width: 640,
            height: 360,
            duration: 8,
          },
        })
      ).json(),
    );
    const bits = Array.from(
      { length: 10 },
      (_, bit) =>
        `drawbox=x=${10 + bit * 24}:y=10:w=20:h=20:color=white:t=fill:enable='mod(floor(n/${2 ** bit}),2)'`,
    );
    const font = [
      "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
      "/usr/share/fonts/TTF/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ].find(existsSync);
    if (!font)
      throw new Error(
        "The frame-number fixture needs an installed sans-serif font.",
      );
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x360:r=30:d=20",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=20",
      "-c:a",
      "aac",
      "-shortest",
      "-vf",
      [
        "drawbox=x=0:y=0:w=260:h=40:color=black:t=fill",
        ...bits,
        `drawtext=fontfile=${font}:text='FRAME %{n}  %{pts\\:hms}':x=16:y=55:fontsize=28:fontcolor=white:box=1:boxcolor=black`,
      ].join(","),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "18",
      "-g",
      "30",
      join(project.path, "Frames.mp4"),
    ]);
    const link = operation === "linked-audio" ? 'data-link="pair"' : "";
    const sound = operation.endsWith("audio")
      ? `<audio id="sound" ${link} src="Frames.mp4" data-track-index="1" data-start="0" data-duration="4" data-media-start="2"></audio>`
      : "";
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><head><style>
      body{margin:0;background:black}main{position:relative;width:640px;height:360px}
      video{position:absolute;inset:0;width:100%;height:100%}
      </style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-duration="8" data-fps="30">
      <video id="outgoing" ${link} muted src="Frames.mp4" data-track-index="0" data-start="0" data-duration="4" data-media-start="2"></video>
      <video id="incoming" muted src="Frames.mp4" data-track-index="0" data-start="4" data-duration="4" data-media-start="10"></video>
      ${sound}</main></body></html>`,
    );
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator(".edit-stage")).toHaveAttribute(
      "data-preview-ready",
    );
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page.getByLabel("Go to time").pressSequentially("100");
    await page.keyboard.press("Enter");
    await expect.poll(() => pictureFrames(page)).toEqual([90]);
    await page.getByRole("button", { name: /^Snapping/ }).click();
    if (operation === "roll" || operation.startsWith("ripple"))
      await page.keyboard.press("t");
    const grid = page.locator(".tl-grid");
    await expect(grid).toHaveAttribute("data-refit", "settled");
    const ppf = await grid.evaluate((grid) =>
      Number((grid as HTMLElement).style.getPropertyValue("--ppf")),
    );
    const start = operation.endsWith("audio")
      ? "sound"
      : operation.endsWith("in")
        ? "incoming"
        : "outgoing";
    const clip = page.locator(`[data-clip="${start}"]`);
    const box = (await clip.boundingBox())!;
    const isIn = operation.endsWith("in");
    const inset = operation.startsWith("ripple") ? 5 : 1;
    const from = {
      x: isIn ? box.x + inset : box.x + box.width - inset,
      y: box.y + box.height / 2,
    };
    const evidence = process.env.CUTROOM_TRIM_EVIDENCE;
    const baseline = process.env.CUTROOM_TRIM_BASELINE === "1";
    if (evidence) await mkdir(evidence, { recursive: true });
    for (const ending of ["escape", "release"] as const) {
      await expect
        .poll(() =>
          page
            .locator(".tl-lanes")
            .evaluate(
              (element) =>
                element
                  .getAnimations({ subtree: true })
                  .filter((animation) => !(animation instanceof CSSAnimation))
                  .length,
            ),
        )
        .toBe(0);
      const previewSrc = await page
        .locator("iframe[data-live]")
        .getAttribute("src");
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (const [index, delta] of [6, 12, 18, 24].entries()) {
        const by = isIn || operation === "roll" ? delta : -delta;
        await page.mouse.move(from.x + by * ppf, from.y, { steps: 3 });
        const expected =
          baseline || operation === "audio"
            ? [90]
            : operation === "roll"
              ? [179 + by, 300 + by]
              : [isIn ? 300 + by : 179 + by];
        await expect.poll(() => pictureFrames(page)).toEqual(expected);
        await expect(page.locator("iframe[data-live]")).toHaveAttribute(
          "src",
          previewSrc!,
        );
        await expect(page.locator("iframe")).toHaveCount(1);
        if (evidence && ending === "escape")
          await page.screenshot({
            path: join(evidence, `${operation}-${index + 1}.png`),
          });
      }
      if (ending === "escape") await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect.poll(() => pictureFrames(page)).toEqual([90]);
      await expect(page.locator(".edit-stage")).toHaveAttribute(
        "data-preview-ready",
      );
      if (ending === "release") {
        await expect
          .poll(async () => {
            const view = TimelineViewSchema.parse(
              await (
                await request.get(
                  `/api/cutroom/projects/${project.id}/timeline`,
                )
              ).json(),
            );
            return view.timeline.clips.find((clip) => clip.id === start)
              ?.duration;
          })
          .toBe(operation === "roll" ? 144 : 96);
        await expect(page.locator("iframe[data-live]")).not.toHaveAttribute(
          "src",
          previewSrc!,
        );
        await expect(page.locator(".edit-stage")).toHaveAttribute(
          "data-preview-ready",
        );
        await expect.poll(() => pictureFrames(page)).toEqual([90]);
      }
      if (ending === "escape") {
        const view = TimelineViewSchema.parse(
          await (
            await request.get(`/api/cutroom/projects/${project.id}/timeline`)
          ).json(),
        );
        expect(
          view.timeline.clips
            .filter((clip) => clip.kind === "video")
            .map((clip) => clip.duration),
        ).toEqual([120, 120]);
      }
    }
  });
}
