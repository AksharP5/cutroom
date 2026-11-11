import { startMediaDrag } from "./media-drag";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

declare global {
  interface Window {
    recordViewerFrame(type: "opened" | "closed"): Promise<void>;
    viewerResources: {
      maxDocuments: number;
      reports: number;
    };
  }
}

// This test owns the compositor screencast; Playwright's trace must not replace it.
test.use({ trace: "off" });

async function openMedia(
  page: Page,
  request: APIRequestContext,
  appearance?: { pattern: boolean; style: string },
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Razor picture", width: 640, height: 360, duration: 12 },
      })
    ).json(),
  );
  const exec = promisify(execFile);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    appearance?.pattern
      ? "testsrc2=s=640x360:r=30:d=12"
      : "color=c=red:s=640x360:r=30:d=12",
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
    join(project.path, "Picture.mp4"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=orange:s=100x60",
    "-frames:v",
    "1",
    join(project.path, "Still.png"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=12",
    join(project.path, "Music.wav"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>
    body{margin:0;background:#101010}main{position:relative;width:640px;height:360px}
    video{position:absolute;inset:0;width:100%;height:100%}img{position:absolute;right:12px;top:12px;width:100px;height:60px}
    ${appearance?.style ?? ""}
    </style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-duration="12" data-fps="30">
    <video id="picture" data-start="0" data-duration="12" data-track-index="0" muted data-link="sound" src="Picture.mp4"></video>
    <audio id="sound" data-start="0" data-duration="12" data-track-index="2" data-link="sound" src="Picture.mp4"></audio>
    <img id="still" class="clip" data-start="0" data-duration="12" data-track-index="1" src="Still.png">
    <audio id="music" data-start="0" data-duration="12" data-track-index="3" src="Music.wav"></audio>
    </main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  const seek = async (digits: string) => {
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page.getByLabel("Go to time").pressSequentially(digits);
    await page.keyboard.press("Enter");
    // Finish this setup seek before measuring the edit's handoff.
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const frame =
            document.querySelector<HTMLIFrameElement>("iframe[data-live]")!;
          const id = crypto.randomUUID();
          const receive = (event: MessageEvent<unknown>) => {
            if (
              event.source !== frame.contentWindow ||
              !event.data ||
              typeof event.data !== "object" ||
              !("id" in event.data) ||
              event.data.id !== id
            )
              return;
            removeEventListener("message", receive);
            if ("error" in event.data && event.data.error)
              reject(new Error(String(event.data.error)));
            else resolve();
          };
          addEventListener("message", receive);
          frame.contentWindow!.postMessage(
            { source: "cutroom-viewer", action: "paint", id },
            "*",
          );
        }),
    );
  };
  return { project, read, seek };
}

/** Decode every compositor screencast frame in the page, including opaque iframes. */
async function capturePicture(page: Page) {
  const session = await page.context().newCDPSession(page);
  const box = (await page.locator(".edit-picture").boundingBox())!;
  const samples: { time: number; color: number[] }[] = [];
  let blank: string | null = null;
  let since = 0;
  let decoding = Promise.resolve();
  await page.evaluate(() => {
    const marker = document.createElement("div");
    marker.id = "frame-sampler-pulse";
    marker.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;pointer-events:none;z-index:2147483647";
    document.body.append(marker);
    let beat = 0;
    const pulse = () => {
      if (!marker.isConnected) return;
      marker.style.background = ++beat % 2 ? "black" : "white";
      requestAnimationFrame(pulse);
    };
    pulse();
  });
  session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    void session.send("Page.screencastFrameAck", { sessionId });
    decoding = decoding.then(async () => {
      const color = await page.evaluate(
        async ({ data, box }) => {
          const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          const image = await createImageBitmap(
            new Blob([bytes], { type: "image/png" }),
          );
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d", {
            willReadFrequently: true,
          })!;
          context.drawImage(
            image,
            ((box.x + box.width / 2) * image.width) / innerWidth,
            ((box.y + box.height / 2) * image.height) / innerHeight,
            1,
            1,
            0,
            0,
            1,
            1,
          );
          image.close();
          return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
        },
        { data, box },
      );
      if (metadata.timestamp! < since) return;
      samples.push({ time: metadata.timestamp!, color });
      if (!blank && (color[0]! < 230 || color[1]! > 20 || color[2]! > 20)) {
        blank = data;
        const contexts = await Promise.all(
          page
            .frames()
            .filter((frame) => frame !== page.mainFrame())
            .map((frame) =>
              frame
                .evaluate(() => ({
                  url: location.href,
                  holds: Array.from(
                    document.querySelectorAll<HTMLCanvasElement>(
                      "canvas[data-cutroom-video-hold]",
                    ),
                    (canvas) => {
                      const context = canvas.getContext("2d")!;
                      return {
                        lost: context.isContextLost(),
                        color: Array.from(
                          context.getImageData(
                            canvas.width / 2,
                            canvas.height / 2,
                            1,
                            1,
                          ).data,
                        ),
                      };
                    },
                  ),
                }))
                .catch((error: unknown) => ({
                  url: frame.url(),
                  error: String(error),
                })),
            ),
        );
        console.log("BLANK CONTEXTS", JSON.stringify(contexts));
      }
    });
  });
  await session.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
    maxWidth: 860,
    maxHeight: 525,
  });
  await expect.poll(() => samples.at(-1)?.color[0]).toBeGreaterThan(230);
  return {
    reset() {
      since = Date.now() / 1000;
      samples.length = 0;
      blank = null;
    },
    async read() {
      const count = samples.length;
      await expect.poll(() => samples.length).toBeGreaterThan(count + 1);
      await decoding;
      return { samples: [...samples], blank };
    },
    async stop() {
      await session.send("Page.stopScreencast");
      await decoding;
      await page
        .locator("#frame-sampler-pulse")
        .evaluate((marker) => marker.remove());
      await session.detach();
    },
  };
}

