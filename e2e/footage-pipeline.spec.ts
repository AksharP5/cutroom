import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { ProjectSchema, type Project } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { titleAttributes, titleStyle } from "../src/server/timeline/titles";
import { defaultTitle } from "../src/shared/timeline/title";
import { expect, test } from "./fixtures";

test.use({ trace: "off" });

const WIDTH = 640;
const HEIGHT = 360;
/** Each frame carries its own number as 16 bits along the top, white for 1. */
const BAND = 32;

/** Five seconds of footage at `rate` whose frames are numbered in the top band. */
async function numbered(
  path: string,
  rate: string,
  size = `${WIDTH}x${HEIGHT}`,
) {
  const width = Number(size.split("x")[0]);
  const band = (BAND * width) / WIDTH;
  const bits = Array.from(
    { length: 16 },
    (_, bit) =>
      `drawbox=x=${(bit * width) / 16}:y=0:w=${width / 16}:h=${band}:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
  );
  await promisify(execFile)("ffmpeg", [
    ...["-v", "error", "-y", "-f", "lavfi", "-i"],
    `testsrc2=size=${size}:rate=${rate}:duration=5`,
    "-vf",
    `drawbox=x=0:y=0:w=${width}:h=${band}:color=black:t=fill,${bits.join(",")},format=yuv420p`,
    ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-g", "15"],
    path,
  ]);
}

const fill = "position:absolute;inset:0;width:100%;height:100%";

async function project(
  request: APIRequestContext,
  rate: { num: number; den: number },
  body: (seconds: (frames: number) => string) => string,
  head = "",
) {
  const created = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Pipeline parity",
          width: WIDTH,
          height: HEIGHT,
          duration: 4,
        },
      })
    ).json(),
  );
  const seconds = (frames: number) =>
    String(Math.round(((frames * rate.den) / rate.num) * 1e6) / 1e6);
  const fps = rate.den === 1 ? String(rate.num) : `${rate.num}/${rate.den}`;
  await writeFile(
    join(created.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#111111}</style>${head}</head><body><main id="main" data-composition-id="main" data-width="${WIDTH}" data-height="${HEIGHT}" data-duration="${seconds(110)}" data-fps="${fps}">
${body(seconds)}
</main></body></html>`,
  );
  return created;
}

async function edit(
  request: APIRequestContext,
  project: Project,
  commands: CommandInput[],
) {
  const view = TimelineViewSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/timeline`)
    ).json(),
  );
  const response = await request.post(
    `/api/cutroom/projects/${project.id}/commands`,
    {
      data: {
        composition: "index.html",
        expectedRevision: view.revision,
        label: "Parity setup",
        commands,
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

/** PNG screenshots of the viewer at each frame, with the pipeline on or off. */
async function pictures(
  page: Page,
  project: Project,
  /** Timecode's frames per second, which is 30 for 29.97 and 24 for 23.976. */
  fps: number,
  frames: number[],
  pipeline: boolean,
) {
  await page.addInitScript((on) => {
    // The sandboxed preview has no storage; only the editor reads the setting.
    if (window === window.top)
      localStorage.setItem("cutroom.footagePipeline", String(on));
  }, pipeline);
  const stage = page.locator(".edit-stage");
  const shots: string[] = [];
  await page.goto(`/#project/${project.id}`);
  await expect(stage).toHaveAttribute("data-preview-ready");
  if (pipeline) await expect(stage).toHaveAttribute("data-pipeline", "on");
  else await expect(stage).not.toHaveAttribute("data-pipeline");
  for (const frame of frames) {
    // One typed seek per frame: stepping into a transition under load can leave HyperFrames
    // holding a clip's transition animation several times over, which composes its opacity.
    await page
      .getByRole("button", { name: "Current time. Click to type a time." })
      .click();
    const time = page.getByRole("textbox", { name: "Go to time" });
    await time.pressSequentially(
      String(Math.floor(frame / fps) * 100 + (frame % fps)).padStart(8, "0"),
    );
    await time.press("Enter");
    if (pipeline)
      await expect(page.locator(".edit-pipeline")).toHaveAttribute(
        "data-frame",
        String(frame),
      );
    await expect(stage).toHaveAttribute("data-preview-ready");
    // The exact source frames replace any stand-in once the playhead rests, later on a slow
    // runner: compare only a picture that two screenshots 300 ms apart agree on.
    const picture = page.locator(".edit-picture");
    let shot = (await picture.screenshot()).toString("base64");
    for (let tries = 0; tries < 20; tries++) {
      await page.waitForTimeout(300);
      const next = (await picture.screenshot()).toString("base64");
      if (next === shot) break;
      shot = next;
    }
    // The reference itself must draw each transition once.
    const preview = page
      .frames()
      .find((frame) => frame.url().includes("/api/isolated/"))!;
    expect(
      await preview.evaluate(() =>
        [...document.querySelectorAll("video")].some((video) => {
          const names = video
            .getAnimations()
            .map((animation) => (animation as CSSAnimation).animationName);
          return new Set(names).size !== names.length;
        }),
      ),
      `frame ${frame} has a repeated animation`,
    ).toBe(false);
    shots.push(shot);
    if (pipeline) await expect(stage).toHaveAttribute("data-pipeline", "on");
  }
  return shots;
}

