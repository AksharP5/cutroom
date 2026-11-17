import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const run = promisify(execFile);

async function seek(page: Page, timecode: string) {
  await page
    .getByRole("button", { name: "Current time. Click to type a time." })
    .click();
  const input = page.getByRole("textbox", { name: "Go to time" });
  await input.pressSequentially(timecode);
  await input.press("Enter");
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
}

async function shownFrame(page: Page, path?: string) {
  const png = await page.locator(".edit-picture").screenshot({ path });
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0))], {
        type: "image/png",
      }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    let number = 0;
    for (let bit = 0; bit < 8; bit++) {
      const [red] = context.getImageData(
        Math.floor(((bit + 0.5) * bitmap.width) / 8),
        Math.floor(bitmap.height / 20),
        1,
        1,
      ).data;
      if (red! > 128) number |= 1 << bit;
    }
    const swatches = [
      [7, 50],
      [68, 65],
      [130, 65],
      [170, 76],
    ].flatMap(([x, y]) =>
      Array.from(
        context.getImageData(
          Math.floor((x! * bitmap.width) / 320),
          Math.floor((y! * bitmap.height) / 180),
          1,
          1,
        ).data,
      ).slice(0, 3),
    );
    return { number, swatches };
  }, png.toString("base64"));
}

test("freeze holds the selected source frame across linked picture and sound, and undo removes it", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Freeze frame evidence" },
      })
    ).json(),
  );
  const bits = Array.from(
    { length: 8 },
    (_, bit) =>
      `drawbox=x=${bit * 40}:y=0:w=40:h=18:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
  );
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30000/1001:d=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=6",
    "-vf",
    ["drawbox=x=0:y=0:w=320:h=18:color=black:t=fill", ...bits].join(","),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "source.mp4"),
  ]);
  const style =
    "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body style="margin:0"><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="4.004" data-fps="24000/1001">
    <video id="picture" class="clip" src="source.mp4" muted data-link="pair" data-start="0" data-duration="2.5025" data-media-start="0.4004" data-track-index="0" style="${style}"></video>
    <audio id="sound" class="clip" src="source.mp4" data-link="pair" data-start="0" data-duration="2.5025" data-media-start="0.4004" data-track-index="1"></audio>
    <video id="later" class="clip" src="source.mp4" muted data-start="3.003" data-duration="1.001" data-track-index="0" style="${style}"></video>
    <div id="other" class="clip" data-start="3.003" data-duration="1.001" data-track-index="2" style="position:absolute;bottom:0;color:white">Other track</div>
  </main></body></html>`,
  );

  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline;
  const before = await read();
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  const picture = page
    .getByRole("region", { name: "Timeline" })
    .locator('[data-clip="picture"]');
  const menu = page.getByRole("menu", { name: "Clip" });
  const freeze = menu.getByRole("menuitem", { name: "Freeze frame" });
  await picture.click({ button: "right" });
  await expect(freeze).toBeDisabled();
  await page.keyboard.press("Escape");

  await seek(page, "00000101");
  await expect.poll(async () => (await shownFrame(page)).number).toBe(43);
  const source = await shownFrame(page, info.outputPath("before-picture.png"));
  await page.screenshot({ path: info.outputPath("before-editor.png") });
  await picture.click({ button: "right" });
  await freeze.click();
  await expect.poll(async () => (await read()).clips.length).toBe(7);
  const clips = (await read()).clips;
  const still = clips.find((clip) => clip.label === "Freeze")!;
  expect(still).toMatchObject({
    kind: "image",
    start: 25,
    duration: 48,
    track: 0,
    hasAudio: false,
  });
  const asset = join(project.path, still.src!);
  const png = await readFile(asset);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  const tails = clips.filter((clip) => clip.start === 73);
  expect(tails).toHaveLength(2);
  expect(tails[0]).toMatchObject({
    track: 0,
    duration: 35,
    mediaStart: 1.443108,
  });
  expect(tails[1]).toMatchObject({
    track: 1,
    duration: 35,
    mediaStart: 1.443108,
    link: tails[0]!.link,
  });
  expect(tails[0]!.link).not.toBe("pair");
  expect(
    clips
      .filter((clip) => clip.id === "later" || clip.id === "other")
      .map(({ id, start }) => [id, start]),
  ).toEqual([
    ["later", 120],
    ["other", 72],
  ]);

  await seek(page, "00000200");
  await expect.poll(async () => (await shownFrame(page)).number).toBe(43);
  const held = await shownFrame(page, info.outputPath("after-picture.png"));
  const largestColourDelta = Math.max(
    ...source.swatches.map((value, pixel) =>
      Math.abs(value - held.swatches[pixel]!),
    ),
  );
  expect(largestColourDelta).toBeLessThanOrEqual(7);
  await page.screenshot({ path: info.outputPath("after-editor.png") });

  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);
  await expect
    .poll(() =>
      readFile(asset).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await read()).clips).toEqual(clips);
  expect(await readFile(asset)).toEqual(png);
});