async function keepPicture(
  page: Page,
  capture: Awaited<ReturnType<typeof capturePicture>>,
  label: string,
  change: () => Promise<unknown>,
) {
  const before = await page.locator("iframe[data-live]").getAttribute("src");
  capture.reset();
  let result;
  try {
    await change();
    await expect(page.locator("iframe[data-live]")).not.toHaveAttribute(
      "src",
      before!,
    );
    await expect(page.locator(".edit-frame")).toHaveCount(1);
  } finally {
    result = await capture.read();
    const frames = test.info().outputPath(`${label}-frames.json`);
    await writeFile(frames, JSON.stringify(result.samples));
    await test.info().attach(`${label} frames`, {
      path: frames,
      contentType: "application/json",
    });
    if (result.blank) {
      const blank = test.info().outputPath(`${label}-blank.png`);
      await writeFile(blank, Buffer.from(result.blank, "base64"));
      await test
        .info()
        .attach(`${label} blank`, { path: blank, contentType: "image/png" });
    }
  }
  const { samples } = result;
  console.log(
    "FRAME SAMPLES",
    JSON.stringify({
      label,
      count: samples.length,
      bad: samples.filter(
        ({ color: [r, g, b] }) => r! < 230 || g! > 20 || b! > 20,
      ),
    }),
  );
  expect(samples.length).toBeGreaterThan(1);
  expect
    .soft(
      samples.filter(
        ({ color: [red, green, blue] }) =>
          red! < 230 || green! > 20 || blue! > 20,
      ),
      "Every animation frame must show the old or new red video, never the blank background",
    )
    .toEqual([]);
  await expect(page.locator(".status-error")).toHaveCount(0);
}

test("the composited sampler catches a one-animation-frame blank", async ({
  page,
}) => {
  await page.route("**/frame-sampler", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div class="edit-picture" style="position:fixed;inset:0;background:red"></div>',
    }),
  );
  await page.goto("/frame-sampler");
  const capture = await capturePicture(page);
  capture.reset();
  try {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            const picture =
              document.querySelector<HTMLElement>(".edit-picture")!;
            picture.style.background = "#0a0a0a";
            requestAnimationFrame(() => {
              picture.style.background = "red";
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              );
            });
          });
        }),
    );
    const { samples } = await capture.read();
    expect(
      samples.some(
        ({ color: [red, green, blue] }) =>
          red! < 20 && green! < 20 && blue! < 20,
      ),
    ).toBe(true);
  } finally {
    await capture.stop();
  }
});

async function gatePaint(page: Page, phase: "loading" | "promotion") {
  const before = await page.locator("iframe[data-live]").getAttribute("src");
  const channel = `paint-gate-${Date.now()}`;
  await page.addInitScript(
    ({ channel, phase }) => {
      if (parent === window) return;
      const request = requestAnimationFrame.bind(window);
      const cancel = cancelAnimationFrame.bind(window);
      const waiting = new Map<number, FrameRequestCallback>();
      let blocked = phase === "loading";
      window.requestAnimationFrame = (callback) => {
        const handle = request((time) => {
          if (blocked) waiting.set(handle, callback);
          else callback(time);
        });
        return handle;
      };
      window.cancelAnimationFrame = (handle) => {
        waiting.delete(handle);
        cancel(handle);
      };
      addEventListener("message", (event) => {
        if (event.source !== parent || event.data?.channel !== channel) return;
        blocked = event.data.blocked;
        parent.postMessage({ channel, blocked }, "*");
        if (blocked) return;
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
        for (const callback of waiting.values()) request(callback);
        waiting.clear();
      });
    },
    { channel, phase },
  );
  const gate = await page.evaluateHandle(
    ({ channel, phase, before }) => {
      let blocked = false;
      const promoted = new WeakSet<HTMLIFrameElement>();
      const observer = new MutationObserver(() => {
        for (const frame of document.querySelectorAll<HTMLIFrameElement>(
          "iframe[data-live]",
        )) {
          if (frame.getAttribute("src") === before || promoted.has(frame))
            continue;
          promoted.add(frame);
          // Observe the reveal itself. This also runs on the original implementation,
          // which never sent a post-promotion paint request.
          frame.contentWindow!.postMessage({ channel, blocked: true }, "*");
        }
      });
      if (phase === "promotion")
        observer.observe(document.body, {
          subtree: true,
          attributes: true,
          attributeFilter: ["data-live"],
        });
      const receive = (event: MessageEvent) => {
        if (event.data?.channel === channel) blocked = event.data.blocked;
      };
      addEventListener("message", receive);
      return {
        get blocked() {
          return blocked;
        },
        release() {
          observer.disconnect();
          removeEventListener("message", receive);
          for (const frame of document.querySelectorAll<HTMLIFrameElement>(
            ".edit-frame",
          ))
            frame.contentWindow!.postMessage({ channel, blocked: false }, "*");
        },
      };
    },
    { channel, phase, before },
  );
  return { before, gate };
}

