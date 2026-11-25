import { execFile } from "node:child_process";
import { copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

test.use({ trace: "off" });

/** The number a frame carries in blocks along its top, white for 1, read off the viewer. */
async function shownFrame(page: Page, bits = 8) {
  const png = (await page.locator(".edit-picture").screenshot()).toString(
    "base64",
  );
  return page.evaluate(
    async ({ png, bits }) => {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], {
          type: "image/png",
        }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      let frame = 0;
      for (let bit = 0; bit < bits; bit++) {
        const [red] = context.getImageData(
          Math.floor(((bit + 0.5) * bitmap.width) / bits),
          Math.floor(bitmap.height / 20),
          1,
          1,
        ).data;
        if (red! > 128) frame |= 1 << bit;
      }
      return frame;
    },
    { png, bits },
  );
}

async function seekFrame(page: Page, frame: number) {
  await page
    .getByRole("button", { name: "Current time. Click to type a time." })
    .click();
  const time = page.getByRole("textbox", { name: "Go to time" });
  const seconds = Math.floor(frame / 30);
  await time.pressSequentially(
    [Math.floor(seconds / 60), seconds % 60, frame % 30]
      .map((part) => String(part).padStart(2, "0"))
      .join("")
      .padStart(8, "0"),
  );
  await time.press("Enter");
}

async function proxyTimeline(
  request: APIRequestContext,
  name: string,
  count: number,
  length: number,
  inPoint: (clip: number) => number,
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name,
          width: 640,
          height: 360,
          duration: count * length,
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
    "color=white:size=640x360:rate=30:duration=3",
    "-vf",
    "drawbox=x=320:y=0:w=320:h=360:color=black:t=fill:enable='gte(t,1)'",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-x265-params",
    "log-level=error:pools=2:frame-threads=2",
    join(project.path, "recording.mkv"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#111}</style></head><body>
<main data-composition-id="main" data-width="640" data-height="360" data-duration="${count * length}" data-fps="30">
${Array.from(
  { length: count },
  (_, i) =>
    `<video id="clip-${i}" src="recording.mkv" muted data-start="${i * length}" data-duration="${length}" data-media-start="${inPoint(i)}" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video>`,
).join("\n")}
</main></body></html>`,
  );
  return project;
}

test("the fallback only loads nearby HEVC clips while the footage plan is pending", async ({
  page,
  request,
}) => {
  const project = await proxyTimeline(
    request,
    "Proxy preload window",
    40,
    2,
    (clip) => (clip === 39 ? 1 : 0),
  );
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname === `/api/cutroom/projects/${project.id}/pipeline`,
    async (route) => {
      requested.resolve();
      await release.promise;
      await route.continue();
    },
  );
  try {
    await page.goto(`/#project/${project.id}`);
    await requested.promise;
    const preview = page.frameLocator('iframe[title="Composition preview"]');
    const first = preview.locator("#clip-0");
    const last = preview.locator("#clip-39");
    const stage = page.locator(".edit-stage");
    await expect(first).toHaveAttribute("src", /hf-proxy=h264/);
    await expect(first).not.toHaveAttribute("src", /hf-proxy-box=/);
    await expect(stage).toHaveAttribute("data-preview-ready");
    await expect.poll(() => shownFrame(page)).toBe(255);
    expect(
      await preview
        .locator("video")
        .evaluateAll((videos) =>
          videos
            .slice(10)
            .flatMap((video) =>
              video instanceof HTMLVideoElement &&
              (video.src.includes("hf-proxy=") ||
                video.networkState === HTMLMediaElement.NETWORK_LOADING ||
                video.readyState !== HTMLMediaElement.HAVE_NOTHING)
                ? [video.id]
                : [],
            ),
        ),
    ).toEqual([]);
    await seekFrame(page, 39 * 2 * 30);
    await expect(last).toHaveAttribute("src", /hf-proxy=h264/);
    await expect(stage).toHaveAttribute("data-preview-ready");
    await expect.poll(() => shownFrame(page)).toBe(15);
  } finally {
    release.resolve();
  }
});

