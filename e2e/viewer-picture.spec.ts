import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import type { Project } from "../src/shared/project";
import { expect, test } from "./fixtures";

const run = promisify(execFile);
const ffmpeg = (args: string[]) =>
  run("ffmpeg", ["-v", "error", "-nostdin", ...args]);
const fill = "position:absolute;inset:0;width:100%;height:100%;object-fit:fill";
const lane = (points: { t: number; v: number }[], offset?: number) =>
  `data-automation='${JSON.stringify({ version: 1, lanes: [{ target: "rate", points, offset }] })}'`;
const video = (
  src: string,
  duration: number,
  attrs = "",
  start = 0,
  mediaStart = 0,
  id = "picture",
) =>
  `<video id="${id}" src="${src}" muted data-start="${start.toFixed(6)}" data-duration="${duration.toFixed(6)}" data-media-start="${mediaStart.toFixed(6)}" data-track-index="0" style="${fill}" ${attrs}></video>`;
const html = (fps: string, duration: number, body: string) =>
  `<!doctype html><html><head><style>html,body{margin:0}main{position:relative}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="480" data-height="270" data-fps="${fps}" data-duration="${duration.toFixed(6)}">${body}</main></body></html>`;

async function project(request: APIRequestContext, name: string) {
  const response = await request.post("/api/cutroom/projects", {
    data: { name, width: 480, height: 270, duration: 10 },
  });
  return ProjectSchema.parse(await response.json());
}

async function numbered(
  path: string,
  rate: string,
  count: number,
  extra: string[] = [],
) {
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `nullsrc=s=96x54:r=${rate},geq=lum='if(mod(floor(N/pow(2,floor(X/12))),2),235,16)':cb=128:cr=128`,
    "-frames:v",
    String(count),
    "-c:v",
    "libx264",
    "-crf",
    "15",
    "-threads",
    "1",
    ...extra,
    path,
  ]);
}

