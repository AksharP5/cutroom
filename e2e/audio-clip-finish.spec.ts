import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

test("five tracks fit, fade handles spare labels and follow a held roll, and edges trim through gain", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Audio clip finish", duration: 12 },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=16",
    join(project.path, "Dialogue.wav"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="180" data-duration="12" data-fps="30">
    <div id="picture" class="clip" data-start="0" data-duration="12" data-track-index="0">Picture</div>
    <div id="overlay" class="clip" data-start="0" data-duration="4" data-track-index="1">Overlay</div>
    <div id="title" class="clip" data-start="0" data-duration="2" data-track-index="2">Title</div>
    <audio id="dialogue" src="Dialogue.wav" data-start="0" data-duration="6" data-track-index="3" data-fade-in="1" data-fade-out="3"></audio>
    <audio id="next" src="Dialogue.wav" data-start="6" data-duration="6" data-media-start="6" data-track-index="3" data-fade-in="1"></audio>
    <audio id="music" src="Dialogue.wav" data-start="0" data-duration="12" data-track-index="4" data-fade-out="3"></audio>
  </main></body></html>`,
  );
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline;
  await page.goto(`/#project/${project.id}`);
  const body = page.locator('[data-clip="dialogue"]');
  const mix = page.locator('[data-clip-mix="dialogue"]');
  const handle = mix.locator('[data-mix="fadeOut"]');
  await expect(body).toBeVisible();
  await page.mouse.move(100, 300);
  await expect(handle).toBeHidden();
  await body.hover({ position: { x: 30, y: 5 } });
  await expect(handle).toBeVisible();
  await page.mouse.move(100, 300);
  await expect(handle).toBeHidden();
  await body.click({ position: { x: 30, y: 5 } });
  await page.mouse.move(100, 300);
  await expect(handle).toBeVisible();
  const label = (await page
    .locator('[data-clip-label="dialogue"]')
    .boundingBox())!;
  expect((await handle.boundingBox())!.y).toBeGreaterThanOrEqual(
    label.y + label.height,
  );
  const timeline = (await page.locator(".tl-scroll").boundingBox())!;
  const lanes = await page.locator(".tl-lane").evaluateAll((rows) =>
    rows.map((row) => {
      const b = row.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom };
    }),
  );
  expect(lanes).toHaveLength(5);
  expect(lanes[0]!.top).toBeCloseTo(timeline.y + 29, 0);
  expect(lanes.at(-1)!.bottom).toBeLessThan(timeline.y + timeline.height);
  await page.screenshot({ path: info.outputPath("five-tracks.png") });

  // Hold a roll without releasing. Both handles must still sit at their curve's knee.
  await page.keyboard.press("t");
  const initial = await read();
  const next = (await page.locator('[data-clip="next"]').boundingBox())!;
  await page.mouse.move(next.x + 2, next.y + 8);
  await page.mouse.down();
  await page.mouse.move(next.x + 72, next.y + 8, { steps: 8 });
  for (const id of ["dialogue", "next"]) {
    const clip = (await page.locator(`[data-clip="${id}"]`).boundingBox())!;
    const overlay = (await page
      .locator(`[data-clip-mix="${id}"]`)
      .boundingBox())!;
    expect(overlay.x).toBeCloseTo(clip.x, 1);
    expect(overlay.width).toBeCloseTo(clip.width, 1);
    for (const edge of ["fadeIn", "fadeOut"]) {
      const h = (await page
        .locator(`[data-clip-mix="${id}"] [data-mix="${edge}"]`)
        .boundingBox())!;
      expect(h.x).toBeGreaterThanOrEqual(clip.x - 1);
      expect(h.x + h.width).toBeLessThanOrEqual(clip.x + clip.width + 1);
    }
  }
  await page.screenshot({ path: info.outputPath("held-roll.png") });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await read()).toEqual(initial);

  await page.keyboard.press("a");
  // The gain hit stroke extends into the edge, where a trim must still win.
  const music = page.locator('[data-clip="music"]');
  const box = (await music.boundingBox())!;
  const svg = (await page
    .locator('[data-clip-mix="music"] svg')
    .boundingBox())!;
  await page.mouse.move(box.x + 3, svg.y + svg.height / 2);
  await expect(page.locator(".tl-lanes")).toHaveAttribute(
    "data-cursor",
    "trim",
  );
  await page.mouse.down();
  await page.mouse.move(box.x + 43, svg.y + svg.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await read()).clips.find((c) => c.id === "music")!.start)
    .toBeGreaterThan(0);
  expect((await read()).clips.find((c) => c.id === "music")!.volume).toBeNull();
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(initial);
  // A middle gain drag leaves timing alone, and its readout stays within the scroller.
  const x = box.x + box.width / 3;
  const y = svg.y + svg.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 35, { steps: 8 });
  await expect(page.locator(".tl-readout")).toBeVisible();
  const readout = (await page.locator(".tl-readout").boundingBox())!;
  expect(readout.y + readout.height).toBeLessThan(timeline.y + timeline.height);
  await page.screenshot({ path: info.outputPath("gain-readout.png") });
  await page.mouse.up();
  await expect
    .poll(
      async () => (await read()).clips.find((c) => c.id === "music")!.volume,
    )
    .toBe(0);
  expect((await read()).clips.find((c) => c.id === "music")!.start).toBe(0);
});