// Read the displayed video's picture in the middle of each clip. This avoids sampling
// a frame at the boundary and catches both blank or stale pictures while the clock advances.
async function watchCuts(page: Page, first: number, count: number) {
  return page
    .frameLocator('iframe[title="Composition preview"]')
    .locator("video")
    .evaluateAll(
      (elements, { first, count }) => {
        const player = (window as Window & { __player?: { getTime(): number } })
          .__player;
        const canvas = new OffscreenCanvas(2, 1);
        const context = canvas.getContext("2d")!;
        const videos = new Map(
          elements
            .filter((video) => video instanceof HTMLVideoElement)
            .map((video) => [video.id, video]),
        );
        const pictures = new Set<number>();
        let started: number | undefined;
        return new Promise<{ elapsed: number; pictures: number[] }>(
          (resolve) => {
            const deadline = performance.now() + 7_000;
            const sample = (now: number) => {
              const time = player?.getTime() ?? 0;
              const clip = Math.floor(time * 2);
              if (time > first / 2 - 0.2) started ??= now;
              if (
                clip >= first &&
                clip < first + count &&
                time * 2 - clip > 0.2
              ) {
                const video = videos.get(`clip-${clip}`);
                const hold = video?.nextElementSibling;
                const picture =
                  hold instanceof HTMLCanvasElement &&
                  hold.hasAttribute("data-cutroom-video-hold")
                    ? hold
                    : video &&
                        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
                      ? video
                      : null;
                if (picture?.checkVisibility({ visibilityProperty: true })) {
                  context.drawImage(picture, 0, 0, 2, 1);
                  const pixels = context.getImageData(0, 0, 2, 1).data;
                  if (
                    pixels[0]! > 200 &&
                    (clip % 2 ? pixels[4]! < 50 : pixels[4]! > 200)
                  )
                    pictures.add(clip);
                }
              }
              if (time >= (first + count) / 2 || now >= deadline) {
                resolve({
                  elapsed: now - (started ?? now),
                  pictures: [...pictures],
                });
              } else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          },
        );
      },
      { first, count },
    );
}

test("fallback playback shows rapid HEVC cuts at 2x without stalling", async ({
  page,
  request,
}) => {
  const project = await proxyTimeline(
    request,
    "Fast HEVC cuts",
    120,
    0.5,
    (clip) => clip % 2,
  );
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("cutroom.footagePipeline", "false");
  });
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  await expect.poll(() => shownFrame(page)).toBe(255);
  const played = watchCuts(page, 2, 12);
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect(page.getByLabel("Shuttle speed")).toHaveText("2x");
  const result = await played;
  expect(result.pictures).toEqual(Array.from({ length: 12 }, (_, i) => i + 2));
  expect(result.elapsed).toBeLessThan(3_800);
});

test("turning GPU footage off after a distant seek primes the next HEVC cut", async ({
  page,
  request,
}) => {
  const project = await proxyTimeline(
    request,
    "HEVC playback handback",
    40,
    0.5,
    (clip) => clip % 2,
  );
  await page.goto(`/#project/${project.id}`);
  const stage = page.locator(".edit-stage");
  await expect(stage).toHaveAttribute("data-pipeline", "on", {
    timeout: 30_000,
  });
  await seekFrame(page, 30 * 15);
  await expect(page.locator(".edit-pipeline")).toHaveAttribute(
    "data-frame",
    "450",
  );
  await expect.poll(() => shownFrame(page)).toBe(255);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "GPU footage playback" }).uncheck();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(stage).not.toHaveAttribute("data-pipeline", "on");
  await expect(stage).toHaveAttribute("data-preview-ready");
  const played = watchCuts(page, 31, 2);
  await page.keyboard.press("l");
  const result = await played;
  expect(result.pictures).toEqual([31, 32]);
  expect(result.elapsed).toBeLessThan(1_650);
});

