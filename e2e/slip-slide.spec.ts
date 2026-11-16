import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { waitForPreview } from "./preview-ready";

/** The binary frame numbers burnt into each side of the edit picture. */
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

/**
 * Three shots of one 20-second file with its frame number burnt in, each with linked sound:
 * a shows source frames 60-119, b 300-359 and c 420-479, end to end from frame 0, unless
 * `gap` leaves that many frames between a and b. With `broll`, b is picture alone.
 */
async function openProject(
  page: Page,
  request: APIRequestContext,
  { gap = 0, broll = false } = {},
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Slip and slide", width: 640, height: 360, duration: 8 },
      })
    ).json(),
  );
  const bits = Array.from(
    { length: 10 },
    (_, bit) =>
      `drawbox=x=${10 + bit * 24}:y=10:w=20:h=20:color=white:t=fill:enable='mod(floor(n/${2 ** bit}),2)'`,
  );
  await promisify(execFile)("ffmpeg", [
    ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=20"],
    ...["-f", "lavfi", "-i", "sine=frequency=220:duration=20"],
    ...["-c:a", "aac", "-shortest", "-vf"],
    ["drawbox=x=0:y=0:w=260:h=40:color=black:t=fill", ...bits].join(","),
    ...["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-g", "30"],
    join(project.path, "Frames.mp4"),
  ]);
  const shots = [
    { id: "a", start: 0, source: 2 },
    { id: "b", start: (60 + gap) / 30, source: 10 },
    { id: "c", start: (120 + gap) / 30, source: 14 },
  ];
  const clips = shots
    .map(
      ({ id, start, source }) =>
        `<video id="${id}" data-link="${id}" muted src="Frames.mp4" data-track-index="0" data-start="${start}" data-duration="2" data-media-start="${source}"></video>
    ${broll && id === "b" ? "" : `<audio id="${id}-sound" data-link="${id}" src="Frames.mp4" data-track-index="1" data-start="${start}" data-duration="2" data-media-start="${source}"></audio>`}`,
    )
    .join("\n    ");
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>
    body{margin:0;background:black}main{position:relative;width:640px;height:360px}
    video{position:absolute;inset:0;width:100%;height:100%}
    </style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-duration="8" data-fps="30">
    ${clips}
    </main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  await page.getByRole("button", { name: /^Snapping/ }).click();
  return project;
}