for (const phase of ["loading", "promotion"] as const) {
  test(`a delayed ${phase} paint retains the previous picture`, async ({
    page,
    request,
  }) => {
    const { seek } = await openMedia(page, request);
    await seek("0311");
    const { before, gate } = await gatePaint(page, phase);
    const capture = await capturePicture(page);
    capture.reset();
    try {
      await page.keyboard.press("e");
      if (phase === "promotion")
        await expect
          .poll(() => gate.evaluate((gate) => gate.blocked))
          .toBe(true);
      else await expect(page.locator(".edit-frame")).toHaveCount(2);
      // Let the parent run well past its old two-animation-frame retirement.
      await page.evaluate(async () => {
        for (let i = 0; i < 6; i++)
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
      });
      const result = await capture.read();
      expect
        .soft(
          result.samples.filter(
            ({ color: [r, g, b] }) => r! < 230 || g! > 20 || b! > 20,
          ),
          "The composited picture stays red while the candidate cannot paint",
        )
        .toEqual([]);
      await expect(
        page.locator(".edit-frame"),
        "Retain the confirmed iframe until a visible paint is acknowledged",
      ).toHaveCount(2);
      await expect(page.locator(`iframe[src="${before}"]`)).toBeVisible();
      await gate.evaluate((gate) => gate.release());
      await expect(page.locator(".edit-frame")).toHaveCount(1);
      await expect(page.locator("iframe[data-live]")).not.toHaveAttribute(
        "src",
        before!,
      );
      await expect(page.locator(".status-error")).toHaveCount(0);
    } finally {
      await gate.evaluate((gate) => gate.release());
      await gate.dispose();
      await capture.stop();
    }
  });
}

test("razor at fractional-second playheads never blanks the visible picture", async ({
  page,
  request,
}) => {
  const { read, seek } = await openMedia(page, request);
  const capture = await capturePicture(page);
  try {
    for (const [digits, count] of [
      ["0103", 8],
      ["0207", 12],
      ["0311", 16],
      ["0419", 20],
      ["0513", 24],
      ["0617", 28],
      ["0719", 32],
      ["0811", 36],
      ["0923", 40],
      ["1017", 44],
      ["1117", 48],
    ] as const) {
      await keepPicture(page, capture, `razor ${digits}`, async () => {
        await seek(digits);
        await page.keyboard.press("e");
      });
      await expect
        .poll(async () => (await read()).timeline.clips.length)
        .toBe(count);
    }
  } finally {
    await capture.stop();
  }
});

test("the held picture survives native snapshot loss and retirement", async ({
  page,
  request,
}) => {
  const { seek } = await openMedia(page, request);
  await seek("0311");
  const loseNativeSnapshot = () => {
    if (parent === window) return;
    // Chromium can report a decoded video yet paint no pixels through its native
    // element. Model that browser boundary; the decoded VideoFrame remains usable.
    CanvasRenderingContext2D.prototype.drawImage = new Proxy(
      CanvasRenderingContext2D.prototype.drawImage,
      {
        apply(draw, context: CanvasRenderingContext2D, args: unknown[]) {
          if (
            args[0] instanceof HTMLVideoElement &&
            context.canvas.hasAttribute("data-cutroom-video-hold")
          )
            return;
          return Reflect.apply(draw, context, args);
        },
      },
    );
    let attempts = 0;
    Object.defineProperty(window, "decodedFrameAttempts", {
      get: () => attempts,
    });
    window.VideoFrame = new Proxy(VideoFrame, {
      construct(Frame, args: unknown[], target) {
        if (args[0] instanceof HTMLVideoElement && ++attempts <= 3)
          throw new DOMException("No decoded frame yet", "InvalidStateError");
        return Reflect.construct(Frame, args, target);
      },
    });
  };
  await page.addInitScript(loseNativeSnapshot);
  await page
    .frameLocator("iframe[data-live]")
    .locator("body")
    .evaluate(loseNativeSnapshot);
  const capture = await capturePicture(page);
  try {
    await keepPicture(page, capture, "unavailable native snapshot", () =>
      page.keyboard.press("e"),
    );
    expect(
      await page
        .frameLocator("iframe[data-live]")
        .locator("body")
        .evaluate(() => Reflect.get(window, "decodedFrameAttempts")),
    ).toBeGreaterThanOrEqual(4);
    capture.reset();
    await page
      .frameLocator("iframe[data-live]")
      .locator("body")
      .evaluate(() => {
        // The compositor may still show this document after its native video retires.
        document
          .querySelector<HTMLVideoElement>("video[data-cutroom-held]")!
          .style.setProperty("visibility", "hidden", "important");
        dispatchEvent(new PageTransitionEvent("pagehide"));
      });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
        ),
    );
    const { samples } = await capture.read();
    expect(
      samples.every(({ color: [r, g, b] }) => r! > 230 && g! < 20 && b! < 20),
    ).toBe(true);
  } finally {
    await capture.stop();
  }
});

