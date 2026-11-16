import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

test.use({ trace: "off" });

const run = promisify(execFile);
const WIDTH = 640;
const HEIGHT = 360;
/** Each frame's number in sixteen blocks along its top, white for 1. */
const BITS = Array.from(
  { length: 16 },
  (_, bit) =>
    `drawbox=x=${bit * 40}:y=0:w=40:h=36:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
);

/** The number an exported frame of RGBA bytes carries. */
const numberIn = (rgba: Uint8Array) => {
  let frame = 0;
  for (let bit = 0; bit < 16; bit++) {
    const at = (18 * WIDTH + bit * 40 + 20) * 4;
    if (rgba[at]! > 128) frame |= 1 << bit;
  }
  return frame;
};

/** The number the viewer's picture carries. */
async function shownFrame(page: Page) {
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
    let frame = 0;
    for (let bit = 0; bit < 16; bit++) {
      const [red] = context.getImageData(
        Math.floor(((bit + 0.5) * bitmap.width) / 16),
        Math.floor(bitmap.height / 20),
        1,
        1,
      ).data;
      if (red! > 128) frame |= 1 << bit;
    }
    return frame;
  }, png);
}

/**
 * OBS records 60 fps on Matroska's millisecond clock, so frame k starts at round(k * 1000 / 60) ms:
 * frame 1 at 17 ms, a third of a millisecond after its slot. Export snaps frames back to their
 * slots. The preview stepped one frame at a time used to show the frame before at many of them.
 */
for (const { codec, pipeline } of [
  { codec: "hevc", pipeline: false },
  { codec: "hevc", pipeline: true },
  { codec: "h264", pipeline: false },
] as const)
  test(`a 60 fps ${codec === "hevc" ? "HEVC" : "H.264"} recording on a millisecond clock shows every frame export writes on a 60 fps timeline, with the footage pipeline ${pipeline ? "on" : "off"}`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(150_000);
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: "Frame rounding", width: WIDTH, height: HEIGHT },
        })
      ).json(),
    );
    await run("ffmpeg", [
      ...["-v", "error", "-y", "-f", "lavfi", "-i"],
      `testsrc2=size=${WIDTH}x${HEIGHT}:rate=60:duration=6`,
      "-vf",
      `drawbox=x=0:y=0:w=${WIDTH}:h=36:color=black:t=fill,${BITS.join(",")}`,
      ...(codec === "hevc"
        ? ["-c:v", "libx265", "-preset", "ultrafast"]
        : ["-c:v", "libx264", "-preset", "ultrafast", "-bf", "2"]),
      ...(codec === "hevc" ? ["-x265-params", "log-level=error"] : []),
      join(project.path, "recording.mkv"),
    ]);
    // Half a second from 2 s into the recording: frames 120 to 149.
    const frames = 30;
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><head><style>html,body{margin:0;background:#111111}</style></head><body><main id="main" data-composition-id="main" data-width="${WIDTH}" data-height="${HEIGHT}" data-duration="0.5" data-fps="60">
<video id="recording" src="recording.mkv" muted data-start="0" data-duration="0.5" data-media-start="2" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video>
</main></body></html>`,
    );
    await page.addInitScript((on) => {
      if (window === window.top)
        localStorage.setItem("cutroom.footagePipeline", String(on));
    }, pipeline);
    await page.goto(`/#project/${project.id}`);
    const stage = page.locator(".edit-stage");
    await expect(stage).toHaveAttribute("data-preview-ready");
    await expect(page.locator(".edit-preparing")).toBeHidden({
      timeout: 60_000,
    });
    if (pipeline)
      await expect(stage).toHaveAttribute("data-pipeline", "on", {
        timeout: 60_000,
      });

    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export", exact: true });
    const started = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/render"),
    );
    await dialog
      .getByRole("button", { name: "Export MP4", exact: true })
      .click();
    const { jobId } = z
      .object({ jobId: z.string() })
      .parse(await (await started).json());
    await expect(dialog).toContainText("Export complete.", { timeout: 60_000 });
    const path = testInfo.outputPath("export.mp4");
    await writeFile(
      path,
      await (await request.get(`/api/render/${jobId}/download`)).body(),
    );
    const { stdout } = await run(
      "ffmpeg",
      [
        ...["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba"],
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 1 << 30 },
    );
    const size = WIDTH * HEIGHT * 4;
    const exported = Array.from({ length: stdout.length / size }, (_, frame) =>
      numberIn(stdout.subarray(frame * size)),
    );
    expect(exported).toHaveLength(frames);
    expect(exported[0]).toBe(120);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // A step of one frame at 60 fps moves less than the 20 ms HyperFrames' runtime leaves a
    // paused video where it is, so this also shows each step reaches its own frame.
    await page.getByRole("application", { name: "Picture" }).focus();
    await page.keyboard.press("Home");
    const shown: number[] = [];
    for (let frame = 0; frame < frames; frame++) {
      if (frame) await page.keyboard.press("ArrowRight");
      if (pipeline)
        await expect(page.locator(".edit-pipeline")).toHaveAttribute(
          "data-frame",
          String(frame),
        );
      await expect(stage).toHaveAttribute("data-preview-ready");
      await expect.poll(() => shownFrame(page)).toBe(exported[frame]);
      shown.push(await shownFrame(page));
    }
    expect(shown).toEqual(exported);
    await expect(page.getByText("did not draw")).toHaveCount(0);
  });
