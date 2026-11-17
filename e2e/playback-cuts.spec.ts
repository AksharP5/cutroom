import { execFile } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
import { waitForPreview } from "./preview-ready";

// The test owns the compositor capture, which tracing would replace.
test.use({ trace: "off" });

test("native playback cuts stay ordered and paused seeks keep the exact frame", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Playback cuts", width: 640, height: 360, duration: 5 },
      })
    ).json(),
  );
  // Each source frame is eight full-height binary stripes. Read the actual composited picture,
  // including held frames, rather than the native video's readiness or callback times.
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "nullsrc=s=8x1:r=30:d=6,format=gray,geq=lum='255*mod(floor(N/pow(2\\,X))\\,2)',scale=640:360:flags=neighbor,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    "30",
    join(project.path, "numbered.mp4"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#333}video{position:absolute;inset:0;width:100%;height:100%}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="5" data-fps="30">
    <video id="first" src="numbered.mp4" muted data-start="0" data-duration="1.5" data-media-start="3" data-track-index="0"></video>
    <video id="second" src="numbered.mp4" muted data-start="1.5" data-duration="1.5" data-media-start="0" data-track-index="0"></video>
    <video id="third" src="numbered.mp4" muted data-start="3" data-duration="2" data-media-start="2" data-playback-rate="0.5" data-track-index="0"></video>
    </main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  const box = (await page.locator(".edit-picture").boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const pictures: string[] = [];
  session.on("Page.screencastFrame", ({ data, sessionId }) => {
    pictures.push(data);
    void session.send("Page.screencastFrameAck", { sessionId });
  });
  const decode = (
    pictures: string[],
    crop = box,
    width = page.viewportSize()!.width,
  ) =>
    page.evaluate(
      async ({ pictures, box, width }) => {
        const canvas = new OffscreenCanvas(1, 1);
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        const numbers: number[] = [];
        for (const data of pictures) {
          const image = await createImageBitmap(
            new Blob([
              Uint8Array.from(atob(data), (char) => char.charCodeAt(0)),
            ]),
          );
          canvas.width = image.width;
          canvas.height = image.height;
          context.drawImage(image, 0, 0);
          const scale = image.width / width;
          let number = 0;
          for (let bit = 0; bit < 8; bit++) {
            const [red] = context.getImageData(
              Math.floor((box.x + ((bit + 0.5) * box.width) / 8) * scale),
              Math.floor((box.y + box.height / 2) * scale),
              1,
              1,
            ).data;
            if (red! > 128) number |= 1 << bit;
          }
          numbers.push(number);
          image.close();
        }
        return numbers;
      },
      { pictures, box: crop, width },
    );
  try {
    await session.send("Page.startScreencast", {
      format: "png",
      everyNthFrame: 1,
      maxWidth: 860,
      maxHeight: 525,
    });
    await page
      .getByRole("button", { name: "Play forward", exact: true })
      .click();
    await page.waitForTimeout(4200);
    await session.send("Page.stopScreencast");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const frames = await decode(pictures);
    await test.info().attach("Composited source frames", {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    const shots = frames.map((frame) => {
      if (frame >= 90 && frame < 135) return 0;
      if (frame >= 0 && frame < 45) return 1;
      if (frame >= 60 && frame < 90) return 2;
      throw new Error(`Playback showed unexpected source frame ${frame}.`);
    });
    expect(
      shots.filter((shot, index) => index === 0 || shot !== shots[index - 1]),
    ).toEqual([0, 1, 2]);
    for (let index = 1; index < frames.length; index++)
      if (shots[index] === shots[index - 1])
        expect(frames[index]!).toBeGreaterThanOrEqual(frames[index - 1]!);

    // A playing visibility lead must never move a paused boundary or a half-speed source frame.
    for (const [time, expected] of [
      ["0129", 14],
      ["0115", 0],
      ["0300", 60],
      ["0400", 75],
    ] as const) {
      await page.getByRole("button", { name: /^Current time/ }).click();
      await page.getByLabel("Go to time").pressSequentially(time);
      await page.keyboard.press("Enter");
      await expect
        .poll(async () => {
          const picture = page.locator(".edit-picture");
          const bounds = (await picture.boundingBox())!;
          return (
            await decode(
              [(await picture.screenshot()).toString("base64")],
              { x: 0, y: 0, width: bounds.width, height: bounds.height },
              bounds.width,
            )
          )[0];
        })
        .toBe(expected);
    }
  } finally {
    await session.detach();
  }
});

test("native cut compensation preserves title timing and scene animation until its end", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Cut title timing",
          width: 640,
          height: 360,
          duration: 3,
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
    "nullsrc=s=8x1:r=30:d=3,format=gray,geq=lum='255*mod(floor(N/pow(2\\,X))\\,2)',scale=640:360:flags=neighbor,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    join(project.path, "shot.mp4"),
  ]);
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    join(project.path, "sound.wav"),
  ]);
  await copyFile(
    join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
    join(project.path, "gsap.min.js"),
  );
  await writeFile(
    join(project.path, "title.html"),
    `<template><main data-composition-id="title" data-width="640" data-height="360" data-duration="1"><div id="graphic" style="position:absolute;left:0;top:140px;width:100px;height:60px;background:lime"></div></main><script>{const tl=gsap.timeline({paused:true});tl.to('#graphic',{x:400,duration:1,ease:'none'},0);window.__timelines.title=tl;}</script></template>`,
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><script src="gsap.min.js"></script><style>html,body{margin:0;background:black}video{position:absolute;inset:0;width:100%;height:100%}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="3" data-fps="30">
  <video id="first" class="clip" src="shot.mp4" muted data-start="0" data-duration="3" data-track-index="0"></video>
  <audio id="sound" class="clip" src="sound.wav" data-start="0" data-duration="3" data-track-index="3"></audio>
  <div id="static" data-start="1" data-duration="1" data-track-index="1" style="position:absolute;left:0;top:60px;width:100px;height:40px;background:magenta"></div>
  <div id="host" data-composition-id="title" data-composition-src="title.html" data-start="1" data-duration="1" data-width="640" data-height="360" data-track-index="2" style="position:absolute;inset:0"></div>
  <canvas id="clock" width="640" height="20" style="position:absolute;left:0;top:0;z-index:100"></canvas>
  </main><script>const c=document.getElementById('clock').getContext('2d');function clock(){const n=Math.floor((window.__player?.getTime()??0)*1000);for(let i=0;i<12;i++){c.fillStyle=n&(1<<i)?'white':'black';c.fillRect(i*640/12,0,640/12,20)}requestAnimationFrame(clock)}requestAnimationFrame(clock);</script></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  const box = (await page.locator(".edit-picture").boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const pictures: string[] = [];
  session.on("Page.screencastFrame", ({ data, sessionId }) => {
    pictures.push(data);
    void session.send("Page.screencastFrameAck", { sessionId });
  });
  try {
    await session.send("Page.startScreencast", {
      format: "png",
      everyNthFrame: 1,
    });
    await page
      .getByRole("button", { name: "Play forward", exact: true })
      .click();
    await page.waitForTimeout(2300);
    await session.send("Page.stopScreencast");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const frames = await page.evaluate(
      async ({ pictures, box, width }) => {
        const canvas = new OffscreenCanvas(1, 1);
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        const frames: { time: number; static: boolean; x: number | null }[] =
          [];
        for (const data of pictures) {
          const image = await createImageBitmap(
            new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))]),
          );
          canvas.width = image.width;
          canvas.height = image.height;
          context.drawImage(image, 0, 0);
          image.close();
          const scale = canvas.width / width;
          const pixel = (x: number, y: number) =>
            context.getImageData(
              Math.floor((box.x + (x * box.width) / 640) * scale),
              Math.floor((box.y + (y * box.height) / 360) * scale),
              1,
              1,
            ).data;
          let time = 0;
          for (let bit = 0; bit < 12; bit++)
            if (pixel(((bit + 0.5) * 640) / 12, 10)[0]! > 128) time |= 1 << bit;
          const staticPixel = pixel(30, 80);
          let x: number | null = null;
          for (let i = 0; i < 640; i += 2) {
            const p = pixel(i, 160);
            if (p[1]! > 180 && p[0]! < 70 && p[2]! < 70) {
              x = i;
              break;
            }
          }
          frames.push({
            time: time / 1000,
            static:
              staticPixel[0]! > 180 &&
              staticPixel[1]! < 70 &&
              staticPixel[2]! > 180,
            x,
          });
        }
        return frames;
      },
      { pictures, box, width: page.viewportSize()!.width },
    );
    await test.info().attach("Composited title positions and transport clock", {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    const late = frames.findLastIndex(
      (frame) => frame.time > 1.95 && frame.time < 2,
    );
    await test.info().attach("Last animated title before its end", {
      body: Buffer.from(pictures[late]!, "base64"),
      contentType: "image/png",
    });
    expect(
      frames.filter((frame) => frame.time > 0.9 && frame.time < 1).length,
    ).toBeGreaterThan(0);
    expect(
      frames.filter((frame) => frame.time > 1.95 && frame.time < 2).length,
    ).toBeGreaterThan(0);
    for (const frame of frames) {
      if (frame.time < 1)
        expect(frame.static, `Static title appeared at ${frame.time}`).toBe(
          false,
        );
      if (frame.time > 1.05 && frame.time < 2) {
        expect(frame.static, `Static title disappeared at ${frame.time}`).toBe(
          true,
        );
        expect(
          frame.x,
          `Animated title disappeared at ${frame.time}`,
        ).not.toBeNull();
        expect(
          frame.x!,
          `Animated title reset at ${frame.time}`,
        ).toBeGreaterThan((frame.time - 1) * 400 - 20);
      }
    }
  } finally {
    await session.detach();
  }
});
