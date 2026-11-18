import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import {
  ProjectSchema,
  SourceSchema,
  type Project,
} from "../src/shared/project";
import { PipelineResponseSchema } from "../src/shared/pipeline";
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

/**
 * Five seconds of footage at `rate` whose frames are numbered in the top band, stored as `tail`
 * leaves them (pixel format and colour tags).
 */
async function numbered(
  path: string,
  rate: string,
  size = `${WIDTH}x${HEIGHT}`,
  tail = "format=yuv420p",
  encoder = ["-g", "15"],
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
    `drawbox=x=0:y=0:w=${width}:h=${band}:color=black:t=fill,${bits.join(",")},${tail}`,
    ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", ...encoder],
    path,
  ]);
}

const fill = "position:absolute;inset:0;width:100%;height:100%";

async function project(
  request: APIRequestContext,
  rate: { num: number; den: number },
  body: (seconds: (frames: number) => string) => string,
  head = "",
  length = 110,
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
    `<!doctype html><html><head><style>html,body{margin:0;background:#111111}</style>${head}</head><body><main id="main" data-composition-id="main" data-width="${WIDTH}" data-height="${HEIGHT}" data-duration="${seconds(length)}" data-fps="${fps}">
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

/**
 * The exact source frames replace any stand-in once the playhead rests, later on a slow runner:
 * a screenshot of the viewer that two taken 300 ms apart agree on.
 */
async function settledShot(page: Page) {
  const picture = page.locator(".edit-picture");
  let shot = (await picture.screenshot()).toString("base64");
  for (let tries = 0; tries < 20; tries++) {
    await page.waitForTimeout(300);
    const next = (await picture.screenshot()).toString("base64");
    if (next === shot) break;
    shot = next;
  }
  return shot;
}

/** Moves the playhead by typing the frame's timecode. */
async function typeFrame(page: Page, frame: number, fps: number) {
  await page
    .getByRole("button", { name: "Current time. Click to type a time." })
    .click();
  const time = page.getByRole("textbox", { name: "Go to time" });
  await time.pressSequentially(
    String(Math.floor(frame / fps) * 100 + (frame % fps)).padStart(8, "0"),
  );
  await time.press("Enter");
}

/** PNG screenshots of the viewer at each frame, with the pipeline on or off. */
async function pictures(
  page: Page,
  project: Project,
  /** Timecode's frames per second, which is 30 for 29.97 and 24 for 23.976. */
  fps: number,
  frames: number[],
  pipeline: boolean,
  exact = false,
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
    await typeFrame(page, frame, fps);
    if (pipeline)
      await expect(
        page.locator(
          exact ? '.edit-pipeline[data-standin="false"]' : ".edit-pipeline",
        ),
      ).toHaveAttribute("data-frame", String(frame));
    await expect(stage).toHaveAttribute("data-preview-ready");
    const shot = await settledShot(page);
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
/** Each pair's frame numbers, mean difference and per-channel bias, out of 255. */
function compare(page: Page, expected: string[], actual: string[]) {
  return page.evaluate(
    async ({ expected, actual, band, height }) => {
      const read = async (base64: string, size?: ImageData) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes]));
        const canvas = new OffscreenCanvas(
          size?.width ?? image.width,
          size?.height ?? image.height,
        );
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        image.close();
        return context.getImageData(0, 0, canvas.width, canvas.height);
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
        const b = await read(actual[index]!, a);
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
}

async function expectSamePictures(
  page: Page,
  expected: string[],
  actual: string[],
  frames: number[],
) {
  const results = await compare(page, expected, actual);
  console.log(
    "PARITY",
    JSON.stringify(
      results.map((r, i) => [
        frames[i],
        Math.round(r.difference * 1000) / 1000,
        Math.round(Math.max(...r.bias) * 1000) / 1000,
      ]),
    ),
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
  // 720 lines, so Chrome reads the untagged file as BT.709 where the cuts above read BT.601.
  await numbered(join(created.path, "a.mp4"), "30", "1280x720");
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

test("an edit or a jump at rest shows the right frame at once and settles on HyperFrames' picture", async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const rate = { num: 30000, den: 1001 };
  const created = await cutsProject(request, rate);
  // The stand-in needs a.mp4's scrub proxy, made before the viewer opens.
  await expect
    .poll(
      async () =>
        (
          await request.get(
            `/api/cutroom/projects/${created.id}/media/scrub?path=a.mp4`,
          )
        ).status(),
      { timeout: 60_000 },
    )
    .toBe(200);
  const context = await browser.newContext({
    viewport: { width: 1720, height: 1050 },
  });
  try {
    const page = await context.newPage();
    await pictures(page, created, 30, [20], true);
    // Each picture the pipeline draws, by the number in its band, and whether it stood in.
    await page.evaluate(
      ({ band, height }) => {
        const canvas =
          document.querySelector<HTMLCanvasElement>(".edit-pipeline")!;
        const read = document.createElement("canvas");
        const context = read.getContext("2d", { willReadFrequently: true })!;
        const drawn: { frame: number; number: number; standIn: boolean }[] = [];
        new MutationObserver(() => {
          read.width = canvas.width;
          read.height = canvas.height;
          context.drawImage(canvas, 0, 0);
          const y = Math.round(((band / 2) * canvas.height) / height);
          let number = 0;
          for (let bit = 0; bit < 16; bit++) {
            const x = Math.round(((bit + 0.5) / 16) * canvas.width);
            if (context.getImageData(x, y, 1, 1).data[0]! > 128)
              number |= 1 << bit;
          }
          drawn.push({
            frame: Number(canvas.dataset.frame),
            number,
            standIn: canvas.dataset.standin === "true",
          });
        }).observe(canvas, {
          attributes: true,
          attributeFilter: ["data-frame", "data-standin"],
        });
        Object.assign(window, { pipelineDrawn: drawn });
      },
      { band: BAND, height: HEIGHT },
    );
    const pipeline = page.locator(".edit-pipeline");
    const settled = async (frame: number) => {
      await expect(pipeline).toHaveAttribute("data-frame", String(frame));
      await expect(pipeline).toHaveAttribute("data-standin", "false");
      await expect(page.locator(".edit-stage")).toHaveAttribute(
        "data-preview-ready",
      );
      const drawn = await page.evaluate(() =>
        (
          window as unknown as {
            pipelineDrawn: {
              frame: number;
              number: number;
              standIn: boolean;
            }[];
          }
        ).pipelineDrawn.splice(0),
      );
      return drawn.filter((picture) => picture.frame === frame);
    };
    // W at frame 20, inside v0, brings v1 to the playhead: a.mp4 from its frame 47.
    await page.keyboard.press("KeyW");
    const trimmed = await settled(20);
    expect(trimmed.length).toBeGreaterThan(0);
    expect(new Set(trimmed.map(({ number }) => number))).toEqual(new Set([47]));
    const shots = [await settledShot(page)];
    // Back to frame 5, v0's a.mp4 frame 5: neither decoder reaches back, so the proxy stands in.
    await typeFrame(page, 5, 30);
    const jumped = await settled(5);
    expect(jumped.some(({ standIn }) => standIn)).toBe(true);
    expect(new Set(jumped.map(({ number }) => number))).toEqual(new Set([5]));
    shots.push(await settledShot(page));
    const reference = await context.newPage();
    const off = await pictures(reference, created, 30, [20, 5], false);
    await expectSamePictures(reference, off, shots, [20, 5]);
  } finally {
    await context.close();
  }
});

test("a clip the pipeline cannot draw plays in HyperFrames on top while the pipeline draws the rest", async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const fps = { num: 30, den: 1 };
  // `over` has a class of its own, so HyperFrames draws it, a.mp4 from its frame 90, over v0.
  const created = await project(request, fps, (seconds) =>
    [
      `<video id="v0" src="a.mp4" muted data-start="0" data-duration="${seconds(110)}" data-media-start="0" data-track-index="0" style="${fill}"></video>`,
      `<video id="over" class="tinted" src="a.mp4" muted data-start="${seconds(30)}" data-duration="${seconds(30)}" data-media-start="3" data-track-index="1" style="${fill}"></video>`,
    ].join("\n"),
  );
  await numbered(join(created.path, "a.mp4"), "30");
  await parity(browser, created, 30, [10, 30, 40, 59, 60, 70]);
});

test("an older drawable plan cannot turn the footage pipeline back on", async ({
  page,
  request,
}, info) => {
  const created = await project(
    request,
    { num: 30, den: 1 },
    (seconds) =>
      `<video id="v0" src="a.mp4" muted data-start="0" data-duration="${seconds(110)}" data-track-index="0" style="${fill}"></video>`,
  );
  await numbered(join(created.path, "a.mp4"), "30");
  const base = `/api/cutroom/projects/${created.id}`;
  const old = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  await page.route(`**${base}/pipeline`, async (route) => {
    if (!first) return route.continue();
    first = false;
    try {
      const response = await route.fetch();
      const { plan } = PipelineResponseSchema.parse(await response.json());
      expect("drawable" in plan && Object.keys(plan.drawable)).toEqual(["v0"]);
      old.resolve();
      await release.promise;
      await route.fulfill({ response });
    } catch (error) {
      old.reject(error);
      throw error;
    }
  });
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("cutroom.footagePipeline", "true");
  });
  try {
    await page.goto(`/#project/${created.id}`);
    await old.promise;
    const refused = page.waitForEvent("console", {
      predicate: (message) => message.text().startsWith("[pipeline] off:"),
    });
    const source = SourceSchema.parse(
      await (await request.get(`${base}/source`)).json(),
    );
    const saved = await request.put(`${base}/source`, {
      data: {
        path: "index.html",
        expectedVersion: source.version,
        content: source.content.replace(
          "</body>",
          '<script>document.getElementById("v0").style.opacity = "0";</script></body>',
        ),
      },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    await refused;
    const stage = page.locator(".edit-stage");
    const picture = page.locator(".edit-picture");
    const preview = page.frameLocator("iframe[data-live]");
    await expect(stage).toHaveAttribute("data-pipeline", "off");
    await expect(preview.locator("#v0")).toHaveCSS("opacity", "0");
    await expect(stage).toHaveAttribute("data-preview-ready");
    const expected = await picture.screenshot();
    const reply = page.waitForResponse((response) =>
      response.url().endsWith(`${base}/pipeline`),
    );
    release.resolve();
    await (await reply).finished();
    for (const frame of [10, 20, 30]) {
      await typeFrame(page, frame, 30);
      await expect(stage).toHaveAttribute("data-preview-ready");
    }
    const actual = await picture.screenshot({
      path: info.outputPath("after-late-plan.png"),
    });
    const [result] = await compare(
      page,
      [expected.toString("base64")],
      [actual.toString("base64")],
    );
    expect(result?.difference).toBe(0);
    await expect(stage).toHaveAttribute("data-pipeline", "off");
  } finally {
    release.resolve();
  }
});

