import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
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

async function openEditFrameProject(
  page: Page,
  request: APIRequestContext,
  operation: string,
  size = { width: 640, height: 360 },
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: `Edit frame ${operation}`,
          width: size.width,
          height: size.height,
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
    ["drawbox=x=0:y=0:w=260:h=40:color=black:t=fill", ...bits].join(","),
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
    body{margin:0;background:black}main{position:relative;width:${size.width}px;height:${size.height}px}
    video{position:absolute;inset:0;width:100%;height:100%}
    </style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="${size.width}" data-height="${size.height}" data-duration="8" data-fps="30">
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
  return project;
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
    const project = await openEditFrameProject(page, request, operation);
    if (operation === "roll" || operation.startsWith("ripple"))
      await page.keyboard.press("t");
    const grid = page.locator(".tl-grid");
    const start = operation.endsWith("audio")
      ? "sound"
      : operation.endsWith("in")
        ? "incoming"
        : "outgoing";
    const clip = page.locator(`[data-clip="${start}"]`);
    const isIn = operation.endsWith("in");
    const inset = operation.startsWith("ripple") ? 5 : 1;
    const evidence = process.env.CUTROOM_TRIM_EVIDENCE;
    const baseline = process.env.CUTROOM_TRIM_BASELINE === "1";
    if (evidence) await mkdir(evidence, { recursive: true });
    for (const ending of ["escape", "release"] as const) {
      await expect(page.locator(".tl-lanes")).not.toHaveAttribute(
        "data-sliding",
      );
      await expect(grid).toHaveAttribute("data-refit", "settled");
      const ppf = await grid.evaluate((grid) =>
        Number((grid as HTMLElement).style.getPropertyValue("--ppf")),
      );
      const box = (await clip.boundingBox())!;
      const from = {
        x: isIn ? box.x + inset : box.x + box.width - inset,
        y: box.y + box.height / 2,
      };
      const previewSrc = await page
        .locator("iframe[data-live]")
        .getAttribute("src");
      const previewRevision = await page
        .locator(".edit-stage")
        .getAttribute("data-preview-ready");
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
        await page.waitForFunction((previous) => {
          const stage = document.querySelector(".edit-stage");
          const next = stage?.getAttribute("data-preview-ready");
          return next != null && next !== previous;
        }, previewRevision);
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

for (const cancellation of ["lostpointercapture", "blur"] as const) {
  test(`${cancellation} discards a trim and restores the playhead before pointerup`, async ({
    page,
    request,
  }) => {
    const project = await openEditFrameProject(page, request, "out");
    const endpoint = `/api/cutroom/projects/${project.id}/timeline`;
    const before = TimelineViewSchema.parse(
      await (await request.get(endpoint)).json(),
    );
    const edits: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/commands"))
        edits.push(request.url());
    });
    const grid = page.locator(".tl-grid");
    await expect(grid).toHaveAttribute("data-refit", "settled");
    const ppf = await grid.evaluate((element) =>
      Number((element as HTMLElement).style.getPropertyValue("--ppf")),
    );
    const clip = page.locator('[data-clip="outgoing"]');
    const box = (await clip.boundingBox())!;
    const x = box.x + box.width - 1;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 24 * ppf, y, { steps: 4 });
    await expect.poll(() => pictureFrames(page)).toEqual([155]);
    await expect(clip).toHaveAttribute("data-held");
    await expect(grid).toHaveAttribute("data-gesturing");

    if (cancellation === "blur") {
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    } else {
      await page.locator(".tl-lanes").evaluate((element) => {
        element.addEventListener(
          "pointermove",
          (event) => {
            if (event instanceof PointerEvent)
              element.releasePointerCapture(event.pointerId);
          },
          { once: true },
        );
      });
      await page.mouse.move(x - 24 * ppf, y + 1);
      await page.mouse.move(x - 24 * ppf, y + 2);
    }

    await expect.poll(() => pictureFrames(page)).toEqual([90]);
    await expect(page.locator(".tl-lanes")).not.toHaveAttribute("data-cursor");
    await expect(clip).not.toHaveAttribute("data-held");
    await expect(page.locator(".tl-readout")).toBeHidden();
    if (cancellation === "blur")
      await expect(grid).toHaveAttribute("data-gesturing");
    // The later pointerup must not resurrect the cancelled edit.
    await page.mouse.up();
    await expect(grid).not.toHaveAttribute("data-gesturing");
    await expect.poll(() => pictureFrames(page)).toEqual([90]);
    const after = TimelineViewSchema.parse(
      await (await request.get(endpoint)).json(),
    );
    expect(after).toEqual(before);
    expect(edits).toEqual([]);
  });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1720, height: 1050 },
]) {
  for (const [aspect, size] of [
    ["16-9", { width: 640, height: 360 }],
    ["1-1", { width: 640, height: 640 }],
    ["9-16", { width: 360, height: 640 }],
  ] as const) {
    test(`roll labels fit the visible ${aspect} picture at ${viewport.width}x${viewport.height}`, async ({
      page,
      request,
    }, info) => {
      await page.setViewportSize(viewport);
      await openEditFrameProject(page, request, "roll", size);
      await page.keyboard.press("t");
      const grid = page.locator(".tl-grid");
      await expect(grid).toHaveAttribute("data-refit", "settled");
      const ppf = await grid.evaluate((element) =>
        Number((element as HTMLElement).style.getPropertyValue("--ppf")),
      );
      const box = (await page.locator('[data-clip="outgoing"]').boundingBox())!;
      const x = box.x + box.width - 1;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 24 * ppf, y, { steps: 4 });
      const labels = page.locator(".edit-edge-labels");
      await expect(labels).toBeVisible();
      await expect(labels).toContainText("00:00:06:23");
      await expect(labels).toContainText("00:00:10:24");
      const frame = page
        .frames()
        .find((frame) => frame.url().includes("/api/isolated/"))!;
      await expect(
        frame.locator('[data-cutroom-edit-frame][data-count="2"]'),
      ).toBeVisible();
      const filename = `roll-${aspect}-${viewport.width}x${viewport.height}.png`;
      await page.screenshot({ path: info.outputPath(filename) });
      const evidence = process.env.CUTROOM_TRIM_LAYOUT_EVIDENCE;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, filename) });
      }
      const bounds = await labels.locator("span").evaluateAll((labels) => {
        const picture = document
          .querySelector(".edit-picture")!
          .getBoundingClientRect();
        const stage = document
          .querySelector(".edit-stage")!
          .getBoundingClientRect();
        return labels.map((label, index) => {
          const range = document.createRange();
          range.selectNodeContents(label);
          const text = range.getBoundingClientRect();
          const box = label.getBoundingClientRect();
          return {
            text: {
              left: text.left,
              right: text.right,
              top: text.top,
              bottom: text.bottom,
            },
            box: {
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
            },
            half: {
              left: picture.left + (index * picture.width) / 2,
              right: picture.left + ((index + 1) * picture.width) / 2,
            },
            visible: {
              left: Math.max(picture.left, stage.left, 0),
              right: Math.min(picture.right, stage.right, innerWidth),
              top: Math.max(picture.top, stage.top, 0),
              bottom: Math.min(picture.bottom, stage.bottom, innerHeight),
            },
          };
        });
      });
      expect(bounds).toHaveLength(2);
      for (const { text, box: label, half, visible } of bounds) {
        for (const rect of [text, label]) {
          expect(rect.left).toBeGreaterThanOrEqual(
            Math.max(half.left, visible.left) - 0.5,
          );
          expect(rect.right).toBeLessThanOrEqual(
            Math.min(half.right, visible.right) + 0.5,
          );
          expect(rect.top).toBeGreaterThanOrEqual(visible.top - 0.5);
          expect(rect.bottom).toBeLessThanOrEqual(visible.bottom + 0.5);
        }
      }
      await page.keyboard.press("Escape");
      await page.mouse.up();
    });
  }
}