test("MCP split, undo, redo, ripple deletion and a media drop keep the picture", async ({
  page,
  request,
  baseURL,
}) => {
  const { project, read, seek } = await openMedia(page, request);
  const client = new Client({ name: "viewer-media-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: new URL(baseURL!).origin } },
    }),
  );
  const capture = await capturePicture(page);
  try {
    await seek("0311");
    const { revision } = await read();
    await keepPicture(page, capture, "MCP split", async () => {
      const result = await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: revision,
          label: "Split picture",
          commands: [{ type: "split", at: 101, clipIds: ["picture"] }],
        },
      });
      expect(result.isError).not.toBe(true);
    });
    await keepPicture(page, capture, "undo", () =>
      page.keyboard.press("Control+z"),
    );
    await keepPicture(page, capture, "redo", () =>
      page.keyboard.press("Control+Shift+z"),
    );
    await page.locator('[data-clip="picture"]').click();
    await keepPicture(page, capture, "ripple delete", () =>
      page.keyboard.press("Shift+X"),
    );

    // Cutroom has no paste command yet. Insert a copy through the shared media
    // command to cover the new-element path a paste would use.
    await seek("0311");
    const current = await read();
    await keepPicture(page, capture, "MCP overwrite insert", async () => {
      const result = await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: current.revision,
          label: "Insert copied picture",
          commands: [
            {
              type: "insert",
              mode: "overwrite",
              track: 0,
              at: 101,
              clip: { kind: "video", src: "Picture.mp4", duration: 30 },
            },
          ],
        },
      });
      expect(result.isError).not.toBe(true);
    });

    // Drop at the playhead on V1, replacing the piece there with a fresh video element.
    const picture = (await read()).timeline.clips.find(
      (clip) => clip.kind === "video",
    )!;
    const clip = page.locator(`[data-clip="${picture.id}"]`);
    const row = page
      .getByRole("region", { name: "Media", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "Picture.mp4" });
    await keepPicture(page, capture, "media drop", async () => {
      await startMediaDrag(page, row);
      const bounds = (await clip.boundingBox())!;
      const playhead = (await page
        .locator(".tl-playhead")
        .first()
        .boundingBox())!;
      await page.mouse.move(playhead.x, bounds.y + bounds.height / 2, {
        steps: 12,
      });
      await page.mouse.move(playhead.x, bounds.y + bounds.height / 2);
      await expect(page.locator(".tl-ghost")).toBeVisible();
      await page.mouse.up();
    });
  } finally {
    await capture.stop();
    await client.close();
  }
});

async function pictureDifference(page: Page, held: Buffer, native: Buffer) {
  return page.evaluate(
    async ({ held, native }) => {
      const pixels = async (data: string) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(
          new Blob([bytes], { type: "image/png" }),
        );
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        image.close();
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const a = await pixels(held);
      const b = await pixels(native);
      let total = 0;
      let max = 0;
      let above3 = 0;
      for (let i = 0; i < a.length; i += 4) {
        let pixelMax = 0;
        for (let channel = 0; channel < 3; channel++) {
          const delta = Math.abs(a[i + channel]! - b[i + channel]!);
          total += delta;
          max = Math.max(max, delta);
          pixelMax = Math.max(pixelMax, delta);
        }
        if (pixelMax > 3) above3++;
      }
      return {
        mean: total / ((a.length / 4) * 3),
        max,
        fractionAbove3: above3 / (a.length / 4),
      };
    },
    { held: held.toString("base64"), native: native.toString("base64") },
  );
}