for (const { name, duration, videoDuration, gap, mp4, frames } of [
  {
    name: "completed MP4",
    duration: 3.8,
    videoDuration: 3.8,
    gap: [30, 38],
    mp4: true,
    frames: [
      [15, 15],
      [35, 29],
      [38, 29],
      [39, 39],
    ],
  },
  {
    name: "HLS",
    duration: 12,
    videoDuration: 12,
    gap: [164, 178],
    mp4: false,
    frames: [
      [125, 125],
      [170, 163],
      [178, 163],
      [179, 179],
      [241, 241],
      [359, 103],
    ],
  },
  {
    name: "HEVC with longer audio",
    duration: 8,
    videoDuration: 5.3,
    gap: null,
    mp4: null,
    frames: [
      [125, 125],
      [184, 158],
      [162, 158],
      [152, 152],
    ],
  },
] as const) {
  test(`a paused ${name} editing proxy holds the right picture through missing video frames`, async ({
    page,
    request,
  }) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: {
            name: "Proxy presentation times",
            width: 640,
            height: 360,
            duration,
          },
        })
      ).json(),
    );
    const bits = Array.from(
      { length: 8 },
      (_, bit) =>
        `drawbox=x=${bit * 40}:y=0:w=40:h=18:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
    );
    const picture = `drawbox=x=0:y=0:w=320:h=18:color=black:t=fill,${bits.join(",")}`;
    const input = gap ? "recording.mp4" : "recording.mkv";
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=320x180:rate=30:duration=${videoDuration}`,
      ...(gap
        ? []
        : [
            "-f",
            "lavfi",
            "-i",
            `anullsrc=r=48000:cl=mono:d=${duration}`,
            // Start the first AAC packet at zero. FFprobe versions disagree on whether
            // negative encoder priming belongs to the Matroska media timeline.
            "-af",
            "asetpts=PTS+1024/SR/TB",
            "-c:a",
            "aac",
          ]),
      "-vf",
      gap ? `${picture},select='not(between(n,${gap.join(",")}))'` : picture,
      "-fps_mode",
      "vfr",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-tag:v",
      "hvc1",
      "-x265-params",
      "log-level=error:pools=2:frame-threads=2",
      join(project.path, input),
    ]);
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><head><style>html,body{margin:0;background:#111111}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="${duration}" data-fps="30">
<video id="recording" src="${input}" muted data-start="0" data-duration="${duration}" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video>
</main></body></html>`,
    );
    await page.addInitScript(() => {
      if (window === window.top)
        localStorage.setItem("cutroom.footagePipeline", "false");
    });
    const proxy = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.searchParams.get("hf-proxy") === "h264" &&
        !url.searchParams.has("cutroom-piece") &&
        /^(video\/mp4|application\/vnd\.apple\.mpegurl)/.test(
          response.headers()["content-type"] ?? "",
        ) &&
        [200, 206].includes(response.status())
      );
    });
    await page.goto(`/#project/${project.id}`);
    const type = (await proxy).headers()["content-type"];
    if (mp4 !== null)
      expect(type).toContain(
        mp4 ? "video/mp4" : "application/vnd.apple.mpegurl",
      );
    await expect(page.locator(".edit-preparing")).toBeHidden();
    const stage = page.locator(".edit-stage");
    for (const [destination, expected] of frames) {
      await seekFrame(page, destination);
      await expect(stage).toHaveAttribute("data-preview-ready");
      expect(await shownFrame(page)).toBe(expected);
    }
    await expect(
      page.getByText("The preview did not draw the frame in time."),
    ).toHaveCount(0);
  });
}

