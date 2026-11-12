import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { audioGainToDb, MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import type { APIRequestContext } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { TimelineViewSettingsInput } from "../src/shared/timeline/view";
import { test, expect } from "./fixtures";

async function createHeightProject(
  request: APIRequestContext,
  clips: string,
  settings: TimelineViewSettingsInput,
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Track geometry regressions" },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<main data-composition-id="main" data-duration="20" data-fps="30">${clips}</main>`,
  );
  const response = await request.put(
    `/api/cutroom/projects/${project.id}/timeline-view`,
    { data: settings },
  );
  expect(response.ok()).toBe(true);
  return project;
}

for (const height of [28, 200]) {
  test(`overwrite preview pieces stay inside a ${height}px row`, async ({
    page,
    request,
  }, info) => {
    const project = await createHeightProject(
      request,
      '<div id="cover" class="clip" data-start="3" data-duration="3" data-track-index="0">Covered title</div><div id="moving" class="clip" data-start="9" data-duration="1" data-track-index="0">Moving title</div>',
      { density: "normal", heights: { "0": height } },
    );
    await page.goto(`/#project/${project.id}`);
    await expect(
      page.getByRole("separator", { name: "Height V1" }),
    ).toHaveAttribute("aria-valuenow", String(height));
    await expect(page.locator(".tl-grid")).toHaveAttribute(
      "data-refit",
      "settled",
    );
    await page.keyboard.press("c");
    const moving = (await page.locator('[data-clip="moving"]').boundingBox())!;
    const cover = (await page.locator('[data-clip="cover"]').boundingBox())!;
    await page.mouse.move(moving.x + moving.width / 2, moving.y + 20);
    await page.mouse.down();
    await page.mouse.move(cover.x + cover.width / 2, moving.y + 20, {
      steps: 12,
    });
    const piece = page.locator(".tl-piece:visible");
    await expect(piece).toHaveCount(1);
    const bounds = (await piece.boundingBox())!;
    expect(bounds.y).toBe(cover.y);
    expect(bounds.height).toBe(height - 2);
    await page.screenshot({ path: info.outputPath("overwrite-preview.png") });
    await page.mouse.up();
    await expect(page.locator("[data-clip]")).toHaveCount(3);
  });

  for (const kind of ["video", "audio"] as const) {
    test(`new ${kind} track preview matches the created track beside a ${height}px row`, async ({
      page,
      request,
    }, info) => {
      const clips =
        kind === "video"
          ? '<div id="moving" class="clip" data-start="3" data-duration="3" data-track-index="0">Moving title</div><audio data-start="0" data-duration="20" data-track-index="1"></audio>'
          : '<div class="clip" data-start="0" data-duration="20" data-track-index="0">Title</div><audio id="moving" src="missing.wav" data-start="3" data-duration="3" data-track-index="1"></audio>';
      const density = height === 28 ? "compact" : "tall";
      const expectedHeight =
        density === "compact" ? 32 : kind === "video" ? 96 : 80;
      const project = await createHeightProject(request, clips, {
        density,
        heights: {
          "0": kind === "video" ? height : 28,
          "1": kind === "audio" ? height : 28,
        },
      });
      await page.goto(`/#project/${project.id}`);
      await expect(
        page.getByRole("separator", {
          name: `Height ${kind === "video" ? "V1" : "A1"}`,
        }),
      ).toHaveAttribute("aria-valuenow", String(height));
      await expect(page.locator(".tl-grid")).toHaveAttribute(
        "data-refit",
        "settled",
      );
      const moving = page.locator('[data-clip="moving"]');
      const clip = (await moving.boundingBox())!;
      const lane = page.locator(`.tl-lane.${kind}`);
      const edge = (await lane.boundingBox())!;
      await page.mouse.move(clip.x + 30, clip.y + 8);
      await page.mouse.down();
      await page.mouse.move(
        clip.x + 30,
        kind === "video" ? edge.y - 8 : edge.y + edge.height + 8,
        { steps: 12 },
      );
      await expect
        .poll(
          async () =>
            (await page.locator(".tl-lane.video").first().boundingBox())!.y -
            (await page.locator(".tl-lanes").boundingBox())!.y,
        )
        .toBe(0);
      if (kind === "audio") {
        await page.locator(".tl-scroll").evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const edge = (await lane.boundingBox())!;
        await page.mouse.move(clip.x + 30, edge.y + edge.height + 8, {
          steps: 6,
        });
      }
      const held = (await moving.boundingBox())!;
      const row = (await lane.boundingBox())!;
      const lanes = (await page.locator(".tl-lanes").boundingBox())!;
      expect(held.height).toBe(expectedHeight - 2);
      if (kind === "video") {
        expect(held.y).toBe(lanes.y + 1);
        expect(row.y).toBe(lanes.y);
      } else {
        expect(held.y).toBe(row.y + row.height + 1);
        expect(held.y + held.height).toBeLessThanOrEqual(
          lanes.y + lanes.height,
        );
      }
      await page.screenshot({ path: info.outputPath("new-track-preview.png") });
      await page.mouse.up();
      await expect(
        page.getByRole("separator", {
          name: `Height ${kind === "video" ? "V2" : "A2"}`,
        }),
      ).toHaveAttribute("aria-valuenow", String(expectedHeight));
      await expect
        .poll(async () => (await moving.boundingBox())!.height)
        .toBe(held.height);
    });
  }

  for (const volume of [MAX_AUDIO_GAIN, 0]) {
    test(`gain readout keeps ${volume === 0 ? "silence" : "+12 dB"} at its limit on a ${height}px row`, async ({
      page,
      request,
    }, info) => {
      const project = await createHeightProject(
        request,
        `<audio id="sound" src="missing.wav" data-start="0" data-duration="20" data-track-index="1" data-volume="${volume}"></audio>`,
        { density: "normal", heights: { "0": 28, "1": height } },
      );
      const api = `/api/cutroom/projects/${project.id}`;
      await page.goto(`/#project/${project.id}`);
      await expect(
        page.getByRole("separator", { name: "Height A1" }),
      ).toHaveAttribute("aria-valuenow", String(height));
      await expect(page.locator(".tl-grid")).toHaveAttribute(
        "data-refit",
        "settled",
      );
      const before = await (await request.get(`${api}/history`)).json();
      const point = await page
        .locator('[data-clip-mix="sound"] [data-mix="gain"]')
        .evaluate((path: SVGPathElement) => {
          const point = path
            .getPointAtLength(path.getTotalLength() / 2)
            .matrixTransform(path.getScreenCTM()!);
          return { x: point.x, y: point.y };
        });
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x, point.y + (volume === 0 ? 12 : -12), {
        steps: 6,
      });
      await expect(page.locator(".tl-readout")).toHaveText(
        volume === 0 ? "-∞ dB" : "+12.0 dB",
      );
      await page.screenshot({ path: info.outputPath("gain-limit.png") });
      await page.mouse.up();
      expect(await (await request.get(`${api}/history`)).json()).toEqual(
        before,
      );
    });
  }
}