test("the footage pipeline draws phone and camera footage as HyperFrames does: turned portrait, Android's full-range colour and open GOPs", async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const fps = { num: 30, den: 1 };
  const fit = `${fill};object-fit:contain`;
  const created = await project(request, fps, (seconds) =>
    [
      `<video id="v0" src="phone.mp4" muted data-start="0" data-duration="${seconds(30)}" data-media-start="0" data-track-index="0" style="${fit}"></video>`,
      `<video id="v1" src="android.mp4" muted data-start="${seconds(30)}" data-duration="${seconds(30)}" data-media-start="${seconds(47)}" data-track-index="0" style="${fit}"></video>`,
      `<video id="v2" src="camera.mov" muted data-start="${seconds(60)}" data-duration="${seconds(50)}" data-media-start="${seconds(28)}" data-track-index="0" style="${fit}"></video>`,
    ].join("\n"),
  );
  // A phone stores its picture landscape and turns it with the track's matrix.
  const stored = join(created.path, "stored.mp4");
  await numbered(stored, "30");
  await promisify(execFile)("ffmpeg", [
    ...["-v", "error", "-y", "-display_rotation:v:0", "90", "-i", stored],
    ...["-c", "copy", join(created.path, "phone.mp4")],
  ]);
  // Full-range BT.601 with EBU primaries in a colr box, which Chrome converts to the screen's gamut.
  await numbered(
    join(created.path, "android.mp4"),
    "30",
    undefined,
    "scale=out_range=full,format=yuvj420p,setparams=range=pc:color_primaries=bt470bg:color_trc=smpte170m:colorspace=bt470bg",
  );
  // An open GOP: the frames shown just before each keyframe refer to the GOP before it, so
  // decoding from their own keyframe never puts them out.
  await numbered(join(created.path, "camera.mov"), "30", undefined, undefined, [
    ...["-g", "30", "-bf", "3", "-x264-params", "open-gop=1:b-pyramid=none"],
  ]);
  await parity(browser, created, 30, [0, 29, 30, 59, 100]);
  // A seeking <video> shows the keyframe after those frames, so HyperFrames is no reference
  // there; the pipeline shows the frames the file's timestamps name, as the export does.
  const context = await browser.newContext({
    viewport: { width: 1720, height: 1050 },
  });
  try {
    const page = await context.newPage();
    const shots = await pictures(page, created, 30, [60, 61, 90, 91], true);
    const results = await compare(page, shots, shots);
    expect(results.map(({ numbers }) => numbers[1])).toEqual([28, 29, 58, 59]);
  } finally {
    await context.close();
  }
});