test("paused holds match native object-fit, transforms, opacity and stacking, then release for playback", async ({
  page,
  request,
}, testInfo) => {
  const { seek } = await openMedia(page, request, {
    pattern: true,
    style: `video{inset:auto;left:71px;top:49px;width:430px;height:240px;
      object-position:23% 71%;transform:rotate(7deg) scale(.91);transform-origin:31% 64%;
      opacity:.63;border:3px solid #74abcf;border-radius:13px}
      main{opacity:.87;transform:translate(3px,2px)}img{z-index:1;right:100px;top:100px}`,
  });
  await seek("0103");
  const live = page.frameLocator("iframe[data-live]");
  const bounds = {
    fill: { mean: 0.25, max: 65, fractionAbove3: 0.0327 },
    contain: { mean: 0.655, max: 131, fractionAbove3: 0.0435 },
    cover: { mean: 0.212, max: 55, fractionAbove3: 0.0285 },
    none: { mean: 0.15, max: 36, fractionAbove3: 0.0197 },
    "scale-down": { mean: 0.655, max: 131, fractionAbove3: 0.0435 },
  };
  for (const fit of [
    "fill",
    "contain",
    "cover",
    "none",
    "scale-down",
  ] as const) {
    await live.locator("video").evaluate((video, fit) => {
      video.style.objectFit = fit;
    }, fit);
    await seek("0103");
    await expect(live.locator("[data-cutroom-video-hold]")).toHaveCount(1);
    const geometry = await live.locator("video").evaluate((video) => {
      const canvas = video.nextElementSibling as HTMLCanvasElement;
      const display = canvas.style.display;
      canvas.style.display = "none";
      video.removeAttribute("data-cutroom-held");
      const properties = [
        "width",
        "height",
        "object-fit",
        "object-position",
        "transform",
        "transform-origin",
        "translate",
        "rotate",
        "scale",
        "opacity",
        "z-index",
        "border-radius",
      ];
      const appearance = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return {
          box: { x, y, width, height },
          style: Object.fromEntries(
            properties.map((name) => [
              name,
              getComputedStyle(element).getPropertyValue(name),
            ]),
          ),
        };
      };
      const native = appearance(video);
      video.setAttribute("data-cutroom-held", "");
      canvas.style.display = display;
      return { video: native, canvas: appearance(canvas) };
    });
    expect(geometry.canvas.style).toEqual(geometry.video.style);
    // Computed transform matrices serialize to six decimals in Chromium.
    for (const key of ["x", "y", "width", "height"] as const)
      expect(
        Math.abs(geometry.canvas.box[key] - geometry.video.box[key]),
      ).toBeLessThan(0.0001);
    const held = await page.locator(".edit-picture").screenshot();
    await live.locator("video").evaluate((video) => {
      video.removeAttribute("data-cutroom-held");
      video.nextElementSibling!.setAttribute(
        "style",
        `${video.nextElementSibling!.getAttribute("style")};visibility:hidden!important`,
      );
    });
    const native = await page.locator(".edit-picture").screenshot();
    const difference = await pictureDifference(page, held, native);
    console.log("HOLD PIXELS", fit, JSON.stringify(difference));
    await writeFile(testInfo.outputPath(`${fit}-held.png`), held);
    await writeFile(testInfo.outputPath(`${fit}-native.png`), native);
    await testInfo.attach(`${fit} held`, {
      body: held,
      contentType: "image/png",
    });
    await testInfo.attach(`${fit} native`, {
      body: native,
      contentType: "image/png",
    });
    expect(difference.mean).toBeLessThanOrEqual(bounds[fit].mean);
    expect(difference.max).toBeLessThanOrEqual(bounds[fit].max);
    expect(difference.fractionAbove3).toBeLessThanOrEqual(
      bounds[fit].fractionAbove3,
    );
    await live.locator("video").evaluate((video) => {
      video.setAttribute("data-cutroom-held", "");
      (video.nextElementSibling as HTMLElement).style.visibility = "visible";
    });
    if (fit === "contain") {
      await live
        .locator("[data-cutroom-video-hold]")
        .evaluate((canvas: HTMLCanvasElement) => {
          canvas.style.translate = "2px 0";
        });
      const shifted = await page.locator(".edit-picture").screenshot();
      const shiftDifference = await pictureDifference(page, shifted, native);
      await writeFile(testInfo.outputPath("shifted-hold.png"), shifted);
      await live
        .locator("[data-cutroom-video-hold]")
        .evaluate((canvas: HTMLCanvasElement) => {
          canvas.style.translate = "none";
        });
      await live.locator("video").evaluate(async (video: HTMLVideoElement) => {
        await new Promise<void>((resolve) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
          video.currentTime = 5;
        });
        video.removeAttribute("data-cutroom-held");
        (video.nextElementSibling as HTMLElement).style.visibility = "hidden";
      });
      const wrongFrame = await page.locator(".edit-picture").screenshot();
      const wrongDifference = await pictureDifference(page, held, wrongFrame);
      await writeFile(
        testInfo.outputPath("wrong-native-frame.png"),
        wrongFrame,
      );
      console.log(
        "HOLD NEGATIVE CONTROLS",
        JSON.stringify({
          shifted: shiftDifference,
          wrongFrame: wrongDifference,
        }),
      );
      for (const difference of [shiftDifference, wrongDifference]) {
        expect(difference.mean).toBeGreaterThan(bounds.contain.mean);
      }
      await live.locator("video").evaluate((video) => {
        video.setAttribute("data-cutroom-held", "");
        (video.nextElementSibling as HTMLElement).style.visibility = "visible";
      });
    }
  }
  await seek("0311");
  const before = await page.locator("iframe[data-live]").getAttribute("src");
  await page.keyboard.press("e");
  await expect(page.locator("iframe[data-live]")).not.toHaveAttribute(
    "src",
    before!,
  );
  await expect(page.locator(".edit-frame")).toHaveCount(1);
  const fresh = page.frameLocator("iframe[data-live]");
  await expect(fresh.locator("[data-cutroom-video-hold]")).toHaveCount(1);
  await seek("0200");
  const frame = await page.locator("iframe[data-live]").elementHandle();
  const preview = (await frame!.contentFrame())!;
  const pacing = await preview.evaluateHandle(() => {
    const times: number[] = [];
    const callbacks = new Map<HTMLVideoElement, number>();
    const sample = (video: HTMLVideoElement) => {
      callbacks.set(
        video,
        video.requestVideoFrameCallback((_, metadata) => {
          if (!video.paused) times.push(metadata.expectedDisplayTime);
          sample(video);
        }),
      );
    };
    for (const video of document.querySelectorAll("video")) sample(video);
    return {
      stop() {
        for (const [video, id] of callbacks) video.cancelVideoFrameCallback(id);
        return times.sort((a, b) => a - b);
      },
    };
  });
  await page.keyboard.press("Space");
  await expect(fresh.locator("[data-cutroom-video-hold]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    /00:00:04:/,
  );
  await page.keyboard.press("k");
  const times = await pacing.evaluate((pacing) => pacing.stop());
  await pacing.dispose();
  const gaps = times.slice(1).map((time, i) => time - times[i]!);
  const averageGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  console.log(
    "CUT PLAYBACK",
    JSON.stringify({
      frames: times.length,
      maxGap: Math.max(...gaps),
      averageGap,
    }),
  );
  expect(times.length).toBeGreaterThan(55);
  expect(averageGap).toBeLessThan(40);
  expect(Math.max(...gaps)).toBeLessThan(150);
  await expect(fresh.locator("[data-cutroom-video-hold]")).toHaveCount(1);
  await expect(page.locator(".status-error")).toHaveCount(0);
});