/**
 * The export parity test's tolerances (tests/export-direct.test.ts): the same frame number, mean
 * difference under 4/255 and each channel's bias under 1.5/255. A wrong frame, matrix, range,
 * placement or opacity moves the picture far more.
 */
async function expectSamePictures(
  page: Page,
  expected: string[],
  actual: string[],
  frames: number[],
) {
  const results = await page.evaluate(
    async ({ expected, actual, band, height }) => {
      const read = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes]));
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height);
      };
      const number = (image: ImageData) => {
        let value = 0;
        const y = Math.round(((band / 2) * image.height) / height);
        for (let bit = 0; bit < 16; bit++) {
          const x = Math.round(((bit + 0.5) / 16) * image.width);
          const at = (y * image.width + x) * 4;
          if (image.data[at]! + image.data[at + 1]! + image.data[at + 2]! > 384)
            value |= 1 << bit;
        }
        return value;
      };
      const out = [];
      for (const [index, base64] of expected.entries()) {
        const a = await read(base64);
        const b = await read(actual[index]!);
        let difference = 0;
        const bias = [0, 0, 0];
        for (let at = 0; at < a.data.length; at += 4)
          for (let channel = 0; channel < 3; channel++) {
            const delta = b.data[at + channel]! - a.data[at + channel]!;
            difference += Math.abs(delta);
            bias[channel]! += delta;
          }
        const pixels = a.data.length / 4;
        out.push({
          numbers: [number(a), number(b)],
          difference: difference / pixels / 3,
          bias: bias.map((sum) => Math.abs(sum / pixels)),
        });
      }
      return out;
    },
    { expected, actual, band: BAND, height: HEIGHT },
  );
  for (const [index, result] of results.entries()) {
    const frame = frames[index];
    expect(result.numbers[1], `frame ${frame} number`).toBe(result.numbers[0]);
    expect(result.difference, `frame ${frame} difference`).toBeLessThan(4);
    for (const bias of result.bias)
      expect(bias, `frame ${frame} bias`).toBeLessThan(1.5);
  }
}

async function parity(
  browser: Browser,
  project: Project,
  fps: number,
  frames: number[],
) {
  const context = await browser.newContext({
    viewport: { width: 1720, height: 1050 },
  });
  try {
    const off = await pictures(
      await context.newPage(),
      project,
      fps,
      frames,
      false,
    );
    const onContext = await browser.newContext({
      viewport: { width: 1720, height: 1050 },
    });
    try {
      const page = await onContext.newPage();
      const on = await pictures(page, project, fps, frames, true);
      await expectSamePictures(page, off, on, frames);
    } finally {
      await onContext.close();
    }
  } finally {
    await context.close();
  }
}

