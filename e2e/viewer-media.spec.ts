import { startMediaDrag } from "./media-drag";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

// This test owns the compositor screencast; Playwright's trace must not replace it.
test.use({ trace: "off" });

async function openMedia(page: Page, request: APIRequestContext) {
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
    "color=c=red:s=640x360:r=30:d=12",
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
      if (!blank && (color[0]! < 230 || color[1]! > 20 || color[2]! > 20))
        blank = data;
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

test("a delayed first paint keeps the old surface through the first visible handoff frame", async ({
  page,
  request,
}) => {
  const { seek } = await openMedia(page, request);
  await seek("0311");
  const before = await page.locator("iframe[data-live]").getAttribute("src");
  const generation = Number(
    new URL(before!, "http://localhost").searchParams.get("v"),
  );
  const channel = `paint-gate-${Date.now()}`;
  // Stall only the candidate iframe; releasing the gate restores its native frame APIs.
  await page.addInitScript(
    ({ generation, channel }) => {
      if (
        parent === window ||
        Number(new URL(location.href).searchParams.get("v")) <= generation
      )
        return;
      const request = requestAnimationFrame.bind(window);
      const cancel = cancelAnimationFrame.bind(window);
      const waiting = new Map<number, FrameRequestCallback>();
      const resumed = new Map<number, number>();
      let blocked = true;
      window.requestAnimationFrame = (callback) => {
        let handle = 0;
        handle = request((time) => {
          if (blocked) {
            waiting.set(handle, callback);
            parent.postMessage({ channel, blocked: true }, "*");
          } else callback(time);
        });
        return handle;
      };
      window.cancelAnimationFrame = (handle) => {
        waiting.delete(handle);
        cancel(resumed.get(handle) ?? handle);
        resumed.delete(handle);
      };
      const release = (event: MessageEvent<{ channel?: string }>) => {
        if (event.source !== parent || event.data?.channel !== channel) return;
        blocked = false;
        removeEventListener("message", release);
        for (const [handle, callback] of waiting) {
          resumed.set(
            handle,
            request((time) => {
              resumed.delete(handle);
              if (!resumed.size) {
                window.requestAnimationFrame = request;
                window.cancelAnimationFrame = cancel;
              }
              callback(time);
            }),
          );
        }
        waiting.clear();
        if (!resumed.size) {
          window.requestAnimationFrame = request;
          window.cancelAnimationFrame = cancel;
        }
      };
      addEventListener("message", release);
    },
    { generation, channel },
  );
  const sampling = await page.evaluateHandle((channel) => {
    const frames: {
      time: number;
      layers: { generation: number; opacity: number; visible: boolean }[];
    }[] = [];
    let blocked = false;
    const receive = (
      event: MessageEvent<{ channel?: string; blocked?: boolean }>,
    ) => {
      if (event.data?.channel === channel && event.data.blocked) blocked = true;
    };
    addEventListener("message", receive);
    let animation = 0;
    const sample = (time: number) => {
      frames.push({
        time,
        layers: Array.from(
          document.querySelectorAll<HTMLIFrameElement>(".edit-frame"),
        ).map((frame) => ({
          generation: Number(new URL(frame.src).searchParams.get("v")),
          opacity: Number(getComputedStyle(frame).opacity),
          visible: frame.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          }),
        })),
      });
      animation = requestAnimationFrame(sample);
    };
    animation = requestAnimationFrame(sample);
    return {
      get blocked() {
        return blocked;
      },
      stop() {
        cancelAnimationFrame(animation);
        removeEventListener("message", receive);
        return frames;
      },
    };
  }, channel);
  let frames;
  try {
    await page.keyboard.press("e");
    await expect.poll(() => sampling.evaluate((s) => s.blocked)).toBe(true);
    await expect(page.locator("iframe[data-live]")).toHaveAttribute(
      "src",
      before!,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
        ),
    );
    await page.evaluate((channel) => {
      for (const frame of document.querySelectorAll<HTMLIFrameElement>(
        ".edit-frame:not([data-live])",
      ))
        frame.contentWindow!.postMessage({ channel }, "*");
    }, channel);
    await expect(page.locator("iframe[data-live]")).not.toHaveAttribute(
      "src",
      before!,
    );
    await expect(page.locator(".edit-frame")).toHaveCount(1);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  } finally {
    frames = await sampling.evaluate((s) => s.stop());
    await sampling.dispose();
    const path = test.info().outputPath("handoff-frames.json");
    await writeFile(path, JSON.stringify(frames));
    await test.info().attach("handoff animation frames", {
      path,
      contentType: "application/json",
    });
  }
  const firstRevealed = frames.findIndex((frame) =>
    frame.layers.some(
      (layer) =>
        layer.generation > generation && layer.visible && layer.opacity === 1,
    ),
  );
  expect(firstRevealed).toBeGreaterThanOrEqual(0);
  expect(
    frames[firstRevealed]!.layers,
    "The old surface must remain fully visible for the first frame that reveals its replacement",
  ).toContainEqual({ generation, opacity: 1, visible: true });
  expect(
    frames
      .slice(firstRevealed + 1)
      .some(
        (frame) =>
          !frame.layers.some((layer) => layer.generation === generation),
      ),
  ).toBe(true);
  await expect(page.locator(".status-error")).toHaveCount(0);
});

test("razor at fractional-second playheads never blanks the visible picture", async ({
  page,
  request,
}) => {
  const { read, seek } = await openMedia(page, request);
  const capture = await capturePicture(page);
  try {
    for (const [digits, count] of [
      ["0103", 8],
      ["0311", 12],
      ["1117", 16],
    ] as const) {
      await seek(digits);
      await keepPicture(page, capture, `razor ${digits}`, () =>
        page.keyboard.press("e"),
      );
      await expect
        .poll(async () => (await read()).timeline.clips.length)
        .toBe(count);
    }
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
