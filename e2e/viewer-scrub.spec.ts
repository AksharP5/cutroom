import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

// The screencast below is the measurement; Playwright's trace must not compete with it.
test.use({ trace: "off" });

/**
 * Twenty seconds of 1080p whose frames carry their own number in sixteen blocks along the top.
 * The ten-second GOP makes each source seek decode many frames, as camera footage does,
 * while staying quick to encode.
 */
async function numberedProject(request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Scrub", width: 1920, height: 1080, duration: 20 },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1920x1080:rate=30:duration=20",
    "-f",
    "lavfi",
    "-i",
    "nullsrc=size=16x1:rate=30:duration=20",
    "-filter_complex",
    "[1:v]format=gray,geq=lum='255*mod(floor(N/pow(2\\,X))\\,2)',scale=1920:54:flags=neighbor[bar];[0:v][bar]overlay=0:0,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    "300",
    join(project.path, "Picture.mp4"),
  ]);
  // A magenta box over the picture: overlays keep drawing while proxies stand in.
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>
    body{margin:0;background:#000}main{position:relative;width:1920px;height:1080px}
    video{position:absolute;inset:0;width:100%;height:100%}
    #badge{position:absolute;right:60px;bottom:60px;width:300px;height:180px;background:#f0f}
    </style></head><body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="20" data-fps="30">
    <video id="picture" data-start="0" data-duration="20" data-track-index="0" muted src="Picture.mp4"></video>
    <div id="badge" class="clip" data-start="0" data-duration="20" data-track-index="1"></div>
    </main></body></html>`,
  );
  // Make the proxy before the viewer opens, as a project imported earlier would have it.
  await expect
    .poll(
      async () =>
        (
          await request.get(
            `/api/cutroom/projects/${project.id}/media/scrub?path=Picture.mp4`,
          )
        ).status(),
      { timeout: 60_000 },
    )
    .toBe(200);
  return project;
}

/** Drags the ruler for `ms`, recording every composited frame and every playhead frame. */
async function scrub(page: Page, ms: number) {
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  await page.keyboard.press("Shift+KeyZ");
  await page.evaluate(() => {
    const clock = document.querySelector<HTMLElement>(
      "[aria-label^='Current time']",
    )!;
    const visits: number[] = [];
    const read = () => {
      const [h, m, s, f] = clock.textContent!.split(":").map(Number);
      visits.push(((h! * 60 + m!) * 60 + s!) * 30 + f!);
    };
    read();
    new MutationObserver(read).observe(clock, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    Object.assign(window, { scrubVisits: visits });
  });
  const session = await page.context().newCDPSession(page);
  const frames: { time: number; data: string }[] = [];
  session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    void session.send("Page.screencastFrameAck", { sessionId });
    frames.push({ time: metadata.timestamp! * 1000, data });
  });
  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 90,
    everyNthFrame: 1,
    maxWidth: 860,
    maxHeight: 525,
  });
  const ruler = (await page.locator(".tl-ruler").boundingBox())!;
  const y = ruler.y + ruler.height / 2;
  await page.mouse.move(ruler.x + 40, y);
  await page.mouse.down();
  await page.waitForTimeout(300);
  const start = Date.now();
  while (Date.now() - start < ms)
    await page.mouse.move(
      ruler.x + 40 + ((Date.now() - start) / ms) * ruler.width * 0.5,
      y,
    );
  const end = Date.now();
  // Rest with the button still down: the exact frame must replace the proxy.
  await page.waitForTimeout(1000);
  await session.send("Page.stopScreencast");
  const box = (await page.locator(".edit-picture").boundingBox())!;
  const pictures = await page.evaluate(
    async ({ frames, box }) => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const decoded: { time: number; number: number; badge: boolean }[] = [];
      for (const { time, data } of frames) {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes]));
        const scale = image.width / innerWidth;
        canvas.width = image.width;
        canvas.height = image.height;
        context.drawImage(image, 0, 0);
        image.close();
        const pixel = (x: number, y: number) =>
          context.getImageData(
            Math.round((box.x + x * box.width) * scale),
            Math.round((box.y + y * box.height) * scale),
            1,
            1,
          ).data;
        let number = 0;
        for (let bit = 0; bit < 16; bit++)
          if (pixel((bit + 0.5) / 16, 27 / 1080)[0]! > 128) number |= 1 << bit;
        const [r, g, b] = pixel(1 - 210 / 1920, 1 - 150 / 1080);
        decoded.push({
          time,
          number,
          badge: r! > 200 && g! < 60 && b! > 200,
        });
      }
      return decoded;
    },
    { frames, box },
  );
  const visits = await page.evaluate(
    () => (window as unknown as { scrubVisits: number[] }).scrubVisits,
  );
  const during = pictures.filter((p) => p.time >= start && p.time <= end);
  const changes = during.filter(
    (picture, index) =>
      picture.number !== (during[index - 1] ?? pictures[0]!).number,
  );
  return { pictures, during, changes, visits, seconds: (end - start) / 1000 };
}

test("scrubbing shows only frames the playhead visited, and the exact frame once it rests", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const project = await numberedProject(request);
  await page.goto(`/#project/${project.id}`);
  const { pictures, during, changes, visits } = await scrub(page, 1500);
  const visited = new Set(visits);
  expect(changes.length).toBeGreaterThan(0);
  expect(changes.filter((p) => !visited.has(p.number))).toEqual([]);
  expect(during.every((p) => p.badge)).toBe(true);
  // At rest the source's own frame replaces the proxy, at the playhead's frame.
  const playhead = visits.at(-1)!;
  expect(pictures.at(-1)!.number).toBe(playhead);
  const preview = page
    .frames()
    .find((frame) => frame.url().includes("/api/isolated/"))!;
  expect(
    await preview.evaluate(() => {
      const hold = document.querySelector<HTMLCanvasElement>(
        "canvas[data-cutroom-video-hold]",
      )!;
      return {
        proxy: hold.hasAttribute("data-cutroom-proxy"),
        width: hold.width,
      };
    }),
  ).toEqual({ proxy: false, width: 1920 });
  await page.mouse.up();
});