for (const pipeline of [false, true])
  test(`a ProRes clip the browser cannot decode plays from its editing proxy, frame for frame, with the footage pipeline ${pipeline ? "on" : "off"}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: "Codec proxy", width: 640, height: 360, duration: 4 },
        })
      ).json(),
    );
    const bits = Array.from(
      { length: 8 },
      (_, bit) =>
        `drawbox=x=${bit * 80}:y=0:w=80:h=36:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
    );
    await promisify(execFile)("ffmpeg", [
      ...["-v", "error", "-y", "-f", "lavfi", "-i"],
      "testsrc2=size=640x360:rate=30:duration=4",
      "-vf",
      `drawbox=x=0:y=0:w=640:h=36:color=black:t=fill,${bits.join(",")},format=yuv422p10le`,
      ...["-c:v", "prores_ks", "-profile:v", "1"],
      join(project.path, "camera.mov"),
    ]);
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><head><style>html,body{margin:0;background:#111111}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="4" data-fps="30">
<video id="camera" src="camera.mov" muted data-start="0" data-duration="4" data-media-start="0" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video>
</main></body></html>`,
    );
    await page.addInitScript((on) => {
      if (window === window.top)
        localStorage.setItem("cutroom.footagePipeline", String(on));
    }, pipeline);
    await page.goto(`/#project/${project.id}`);
    const stage = page.locator(".edit-stage");
    // Before its proxy exists the clip has no picture, and the viewer waits for none.
    await expect(stage).toHaveAttribute("data-preview-ready");
    await expect(page.locator(".edit-preparing")).toBeHidden({
      timeout: 30_000,
    });
    if (pipeline)
      await expect(stage).toHaveAttribute("data-pipeline", "on", {
        timeout: 30_000,
      });
    else await expect(stage).not.toHaveAttribute("data-pipeline");
    await expect(page.getByText("did not draw")).toHaveCount(0);

    for (const frame of [45, 46, 101]) {
      await seekFrame(page, frame);
      if (pipeline) {
        const canvas = page.locator(".edit-pipeline");
        await expect(canvas).toHaveAttribute("data-frame", String(frame));
        await expect(canvas).toHaveAttribute("data-standin", "false");
      }
      await expect(stage).toHaveAttribute("data-preview-ready");
      await expect.poll(() => shownFrame(page)).toBe(frame);
    }
  });

test("PCM audio before the first picture keeps the same proxy frames in HLS and MP4", async ({
  page,
  request,
}) => {
  const duration = 48;
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Leading PCM", width: 640, height: 360, duration },
      })
    ).json(),
  );
  const bits = Array.from(
    { length: 12 },
    (_, bit) =>
      `drawbox=x=${bit * 48}:y=0:w=48:h=36:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
  );
  await promisify(execFile)("ffmpeg", [
    ...["-v", "error", "-y", "-f", "lavfi", "-i"],
    `testsrc2=size=576x324:rate=30:duration=${duration}`,
    ...["-f", "lavfi", "-i", `anullsrc=r=48000:cl=mono:d=${duration}`],
    "-vf",
    `drawbox=x=0:y=0:w=576:h=36:color=black:t=fill,${bits.join(",")},settb=1/15360,setpts=PTS+1782`,
    ...["-fps_mode", "passthrough", "-enc_time_base:v", "1:15360"],
    ...["-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1"],
    ...["-x265-params", "log-level=error:pools=2:frame-threads=2"],
    ...["-c:a", "pcm_s16le", join(project.path, "recording.mov")],
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#111111}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="${duration}" data-fps="30">
<video id="recording" src="recording.mov" muted data-start="0" data-duration="${duration}" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video>
</main></body></html>`,
  );
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("cutroom.footagePipeline", "false");
  });

  const stage = page.locator(".edit-stage");
  const checkFrames = async () => {
    await expect(page.locator(".edit-preparing")).toBeHidden();
    await expect(stage).toHaveAttribute("data-preview-ready");
    // The first picture starts at 116.016 ms. Check before it, around the first
    // piece boundary, and beyond Chromium's initial buffer before going back.
    for (const [destination, expected] of [
      [0, 0],
      [1, 0],
      [5, 1],
      [123, 119],
      [124, 120],
      [780, 776],
      [124, 120],
    ] as const) {
      await seekFrame(page, destination);
      await expect(stage).toHaveAttribute("data-preview-ready");
      expect(await shownFrame(page, bits.length)).toBe(expected);
    }
  };

  const firstPiece = page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get("cutroom-piece") === "0" &&
      response.ok(),
  );
  await page.goto(`/#project/${project.id}`);
  await firstPiece;
  await checkFrames();

  const asset = `/api/cutroom/projects/${project.id}/media/proxy?path=recording.mov`;
  await expect
    .poll(async () => {
      const response = await request.get(asset, {
        headers: { range: "bytes=0-0" },
      });
      const type = response.headers()["content-type"];
      await response.dispose();
      return type;
    })
    .toContain("video/mp4");
  const mp4 = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.searchParams.get("hf-proxy") === "h264" &&
      !url.searchParams.has("cutroom-piece") &&
      response.headers()["content-type"] === "video/mp4" &&
      response.ok()
    );
  });
  await page.reload();
  await mp4;
  await checkFrames();
});