test("the ordinary paused picture is pixel-identical and a timed-out hold keeps it", async ({
  page,
  request,
}) => {
  const { seek } = await openMedia(page, request);
  await seek("0311");
  const live = page.frameLocator("iframe[data-live]");
  const held = await page.locator(".edit-picture").screenshot();
  await live.locator("video").evaluate((video) => {
    video.removeAttribute("data-cutroom-held");
    (video.nextElementSibling as HTMLElement).style.visibility = "hidden";
  });
  const native = await page.locator(".edit-picture").screenshot();
  expect(await pictureDifference(page, held, native)).toEqual({
    mean: 0,
    max: 0,
    fractionAbove3: 0,
  });
  await live.locator("video").evaluate((video) => {
    video.setAttribute("data-cutroom-held", "");
    (video.nextElementSibling as HTMLElement).style.visibility = "visible";
  });
  const before = await page.locator("iframe[data-live]").getAttribute("src");
  const generation = Number(
    new URL(before!, "http://localhost").searchParams.get("v"),
  );
  await page.addInitScript((generation) => {
    if (
      parent === window ||
      Number(new URL(location.href).searchParams.get("v")) <= generation
    )
      return;
    Object.defineProperty(window, "__hfWaitForSeekCompletion", {
      get: () => () => new Promise<void>(() => {}),
      set: () => {},
    });
  }, generation);
  const capture = await capturePicture(page);
  try {
    capture.reset();
    await page.keyboard.press("e");
    await expect(page.locator(".status-error")).toContainText(
      "did not draw the frame in time",
      { timeout: 12_000 },
    );
    await expect(page.locator("iframe[data-live]")).toHaveAttribute(
      "src",
      before!,
    );
    await expect(page.locator(".edit-frame")).toHaveCount(1);
    const { samples } = await capture.read();
    expect(
      samples.every(({ color: [r, g, b] }) => r! > 230 && g! < 20 && b! < 20),
    ).toBe(true);
  } finally {
    await capture.stop();
  }
});

test("a paused hold preserves fractional flex layout and normal-flow stacking", async ({
  page,
  request,
}) => {
  const { seek } = await openMedia(page, request, {
    pattern: true,
    style: `main{display:flex;align-items:center;gap:13px}
      video{position:relative;inset:auto;width:320.5px;height:180.25px;margin:11.25px;transform:translate(3.25px,2.5px);opacity:.5}
      img{z-index:1;left:280px;top:100px}`,
  });
  await seek("0103");
  const live = page.frameLocator("iframe[data-live]");
  const boxes = await live.locator("video").evaluate((video) => {
    const canvas = video.nextElementSibling as HTMLCanvasElement;
    const box = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const held = box(canvas);
    const display = canvas.style.display;
    canvas.style.display = "none";
    video.removeAttribute("data-cutroom-held");
    const native = box(video);
    video.setAttribute("data-cutroom-held", "");
    canvas.style.display = display;
    return { native, held };
  });
  expect(boxes.held).toEqual(boxes.native);
  await expect(page.locator(".status-error")).toHaveCount(0);
});