test("a paused seek shows the leading picture of an open GOP after preparing a later cut", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const created = await project(request, { num: 30, den: 1 }, (seconds) =>
    [
      `<video id="first" src="camera.mp4" muted data-start="0" data-duration="${seconds(60)}" data-media-start="0" data-track-index="0" style="${fill}"></video>`,
      `<video id="later" src="camera.mp4" muted data-start="${seconds(60)}" data-duration="${seconds(18)}" data-media-start="${seconds(100)}" data-track-index="0" style="${fill}"></video>`,
    ].join("\n"),
  );
  await numbered(
    join(created.path, "camera.mp4"),
    "30",
    "1920x1080",
    undefined,
    [
      "-threads",
      "6",
      "-preset",
      "ultrafast",
      "-g",
      "30",
      "-sc_threshold",
      "0",
      "-bf",
      "3",
      "-x264-params",
      "open-gop=1:b-pyramid=none:b-adapt=0",
    ],
  );
  // Source frame 29 decodes after keyframe 30, but needs a picture from the preceding GOP.
  // Frame 57 is the last packet before keyframe 60. Frame 59 needs preroll after that flush.
  const shots = await pictures(
    page,
    created,
    30,
    [65, 28, 29, 30, 29, 57, 59],
    true,
    true,
  );
  const results = await compare(page, shots, shots);
  expect(results.map(({ numbers }) => numbers[1])).toEqual([
    105, 28, 29, 30, 29, 57, 59,
  ]);
});