async function edit(
  request: APIRequestContext,
  project: Project,
  commands: CommandInput[],
) {
  const base = `/api/cutroom/projects/${project.id}`;
  const { revision } = TimelineViewSchema.parse(
    await (await request.get(`${base}/timeline`)).json(),
  );
  const response = await request.post(`${base}/commands`, {
    data: {
      composition: "index.html",
      expectedRevision: revision,
      label: "Picture proof",
      commands,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function marked(
  request: APIRequestContext,
  project: Project,
  start: number,
  end: number,
) {
  const response = await request.post(`/api/projects/${project.id}/export`, {
    data: { format: "mp4", quality: "draft", range: { start, end } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { jobId } = z
    .object({ jobId: z.string() })
    .parse(await response.json());
  const status = z.object({
    status: z.string(),
    outputPath: z.string(),
    error: z.string().nullable(),
  });
  const job = () =>
    request
      .get(`/api/render/${jobId}`)
      .then((result) => result.json())
      .then((body) => status.parse(body));
  await expect
    .poll(async () => (await job()).status, { timeout: 40_000 })
    .not.toBe("rendering");
  const complete = await job();
  expect(complete.status, complete.error ?? "").toBe("complete");
  const { stdout } = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      complete.outputPath,
      "-vf",
      "crop=480:2:0:134,scale=8:1:flags=area,format=gray",
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  return Array.from({ length: stdout.length / 8 }, (_, frame) =>
    stdout
      .subarray(frame * 8, frame * 8 + 8)
      .reduce((label, value, bit) => label + (value > 128 ? 1 << bit : 0), 0),
  );
}

async function seek(page: Page, frame: number, nominal: number) {
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page
    .getByLabel("Go to time")
    .pressSequentially(
      String(Math.floor(frame / nominal) * 100 + (frame % nominal)).padStart(
        8,
        "0",
      ),
    );
  await page.keyboard.press("Enter");
}

async function viewed(
  page: Page,
  frame: number,
  nominal: number,
  pipeline: boolean,
) {
  const start = performance.now();
  const stage = page.locator(".edit-stage");
  await seek(page, frame, nominal);
  if (pipeline)
    await expect(
      page.locator('.edit-pipeline[data-standin="false"]'),
    ).toHaveAttribute("data-frame", String(frame));
  await expect(stage).toHaveAttribute("data-preview-ready");
  const elapsed = performance.now() - start;
  return { elapsed };
}

async function viewedLabel(page: Page) {
  const png = (await page.locator(".edit-picture").screenshot()).toString(
    "base64",
  );
  return page.evaluate(async (png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const ctx = new OffscreenCanvas(image.width, image.height).getContext(
      "2d",
    )!;
    ctx.drawImage(image, 0, 0);
    return Array.from({ length: 8 }, (_, bit) =>
      ctx.getImageData(
        Math.floor((image.width * (bit + 0.5)) / 8),
        Math.floor(image.height / 2),
        1,
        1,
      ).data[0]! > 128
        ? 1 << bit
        : 0,
    ).reduce((label, bit) => label + bit, 0);
  }, png);
}

async function compare(
  page: Page,
  request: APIRequestContext,
  project: Project,
  nominal: number,
  start: number,
  expected: number[],
  pipeline: boolean,
  offsets = expected.map((_, offset) => offset),
) {
  const exported = await marked(
    request,
    project,
    start,
    start + expected.length,
  );
  expect(exported, "exported source ordinals").toEqual(expected);
  await page.addInitScript((on) => {
    if (window === window.top)
      localStorage.setItem("cutroom.footagePipeline", String(on));
  }, pipeline);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  const samples: number[] = [];
  for (const index of offsets) {
    const label = exported[index]!;
    const frame = start + index;
    const { elapsed } = await viewed(page, frame, nominal, pipeline);
    await expect
      .poll(() => viewedLabel(page), { message: `viewer frame ${frame}` })
      .toBe(label);
    samples.push(elapsed);
  }
  console.log(
    `${project.name} ${pipeline ? "pipeline" : "bridge"} seek to ready (ms): ${samples.map(Math.round).join(", ")}`,
  );
}

for (const pipeline of [false, true]) {
  test(`open GOP at a split and marked in-point (${pipeline ? "pipeline" : "bridge"})`, async ({
    page,
    request,
  }) => {
    const fixture = await project(request, "Open GOP");
    await numbered(join(fixture.path, "open.mp4"), "30", 100, [
      "-g",
      "30",
      "-bf",
      "2",
      "-x264-params",
      "open-gop=1:scenecut=0:b-adapt=0",
    ]);
    const split = 59 / 30;
    const flat = pipeline ? "" : lane([{ t: 0, v: 1 }]);
    await writeFile(
      join(fixture.path, "index.html"),
      html(
        "30",
        100 / 30,
        video("open.mp4", split, flat) +
          video(
            "open.mp4",
            41 / 30,
            pipeline ? "" : lane([{ t: 0, v: 1 }], split),
            split,
            split,
            "tail",
          ),
      ),
    );
    await compare(
      page,
      request,
      fixture,
      30,
      57,
      [57, 58, 59, 60, 61],
      pipeline,
    );
    expect(await marked(request, fixture, 59, 62)).toEqual([59, 60, 61]);
  });
}

const vfr = [
  "-vf",
  "setpts='if(lt(N,3),if(eq(N,0),0,if(eq(N,1),40,50)),if(eq(N,3),100,if(eq(N,4),120,200)))'",
  "-fps_mode",
  "vfr",
  "-enc_time_base",
  "1/1000",
  "-video_track_timescale",
  "1000",
];

for (const {
  name,
  fps,
  nominal,
  rate,
  count,
  extra,
  at,
  expected,
  pipeline,
} of [
  {
    name: "P8 25 on 29.97",
    fps: "30000/1001",
    nominal: 30,
    rate: "25",
    count: 30,
    at: 0,
    expected: [0, 0, 1, 2, 3, 4, 5, 5, 6, 7],
    pipeline: true,
  },
  {
    name: "P9 23.976 on 29.97",
    fps: "30000/1001",
    nominal: 30,
    rate: "24000/1001",
    count: 30,
    at: 3,
    expected: [2, 3, 4, 4, 5, 6, 7, 8],
    pipeline: true,
  },
  {
    name: "P10 59.94 on 29.97",
    fps: "30000/1001",
    nominal: 30,
    rate: "60000/1001",
    count: 30,
    at: 0,
    expected: [0, 2, 4, 6, 8, 10],
    pipeline: false,
  },
  {
    name: "P11 VFR",
    fps: "30",
    nominal: 30,
    rate: "1000",
    count: 6,
    extra: vfr,
    at: 0,
    expected: [0, 0, 2, 3, 4, 4, 5],
    pipeline: false,
  },
  {
    name: "P11 VFR pipeline",
    fps: "30",
    nominal: 30,
    rate: "1000",
    count: 6,
    extra: vfr,
    at: 0,
    expected: [0, 0, 2, 3, 4, 4, 5],
    pipeline: true,
  },
  {
    name: "P12 Matroska",
    fps: "60",
    nominal: 60,
    rate: "60",
    count: 30,
    at: 0,
    expected: [0, 1, 2, 3, 4, 5, 6],
    pipeline: false,
  },
  {
    name: "P14 held tail",
    fps: "30",
    nominal: 30,
    rate: "30",
    count: 60,
    at: 58,
    expected: [58, 59, 59, 59, 59],
    pipeline: false,
  },
]) {
  test(name, async ({ page, request }) => {
    const fixture = await project(request, name);
    const src = name.includes("Matroska") ? "numbered.mkv" : "numbered.mp4";
    await numbered(join(fixture.path, src), rate, count, extra);
    const [num, den = 1] = fps.split("/").map(Number);
    const duration = ((at + expected.length) * den!) / num!;
    await writeFile(
      join(fixture.path, "index.html"),
      html(fps, duration, video(src, duration)),
    );
    await compare(page, request, fixture, nominal, at, expected, pipeline);
  });
}

for (const { fps, count, cycle, mediaStart, duration } of [
  { fps: "30", count: 60, cycle: 45, mediaStart: 0.5, duration: 5 },
  {
    fps: "30000/1001",
    count: 61,
    cycle: 46,
    mediaStart: 0.5005,
    duration: 5.005,
  },
]) {
  test(`loop wraps twice at native ${fps} duration`, async ({
    page,
    request,
  }) => {
    const fixture = await project(request, "Native loop");
    await numbered(join(fixture.path, "loop.mp4"), fps, count, [
      "-video_track_timescale",
      "30000",
    ]);
    await writeFile(
      join(fixture.path, "index.html"),
      html(fps, duration, video("loop.mp4", duration, "loop", 0, mediaStart)),
    );
    await compare(
      page,
      request,
      fixture,
      30,
      cycle - 1,
      Array.from(
        { length: cycle + 3 },
        (_, i) => 15 + ((cycle - 1 + i) % cycle),
      ),
      false,
      [0, 1, 2, cycle, cycle + 1, cycle + 2],
    );
  });
}

test("P5 a ramp on the near side of an NTSC frame boundary", async ({
  page,
  request,
}) => {
  const fixture = await project(request, "NTSC ramp boundary");
  await numbered(join(fixture.path, "ntsc.mp4"), "24000/1001", 24);
  await writeFile(
    join(fixture.path, "index.html"),
    html(
      "24000/1001",
      1,
      video("ntsc.mp4", 0.9, lane([{ t: 0, v: 1 }]), 0.041718),
    ),
  );
  await compare(page, request, fixture, 24, 1, [0, 1, 2, 3], false);
});

test("P6 a non-flat rate ramp", async ({ page, request }) => {
  const fixture = await project(request, "Non-flat ramp");
  await numbered(join(fixture.path, "ramp.mp4"), "30", 240);
  await writeFile(
    join(fixture.path, "index.html"),
    html(
      "30",
      5,
      video(
        "ramp.mp4",
        5,
        lane([
          { t: 0, v: 0.5 },
          { t: 4, v: 2 },
        ]),
      ),
    ),
  );
  // The published frame 60 and frame 120 checks straddle different rates.
  for (const [start, expected] of [
    [60, 43],
    [120, 129],
  ] as const)
    await compare(page, request, fixture, 30, start, [expected], false);
});

test("P7 a split and tail dissolve preserve the ramp's source pictures", async ({
  page,
  request,
}) => {
  const fixture = await project(request, "Ramp through-edit");
  await numbered(join(fixture.path, "numbered.mp4"), "30", 245);
  await writeFile(
    join(fixture.path, "index.html"),
    html(
      "30",
      7,
      video(
        "numbered.mp4",
        5,
        lane([
          { t: 0, v: 0.5 },
          { t: 4, v: 2 },
        ]),
      ) + video("numbered.mp4", 2, "", 5, 1, "next"),
    ),
  );
  const cut = await marked(request, fixture, 57, 61);
  const nearTail = await marked(request, fixture, 141, 145);
  await edit(request, fixture, [
    { type: "split", at: 60, clipIds: ["picture"], ids: { picture: ["tail"] } },
    {
      type: "setTransition",
      from: "tail",
      to: "next",
      transition: { duration: 10 },
    },
  ]);
  await compare(page, request, fixture, 30, 57, cut, false);
  await compare(page, request, fixture, 30, 141, nearTail, false);
});

test("P15 a ramp in a scene mounted at frame 100 and trimmed in by one second", async ({
  page,
  request,
}) => {
  const fixture = await project(request, "Trimmed scene");
  await numbered(join(fixture.path, "scene.mp4"), "30", 240);
  const picture = video(
    "scene.mp4",
    5,
    lane([
      { t: 0, v: 0.5 },
      { t: 4, v: 2 },
    ]),
  );
  const scene = html("30", 5, picture).replace(
    'id="main" data-composition-id="main"',
    'id="scene" data-composition-id="scene"',
  );
  await writeFile(join(fixture.path, "scene.html"), scene);
  const mount = `<div id="mount" data-composition-id="scene" data-composition-src="scene.html" data-start="3.333333" data-duration="4" data-media-start="1" data-track-index="0" style="${fill}"></div>`;
  await writeFile(
    join(fixture.path, "index.html"),
    html("30", 220 / 30, mount),
  );
  const reference = await project(request, "Scene alone");
  await numbered(join(reference.path, "scene.mp4"), "30", 240);
  await writeFile(join(reference.path, "index.html"), html("30", 5, picture));
  const alone = await marked(request, reference, 30, 34);
  await compare(page, request, fixture, 30, 100, alone, false);
});
