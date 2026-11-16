import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
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

test("sound under its own picture goes unnamed, titles show their words, missing files look offline, and spare room goes to sound", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Lanes", width: 320, height: 240, duration: 4 },
      })
    ).json(),
  );
  media(join(project.path, "red.mp4"), "red", 440);
  media(join(project.path, "blue.mp4"), "blue", 660);
  // `sa` sits right under its picture; `sb` was slipped six frames; gone.mp4 never existed.
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#000}video{position:absolute;inset:0;width:320px;height:240px}</style></head><body><main data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="4" style="position:relative;width:320px;height:240px">
<video id="a" muted src="red.mp4" data-start="0" data-duration="1.5" data-media-start="0" data-track-index="0" data-link="la"></video>
<video id="b" muted src="blue.mp4" data-start="1.5" data-duration="1.5" data-media-start="0" data-track-index="0" data-link="lb"></video>
<video id="c" muted src="gone.mp4" data-start="3" data-duration="1" data-media-start="0" data-track-index="0"></video>
<audio id="sa" src="red.mp4" data-start="0" data-duration="1.5" data-media-start="0" data-track-index="1" data-link="la"></audio>
<audio id="sb" src="blue.mp4" data-start="1.7" data-duration="1.3" data-media-start="0.2" data-track-index="1" data-link="lb"></audio>
</main></body></html>`,
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const view = TimelineViewSchema.parse(
    await (await request.get(`${api}/timeline`)).json(),
  );
  const response = await request.post(`${api}/commands`, {
    data: {
      expectedRevision: view.revision,
      commands: [
        { type: "setTrack", index: 2, kind: "video" },
        {
          type: "insert",
          track: 2,
          at: 0,
          clip: {
            kind: "title",
            id: "lower",
            text: "Ada Lovelace\nAnalyst",
            duration: 60,
          },
        },
      ],
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  const name = (id: string) =>
    timeline.locator(`[data-clip-label="${id}"] .tl-name`);
  await expect(timeline.locator(".tl-lanes [data-clip]")).toHaveCount(6);

  // The picture names the pair; its sound says nothing until pointed at or selected.
  await expect(name("a")).toBeVisible();
  await expect(name("sa")).toBeHidden();
  // Sound that no longer lines up with its picture names itself.
  await expect(name("sb")).toBeVisible();
  const sound = (await timeline.locator('[data-clip="sa"]').boundingBox())!;
  await page.mouse.move(sound.x + sound.width / 2, sound.y + sound.height / 2);
  await expect(name("sa")).toBeVisible();
  await page.mouse.move(sound.x + sound.width / 2, sound.y - 300);
  await expect(name("sa")).toBeHidden();
  await timeline.locator('[data-clip="sa"]').click();
  await expect(name("sa")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(name("sa")).toBeHidden();

  // A title shows its words on its body: the first line, then the second.
  await expect(name("lower")).toHaveText(["Ada Lovelace", "Analyst"]);

  // A clip whose file is missing says so, and so does one whose file goes while it is open.
  const offline = (id: string) =>
    timeline.locator(`[data-clip-label="${id}"]`).getByText("Media offline");
  await expect(offline("c")).toBeVisible();
  await expect(offline("b")).toHaveCount(0);
  await rm(join(project.path, "blue.mp4"));
  await expect(offline("b")).toBeVisible();
  await expect(offline("sb")).toBeVisible();
  await expect(offline("a")).toHaveCount(0);

  // Two video tracks and one audio track leave room, which the audio track takes up to Tall.
  const height = timeline.getByRole("separator", { name: "Height A1" });
  await expect(height).toHaveAttribute("aria-valuenow", "80");
  await expect(
    timeline.getByRole("separator", { name: "Height V1" }),
  ).toHaveAttribute("aria-valuenow", "56");
  // Compact asks for small tracks, so it keeps them small.
  await timeline.getByRole("combobox", { name: "Track density" }).click();
  await page.getByRole("option", { name: "Compact" }).click();
  await expect(height).toHaveAttribute("aria-valuenow", "32");
});
