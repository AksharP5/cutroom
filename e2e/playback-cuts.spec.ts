import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
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