test("track height and density survive reload, gain follows the pointer at each, and view changes leave undo to edits", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Track heights" },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="12" data-fps="30"><div id="title" class="clip" data-start="0" data-duration="10" data-track-index="0">Title</div><div id="upper" class="clip" data-start="1" data-duration="8" data-track-index="2">Upper title</div><audio id="sound" src="missing.wav" data-start="0" data-duration="10" data-track-index="1"></audio></main></body></html>',
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const clip = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    ).timeline.clips.find((clip) => clip.id === "sound")!;
  await page.goto(`/#project/${project.id}`);
  const density = page.getByRole("combobox", { name: "Track density" });
  const chooseDensity = async (value: string) => {
    await density.click();
    await page.getByRole("option", { name: value, exact: true }).click();
  };
  const height = page.getByRole("separator", { name: "Height V1" });
  await expect(height).toHaveAttribute("aria-valuenow", "56");
  const titleTop = (await page.locator('[data-clip="title"]').boundingBox())!.y;
  const upperTop = (await page.locator('[data-clip="upper"]').boundingBox())!.y;
  const box = (await height.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 66, { steps: 12 });
  await expect(height).toHaveAttribute("aria-valuenow", "120");
  expect((await page.locator('[data-clip="title"]').boundingBox())!.y).toBe(
    titleTop,
  );
  expect((await page.locator('[data-clip="upper"]').boundingBox())!.y).toBe(
    upperTop,
  );
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${api}/timeline-view`)).json()).heights,
    )
    .toEqual({ "0": 120 });
  await page.reload();
  await expect(height).toHaveAttribute("aria-valuenow", "120");
  await chooseDensity("Compact");
  await expect(height).toHaveAttribute("aria-valuenow", "32");
  await expect(
    page.getByRole("separator", { name: "Height A1" }),
  ).toHaveAttribute("aria-valuenow", "32");
  await expect
    .poll(
      async () =>
        (await (await request.get(`${api}/timeline-view`)).json()).density,
    )
    .toBe("compact");
  await page.reload();
  await expect(density).toHaveText("Compact");
  const before = await clip();
  const readout = page.locator(".tl-readout");
  const line = () =>
    page
      .locator('[data-clip-mix="sound"] path')
      .first()
      .evaluate((path: SVGPathElement) => {
        const at = path
          .getPointAtLength(path.getTotalLength() / 2)
          .matrixTransform(path.getScreenCTM()!);
        return { x: at.x, y: at.y };
      });
  for (const [densityValue, shift] of [
    ["compact", false],
    ["tall", false],
    ["compact", true],
    ["tall", true],
  ] as const) {
    await chooseDensity(densityValue === "compact" ? "Compact" : "Tall");
    await expect(page.locator(".tl-grid")).toHaveAttribute(
      "data-refit",
      "settled",
    );
    const point = await line();
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y + 6, { steps: 10 });
    // The line stays under the pointer on a short row and a tall one; Shift holds it back.
    if (shift) await expect(readout).toHaveText("-0.6 dB");
    else
      await expect
        .poll(async () => Math.abs((await line()).y - (point.y + 6)))
        .toBeLessThanOrEqual(0.5);
    const db = parseFloat(await readout.innerText());
    expect(db).toBeLessThan(0);
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
    await expect
      .poll(async () => audioGainToDb((await clip()).volume!))
      .toBeCloseTo(db, 5);
    await page.keyboard.press("Control+z");
    await expect.poll(clip).toEqual(before);
    await expect(density).toHaveText(
      densityValue === "compact" ? "Compact" : "Tall",
    );
  }
  // View changes never consume an undo. The only person edits are the four gain drags.
  const history = await (await request.get(`${api}/history`)).json();
  expect(
    history.entries.filter(
      (entry: { who: { kind: string }; label: string }) =>
        entry.who.kind === "person" && entry.label.startsWith("Set gain to "),
    ),
  ).toHaveLength(4);
  for (const value of ["compact", "tall"] as const) {
    await chooseDensity(value === "compact" ? "Compact" : "Tall");
    const handle = page.locator('[data-clip-mix="sound"] [data-mix="fadeIn"]');
    const bounds = (await handle.boundingBox())!;
    const ppf = await page
      .locator(".tl-grid")
      .evaluate((grid: HTMLElement) =>
        Number(grid.style.getPropertyValue("--ppf")),
      );
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width / 2 + ppf * 30,
      bounds.y + bounds.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect.poll(async () => (await clip()).fadeIn).toBe(30);
    await page.keyboard.press("Control+z");
    await expect.poll(clip).toEqual(before);
  }
  await chooseDensity("Compact");
  await page.getByRole("separator", { name: "Height V2" }).focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("separator", { name: "Height V2" }),
  ).toHaveAttribute("aria-valuenow", "200");
  const title = (await page.locator('[data-clip="title"]').boundingBox())!;
  const upper = (await page.locator('.tl-head[data-row="2"]').boundingBox())!;
  await page.mouse.move(title.x + 50, title.y + 20);
  await page.mouse.down();
  await page.mouse.move(title.x + 50, upper.y + 80, { steps: 12 });
  expect(
    (await page.locator('[data-clip="title"]').boundingBox())!.height,
  ).toBe(198);
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        TimelineViewSchema.parse(
          await (await request.get(`${api}/timeline`)).json(),
        ).timeline.clips.find((clip) => clip.id === "title")!.track,
    )
    .toBe(2);
  await page.keyboard.press("Control+z");
  await expect.poll(clip).toEqual(before);
  await writeFile(join(project.path, ".cutroom/view.json"), "{broken");
  await page.reload();
  await expect(density).toHaveText("Normal");
  await expect(height).toHaveAttribute("aria-valuenow", "56");
});