test("HDR named only in the bitstream stays with HyperFrames", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const fps = { num: 30, den: 1 };
  const created = await project(
    request,
    fps,
    (seconds) =>
      `<video id="v0" src="hdr.mp4" muted data-start="0" data-duration="${seconds(110)}" data-media-start="0" data-track-index="0" style="${fill}"></video>`,
  );
  // x264 writes these tags into the stream's VUI only, so the file has no colr box.
  await numbered(
    join(created.path, "hdr.mp4"),
    "30",
    undefined,
    "format=yuv420p10le",
  );
  await promisify(execFile)("ffmpeg", [
    ...["-v", "error", "-y", "-i", join(created.path, "hdr.mp4")],
    ...["-c:v", "libx264", "-preset", "veryfast", "-x264-params"],
    "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
    join(created.path, "pq.mp4"),
  ]);
  await rename(join(created.path, "pq.mp4"), join(created.path, "hdr.mp4"));
  const context = await browser.newContext({
    viewport: { width: 1720, height: 1050 },
  });
  try {
    const page = await context.newPage();
    const reasons: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("[pipeline]")) reasons.push(message.text());
    });
    await page.addInitScript(() => {
      if (window === window.top)
        localStorage.setItem("cutroom.footagePipeline", "true");
    });
    await page.goto(`/#project/${created.id}`);
    const stage = page.locator(".edit-stage");
    await expect(stage).toHaveAttribute("data-preview-ready");
    await typeFrame(page, 20, 30);
    await expect
      .poll(() => reasons)
      .toContain(
        "[pipeline] HyperFrames draws a clip: v0 stays in HyperFrames because its source is HDR",
      );
    await expect(stage).toHaveAttribute("data-pipeline", "off");
    await expect(page.locator(".edit-pipeline")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("the original benchmark markup draws graded cuts under two GSAP scene mounts, on the source frames export selects", async ({
  page,
  request,
}, info) => {
  test.setTimeout(180_000);
  const frameCount = 12;
  const created = await project(
    request,
    { num: 60, den: 1 },
    (seconds) => `
    <video class="clip" id="v0" src="a.mp4" muted data-start="0" data-duration="${seconds(6)}" data-track-index="0" data-color-grading='{"adjust":{"contrast":0.08}}' style="${fill}"></video>
    <video class="clip" id="v1" src="a.mp4" muted data-start="${seconds(6)}" data-duration="${seconds(6)}" data-media-start="1" data-track-index="0" data-color-grading='{"adjust":{"contrast":0.08}}' style="${fill};scale:1.02"></video>
    <div id="title" class="clip title" data-start="0" data-duration="${seconds(frameCount)}" data-track-index="1">Title</div>
    ${[1, 7].map((start, index) => `<div id="s${index}" class="clip scene" data-composition-id="scene" data-composition-src="scene.html" data-start="${seconds(start)}" data-duration="${seconds(4)}" data-track-index="2" data-width="${WIDTH}" data-height="${HEIGHT}"></div>`).join("")}
  `,
    `<script src="gsap.min.js"></script><style>.title{position:absolute;bottom:42px;left:24px;background:#142137;color:white;padding:8px}.scene{position:absolute;inset:0}</style>`,
    frameCount,
  );
  const root = join(created.path, "index.html");
  const html = (await readFile(root, "utf8")).replace(
    "</body>",
    "<script>window.__timelines=window.__timelines||{};window.__timelines.main=gsap.timeline({paused:true});</script></body>",
  );
  await writeFile(root, html);
  await copyFile(
    "node_modules/gsap/dist/gsap.min.js",
    join(created.path, "gsap.min.js"),
  );
  await writeFile(
    join(created.path, "scene.html"),
    `<template><main data-composition-id="scene" data-duration="0.066667" data-width="${WIDTH}" data-height="${HEIGHT}"><div id="card" style="position:absolute;right:30px;top:130px;width:120px;height:90px;background:#2985c9">Scene</div></main><script>{const tl=gsap.timeline({paused:true});tl.fromTo("#card",{x:30,opacity:0},{x:0,opacity:1,duration:0.04},0);window.__timelines.scene=tl;}</script></template>`,
  );
  await numbered(
    join(created.path, "a.mp4"),
    "60",
    undefined,
    "format=yuv420p",
    [
      "-g",
      "15",
      "-colorspace",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_primaries",
      "bt709",
    ],
  );
  const frames = Array.from({ length: frameCount }, (_, frame) => frame);
  const actual = await pictures(page, created, 60, frames, true, true);

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  await dialog.getByRole("button", { name: "Export MP4", exact: true }).click();
  const { jobId } = z
    .object({ jobId: z.string() })
    .parse(await (await started).json());
  await expect(dialog).toContainText("Export complete.", { timeout: 90_000 });
  const output = info.outputPath("pictures");
  await mkdir(output, { recursive: true });
  const path = join(output, "export.mp4");
  await writeFile(
    path,
    await (await request.get(`/api/render/${jobId}/download`)).body(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-i",
    path,
    join(output, "frame-%03d.png"),
  ]);
  const names = (await readdir(output))
    .filter((name) => name.endsWith(".png"))
    .sort();
  expect(names).toHaveLength(frameCount);
  const expected = await Promise.all(
    names.map(async (name) =>
      (await readFile(join(output, name))).toString("base64"),
    ),
  );
  const result = await compare(page, expected, actual);
  console.log("EXPORT PARITY", JSON.stringify(result));
  expect(result.map(({ numbers }) => numbers[0])).toEqual([
    0, 1, 2, 3, 4, 5, 60, 61, 62, 63, 64, 65,
  ]);
  expect(result.map(({ numbers }) => numbers[1])).toEqual(
    result.map(({ numbers }) => numbers[0]),
  );

  // Both mounts have had time to reach their full opacity at their fourth frame.
  const colours = await page.evaluate(
    async (frames) => {
      const canvas = new OffscreenCanvas(640, 360);
      const context = canvas.getContext("2d")!;
      return Promise.all(
        frames.map(async (frame) => {
          const bytes = Uint8Array.from(atob(frame), (value) =>
            value.charCodeAt(0),
          );
          const bitmap = await createImageBitmap(new Blob([bytes]));
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
          return [...context.getImageData(550, 200, 1, 1).data].slice(0, 3);
        }),
      );
    },
    [actual[4]!, actual[10]!],
  );
  expect(colours).toEqual([
    [41, 133, 201],
    [41, 133, 201],
  ]);
});

test("a 4K60 source stays native while overlapping HD footage and after a cut", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const created = await project(
    request,
    { num: 60, den: 1 },
    (seconds) => `
    <video id="hd" src="a.mp4" muted data-start="0" data-duration="${seconds(80)}" data-track-index="0" style="${fill}"></video>
    <video id="uhd" src="large.mp4" muted data-start="${seconds(30)}" data-duration="${seconds(60)}" data-media-start="1" data-track-index="1" style="${fill}"></video>`,
  );
  await Promise.all([
    numbered(join(created.path, "a.mp4"), "60"),
    numbered(join(created.path, "large.mp4"), "60", "3840x2160", undefined, [
      "-preset",
      "ultrafast",
      "-threads",
      "6",
      "-t",
      "2",
    ]),
  ]);
  const response = await request.get(
    `/api/cutroom/projects/${created.id}/pipeline`,
  );
  const { plan } = PipelineResponseSchema.parse(await response.json());
  expect(plan).toMatchObject({
    drawable: { hd: "fill" },
    hyperframes: {
      uhd: expect.stringContaining("above the pipeline's 1080p limit"),
    },
  });
  const shots = await pictures(page, created, 60, [24, 31, 82, 26], true, true);
  const result = await compare(page, shots, shots);
  expect(result.map(({ numbers }) => numbers[1])).toEqual([24, 61, 112, 26]);
});

test("a title under footage switches only the intersecting range to HyperFrames", async ({
  page,
  request,
}) => {
  const created = await project(
    request,
    { num: 30, den: 1 },
    (seconds) => `
    <div class="clip" id="under" data-start="${seconds(15)}" data-duration="${seconds(6)}" data-track-index="0" style="position:absolute;inset:0;background:#369">Behind the video</div>
    <video id="v0" src="a.mp4" muted data-start="0" data-duration="${seconds(90)}" data-track-index="1" style="${fill};opacity:0.8"></video>`,
  );
  await numbered(join(created.path, "a.mp4"), "30");
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("cutroom.footagePipeline", "true");
  });
  await page.goto(`/#project/${created.id}`);
  const stage = page.locator(".edit-stage");
  for (const [frame, mode] of [
    [14, "on"],
    [15, "off"],
    [20, "off"],
    [21, "on"],
  ] as const) {
    await typeFrame(page, frame, 30);
    await expect(stage).toHaveAttribute("data-pipeline", mode);
    await expect(stage).toHaveAttribute("data-preview-ready");
    const shot = await settledShot(page);
    const [result] = await compare(page, [shot], [shot]);
    expect(result!.numbers[1]).toBe(frame);
  }
});
