import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./fixtures";
import { ProjectSchema, SourceSchema } from "../src/shared/project";

test("media panel follows project media and imports files into assets", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Media shelf" },
      })
    ).json(),
  );
  const tone = (path: string) =>
    promisify(execFile)("ffmpeg", [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-t",
      "1",
      "-y",
      path,
    ]);
  await page.goto(`/#project/${project.id}`);
  const media = page.getByRole("region", { name: "Media", exact: true });
  await expect(media.getByText("No media yet")).toBeVisible();

  await mkdir(join(project.path, "sound.v2"), { recursive: true });
  await tone(join(project.path, "sound.v2", "room-tone.wav"));
  await expect(
    media.getByRole("listitem").filter({ hasText: "room-tone" }),
  ).toHaveAttribute("data-kind", "audio");

  const outside = await mkdtemp(join(tmpdir(), "cutroom-media-"));
  await tone(join(outside, "narration.mp3"));
  await media
    .locator('input[type="file"]')
    .setInputFiles(join(outside, "narration.mp3"));
  await expect(
    media.getByRole("listitem").filter({ hasText: "narration" }),
  ).toBeVisible();
  await stat(join(project.path, "assets", "narration.mp3"));

  await writeFile(join(outside, "notes.txt"), "not media");
  await media
    .locator('input[type="file"]')
    .setInputFiles(join(outside, "notes.txt"));
  await expect(media.getByRole("alert")).toContainText(
    "notes.txt is not a supported",
  );

  // Moving a whole folder out reports only the folder, even when its name has a dot.
  const moved = `${project.path}-sound`;
  await rename(join(project.path, "sound.v2"), moved);
  await expect(
    media.getByRole("listitem").filter({ hasText: "room-tone" }),
  ).toHaveCount(0);
  await rm(moved, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("Script explains what to do only until there is footage on the timeline", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/cutroom/projects", {
    data: { name: "Script guidance" },
  });
  const project = ProjectSchema.parse(await created.json());
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Script", exact: true }).click();
  const script = page.getByRole("region", { name: "Script editor" });
  const guidance = script.getByText(
    "Add a clip to the timeline to transcribe it.",
    { exact: true },
  );
  await expect(guidance).toBeVisible();

  await promisify(execFile)("ffmpeg", [
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:sample_rate=16000",
    "-t",
    "1",
    "-y",
    join(project.path, "assets", "room.wav"),
  ]);
  const path = `/api/cutroom/projects/${project.id}/source`;
  const source = SourceSchema.parse(await (await request.get(path)).json());
  const saved = await request.put(path, {
    data: {
      path: "index.html",
      content: source.content.replace(
        "</main>",
        '<audio id="room" class="clip" src="assets/room.wav" data-start="0" data-duration="1" data-track-index="3"></audio></main>',
      ),
      expectedVersion: source.version,
    },
  });
  expect(saved.ok()).toBe(true);
  await expect(
    script.getByRole("button", { name: "Transcribe locally" }),
  ).toBeEnabled();
  await expect(guidance).toHaveCount(0);
});