async function readClips(request: APIRequestContext, projectId: string) {
  const view = TimelineViewSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${projectId}/timeline`)
    ).json(),
  );
  return Object.fromEntries(view.timeline.clips.map((clip) => [clip.id, clip]));
}

async function settled(page: Page) {
  await expect(page.locator(".tl-lanes")).not.toHaveAttribute("data-sliding");
  const grid = page.locator(".tl-grid");
  await expect(grid).toHaveAttribute("data-refit", "settled");
  return grid.evaluate((grid) =>
    Number((grid as HTMLElement).style.getPropertyValue("--ppf")),
  );
}

test("the Trim tool slips a clip by its body, showing its new in and out, without a reload", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const project = await openProject(page, request);
  await page.keyboard.press("t");
  const ppf = await settled(page);
  const box = (await page.locator('[data-clip="b"]').boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height - 6 };
  const src = await page.locator("iframe[data-live]").getAttribute("src");
  const revision = await page
    .locator(".edit-stage")
    .getAttribute("data-preview-ready");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // The source follows the pointer: dragging right shows earlier frames.
  for (const by of [6, 12]) {
    await page.mouse.move(from.x + by * ppf, from.y, { steps: 3 });
    await expect.poll(() => pictureFrames(page)).toEqual([300 - by, 359 - by]);
  }
  await page.mouse.up();
  await expect
    .poll(async () => {
      const { b, "b-sound": sound } = await readClips(request, project.id);
      return [b?.start, b?.mediaStart, sound?.mediaStart];
    })
    .toEqual([60, 9.6, 9.6]);
  await waitForPreview(page, { after: revision });
  await expect(page.locator("iframe[data-live]")).toHaveAttribute("src", src!);
  await expect(page.locator("iframe")).toHaveCount(1);

  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await readClips(request, project.id)).b?.mediaStart)
    .toBe(10);
  await page.keyboard.press("Control+Shift+z");
  await expect
    .poll(async () => (await readClips(request, project.id)).b?.mediaStart)
    .toBe(9.6);
});

test("the Trim tool slides a clip by its name strip, trimming its neighbours and their sound", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const project = await openProject(page, request);
  await page.keyboard.press("t");
  const ppf = await settled(page);
  const box = (await page.locator('[data-clip="b"]').boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + 5 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // a's new out and c's new in, either side of b.
  for (const by of [6, 12]) {
    await page.mouse.move(from.x + by * ppf, from.y, { steps: 3 });
    await expect.poll(() => pictureFrames(page)).toEqual([119 + by, 420 + by]);
  }
  await page.mouse.up();
  const expected = {
    a: [0, 72, 2],
    b: [72, 60, 10],
    c: [132, 48, 14.4],
  };
  const places = async () => {
    const clips = await readClips(request, project.id);
    return Object.fromEntries(
      ["a", "b", "c", "a-sound", "b-sound", "c-sound"].map((id) => [
        id,
        [clips[id]?.start, clips[id]?.duration, clips[id]?.mediaStart],
      ]),
    );
  };
  await expect.poll(places).toEqual({
    ...expected,
    "a-sound": expected.a,
    "b-sound": expected.b,
    "c-sound": expected.c,
  });
  // The first edit that moves a clip adds the track stylesheet and reloads; slides after it
  // update the preview in place. After S, period slides b one frame.
  await waitForPreview(page);
  const src = await page.locator("iframe[data-live]").getAttribute("src");
  const revision = await page
    .locator(".edit-stage")
    .getAttribute("data-preview-ready");
  await page.keyboard.press("s");
  await page.keyboard.press(".");
  await expect.poll(async () => (await places()).b).toEqual([73, 60, 10]);
  await waitForPreview(page, { after: revision });
  await expect(page.locator("iframe[data-live]")).toHaveAttribute("src", src!);
  await expect(page.locator("iframe")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await places()).b).toEqual([60, 60, 10]);
});

test("a clicked gap closes with Delete; drifted sound shows its offset until unlinked", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const project = await openProject(page, request, { gap: 30 });
  const ppf = await settled(page);
  const lane = (await page.locator('[data-clip="a"]').boundingBox())!;
  // The middle of the 30-frame gap between a and b on V1.
  await page.mouse.click(lane.x + 75 * ppf, lane.y + lane.height / 2);
  await expect(page.locator(".tl-gap")).toHaveAttribute("data-gap", "60-90");
  await page.keyboard.press("Delete");
  await expect
    .poll(async () => {
      const clips = await readClips(request, project.id);
      return [clips.b?.start, clips["b-sound"]?.start, clips.c?.start];
    })
    .toEqual([60, 60, 120]);
  await expect(page.locator(".tl-gap")).toHaveCount(0);

  // Alt+period slips b's sound alone: it now plays its source one frame late.
  const b = (await page.locator('[data-clip="b"]').boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height - 6);
  await page.keyboard.press("Alt+.");
  await expect(page.locator('[data-clip-label="b-sound"] .tl-sync')).toHaveText(
    "+1",
  );
  await expect(page.locator('[data-clip-label="b"] .tl-sync')).toHaveText("-1");
  await page.keyboard.press("Control+Alt+l");
  await expect(page.locator(".tl-sync")).toHaveCount(0);
  await expect
    .poll(async () => (await readClips(request, project.id)).b?.link)
    .toBeNull();
  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-clip-label="b"] .tl-sync')).toHaveText("-1");
});

test("sliding B-roll between interview shots trims their sound with their pictures", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const project = await openProject(page, request, { broll: true });
  await page.keyboard.press("t");
  const ppf = await settled(page);
  const box = (await page.locator('[data-clip="b"]').boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + 5 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12 * ppf, from.y, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const clips = await readClips(request, project.id);
      return ["a", "a-sound", "b", "c", "c-sound"].map((id) => [
        clips[id]?.start,
        clips[id]?.duration,
        clips[id]?.mediaStart,
      ]);
    })
    .toEqual([
      [0, 72, 2],
      [0, 72, 2],
      [72, 60, 10],
      [132, 48, 14.4],
      [132, 48, 14.4],
    ]);
});
