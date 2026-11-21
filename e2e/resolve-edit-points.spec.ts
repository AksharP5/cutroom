import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

async function linkedShots(request: APIRequestContext, overlay = "") {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Resolve keys", width: 320, height: 240, duration: 6 },
      })
    ).json(),
  );
  const path = `/api/cutroom/projects/${project.id}`;
  for (const [color, hz] of [
    ["red", 440],
    ["blue", 660],
    ["green", 550],
  ]) {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=320x240:r=30:d=4`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${hz}:sample_rate=48000:d=4`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      join(project.path, `${color}.mp4`),
    ]);
  }
  const clips = ["red", "blue", "green"]
    .map((color, index) => {
      const timing = `data-start="${index * 2}" data-duration="2" data-media-start="1" data-link="l${index}"`;
      return `<video id="v${index}" muted src="${color}.mp4" ${timing} data-track-index="0"></video><audio id="a${index}" src="${color}.mp4" ${timing} data-track-index="1"></audio>`;
    })
    .join("");
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;background:black}video{position:absolute;inset:0;width:100%;height:100%}</style></head><body><main data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="6" style="position:relative;width:320px;height:240px">${clips}${overlay}</main></body></html>`,
  );
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${path}/timeline`)).json(),
    );
  return { project, path, read };
}

async function pressEdit(
  page: Page,
  path: string,
  key: string,
  route = "commands",
) {
  const response = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" &&
      new URL(item.url()).pathname === `${path}/${route}`,
  );
  await page.keyboard.press(key);
  const saved = await response;
  expect(saved.ok(), await saved.text()).toBe(true);
  return TimelineViewSchema.parse(
    route === "commands"
      ? await saved.json()
      : await (await page.request.get(`${path}/timeline`)).json(),
  );
}

test("V and U trim the selected edit point with linked sound and one undo per press", async ({
  page,
  request,
}) => {
  const { project, path } = await linkedShots(request);
  await page.goto(`/#project/${project.id}`);
  await seekFrame(page, 60);
  await page.keyboard.press("Control+Shift+l");
  await page.keyboard.press("Alt+9");
  await page.keyboard.press("v");
  await expect(page.locator("[data-edit-edge]")).toHaveCount(2);
  await expect(page.locator('[data-edit-edge="a1:start"]')).toBeVisible();
  await page.keyboard.press("Alt+9");
  await page.keyboard.press("Control+Shift+l");
  await page.keyboard.press("v");
  await expect(page.locator("[data-edit-edge]")).toHaveCount(4);
  await expect(page.locator('[data-edit-edge="v1:start"]')).toBeVisible();

  const roll = await pressEdit(page, path, "Period");
  const readClip = (view: typeof roll, id: string) =>
    view.timeline.clips.find((clip) => clip.id === id);
  expect(readClip(roll, "v0")).toMatchObject({ start: 0, duration: 61 });
  expect(readClip(roll, "v1")).toMatchObject({ start: 61, duration: 59 });
  expect(readClip(roll, "a1")).toMatchObject({ start: 61, duration: 59 });
  await expect(page.locator('[data-edit-edge="v1:start"]')).toHaveAttribute(
    "data-frame",
    "61",
  );

  await page.keyboard.press("u");
  await expect(page.locator("[data-edit-edge]")).toHaveCount(2);
  await expect(page.locator('[data-edit-edge="v1:start"]')).toHaveCount(0);
  await page.keyboard.press("Period");
  await expect(page.getByRole("alert")).toContainText("overlap");
  await page.keyboard.press("t");
  const end = await pressEdit(page, path, "Period");
  expect(readClip(end, "v0")).toMatchObject({ duration: 62 });
  expect(readClip(end, "v1")).toMatchObject({ start: 62 });

  await page.keyboard.press("u");
  await expect(page.locator('[data-edit-edge="v1:start"]')).toBeVisible();
  const start = await pressEdit(page, path, "Shift+Period");
  expect(readClip(start, "v1")).toMatchObject({ start: 62, duration: 54 });
  expect(readClip(start, "a1")).toMatchObject({ start: 62, duration: 54 });
  expect(readClip(start, "v2")).toMatchObject({ start: 116 });
  const undone = await pressEdit(page, path, "Control+z", "history/undo");
  expect(readClip(undone, "v1")).toMatchObject({ start: 62, duration: 59 });

  const lock = page.getByRole("button", { name: "Lock A1", exact: true });
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("v");
  await page.keyboard.press("Period");
  await expect(page.getByRole("alert")).toContainText("A1 is locked.");
  await expect(page.locator('[data-edit-edge="v1:start"]')).toHaveAttribute(
    "data-frame",
    "62",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-edit-edge]")).toHaveCount(0);
});

