import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import type { CommandInput } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

test.use({ trace: "off" });

const run = promisify(execFile);
const WIDTH = 640;
const HEIGHT = 360;
/** Each source picture's ordinal in sixteen blocks along its top, white for 1. */
const LABEL = Array.from(
  { length: 16 },
  (_, bit) =>
    `drawbox=x=${bit * 40}:y=0:w=40:h=36:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
).join(",");

const numberIn = (rgba: Uint8Array) => {
  let label = 0;
  for (let bit = 0; bit < 16; bit++)
    if (rgba[(18 * WIDTH + bit * 40 + 20) * 4]! > 128) label |= 1 << bit;
  return label;
};

/** The ordinal the viewer's resting picture carries. */
async function shownLabel(page: Page) {
  const png = (await page.locator(".edit-picture").screenshot()).toString(
    "base64",
  );
  return page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], {
        type: "image/png",
      }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    let label = 0;
    for (let bit = 0; bit < 16; bit++) {
      const [red] = context.getImageData(
        Math.floor(((bit + 0.5) * bitmap.width) / 16),
        Math.floor(bitmap.height / 20),
        1,
        1,
      ).data;
      if (red! > 128) label |= 1 << bit;
    }
    return label;
  }, png);
}

/** A numbered source: `count` pictures at `rate`, labelled before any retiming or reordering. */
const source = (
  dir: string,
  name: string,
  rate: string,
  count: number,
  extra: string[] = [],
  filters = "",
) =>
  run("ffmpeg", [
    ...["-v", "error", "-y", "-f", "lavfi", "-i"],
    `color=c=black:s=${WIDTH}x${HEIGHT}:r=${rate}`,
    "-vf",
    `${LABEL}${filters}`,
    ...["-frames:v", String(count), "-c:v", "libx264", "-preset", "ultrafast"],
    ...["-pix_fmt", "yuv420p"],
    ...extra,
    join(dir, name),
  ]);

type Fps = { num: number; den: number };
const seconds = (frames: number, fps: Fps) =>
  ((frames * fps.den) / fps.num).toFixed(6);
const RAMP = (points: string) =>
  `data-automation='{"version":1,"lanes":[{"target":"rate","points":${points}}]}'`;
/** HyperFrames' default two-point curve from 0.5x to 2x over 4 s. */
const GEOMETRIC = RAMP('[{"t":0,"v":0.5},{"t":4,"v":2}]');

const videoTag = (
  id: string,
  src: string,
  start: string,
  duration: string,
  attrs = "",
) =>
  `<video id="${id}" src="${src}" muted data-start="${start}" data-duration="${duration}" data-track-index="0" ${attrs} style="position:absolute;inset:0;width:100%;height:100%"></video>`;

const page = (fps: Fps, frames: number, body: string) =>
  `<!doctype html><html><head><style>html,body{margin:0;background:#000}</style></head><body><main id="main" data-composition-id="main" data-width="${WIDTH}" data-height="${HEIGHT}" data-duration="${seconds(frames, fps)}" data-fps="${fps.den === 1 ? fps.num : `${fps.num}/${fps.den}`}">${body}</main></body></html>`;

type Row = {
  name: string;
  fps: Fps;
  frames: number;
  setup: (dir: string) => Promise<string>;
  /** Frames to compare. Every frame by default. */
  check?: number[];
  /** The label a checked frame must show, from the matrix's closed form, where it gives one. */
  expected?: (frame: number) => number | undefined;
  /**
   * A document exported first, whose frame `from(n)` the edited project's frame n must equal,
   * and the timeline edits that turn it into the one under test.
   */
  reference?: {
    html?: (dir: string) => Promise<string>;
    edit?: CommandInput[];
    from: (frame: number) => number | null;
  };
  /** Plain 1x clips the footage pipeline can draw: true for both, "only" for the pipeline alone. */
  pipeline?: boolean | "only";
};

const thirty = { num: 30, den: 1 };
const sceneVideo = videoTag("ramp", "p6.mp4", "0", "5", GEOMETRIC);
const scene = `<template><div data-composition-id="scene" data-width="${WIDTH}" data-height="${HEIGHT}" data-duration="5" data-fps="30" style="position:relative;width:${WIDTH}px;height:${HEIGHT}px">${sceneVideo}</div></template>`;
const ntsc = { num: 30000, den: 1001 };
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => from + i);

const ROWS: Row[] = [
  {
    // Chromium's <video> refuses an open-GOP H.264 file outright (PIPELINE_ERROR_DECODE), so
    // only the footage pipeline, which decodes with WebCodecs, can show it.
    name: "P4 open-GOP 1x split at 59",
    fps: thirty,
    frames: 100,
    pipeline: "only",
    async setup(dir) {
      await source(dir, "open.mp4", "30", 100, [
        ...["-g", "30", "-bf", "2"],
        ...["-x264-params", "open-gop=1:scenecut=0:b-adapt=0"],
      ]);
      return page(
        thirty,
        100,
        videoTag("head", "open.mp4", "0", seconds(59, thirty)) +
          videoTag(
            "tail",
            "open.mp4",
            seconds(59, thirty),
            seconds(41, thirty),
            `data-media-start="${seconds(59, thirty)}"`,
          ),
      );
    },
    check: range(55, 64),
    expected: (n) => n,
  },
  {
    name: "P5 ramp a hair after a 23.976 frame",
    fps: { num: 24000, den: 1001 },
    frames: 24,
    async setup(dir) {
      await source(dir, "p5.mp4", "24000/1001", 48);
      const fps = { num: 24000, den: 1001 };
      return page(
        fps,
        24,
        videoTag(
          "p",
          "p5.mp4",
          "0.041718",
          seconds(20, fps),
          RAMP('[{"t":0,"v":1}]'),
        ),
      );
    },
    check: [1, 2, 3, 4],
    expected: (n) => n - 1,
  },
  {
    name: "P6 geometric ramp",
    fps: thirty,
    frames: 150,
    async setup(dir) {
      await source(dir, "p6.mp4", "30", 200);
      return page(thirty, 150, videoTag("p", "p6.mp4", "0", "5", GEOMETRIC));
    },
    // The closed form: 1.4427 s and 4.3281 s, far from a picture boundary.
    expected: (n) => ({ 60: 43, 120: 129 })[n],
  },
  {
    name: "P7 geometric ramp split at 60, dissolving into the next clip",
    fps: thirty,
    frames: 180,
    async setup(dir) {
      await source(dir, "p6.mp4", "30", 240);
      return page(
        thirty,
        180,
        videoTag("p", "p6.mp4", "0", "5", GEOMETRIC) +
          videoTag("next", "p6.mp4", "5", "1", 'data-media-start="7"'),
      );
    },
    reference: {
      edit: [
        { type: "split", at: 60, clipIds: ["p"], ids: { p: ["tail"] } },
        {
          type: "setTransition",
          from: "tail",
          to: "next",
          transition: { duration: 10 },
        },
      ],
      // Outside the dissolve every frame shows what it showed uncut.
      from: (n) => (n < 145 ? n : null),
    },
    check: [...range(0, 145)],
    expected: (n) => ({ 60: 43, 120: 129 })[n],
  },
  {
    name: "P8 25 fps source on 29.97",
    fps: ntsc,
    frames: 30,
    pipeline: true,
    async setup(dir) {
      await source(dir, "p8.mp4", "25", 60);
      return page(ntsc, 30, videoTag("p", "p8.mp4", "0", seconds(30, ntsc)));
    },
    expected: (n) => [0, 0, 1, 2, 3, 4, 5, 5, 6, 7][n],
  },
  {
    name: "P9 23.976 source on 29.97",
    fps: ntsc,
    frames: 30,
    pipeline: true,
    async setup(dir) {
      await source(dir, "p9.mp4", "24000/1001", 60);
      return page(ntsc, 30, videoTag("p", "p9.mp4", "0", seconds(30, ntsc)));
    },
    expected: (n) => Math.floor((n * 4) / 5),
  },
  {
    name: "P10 59.94 source on 29.97",
    fps: ntsc,
    frames: 25,
    pipeline: true,
    async setup(dir) {
      await source(dir, "p10.mp4", "60000/1001", 60);
      return page(ntsc, 25, videoTag("p", "p10.mp4", "0", seconds(25, ntsc)));
    },
    expected: (n) => 2 * n,
  },
  {
    name: "P11 variable frame rate",
    fps: thirty,
    frames: 7,
    pipeline: true,
    async setup(dir) {
      await source(
        dir,
        "p11.mp4",
        "1000",
        6,
        [
          ...["-bf", "0", "-bsf:v", "setts=duration=1", "-fps_mode", "vfr"],
          ...["-enc_time_base", "1/1000", "-video_track_timescale", "1000"],
        ],
        ",setpts='if(lt(N,3),if(eq(N,0),0,if(eq(N,1),40,50)),if(eq(N,3),100,if(eq(N,4),120,200)))'",
      );
      return page(thirty, 7, videoTag("p", "p11.mp4", "0", seconds(7, thirty)));
    },
    expected: (n) => [0, 0, 2, 3, 4, 4, 5][n]!,
  },
  {
    name: "P12 60 fps Matroska on a millisecond clock",
    fps: { num: 60, den: 1 },
    frames: 40,
    async setup(dir) {
      await source(dir, "p12.mkv", "60", 60);
      const fps = { num: 60, den: 1 };
      return page(fps, 40, videoTag("p", "p12.mkv", "0", seconds(40, fps)));
    },
    expected: (n) => n,
  },
  {
    name: "P13 loop from picture 15",
    fps: thirty,
    frames: 150,
    async setup(dir) {
      await source(dir, "p13.mp4", "30", 60);
      return page(
        thirty,
        150,
        videoTag("p", "p13.mp4", "0", "5", 'data-media-start="0.5" loop'),
      );
    },
    check: [...range(40, 50), ...range(85, 95), ...range(130, 140)],
    expected: (n) => 15 + (n % 45),
  },
  {
    name: "P13b loop with a fractional-microsecond end",
    fps: ntsc,
    frames: 2000,
    async setup(dir) {
      await source(dir, "p13b.mp4", "30000/1001", 61, [
        ...["-video_track_timescale", "30000"],
      ]);
      return page(
        ntsc,
        2000,
        videoTag(
          "p",
          "p13b.mp4",
          "0",
          seconds(2000, ntsc),
          'data-media-start="0.500500" loop',
        ),
      );
    },
    // Both wraps the design reproduced, and the last wraps of 2,000 frames.
    check: [
      ...range(44, 48),
      ...range(90, 94),
      ...range(1930, 1935),
      ...range(1975, 1979),
      1999,
    ],
    expected: (n) => 15 + (n % 46),
  },
  {
    name: "P14 held tail",
    fps: thirty,
    frames: 90,
    pipeline: true,
    async setup(dir) {
      await source(dir, "p14.mp4", "30", 60);
      return page(thirty, 90, videoTag("p", "p14.mp4", "0", "3"));
    },
    check: range(55, 90),
    expected: (n) => Math.min(n, 59),
  },
  {
    name: "P15 ramp inside a scene mounted at frame 100 with a trimmed in-point",
    fps: thirty,
    frames: 160,
    async setup(dir) {
      await source(dir, "p6.mp4", "30", 200);
      await writeFile(join(dir, "scene.html"), scene);
      return page(
        thirty,
        160,
        `<div id="mount" class="clip" data-composition-id="scene" data-composition-src="scene.html" data-start="${seconds(100, thirty)}" data-duration="2" data-media-start="0.5" data-track-index="0" data-width="${WIDTH}" data-height="${HEIGHT}" style="position:absolute;inset:0"></div>`,
      );
    },
    // The scene rendered alone, shifted by the mount and its 15-frame in-point.
    reference: {
      html: async () => page(thirty, 150, sceneVideo),
      from: (n) => (n >= 100 ? n - 85 : null),
    },
    check: [...range(98, 160)],
  },
];

async function exportedLabels(
  page: Page,
  request: APIRequestContext,
  path: string,
) {
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
  await expect(dialog).toContainText("Export complete.", { timeout: 240_000 });
  await writeFile(
    path,
    await (await request.get(`/api/render/${jobId}/download`)).body(),
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
    { encoding: "buffer", maxBuffer: 2 ** 31 - 1 },
  );
  const size = WIDTH * HEIGHT * 4;
  return Array.from({ length: stdout.length / size }, (_, frame) =>
    numberIn(stdout.subarray(frame * size)),
  );
}

async function goTo(page: Page, frame: number, fps: Fps) {
  const nominal = Math.round(fps.num / fps.den);
  const digits =
    String(Math.floor(frame / nominal)).padStart(6, "0") +
    String(frame % nominal).padStart(2, "0");
  await page
    .getByRole("button", { name: "Current time. Click to type a time." })
    .click();
  const input = page.getByRole("textbox", { name: "Go to time" });
  await input.pressSequentially(digits);
  await input.press("Enter");
}

async function editTimeline(
  baseURL: string,
  projectId: string,
  commands: CommandInput[],
) {
  const client = new Client({ name: "viewer-picture-tests", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: baseURL } },
    }),
  );
  try {
    const read = await client.callTool({
      name: "timeline_read",
      arguments: { projectId },
    });
    const { revision } = z
      .object({
        structuredContent: z.object({
          result: z.object({ revision: z.string() }),
        }),
      })
      .parse(read).structuredContent.result;
    const result = await client.callTool({
      name: "timeline_edit",
      arguments: { commands, projectId, expectedRevision: revision },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  } finally {
    await client.close();
  }
}

for (const row of ROWS)
  for (const pipeline of row.pipeline === "only"
    ? [true]
    : row.pipeline
      ? [false, true]
      : [false])
    test(`${row.name}: the resting viewer shows the exported picture, with GPU playback ${pipeline ? "on" : "off"}`, async ({
      page,
      request,
      baseURL,
    }, info) => {
      test.setTimeout(600_000);
      const project = ProjectSchema.parse(
        await (
          await request.post("/api/cutroom/projects", {
            data: { name: row.name, width: WIDTH, height: HEIGHT },
          })
        ).json(),
      );
      const index = join(project.path, "index.html");
      const html = await row.setup(project.path);
      await writeFile(
        index,
        (await row.reference?.html?.(project.path)) ?? html,
      );
      await page.addInitScript((on) => {
        if (window === window.top)
          localStorage.setItem("cutroom.footagePipeline", String(on));
      }, pipeline);
      await page.goto(`/#project/${project.id}`);
      const stage = page.locator(".edit-stage");
      const settled = async () => {
        await expect(stage).toHaveAttribute("data-preview-ready");
        await expect(page.locator(".edit-preparing")).toBeHidden({
          timeout: 60_000,
        });
        if (pipeline)
          await expect(stage).toHaveAttribute("data-pipeline", "on", {
            timeout: 60_000,
          });
      };
      await settled();
      let reference: number[] | undefined;
      if (row.reference) {
        reference = await exportedLabels(
          page,
          request,
          info.outputPath("reference.mp4"),
        );
        if (row.reference.edit)
          await editTimeline(baseURL!, project.id, row.reference.edit);
        else {
          await writeFile(index, html);
          await page.reload();
        }
        await settled();
      }
      const exported = await exportedLabels(
        page,
        request,
        info.outputPath("export.mp4"),
      );
      expect(exported).toHaveLength(row.frames);
      const frames = row.check ?? range(0, row.frames);
      const shown: number[] = [];
      let at = -2;
      for (const frame of frames) {
        if (frame === at + 1) {
          await page.getByRole("application", { name: "Picture" }).focus();
          await page.keyboard.press("ArrowRight");
        } else await goTo(page, frame, row.fps);
        at = frame;
        if (pipeline)
          await expect(page.locator(".edit-pipeline")).toHaveAttribute(
            "data-frame",
            String(frame),
          );
        await expect(stage).toHaveAttribute("data-preview-ready");
        shown.push(await shownLabel(page));
      }
      const report = frames.map((frame, i) => {
        const from = row.reference?.from(frame);
        return [
          `frame ${frame}`,
          `viewer ${shown[i]}`,
          `export ${exported[frame]}`,
          ...(reference && from != null
            ? [`reference ${reference[from]}`]
            : []),
          ...(row.expected?.(frame) !== undefined
            ? [`expected ${row.expected(frame)}`]
            : []),
        ].join("  ");
      });
      await info.attach("frames", { body: report.join("\n") });
      console.log(
        `${row.name}, GPU playback ${pipeline ? "on" : "off"}\n${report.join("\n")}`,
      );
      for (const frame of frames) {
        const expected = row.expected?.(frame);
        if (expected !== undefined)
          expect(exported[frame], `export frame ${frame}`).toBe(expected);
        const from = row.reference?.from(frame);
        if (reference && from != null)
          expect(exported[frame], `export frame ${frame}`).toBe(
            reference[from],
          );
      }
      expect(shown).toEqual(frames.map((frame) => exported[frame]));
      await expect(page.locator(".status-error")).toHaveCount(0);
    });
