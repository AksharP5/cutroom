import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { expect, test } from "./fixtures";
import type { APIRequestContext } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

const scene = `<template>
  <div id="intro-root" data-composition-id="intro" data-width="1920" data-height="1080" data-duration="6" style="position:absolute;inset:0;background:#1b2a3a">
    <div id="intro-title" class="clip" style="position:absolute;left:160px;top:420px;font-size:120px;color:#fff" data-start="0" data-duration="6" data-track-index="0" data-label="Scene title">Northlight</div>
    <div id="intro-sub" class="clip" style="position:absolute;left:164px;top:580px;font-size:44px;color:#ddd" data-start="2" data-duration="4" data-track-index="1" data-label="Subtitle">A film about light</div>
  </div>
</template>
`;

/** A project whose root plays the intro scene from 2 s, followed by an end card. */
async function scenes(request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Scenes", duration: 12 },
      })
    ).json(),
  );
  await mkdir(join(project.path, "compositions"));
  await writeFile(join(project.path, "compositions", "intro.html"), scene);
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      /(<main[^>]*>)[\s\S]*<\/main>/,
      `$1
<div id="intro" class="clip" data-composition-id="intro" data-composition-src="compositions/intro.html" data-start="2" data-duration="6" data-track-index="0" data-width="1920" data-height="1080" data-label="Intro scene"></div>
<div id="card" class="clip" data-start="8" data-duration="4" data-track-index="0">End card</div>
</main>`,
    ),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async (composition: string) =>
    TimelineViewSchema.parse(
      await (
        await request.get(
          `${api}/timeline?composition=${encodeURIComponent(composition)}`,
        )
      ).json(),
    ).timeline.clips;
  return { project, read };
}

test("a scene opens in the editor, edits and undoes there, and Esc returns to the root as it was left", async ({
  page,
  request,
}) => {
  const { project, read: clips } = await scenes(request);
  const read = async (composition: string) =>
    (await clips(composition)).map((clip) => clip.id);

  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  const path = page.getByRole("navigation", { name: "Composition" });
  const time = page.getByRole("button", { name: /^Current time/ });
  const zoom = timeline.getByRole("slider", { name: "Zoom" });
  const live = page.locator(".edit-frame[data-live]");
  await expect(timeline.locator("[data-clip]")).toHaveCount(2);
  await expect(path).toHaveCount(0);

  // The root's own playhead and zoom, to come back to.
  await time.click();
  await page.getByLabel("Go to time").pressSequentially("0315");
  await page.keyboard.press("Enter");
  await timeline.getByRole("button", { name: "Zoom in", exact: true }).click();
  await timeline.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(zoom).not.toHaveAttribute("aria-valuenow", "0");
  const rootZoom = await zoom.getAttribute("aria-valuenow");

  // The playhead is 1:15 into the scene, so the scene opens there.
  await timeline.locator('[data-clip="intro"]').dblclick();
  await expect(path).toHaveText(/Scenes.*intro/);
  await expect(timeline.locator("[data-clip]")).toHaveCount(2);
  await expect(timeline.locator('[data-clip="intro-sub"]')).toBeVisible();
  await expect(time).toHaveText("00:00:01:15");
  await expect(live).toHaveAttribute(
    "src",
    /composition=compositions%2Fintro\.html/,
  );
  await expect(zoom).toHaveAttribute("aria-valuenow", "0");

  // Editing keys, the inspector and the agent's view of the selection all follow the scene.
  await timeline.locator('[data-clip="intro-sub"]').click();
  await expect(
    page.getByRole("complementary", { name: "Inspector" }),
  ).toContainText("Subtitle");
  await expect
    .poll(
      async () =>
        z
          .object({
            selection: z
              .object({
                compositionPath: z.string(),
                target: z.object({ id: z.string() }),
              })
              .nullable(),
          })
          .parse(
            await (
              await request.get(`/api/projects/${project.id}/selection`)
            ).json(),
          ).selection,
    )
    .toMatchObject({
      compositionPath: "compositions/intro.html",
      target: { id: "intro-sub" },
    });
  await page.keyboard.press("x");
  await expect(timeline.locator('[data-clip="intro-sub"]')).toHaveCount(0);
  await expect
    .poll(() => read("compositions/intro.html"))
    .toEqual(["intro-title"]);
  expect(await read("index.html")).toEqual(["intro", "card"]);
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => read("compositions/intro.html"))
    .toEqual(["intro-title", "intro-sub"]);
  await expect(timeline.locator('[data-clip="intro-sub"]')).toBeVisible();

  // Esc first clears the selection, then leaves the scene with the root as it was.
  await timeline.locator('[data-clip="intro-title"]').click();
  await page.keyboard.press("Escape");
  await expect(path).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(path).toHaveCount(0);
  await expect(timeline.locator('[data-clip="card"]')).toBeVisible();
  await expect(time).toHaveText("00:00:03:15");
  await expect(zoom).toHaveAttribute("aria-valuenow", rootZoom!);
  await expect(live).not.toHaveAttribute("src", /composition=/);

  // Enter on the selected host goes back in, to the scene's playhead as it was left.
  await timeline.locator('[data-clip="intro"]').click();
  await page.keyboard.press("Enter");
  await expect(path).toBeVisible();
  await expect(time).toHaveText("00:00:01:15");
  await path.getByRole("button", { name: "Scenes" }).click();
  await expect(path).toHaveCount(0);
});

