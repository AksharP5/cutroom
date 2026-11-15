import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";

/** A four-second colour clip with a tone. */
const media = (path: string, color: string, hz: number) =>
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=320x240:r=30:d=4`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${hz}:sample_rate=48000:d=4`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    path,
  ]);

/** The viewer's centre pixel, from a screenshot of the picture. */
async function centre(page: Page) {
  const png = await page.locator("iframe[data-live]").screenshot();
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return [
      ...context
        .getImageData(image.width >> 1, image.height >> 1, 1, 1)
        .data.slice(0, 3),
    ];
  }, png.toString("base64"));
}

test("Ctrl+T adds a cross dissolve the viewer mixes; its end drags its length; Delete removes it and undo brings it back", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Dissolve", width: 320, height: 240, duration: 4 },
      })
    ).json(),
  );
  media(join(project.path, "red.mp4"), "red", 440);
  media(join(project.path, "blue.mp4"), "blue", 660);
  // Each shot starts a second into its file, so both have a second of media past the cut at 60.
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#000}video{position:absolute;inset:0;width:320px;height:240px}</style></head><body><main data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="4" style="position:relative;width:320px;height:240px">
<video id="a" muted src="red.mp4" data-start="0" data-duration="2" data-media-start="1" data-track-index="0" data-link="la"></video>
<video id="b" muted src="blue.mp4" data-start="2" data-duration="2" data-media-start="1" data-track-index="0" data-link="lb"></video>
<audio id="sa" src="red.mp4" data-start="0" data-duration="2" data-media-start="1" data-track-index="1" data-link="la"></audio>
<audio id="sb" src="blue.mp4" data-start="2" data-duration="2" data-media-start="1" data-track-index="1" data-link="lb"></audio>
</main></body></html>`,
  );
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline.clips.find((clip) => clip.id === "b")!.transitionIn;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".tl-lanes [data-clip]")).toHaveCount(4);
  await seekFrame(page, 66);

  await page.keyboard.press("Control+t");
  // The cut and its linked sound each show the transition.
  await expect(page.locator("[data-transition]")).toHaveCount(2);
  // Wide enough, a transition prints its length.
  const length = page.locator('[data-transition-length="b"]');
  await expect(length).toHaveText("1:00");
  await expect(length.locator("span")).toBeVisible();
  await expect.poll(read).toEqual({
    kind: "dissolve",
    duration: 30,
    alignment: "center",
  });

  // Halfway through, the viewer shows half of each shot.
  await seekFrame(page, 60);
  await expect
    .poll(async () => {
      const [r = 0, , b = 0] = await centre(page);
      return Math.abs(r - 128) <= 16 && Math.abs(b - 128) <= 16;
    })
    .toBe(true);
  await seekFrame(page, 44);
  await expect.poll(async () => (await centre(page))[2]).toBeLessThan(16);

  // Dragging the right end twice as far from the cut doubles the length, as one step.
  const mark = page.locator('[data-transition="b"]');
  const box = (await mark.boundingBox())!;
  const cut = box.x + box.width / 2;
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(cut + box.width, box.y + box.height / 2, {
    steps: 5,
  });
  // The printed length steps aside while the drag changes it.
  await expect(length).toBeHidden();
  await page.mouse.up();
  await expect.poll(async () => (await read())?.duration).toBe(60);
  await expect(length).toHaveText("2:00");
  await expect(mark).toHaveClass(/selected/);

  // Selected, it shows in the inspector, and Delete removes it from both cuts.
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByText("Cross dissolve").first()).toBeVisible();
  await mark.click();
  await page.keyboard.press("Delete");
  await expect(page.locator("[data-transition]")).toHaveCount(0);
  await expect.poll(read).toBeNull();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read())?.duration).toBe(60);
  await expect(page.locator("[data-transition]")).toHaveCount(2);
});
