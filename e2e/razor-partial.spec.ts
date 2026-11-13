import { execFile } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

test("E cuts video under an id-animated title, reports the skip, and undoes in one step", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Razor under a title",
          width: 640,
          height: 360,
          duration: 4,
        },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30:d=4",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    join(project.path, "picture.mp4"),
  ]);
  await copyFile(
    join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
    join(project.path, "gsap.min.js"),
  );
  const title = `<div id="lower" class="clip" data-label="Lower third" data-start="0" data-duration="4" data-track-index="1">Lower third</div>`;
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    `<!doctype html><html><head><style>html,body{margin:0}video{width:640px;height:360px}.clip{position:absolute;left:40px;top:260px;color:white;background:#151515;padding:16px;font:28px sans-serif}</style><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="4"><video id="picture" data-label="Picture" src="picture.mp4" muted data-start="0" data-duration="4" data-track-index="0"></video>${title}</main><script>window.__timelines.main=gsap.timeline({paused:true}).fromTo('#lower',{opacity:0,x:-30},{opacity:1,x:0,duration:.5});</script></body></html>`,
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("[data-clip]")).toHaveCount(2);
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("0200");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-preview-ready]")).toHaveAttribute(
    "data-preview-ready",
  );
  const before = await read();
  const batches: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`${api}/commands`)
    )
      batches.push(request.postDataJSON());
  });
  await page.keyboard.press("e");
  await expect.poll(async () => (await read()).timeline.clips.length).toBe(3);
  await page.screenshot({ path: info.outputPath("partial-notice.png") });
  await expect(page.getByRole("status").locator("span")).toHaveText(
    "Cut 1 clip. Lower third left whole.",
  );
  await expect(page.locator("[data-clip]")).toHaveCount(3);
  const after = await read();
  expect(
    after.timeline.clips
      .filter((clip) => clip.kind === "video")
      .map((clip) => [clip.start, clip.duration]),
  ).toEqual([
    [0, 60],
    [60, 60],
  ]);
  expect(after.timeline.clips.find((clip) => clip.id === "lower")).toEqual(
    before.timeline.clips.find((clip) => clip.id === "lower"),
  );
  expect(await readFile(index, "utf8")).toContain(title);
  expect(batches).toEqual([
    expect.objectContaining({
      commands: [
        expect.objectContaining({
          type: "split",
          at: 60,
          clipIds: ["picture", "lower"],
          autoSelect: true,
        }),
      ],
    }),
  ]);
  await expect(page.locator("[data-preview-ready]")).toHaveAttribute(
    "data-preview-ready",
  );
  await page.screenshot({ path: info.outputPath("after.png") });
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await read()).timeline)
    .toEqual(before.timeline);
  await page.locator('[data-clip="lower"]').click();
  await page.keyboard.press("e");
  await expect(page.getByRole("alert")).toContainText(
    "Edit it in the source instead.",
  );
  expect((await read()).timeline).toEqual(before.timeline);
  expect(batches).toHaveLength(1);
});

for (const [key, expectedPicture] of [
  [
    "q",
    [
      ["shot", 60, 30],
      ["later", 90, 360],
    ],
  ],
  [
    "w",
    [
      ["shot", 60, 30],
      ["later", 90, 360],
    ],
  ],
  ["Shift+x", [["later", 60, 360]]],
] satisfies [string, (string | number)[][]][]) {
  test(`${key} shortens an id-animated title in place and honors its auto-select opt-out`, async ({
    page,
    request,
  }, info) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: {
            name: `Ripple sync ${key}`,
            width: 640,
            height: 360,
            duration: 16,
          },
        })
      ).json(),
    );
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x360:r=30:d=16",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      join(project.path, "picture.mp4"),
    ]);
    await copyFile(
      join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
      join(project.path, "gsap.min.js"),
    );
    const title = `<div id="lower" class="clip" data-label="Lower third" data-start="0" data-duration="10" data-track-index="1">Lower third</div>`;
    const index = join(project.path, "index.html");
    const html = `<!doctype html><html><head><style>html,body{margin:0}video{width:640px;height:360px}.clip{position:absolute;left:40px;top:260px;color:white;background:#151515;padding:16px;font:28px sans-serif}</style><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="16"><video id="shot" data-label="Shot" src="picture.mp4" muted data-start="2" data-duration="2" data-media-start="2" data-track-index="0"></video><video id="later" data-label="Later shot" src="picture.mp4" muted data-start="4" data-duration="12" data-track-index="0"></video>${title}<div id="later-title" class="clip" data-start="14" data-duration="2" data-track-index="1">Later cue</div></main><script>window.__timelines.main=gsap.timeline({paused:true}).fromTo('#lower',{opacity:0,x:-30},{opacity:1,x:0,duration:.5});</script></body></html>`;
    await writeFile(index, html);
    const api = `/api/cutroom/projects/${project.id}`;
    const read = async () =>
      TimelineViewSchema.parse(
        await (await request.get(`${api}/timeline`)).json(),
      );
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator("[data-clip]")).toHaveCount(4);
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page.getByLabel("Go to time").pressSequentially("0300");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-preview-ready]")).toHaveAttribute(
      "data-preview-ready",
    );
    if (key === "Shift+x") await page.locator('[data-clip="shot"]').click();
    const before = await read();
    await page.keyboard.press(key);
    await expect
      .poll(
        async () =>
          (await read()).timeline.clips.find((clip) => clip.id === "lower")
            ?.duration,
      )
      .toBe(key === "Shift+x" ? 240 : 270);
    await expect(page.locator('[data-clip^="lower"]')).toHaveCount(1);
    expect(
      (await read()).timeline.clips.find((clip) => clip.id === "lower")?.start,
    ).toBe(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator("[data-preview-ready]")).toHaveAttribute(
      "data-preview-ready",
    );
    await page.screenshot({ path: info.outputPath("shortened.png") });
    await page.keyboard.press("Control+z");
    await expect
      .poll(async () => (await read()).timeline)
      .toEqual(before.timeline);
    expect(await readFile(index, "utf8")).toBe(html);
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page.getByLabel("Go to time").pressSequentially("0300");
    await page.keyboard.press("Enter");
    if (key === "Shift+x") await page.locator('[data-clip="shot"]').click();
    await page
      .getByRole("button", { name: "Auto-select V2", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await read()).timeline.tracks.find((track) => track.index === 1)
            ?.autoSelect,
      )
      .toBe(false);
    const optedOut = await read();
    await page.keyboard.press(key);
    await expect
      .poll(async () =>
        (await read()).timeline.clips
          .filter((clip) => clip.track === 0)
          .map((clip) => [clip.id, clip.start, clip.duration]),
      )
      .toEqual(expectedPicture);
    expect(
      (await read()).timeline.clips.filter((clip) => clip.track === 1),
    ).toEqual(before.timeline.clips.filter((clip) => clip.track === 1));
    expect(await readFile(index, "utf8")).toContain(title);
    await expect(page.locator("[data-preview-ready]")).toHaveAttribute(
      "data-preview-ready",
    );
    await page.screenshot({ path: info.outputPath("opted-out.png") });
    await page.keyboard.press("Control+z");
    await expect
      .poll(async () => (await read()).timeline)
      .toEqual(optedOut.timeline);
    await page.keyboard.press("Control+z");
    await expect
      .poll(async () => (await read()).timeline)
      .toEqual(before.timeline);
    expect(await readFile(index, "utf8")).toBe(html);
  });
}
