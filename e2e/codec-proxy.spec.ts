import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

test.use({ trace: "off" });

/** The number a frame carries in eight blocks along its top, white for 1, read off the viewer. */
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
    for (let bit = 0; bit < 8; bit++) {
      const [red] = context.getImageData(
        Math.floor(((bit + 0.5) * bitmap.width) / 8),
        Math.floor(bitmap.height / 20),
        1,
        1,
      ).data;
      if (red! > 128) frame |= 1 << bit;
    }
    return frame;
  }, png);
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
      await page
        .getByRole("button", { name: "Current time. Click to type a time." })
        .click();
      const time = page.getByRole("textbox", { name: "Go to time" });
      await time.pressSequentially(
        String(Math.floor(frame / 30) * 100 + (frame % 30)).padStart(8, "0"),
      );
      await time.press("Enter");
      if (pipeline) {
        const canvas = page.locator(".edit-pipeline");
        await expect(canvas).toHaveAttribute("data-frame", String(frame));
        await expect(canvas).toHaveAttribute("data-standin", "false");
      }
      await expect(stage).toHaveAttribute("data-preview-ready");
      await expect.poll(() => shownFrame(page)).toBe(frame);
    }
  });