for (const rate of [
  { num: 30000, den: 1001 },
  { num: 24000, den: 1001 },
])
  test(`the footage pipeline draws the frames HyperFrames draws at cuts and offsets, ${rate.num}/${rate.den}`, async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const created = await cutsProject(request, rate);
    // Each side of both cuts, and frames inside each clip.
    await parity(
      browser,
      created,
      Math.round(rate.num / rate.den),
      [0, 1, 29, 30, 31, 59, 60, 61, 100],
    );
  });

/** Two cuts on V1 with media offsets, the second of a different file and size. */
async function cutsProject(
  request: APIRequestContext,
  rate: { num: number; den: number },
) {
  const text = `${rate.num}/${rate.den}`;
  const created = await project(request, rate, (seconds) =>
    [
      `<video id="v0" src="a.mp4" muted data-start="0" data-duration="${seconds(30)}" data-media-start="0" data-track-index="0" style="${fill}"></video>`,
      `<video id="v1" src="a.mp4" muted data-start="${seconds(30)}" data-duration="${seconds(30)}" data-media-start="${seconds(47)}" data-track-index="0" style="${fill}"></video>`,
      `<video id="v2" src="b.mp4" muted data-start="${seconds(60)}" data-duration="${seconds(50)}" data-media-start="${seconds(13)}" data-track-index="0" style="${fill};object-fit:contain"></video>`,
    ].join("\n"),
  );
  await numbered(join(created.path, "a.mp4"), text);
  await numbered(join(created.path, "b.mp4"), text, "480x360");
  return created;
}

test("the footage pipeline places, crops, fades and dissolves clips as HyperFrames does, under a title", async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const fps = { num: 30, den: 1 };
  const title = titleAttributes(defaultTitle(fps), fps)
    .map(([name, value]) => (value === null ? "" : ` ${name}="${value}"`))
    .join("");
  const created = await project(
    request,
    fps,
    (seconds) =>
      [
        `<video id="a" src="a.mp4" muted data-start="0" data-duration="${seconds(40)}" data-media-start="0" data-track-index="0" style="${fill}"></video>`,
        `<video id="b" src="a.mp4" muted data-start="${seconds(40)}" data-duration="${seconds(40)}" data-media-start="2" data-track-index="0" style="${fill}"></video>`,
        `<video id="c" src="a.mp4" muted data-start="${seconds(80)}" data-duration="${seconds(30)}" data-media-start="3.5" data-track-index="0" style="${fill}"></video>`,
        `<video id="inset" src="a.mp4" muted data-start="0" data-duration="${seconds(110)}" data-media-start="1" data-track-index="1" style="${fill}"></video>`,
        `<div id="name" class="clip" data-start="0" data-duration="${seconds(110)}" data-track-index="2"${title}>Alex Rivera</div>`,
      ].join("\n"),
    titleStyle([]),
  );
  await numbered(join(created.path, "a.mp4"), "30");
  await edit(request, created, [
    {
      type: "setClip",
      clipId: "inset",
      x: 120,
      y: -40,
      scaleX: 0.45,
      scaleY: 0.45,
      rotation: 12,
      crop: { top: 10, right: 0, bottom: 30, left: 20 },
      opacity: 0.6,
    },
    {
      type: "setTransition",
      from: "a",
      to: "b",
      transition: { kind: "dissolve", duration: 12, alignment: "center" },
    },
    {
      type: "setTransition",
      from: "b",
      to: "c",
      transition: { kind: "dip", duration: 12, alignment: "center" },
    },
  ]);
  // Before, inside and after the dissolve at 40 and the dip at 80, with the inset and title on
  // top. Frame 40 is the dissolve's midpoint, where every bit of the band sits on the threshold.
  await parity(
    browser,
    created,
    30,
    [10, 34, 37, 39, 43, 46, 74, 77, 80, 83, 86, 100],
  );
});