test("media placed inside a scene is written from the scene's folder and plays there", async ({
  page,
  request,
}) => {
  const { project, read } = await scenes(request);
  await mkdir(join(project.path, "media"));
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=1",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    join(project.path, "media", "shot.mp4"),
  ]);
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await timeline.locator('[data-clip="intro"]').dblclick();
  await expect(timeline.locator('[data-clip="intro-sub"]')).toBeVisible();

  await page.locator('.media-row[data-path="media/shot.mp4"]').click({
    button: "right",
  });
  await page
    .getByRole("menu", { name: "media/shot.mp4" })
    .getByRole("menuitem", { name: "Overwrite at playhead" })
    .click();
  await expect
    .poll(async () =>
      (await read("compositions/intro.html")).flatMap((clip) =>
        clip.kind === "video" ? [clip.src] : [],
      ),
    )
    .toEqual(["../media/shot.mp4"]);
  const shot = timeline.locator('.tl-clip.video[data-clip^="shot"]');
  await expect(shot).toBeVisible();
  await expect(shot).not.toHaveClass(/offline/);
});

test("the composition list shows each scene's lint, opens it, and places it at the playhead", async ({
  page,
  request,
}) => {
  const { project, read } = await scenes(request);
  await writeFile(
    join(project.path, "compositions", "outro.html"),
    // A CSS transition runs on the browser clock, which lint warns about.
    scene
      .replaceAll("intro", "outro")
      .replace("font-size:44px;", "font-size:44px;transition:opacity 1s;"),
  );
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  const media = page.getByRole("region", { name: "Media" });
  await media.getByRole("button", { name: /^Compositions/ }).click();
  const list = media.getByRole("list", { name: "Compositions" });
  const row = (path: string) => list.locator(`[data-path="${path}"]`);
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(row("index.html")).toHaveAttribute("aria-current", "true");
  await expect(row("compositions/intro.html")).toContainText("00:00:06:00");
  await expect(
    row("compositions/outro.html").getByLabel("1 lint findings"),
  ).toBeVisible();
  await expect(
    row("compositions/intro.html").getByLabel(/lint findings/),
  ).toHaveCount(0);

  // Overwrite at playhead puts the outro on the video destination as one undo step.
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("1000");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    "00:00:10:00",
  );
  await row("compositions/outro.html").click({ button: "right" });
  await page
    .getByRole("menu", { name: "compositions/outro.html" })
    .getByRole("menuitem", { name: "Overwrite at playhead" })
    .click();
  await expect
    .poll(async () =>
      (await read("index.html")).map((clip) => [
        clip.kind,
        clip.src,
        clip.start,
        clip.duration,
      ]),
    )
    .toEqual([
      ["composition", "compositions/intro.html", 60, 180],
      ["element", null, 240, 60],
      ["composition", "compositions/outro.html", 300, 180],
    ]);
  await expect(timeline.locator(".tl-clip.composition")).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await read("index.html")).length).toBe(2);

  // Double-click opens a scene, and the list follows the editor.
  await row("compositions/intro.html").dblclick();
  await expect(
    page.getByRole("navigation", { name: "Composition" }),
  ).toContainText("intro");
  await expect(row("compositions/intro.html")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(timeline.locator('[data-clip="intro-sub"]')).toBeVisible();
});