test(
  "scrubbing the ruler keeps showing new pictures",
  { tag: "@performance" },
  async ({ page, request }) => {
    test.setTimeout(120_000);
    const project = await numberedProject(request);
    await page.goto(`/#project/${project.id}`);
    const { changes, seconds } = await scrub(page, 3000);
    // Before scrub proxies a continuous drag showed under one new picture a second.
    // Locally it now shows about fifty; CI's shared cores still clear six.
    expect(changes.length / seconds).toBeGreaterThan(6);
    await page.mouse.up();
  },
);

test("the preview polls a pending scrub proxy once per source across repeated cuts", async ({
  page,
  request,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("cutroom.footagePipeline", "false"),
  );
  const response = await request.post("/api/cutroom/projects", {
    data: { name: "Repeated cuts", width: 640, height: 360, duration: 6 },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const project = ProjectSchema.parse(await response.json());
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:r=30:d=2",
    "-c:v",
    "libx264",
    join(project.path, "picture.mp4"),
  ]);
  const cuts = Array.from(
    { length: 6 },
    (_, index) =>
      `<video id="cut-${index}" src="picture.mp4" muted data-start="${index}" data-duration="1" data-track-index="0"></video>`,
  ).join("\n");
  await writeFile(
    join(project.path, "index.html"),
    `<main id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="6" data-fps="30">${cuts}</main>`,
  );

  const lastPoll = new Map<string, number>();
  const intervals: number[] = [];
  await page.route(
    /\/api\/isolated\/[^/]+\/scrub\?path=picture\.mp4$/,
    (route) => {
      const url = route.request().url();
      const now = performance.now();
      const previous = lastPoll.get(url);
      if (previous !== undefined) intervals.push(now - previous);
      lastPoll.set(url, now);
      return route.fulfill({
        status: 202,
        headers: { "access-control-allow-origin": "*" },
        json: { status: "running" },
      });
    },
  );
  await page.goto(`/#project/${project.id}`);
  await expect.poll(() => intervals.length).toBeGreaterThan(0);
  // A pending proxy is rechecked after two seconds. Repeated cuts used to poll it again
  // immediately, while it was still being made.
  expect(Math.min(...intervals)).toBeGreaterThanOrEqual(1500);
});