test("Alt+V applies the copied attributes and Shift+R holds the whole picture clip", async ({
  page,
  request,
}) => {
  const { project, path, read } = await linkedShots(request);
  const basis = await read();
  const authored = await request.post(`${path}/commands`, {
    data: {
      expectedRevision: basis.revision,
      commands: [
        {
          type: "setClip",
          clipId: "v0",
          x: 16,
          scale: 1.25,
          grade: { adjust: { saturation: 0.5 } },
          region: {
            effect: "zoom",
            box: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          },
        },
        {
          type: "setClip",
          clipId: "v1",
          rotation: 10,
          fadeIn: 10,
          fadeOut: 8,
          region: {
            effect: "zoom",
            box: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
            in: 10,
            out: 8,
          },
          keyframes: {
            opacity: [
              { frame: 0, value: 1, ease: "linear" },
              { frame: 30, value: 0.6, ease: "linear" },
            ],
          },
        },
        { type: "setClip", clipId: "a0", volume: 0.5, fx: [{ type: "gain" }] },
        { type: "setTiming", clipId: "v0", playbackRate: 0.75 },
      ],
    },
  });
  expect(authored.ok(), await authored.text()).toBe(true);
  await page.goto(`/#project/${project.id}`);
  await seekFrame(page, 30);
  await page.keyboard.press("Shift+v");
  await page.keyboard.press("Control+c");
  await seekFrame(page, 90);
  await page.keyboard.press("Shift+v");
  const pasted = await pressEdit(page, path, "Alt+v");
  expect(pasted.timeline.clips.find(({ id }) => id === "v1")).toMatchObject({
    start: 80,
    duration: 80,
    src: "blue.mp4",
    x: 16,
    scaleX: 1.25,
    grade: { adjust: { saturation: 0.5 } },
    region: { effect: "zoom" },
    playbackRate: 0.75,
  });
  expect(pasted.timeline.clips.find(({ id }) => id === "a1")).toMatchObject({
    start: 80,
    duration: 80,
    src: "blue.mp4",
    volume: 0.5,
    playbackRate: 0.75,
    fx: [{ type: "gain" }],
  });
  for (const id of ["v2", "a2"])
    expect(pasted.timeline.clips.find((clip) => clip.id === id)?.start).toBe(
      160,
    );
  const speed = page.getByRole("textbox", { name: "Speed", exact: true });
  await expect(speed).toHaveValue("75%");
  const undone = await pressEdit(page, path, "Control+z", "history/undo");
  const beforeFreeze = undone.timeline.clips.find(({ id }) => id === "v1")!;
  expect(beforeFreeze).toMatchObject({
    start: 80,
    duration: 60,
    x: null,
    grade: null,
    playbackRate: 1,
  });
  await expect(speed).toHaveValue("100%");
  const frozen = await pressEdit(page, path, "Shift+r");
  const still = frozen.timeline.clips.find(({ kind }) => kind === "image");
  expect(still).toMatchObject({
    start: 80,
    duration: 60,
    link: "l1",
    rotation: 10,
    fadeIn: 10,
    fadeOut: 8,
    region: beforeFreeze.region,
    keyframes: beforeFreeze.keyframes,
  });
  expect(still?.region).toMatchObject({ in: 10, out: 8 });
  expect(still?.keyframes?.opacity).toHaveLength(2);
  expect(frozen.timeline.clips).toHaveLength(6);
  expect(frozen.timeline.clips.find(({ id }) => id === "a1")).toMatchObject({
    start: 80,
    duration: 60,
    link: "l1",
  });
  expect(frozen.timeline.clips.find(({ id }) => id === "v2")?.start).toBe(140);
  await expect(
    page.locator(`.tl-clip[data-clip="${still?.id}"]`),
  ).toBeVisible();
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
});