/** Four minutes of HEVC, each frame's number in sixteen blocks; made once for both settings. */
let longRecording: Promise<string> | undefined;
const makeLongRecording = () =>
  (longRecording ??= (async () => {
    const path = join(tmpdir(), `cutroom-e2e-long-${process.pid}.mp4`);
    const bits = Array.from(
      { length: 16 },
      (_, bit) =>
        `drawbox=x=${bit * 40}:y=0:w=40:h=36:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
    );
    await promisify(execFile)("ffmpeg", [
      ...["-v", "error", "-y", "-f", "lavfi", "-i"],
      "testsrc2=size=640x360:rate=30:duration=240",
      "-vf",
      `drawbox=x=0:y=0:w=640:h=36:color=black:t=fill,${bits.join(",")}`,
      ...["-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1"],
      ...["-x265-params", "log-level=error"],
      path,
    ]);
    return path;
  })());

test.afterAll(async () => {
  if (longRecording) await rm(await longRecording, { force: true });
});

/** Model Chromium presenting and returning the same stale frame after a seek settles. */
function delayProxyPicture() {
  if (window === window.top) return;
  const nativeRequest = HTMLVideoElement.prototype.requestVideoFrameCallback;
  const NativeFrame = VideoFrame;
  let held: { video: HTMLVideoElement; frame: VideoFrame } | null = null;
  let stalePresented = false;
  addEventListener(
    "hold-proxy-picture",
    () => {
      const video = document.querySelector<HTMLVideoElement>("#recording")!;
      held = { video, frame: new NativeFrame(video) };
    },
    { once: true },
  );
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    return nativeRequest.call(this, (now, metadata) => {
      if (
        held?.video === this &&
        Math.abs(this.currentTime - 1234 / 30) < 0.02
      ) {
        stalePresented = true;
        callback(now, { ...metadata, mediaTime: held.frame.timestamp / 1e6 });
        addEventListener(
          "release-proxy-picture",
          () => callback(now, metadata),
          {
            once: true,
          },
        );
      } else {
        callback(now, metadata);
      }
    });
  };
  window.VideoFrame = new Proxy(NativeFrame, {
    construct(Frame, args, target) {
      if (held && args[0] === held.video && stalePresented) {
        held.video.toggleAttribute("data-stale-capture", true);
        return held.frame.clone();
      }
      return Reflect.construct(Frame, args, target);
    },
  });
  addEventListener(
    "release-proxy-picture",
    () => {
      if (!held) return;
      held.frame.close();
      held = null;
      window.VideoFrame = NativeFrame;
      HTMLVideoElement.prototype.requestVideoFrameCallback = nativeRequest;
    },
    { once: true },
  );
}

for (const { pipeline, supersede } of [
  { pipeline: false, supersede: false },
  { pipeline: true, supersede: false },
  { pipeline: false, supersede: true },
]) {
  const title = supersede
    ? "a superseded HLS seek holds the previous picture until the latest decoded frame arrives"
    : `a long HEVC recording shows the frame under the playhead from its proxy's pieces before the proxy is finished, with the footage pipeline ${pipeline ? "on" : "off"}`;
  test(title, async ({ page, request }) => {
    test.setTimeout(150_000);
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: {
            name: "Long recording",
            width: 640,
            height: 360,
            duration: 240,
          },
        })
      ).json(),
    );
    await copyFile(
      await makeLongRecording(),
      join(project.path, "recording.mp4"),
    );
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><head><style>html,body{margin:0;background:#111111}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="240" data-fps="30">
<video id="recording" src="recording.mp4" muted data-start="0" data-duration="240" data-media-start="0" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video>
</main></body></html>`,
    );
    const pieces: string[] = [];
    page.on("request", (sent) => {
      const piece = new URL(sent.url()).searchParams.get("cutroom-piece");
      if (piece !== null) pieces.push(piece);
    });
    const piece = Promise.withResolvers<void>();
    let waitingForPiece = false;
    await page.route(
      (url) => url.searchParams.get("cutroom-piece") === "45",
      async (route) => {
        waitingForPiece = true;
        await piece.promise;
        await route.continue();
      },
    );
    await page.addInitScript((on) => {
      if (window === window.top)
        localStorage.setItem("cutroom.footagePipeline", String(on));
    }, pipeline);
    if (supersede) await page.addInitScript(delayProxyPicture);
    await page.goto(`/#project/${project.id}`);
    const stage = page.locator(".edit-stage");
    await expect(stage).toHaveAttribute("data-preview-ready");
    // Three minutes in, past where the proxy has got to, then a frame on either side.
    for (const frame of [5400, 5401, 1234]) {
      if (supersede && frame === 1234) {
        const releasePiece = Promise.withResolvers<void>();
        let waitingForSupersededPiece = false;
        await page.route(
          (url) => url.searchParams.get("cutroom-piece") === "25",
          async (route) => {
            waitingForSupersededPiece = true;
            await releasePiece.promise;
            await route.continue();
          },
        );
        const video = page
          .frameLocator("iframe[data-live]")
          .locator("#recording");
        await video.evaluate(() =>
          dispatchEvent(new Event("hold-proxy-picture")),
        );
        try {
          await seekFrame(page, 3000);
          await expect.poll(() => waitingForSupersededPiece).toBe(true);
          await expect(stage).not.toHaveAttribute("data-preview-ready");
          expect(await shownFrame(page, 16)).toBe(5401);
          await seekFrame(page, frame);
        } finally {
          releasePiece.resolve();
        }
        try {
          await expect(video).toHaveAttribute("data-stale-capture");
          expect(await shownFrame(page, 16)).toBe(5401);
          expect(await stage.getAttribute("data-preview-ready")).toBeNull();
        } finally {
          await video.evaluate(() =>
            dispatchEvent(new Event("release-proxy-picture")),
          );
        }
      } else {
        await seekFrame(page, frame);
      }
      if (frame === 5400) {
        try {
          await expect.poll(() => waitingForPiece).toBe(true);
          await expect(stage).not.toHaveAttribute("data-preview-ready");
          expect(await shownFrame(page, 16)).toBe(0);
        } finally {
          piece.resolve();
        }
      }
      await expect(stage).toHaveAttribute("data-preview-ready");
      expect(await shownFrame(page, 16)).toBe(frame);
    }
    // The playhead's piece, 3:00 to 3:04, was asked for: the frames came from the pieces.
    expect(pieces).toContain("45");
    await expect(page.getByText("did not draw")).toHaveCount(0);
  });
}