async function trackViewerResources(page: Page) {
  const frames = { opened: 0, closed: 0 };
  await page.exposeBinding(
    "recordViewerFrame",
    (_, type: "opened" | "closed") => {
      frames[type]++;
    },
  );
  await page.addInitScript(() => {
    if (parent === window) {
      const counts = { maxDocuments: 0, reports: 0 };
      Object.defineProperty(window, "viewerResources", { value: counts });
      addEventListener("DOMContentLoaded", () => {
        let error = "";
        new MutationObserver(() => {
          counts.maxDocuments = Math.max(
            counts.maxDocuments,
            document.querySelectorAll(".edit-frame").length,
          );
          const next =
            document.querySelector(".status-error")?.textContent ?? "";
          if (next && next !== error) counts.reports++;
          error = next;
        }).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });
      return;
    }
    const close = VideoFrame.prototype.close;
    const closed = new WeakSet<VideoFrame>();
    VideoFrame.prototype.close = function () {
      if (!closed.has(this)) {
        closed.add(this);
        void window.recordViewerFrame("closed");
      }
      close.call(this);
    };
    window.VideoFrame = new Proxy(VideoFrame, {
      construct(Frame, args: unknown[], target) {
        const frame: VideoFrame = Reflect.construct(Frame, args, target);
        void window.recordViewerFrame("opened");
        return frame;
      },
    });
  });
  return frames;
}

for (const withheld of [false, true]) {
  test(`50-edit batches bound documents and decoded frames with ${withheld ? "withheld" : "normal"} acknowledgments`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(240_000);
    const frames = await trackViewerResources(page);
    const { project, read, seek } = await openMedia(page, request);
    await seek("0311");
    await expect(page.locator(".edit-frame")).toHaveCount(1);
    const resourceCounts = async () => ({
      ...(await page.evaluate(() => {
        const counts = window.viewerResources;
        return {
          ...counts,
          documents: document.querySelectorAll(".edit-frame").length,
        };
      })),
      ...frames,
    });
    const browser = await page.context().browser()!.newBrowserCDPSession();
    const rss = async () => {
      const { processInfo } = await browser.send("SystemInfo.getProcessInfo");
      const sizes = await Promise.all(
        processInfo.map(async ({ id }) => {
          const status = await readFile(`/proc/${id}/status`, "utf8").catch(
            (error: unknown) => {
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
                return "";
              throw error;
            },
          );
          return Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
        }),
      );
      return sizes.reduce((sum, size) => sum + size, 0) / 1024;
    };
    const renderer = await page.context().newCDPSession(page);
    const memory = async () => {
      const beforeGcMiB = await rss();
      await renderer.send("HeapProfiler.collectGarbage");
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const child = await page.context().newCDPSession(frame);
        await child.send("HeapProfiler.collectGarbage");
        expect((await child.send("Memory.getDOMCounters")).documents).toBe(1);
        await child.detach();
      }
      return { beforeGcMiB, rssMiB: await rss() };
    };
    const { before, gate } = withheld
      ? await gatePaint(page, "promotion")
      : { before: null, gate: null };
    const measurements = [
      { batch: 0, ...(await memory()), ...(await resourceCounts()) },
    ];
    const initial = await page.locator(".edit-picture").screenshot();
    try {
      for (let batch = 1; batch <= 3; batch++) {
        for (let edit = 0; edit < 50; edit++) {
          const previous = await page
            .locator(".edit-frame")
            .last()
            .getAttribute("src");
          const view = await read();
          const result = await request.post(
            `/api/cutroom/projects/${project.id}/commands`,
            {
              data: {
                expectedRevision: view.revision,
                label: "Rename picture",
                commands: [
                  {
                    type: "setClip",
                    clipId: "picture",
                    label: `Picture ${batch}-${edit}`,
                  },
                ],
              },
            },
          );
          expect(result.ok(), await result.text()).toBe(true);
          await expect(page.locator(".edit-frame").last()).not.toHaveAttribute(
            "src",
            previous!,
          );
          // Each candidate must actually allocate a decoded hold before replacement.
          await expect(
            page
              .frameLocator(".edit-frame")
              .last()
              .locator("[data-cutroom-video-hold]"),
          ).toHaveCount(1);
          if (withheld) {
            await expect(page.locator("iframe[data-live]")).not.toHaveAttribute(
              "src",
              before!,
            );
            await expect(page.locator(`iframe[src="${before}"]`)).toBeVisible();
          } else await expect(page.locator(".edit-frame")).toHaveCount(1);
          expect((await resourceCounts()).maxDocuments).toBeLessThanOrEqual(2);
        }
        await expect(page.locator(".edit-frame")).toHaveCount(1);
        if (withheld) {
          await expect(page.locator("iframe[data-live]")).toHaveAttribute(
            "src",
            before!,
          );
          await expect(page.locator(".status-error")).toContainText("in time");
          expect((await resourceCounts()).reports).toBe(1);
        }
        await expect
          .poll(
            async () => {
              const counts = await resourceCounts();
              return counts.opened - counts.closed;
            },
            {
              message:
                "Every retired decoded frame is closed, leaving only the current hold",
            },
          )
          .toBe(1);
        const picture = await page.locator(".edit-picture").screenshot();
        expect(await pictureDifference(page, initial, picture)).toEqual({
          mean: 0,
          max: 0,
          fractionAbove3: 0,
        });

        measurements.push({
          batch,
          ...(await memory()),
          ...(await resourceCounts()),
        });
        console.log(
          "VIEWER BATCH",
          JSON.stringify({ withheld, ...measurements.at(-1) }),
        );
      }
      console.log(
        "VIEWER RESOURCES",
        JSON.stringify({
          withheld,
          measurements,
        }),
      );
      await testInfo.attach("viewer resources", {
        body: JSON.stringify({ withheld, measurements }, null, 2),
        contentType: "application/json",
      });
      if (withheld) {
        const replacement = ProjectSchema.parse(
          await (
            await request.post("/api/cutroom/projects", {
              data: { name: "Replacement project" },
            })
          ).json(),
        );
        const view = await read();
        const edit = await request.post(
          `/api/cutroom/projects/${project.id}/commands`,
          {
            data: {
              expectedRevision: view.revision,
              commands: [
                {
                  type: "setClip",
                  clipId: "picture",
                  label: "Switch while promoting",
                },
              ],
            },
          },
        );
        expect(edit.ok()).toBe(true);
        await expect(page.locator("iframe[data-held]")).toHaveCount(1);
        await gate!.evaluate((gate) => gate.release());
        await page.evaluate((id) => {
          location.hash = `project/${id}`;
        }, replacement.id);
        await expect(page.locator(".edit-frame")).toHaveCount(1);
        await expect(page.locator("iframe[data-live]")).toHaveAttribute(
          "src",
          new RegExp(replacement.id),
        );
        await expect.poll(() => frames.opened - frames.closed).toBe(0);
      }
      await page.evaluate(() => {
        location.hash = "";
      });
      await expect(page.locator(".edit-frame")).toHaveCount(0);
      await expect
        .poll(async () => {
          const counts = await resourceCounts();
          return counts.opened - counts.closed;
        })
        .toBe(0);
      console.log(
        "VIEWER RELEASED",
        JSON.stringify({ withheld, ...(await resourceCounts()) }),
      );
    } finally {
      await gate?.evaluate((gate) => gate.release());
      await gate?.dispose();
      await renderer.detach();
      await browser.detach();
    }
  });
}

