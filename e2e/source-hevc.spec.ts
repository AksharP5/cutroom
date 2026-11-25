import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Locator } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { startMediaDrag } from "./media-drag";

const exec = promisify(execFile);

/** Read the middle pixel from the browser's rendered picture, including a paused seek. */
async function colour(locator: Locator) {
  const png = (await locator.screenshot()).toString("base64");
  return locator.page().evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const context = new OffscreenCanvas(1, 1).getContext("2d")!;
    context.drawImage(image, -image.width / 2, -image.height / 2);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return r! > 180 && g! < 80 && b! < 80
      ? "red"
      : g! > 180 && r! < 80 && b! < 80
        ? "green"
        : b! > 180 && r! < 80 && g! < 80
          ? "blue"
          : "blank";
  }, png);
}

test("HEVC shows in Media and Source, and a marked silent 4K shot can be placed", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.fetch("/api/cutroom/projects", {
        method: "POST",
        data: {
          name: "HEVC source",
          width: 1920,
          height: 1080,
          fps: { num: 60, den: 1 },
        },
      })
    ).json(),
  );
  const make = (name: string, size: string, seconds: number, audio: boolean) =>
    exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=red:s=${size}:r=60:d=${seconds}`,
      ...(audio
        ? [
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=440:duration=${seconds}`,
            "-af",
            "asetpts=PTS+1024/SR/TB",
            "-c:a",
            "aac",
          ]
        : ["-an"]),
      "-vf",
      "drawbox=color=lime:t=fill:enable='gte(t,1)',drawbox=color=blue:t=fill:enable='eq(n,420)'",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-tag:v",
      "hvc1",
      "-g",
      "60",
      "-x265-params",
      "log-level=error:pools=2:frame-threads=2",
      join(project.path, name),
    ]);
  await make("recording.mkv", "1920x1080", 10, true);
  await make("silent-4k.mp4", "3840x2160", 2, false);

  await page.goto(`/#project/${project.id}`);
  const media = page.getByRole("region", { name: "Media", exact: true });
  const recording = media.getByRole("listitem", { name: "recording.mkv" });
  const silent = media.getByRole("listitem", { name: "silent-4k.mp4" });
  await expect(recording).toHaveAttribute("draggable", "true");
  const source = page.getByRole("group", { name: "Source" });
  const picture = source.locator(".edit-source-media");
  const opening = performance.now();
  await recording.dblclick();
  await expect(picture).toBeVisible();
  await expect.poll(() => colour(picture), { timeout: 12_000 }).toBe("red");
  console.log(
    `Recording open to first picture: ${Math.round(performance.now() - opening)} ms`,
  );
  await page.screenshot({ path: info.outputPath("recording-source.png") });
  for (const row of [recording, silent])
    await expect.poll(() => colour(row.locator(".media-thumb"))).toBe("red");
  await media.screenshot({ path: info.outputPath("media.png") });

  const video = source.locator("video");
  await page.keyboard.press("Space");
  await expect.poll(() => colour(picture)).toBe("green");
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.currentTime),
  ).toBeGreaterThan(1);
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => colour(picture)).toBe("red");

  const seek = async (time: string) => {
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page.getByLabel("Go to time").pressSequentially(time);
    await page.getByLabel("Go to time").press("Enter");
  };
  // A single blue frame at 7:00, in a different four-second proxy piece.
  await seek("00000700");
  await expect.poll(() => colour(picture)).toBe("blue");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => colour(picture)).toBe("green");

  const clips = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline.clips.map(({ kind, src, duration, mediaStart }) => [
      kind,
      src,
      duration,
      mediaStart,
    ]);
  const openMarked = async () => {
    await silent.dblclick();
    await expect(source).toBeVisible();
    await seek("00000030");
    await page.keyboard.press("i");
    await seek("00000129");
    await page.keyboard.press("o");
    await expect(source.getByTitle("Length to place")).toHaveText(
      "00:00:01:00",
    );
    await expect.poll(() => colour(picture)).toBe("green");
  };
  await expect(silent).toHaveAttribute("draggable", "true");
  await openMarked();
  await page.screenshot({ path: info.outputPath("silent-source.png") });
  const marked = [["video", "silent-4k.mp4", 60, 0.5]];
  for (const edit of ["Insert", "Overwrite"]) {
    await source.getByRole("button", { name: new RegExp(`^${edit}`) }).click();
    await expect.poll(clips).toEqual(marked);
    await page.keyboard.press("Control+z");
    await expect.poll(clips).toEqual([]);
    await openMarked();
  }
  const drop = async (dragged: Locator) => {
    await startMediaDrag(page, dragged);
    const band = page.locator(".tl-drop-above");
    const box = (await band.boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + box.height / 2, { steps: 10 });
    await expect(page.locator(".tl-ghost")).toBeVisible();
    await page.mouse.up();
  };
  await drop(picture);
  await expect.poll(clips).toEqual(marked);
  await page.keyboard.press("Control+z");
  await expect.poll(clips).toEqual([]);
  await drop(silent);
  await expect.poll(clips).toEqual([["video", "silent-4k.mp4", 120, 0]]);
});

test("Source and Media place the video span when it starts late and the audio runs longer", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Late HEVC picture",
          width: 1920,
          height: 1080,
          fps: { num: 60, den: 1 },
        },
      })
    ).json(),
  );
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=320x180:r=60:d=10",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo:d=12.02",
    "-vf",
    "drawbox=color=black:t=fill:enable='between(n,1,2)',drawbox=color=lime:t=fill:enable='gte(n,60)',drawbox=color=blue:t=fill:enable='eq(n,180)',setpts=PTS+2/TB",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-x265-params",
    "log-level=error:pools=2:frame-threads=2",
    "-tag:v",
    "hvc1",
    "-c:a",
    "aac",
    join(project.path, "late.mp4"),
  ]);

  await page.goto(`/#project/${project.id}`);
  const row = page.getByRole("listitem", { name: "late.mp4" });
  await expect(row).toHaveAttribute("draggable", "true");
  await expect(row.locator(".media-duration")).toHaveText("00:00:10:00");
  await expect.poll(() => colour(row.locator(".media-thumb"))).toBe("red");
  await row.dblclick();

  const source = page.getByRole("group", { name: "Source" });
  const picture = source.locator(".edit-source-media");
  await expect.poll(() => colour(picture)).toBe("red");
  await expect(source.getByTitle("Length to place")).toHaveText("00:00:10:00");
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("00000300");
  await page.getByLabel("Go to time").press("Enter");
  await expect.poll(() => colour(picture)).toBe("blue");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => colour(picture)).toBe("green");

  await source.getByRole("button", { name: /^Insert/ }).click();
  await expect
    .poll(async () =>
      TimelineViewSchema.parse(
        await (
          await request.get(`/api/cutroom/projects/${project.id}/timeline`)
        ).json(),
      )
        .timeline.clips.filter(({ kind }) => kind === "video")
        .map(({ src, duration, mediaStart }) => [src, duration, mediaStart]),
    )
    .toEqual([["late.mp4", 600, 2]]);
});
