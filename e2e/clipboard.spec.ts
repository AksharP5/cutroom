import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

test("clipboard keys overwrite, lift and insert linked clips, each edit undoing once", async ({
  page,
  request,
}, testInfo) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Clipboard keys" },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=12",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "source.mp4"),
  ]);
  const path = join(project.path, "index.html");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      /<main([^>]*)data-duration="12"([^>]*)>[\s\S]*<\/main>/,
      `<main$1data-duration="12"$2>
    <video src="source.mp4" muted id="picture" class="clip" data-label="Picture" data-start="0" data-duration="2" data-track-index="0" data-link="pair"></video>
    <audio src="source.mp4" id="sound" class="clip" data-label="Sound" data-start="0.5" data-duration="2" data-track-index="1" data-link="pair"></audio>
    <video src="source.mp4" muted id="destination" class="clip" data-label="Destination" data-start="3" data-duration="6" data-track-index="0" data-link="destination-pair"></video>
    <audio src="source.mp4" id="destination-sound" class="clip" data-start="3" data-duration="6" data-track-index="1" data-link="destination-pair"></audio>
    </main>`,
    ),
  );
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(4);
  const endpoint = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${endpoint}/timeline`)).json(),
    ).timeline;
  const before = await read();
  const history = async () => (await request.get(`${endpoint}/history`)).json();
  const initialHistory = await history();
  const seek = async () => {
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page.getByLabel("Go to time").pressSequentially("0400");
    await page.keyboard.press("Enter");
  };
  const undo = async () => {
    await page.keyboard.press("Control+z");
    await expect.poll(read).toEqual(before);
  };
  const liftPasted = async () => {
    const pasted = await read();
    const copies = pasted.clips.filter(
      (clip) =>
        clip.start >= 120 &&
        (clip.label === "Picture" || clip.label === "Sound"),
    );
    expect(copies).toHaveLength(2);
    await expect(timeline.locator("[data-clip].selected")).toHaveCount(2);
    for (const clip of copies)
      await expect(timeline.locator(`[data-clip="${clip.id}"]`)).toHaveClass(
        /selected/,
      );
    await page.keyboard.press("x");
    await expect
      .poll(async () => (await read()).clips)
      .toEqual(pasted.clips.filter((clip) => !copies.includes(clip)));
    expect(
      (await read()).clips.filter(
        (clip) => clip.id === "picture" || clip.id === "sound",
      ),
    ).toEqual(
      before.clips.filter(
        (clip) => clip.id === "picture" || clip.id === "sound",
      ),
    );
    await page.keyboard.press("Control+z");
    await expect.poll(read).toEqual(pasted);
  };
  await timeline.locator('[data-clip="picture"]').click();
  // Delayed copy proves an immediate paste waits for its snapshot, even after deselection.
  await page.route("**/timeline/copy", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Shift+A");
  await seek();
  await expect.poll(history).toEqual(initialHistory);
  await page.screenshot({ path: testInfo.outputPath("before.png") });
  await page.keyboard.press("Control+v");
  await expect.poll(async () => (await read()).clips.length).toBe(8);
  const pasted = (await read()).clips.filter(
    (clip) =>
      !before.clips.some((old) => old.id === clip.id) &&
      (clip.label === "Picture" || clip.label === "Sound"),
  );
  expect(pasted.map((clip) => [clip.track, clip.start, clip.duration])).toEqual(
    [
      [0, 120, 60],
      [1, 135, 60],
    ],
  );
  expect(pasted[0]!.link).toBe(pasted[1]!.link);
  expect(pasted[0]!.link).not.toBe("pair");
  await expect(timeline.locator("[data-clip]")).toHaveCount(8);
  await page.screenshot({ path: testInfo.outputPath("after-overwrite.png") });
  await liftPasted();
  await undo();

  await timeline.locator('[data-clip="picture"]').click();
  await page.keyboard.press("Control+x");
  await expect
    .poll(async () => (await read()).clips.map((clip) => clip.id))
    .toEqual(["destination", "destination-sound"]);
  await undo();

  // Cut left the clipboard intact. Paste Insert opens its full 75-frame span once.
  await timeline.locator('[data-clip="picture"]').click();
  await seek();
  await page.keyboard.press("Control+Shift+v");
  await expect.poll(async () => (await read()).clips.length).toBe(8);
  expect(
    (await read()).clips.map((clip) => [clip.track, clip.start, clip.duration]),
  ).toEqual([
    [0, 0, 60],
    [0, 90, 30],
    [0, 120, 60],
    [0, 195, 150],
    [1, 15, 60],
    [1, 90, 30],
    [1, 135, 60],
    [1, 195, 150],
  ]);
  await expect(timeline.locator("[data-clip]")).toHaveCount(8);
  await page.screenshot({ path: testInfo.outputPath("after-insert.png") });
  await liftPasted();
  await undo();

  // Typing and open dialogs keep their ordinary clipboard keys.
  await page.getByRole("button", { name: /^Current time/ }).click();
  for (const key of ["Control+c", "Control+x", "Control+v", "Control+Shift+v"])
    await page.keyboard.press(key);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+8");
  await expect(page.getByRole("dialog")).toBeVisible();
  for (const key of ["Control+c", "Control+x", "Control+v", "Control+Shift+v"])
    await page.keyboard.press(key);
  await page.keyboard.press("Escape");
  expect(await read()).toEqual(before);
});

test("clipboard names restricted clips and insert preserves the auto-select refusal", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Restricted clipboard" },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>#lower{color:white}</style></head><body><main data-composition-id="main" data-duration="12" data-width="1920" data-height="1080" data-fps="30">
    <div id="shot" class="clip" data-start="0" data-duration="2" data-track-index="0">Shot</div>
    <div id="lower" class="clip" data-label="Lower third" data-start="0" data-duration="12" data-track-index="1">Lower third</div>
  </main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(2);
  await timeline.locator('[data-clip="lower"]').click();
  await page.keyboard.press("Control+c");
  await expect(page.locator(".toast")).toContainText(
    "Lower third can't be copied",
  );
  await timeline.locator('[data-clip="shot"]').click();
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("0100");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+Shift+v");
  await expect(page.locator(".toast")).toContainText(
    "Turn off auto-select on V2",
  );
  await expect(timeline.locator("[data-clip]")).toHaveCount(2);
});