test("a navigation that never loads expires and keeps the confirmed picture", async ({
  page,
  request,
}) => {
  const { seek } = await openMedia(page, request);
  await seek("0311");
  const before = await page.locator("iframe[data-live]").getAttribute("src");
  let release = () => {};
  await page.route("**/isolated-preview?*", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.abort();
  });
  const capture = await capturePicture(page);
  capture.reset();
  const started = Date.now();
  try {
    await page.keyboard.press("e");
    await expect(page.locator(".edit-frame")).toHaveCount(2);
    await expect(page.locator(".status-error")).toContainText(
      "did not finish loading",
      { timeout: 17_000 },
    );
    expect(Date.now() - started).toBeLessThan(17_000);
    await expect(page.locator(".edit-frame")).toHaveCount(1);
    await expect(page.locator("iframe[data-live]")).toHaveAttribute(
      "src",
      before!,
    );
    const result = await capture.read();
    expect(
      result.samples.filter(
        ({ color: [r, g, b] }) => r! < 230 || g! > 20 || b! > 20,
      ),
    ).toEqual([]);
  } finally {
    release();
    await capture.stop();
  }
});

test("stalled candidate replacements never expose the viewer background", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const { project, read, seek } = await openMedia(page, request);
  await seek("0311");
  const { before, gate } = await gatePaint(page, "promotion");
  const capture = await capturePicture(page);
  capture.reset();
  try {
    for (let edit = 0; edit < 50; edit++) {
      const previous = await page
        .locator(".edit-frame")
        .last()
        .getAttribute("src");
      const view = await read();
      const response = await request.post(
        `/api/cutroom/projects/${project.id}/commands`,
        {
          data: {
            expectedRevision: view.revision,
            commands: [
              {
                type: "setClip",
                clipId: "picture",
                label: `Stalled replacement ${edit}`,
              },
            ],
          },
        },
      );
      expect(response.ok()).toBe(true);
      await expect(page.locator(".edit-frame").last()).not.toHaveAttribute(
        "src",
        previous!,
      );
      await expect(page.locator("iframe[data-live]")).not.toHaveAttribute(
        "src",
        before!,
      );
      await expect(page.locator(".edit-frame")).toHaveCount(2);
      await expect(page.locator(`iframe[src="${before}"]`)).toBeVisible();
    }
    await expect(page.locator(".edit-frame")).toHaveCount(1);
    await expect(page.locator("iframe[data-live]")).toHaveAttribute(
      "src",
      before!,
    );
    const result = await capture.read();
    const bad = result.samples.filter(
      ({ color: [r, g, b] }) => r! < 230 || g! > 20 || b! > 20,
    );
    console.log(
      "STALLED PICTURE",
      JSON.stringify({ edits: 50, samples: result.samples.length, bad }),
    );
    await testInfo.attach("stalled replacement frames", {
      body: JSON.stringify(result.samples),
      contentType: "application/json",
    });
    expect(result.samples.length).toBeGreaterThan(1);
    expect(bad).toEqual([]);
    await expect(page.locator(".status-error")).toContainText("in time");
  } finally {
    await gate.evaluate((gate) => gate.release());
    await gate.dispose();
    await capture.stop();
  }
});