test("the source replaces to the playheads and places the marked range on top", async ({
  page,
  request,
}) => {
  const { project, path } = await linkedShots(request);
  await page.goto(`/#project/${project.id}`);
  await seekFrame(page, 30);
  await page.keyboard.press("f");
  await expect(
    page.getByRole("group", { name: "Source", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Alt+q");
  await seekFrame(page, 90);

  const replaced = await pressEdit(page, path, "F11");
  const picture = replaced.timeline.clips.find(
    ({ kind, start }) => kind === "video" && start === 60,
  );
  expect(picture).toMatchObject({
    src: "red.mp4",
    mediaStart: 1,
    duration: 60,
    track: 0,
  });
  expect(
    replaced.timeline.clips.find(
      ({ kind, start }) => kind === "audio" && start === 60,
    ),
  ).toMatchObject({
    src: "red.mp4",
    mediaStart: 1,
    link: picture?.link,
    track: 1,
  });

  await page.keyboard.press("Alt+q");
  await expect(
    page.getByRole("group", { name: "Source", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("i");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  const overlaid = await pressEdit(page, path, "F12");
  expect(overlaid.timeline.clips.find(({ id }) => id === picture?.id)).toEqual(
    picture,
  );
  expect(
    overlaid.timeline.clips.find(
      ({ kind, start }) => kind === "video" && start === 90,
    ),
  ).toMatchObject({ src: "red.mp4", duration: 2, mediaStart: 2, track: 2 });
});

test("swap, trim to playhead and linked selection use their preset keys", async ({
  page,
  request,
}) => {
  const { project, path } = await linkedShots(
    request,
    '<div id="later-title" class="clip" data-start="5" data-duration="1" data-track-index="2">Later title</div>',
  );
  await page.goto(`/#project/${project.id}`);
  await seekFrame(page, 30);
  await page.keyboard.press("Shift+v");
  const swapped = await pressEdit(page, path, "Control+Shift+Period");
  const startOf = (id: string) =>
    swapped.timeline.clips.find((clip) => clip.id === id)?.start;
  expect([startOf("v0"), startOf("a0"), startOf("v1"), startOf("a1")]).toEqual([
    60, 60, 0, 0,
  ]);

  await page.keyboard.press("Shift+v");
  const head = await pressEdit(page, path, "Shift+BracketLeft");
  expect(head.timeline.clips.find(({ id }) => id === "v1")).toMatchObject({
    start: 30,
    duration: 30,
    mediaStart: 2,
  });
  await seekFrame(page, 45);
  const tail = await pressEdit(page, path, "Shift+BracketRight");
  expect(tail.timeline.clips.find(({ id }) => id === "a1")).toMatchObject({
    start: 30,
    duration: 15,
  });

  await seekFrame(page, 35);
  await page.keyboard.press("t");
  const rippled = await pressEdit(page, path, "Shift+BracketLeft");
  for (const id of ["v1", "a1"]) {
    expect(rippled.timeline.clips.find((clip) => clip.id === id)).toMatchObject(
      {
        start: 30,
        duration: 10,
      },
    );
  }
  for (const id of ["v0", "a0"]) {
    expect(rippled.timeline.clips.find((clip) => clip.id === id)?.start).toBe(
      55,
    );
  }
  expect(
    rippled.timeline.clips.find(({ id }) => id === "later-title"),
  ).toMatchObject({ start: 145, duration: 30 });

  await page.keyboard.press("Control+Shift+l");
  await expect(
    page.getByRole("button", { name: "Linked selection", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.locator('.tl-clip[data-clip="v0"]').click();
  await expect(page.locator("[data-clip-outline]")).toHaveCount(1);
});
