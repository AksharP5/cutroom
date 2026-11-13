import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);

/**
 * `talk.mp4` plays as a picture on V1 with its linked sound on A1. `music.wav`, `spare.wav`,
 * and `still.png` are in Media and on no track.
 */
async function open(page: Page, request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: `Media files ${Date.now()}`, duration: 6 },
      })
    ).json(),
  );
  const assets = join(project.path, "assets");
  await mkdir(assets, { recursive: true });
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=6",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(assets, "talk.mp4"),
  ]);
  for (const name of ["music.wav", "spare.wav"])
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=2",
      join(assets, name),
    ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=orange:s=64x36",
    "-frames:v",
    "1",
    join(assets, "still.png"),
  ]);
  const path = join(project.path, "index.html");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      /<main([^>]*)>[\s\S]*<\/main>/,
      `<main$1>
    <video src="assets/talk.mp4" muted id="picture" class="clip" data-start="0" data-duration="4" data-track-index="0" data-link="pair"></video>
    <audio src="assets/talk.mp4" id="sound" class="clip" data-start="0" data-duration="4" data-track-index="1" data-link="pair"></audio>
    </main>`,
    ),
  );
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(2);
  const media = page.getByRole("region", { name: "Media", exact: true });
  const row = (name: string) =>
    media.getByRole("listitem").filter({ hasText: name });
  await expect(media.getByRole("listitem")).toHaveCount(4);
  const sources = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline.clips.map((clip) => clip.src);
  const present = (file: string) =>
    stat(join(project.path, file)).then(
      () => true,
      () => false,
    );
  return { project, timeline, media, row, sources, present };
}

test("Rename in a media row's menu renames the file and every clip that plays it, in one undo step", async ({
  page,
  request,
}) => {
  const { timeline, media, row, sources, present } = await open(page, request);
  await row("talk.mp4").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();

  // The name is selected and the extension is not part of what is typed.
  const field = media.getByRole("textbox", { name: "Rename talk.mp4" });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("talk");
  // Typing a name never plays, cuts, or removes: the keys belong to the field.
  await page.keyboard.type("interviex");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("w");
  await page.keyboard.press("Enter");

  await expect(row("interview.mp4")).toBeFocused();
  await expect(media.getByRole("listitem")).toHaveCount(4);
  await expect(row("talk.mp4")).toHaveCount(0);
  await expect(
    timeline.locator('[data-clip-label="picture"] .tl-name'),
  ).toHaveText("interview.mp4");
  expect(await sources()).toEqual([
    "assets/interview.mp4",
    "assets/interview.mp4",
  ]);
  expect(await present("assets/interview.mp4")).toBe(true);
  expect(await present("assets/talk.mp4")).toBe(false);
  // The editor's own rename is not reported back to it as an outside change.
  await expect(page.locator(".toast")).toHaveCount(0);

  await page.keyboard.press("Control+z");
  await expect(row("talk.mp4")).toBeVisible();
  await expect(row("interview.mp4")).toHaveCount(0);
  await expect(
    timeline.locator('[data-clip-label="picture"] .tl-name'),
  ).toHaveText("talk.mp4");
  expect(await sources()).toEqual(["assets/talk.mp4", "assets/talk.mp4"]);
  expect(await present("assets/talk.mp4")).toBe(true);

  // Escape leaves the name alone and hands the keys back to the row.
  await row("talk.mp4").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.keyboard.type("changed");
  await page.keyboard.press("Escape");
  await expect(media.getByRole("textbox")).toHaveCount(0);
  await expect(row("talk.mp4")).toBeVisible();
  expect(await present("assets/talk.mp4")).toBe(true);

  // A name another file has is refused where it was typed, and stays open to correct.
  await row("spare.wav").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.keyboard.type("music");
  await page.keyboard.press("Enter");
  await expect(media.getByRole("alert")).toHaveText(
    "music.wav already exists in this folder. Choose another name.",
  );
  await expect(
    media.getByRole("textbox", { name: "Rename spare.wav" }),
  ).toBeFocused();
  await page.keyboard.type("-bed");
  await page.keyboard.press("Enter");
  await expect(row("music-bed.wav")).toBeFocused();
  await expect(media.getByRole("alert")).toHaveCount(0);
  expect(await present("assets/music.wav")).toBe(true);
  expect(await present("assets/spare.wav")).toBe(false);
});

test("Remove asks before taking a file the timeline uses, and Undo brings it back", async ({
  page,
  request,
}) => {
  const { project, timeline, media, row, present } = await open(page, request);
  const dialog = page.getByRole("dialog", { name: "Remove talk.mp4?" });

  await row("talk.mp4").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
  // The picture and its linked sound are one clip, as they are everywhere else in the editor.
  await expect(dialog).toContainText("This file has 1 use in the project.");
  await expect(dialog.getByRole("button", { name: "Keep file" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(await present("assets/talk.mp4")).toBe(true);
  await expect(row("talk.mp4")).toBeVisible();

  await row("talk.mp4").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row("talk.mp4")).toHaveCount(0);
  // The file is moved, never deleted: it sits in the project's trash folder.
  expect(await present("assets/talk.mp4")).toBe(false);
  expect(await readdir(join(project.path, "trash"))).toEqual(["talk.mp4"]);
  // Its clips stay where they were cut.
  await expect(timeline.locator("[data-clip]")).toHaveCount(2);

  const toast = page.locator('.toast[role="status"]');
  await expect(toast.locator("span")).toHaveText(
    "Moved talk.mp4 to the project's trash folder.",
  );
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(row("talk.mp4")).toBeVisible();
  expect(await present("assets/talk.mp4")).toBe(true);
  expect(await readdir(join(project.path, "trash"))).toEqual([]);
  await expect(media.getByRole("listitem")).toHaveCount(4);
});

test("the delete keys remove the file reached by keyboard, and stay the timeline's after a click", async ({
  page,
  request,
}) => {
  const { timeline, media, row, sources, present } = await open(page, request);

  // After a click on a row, X still lifts the selected clip and the file stays.
  await timeline.locator('[data-clip="picture"]').click();
  await row("music.wav").click();
  await page.keyboard.press("x");
  await expect(timeline.locator("[data-clip]")).toHaveCount(0);
  expect(await sources()).toEqual([]);
  expect(await present("assets/music.wav")).toBe(true);
  await expect(media.getByRole("listitem")).toHaveCount(4);

  // Tab from the import button reaches the list by keyboard.
  await media.getByRole("button", { name: "Import media" }).focus();
  await page.keyboard.press("Tab");
  await expect(row("music.wav")).toBeFocused();
  // A click on that same row hands the keys back to the timeline, until the keyboard returns.
  await row("music.wav").click();
  await page.keyboard.press("Delete");
  await expect(media.getByRole("listitem")).toHaveCount(4);
  await page.keyboard.press("Control+2");
  await expect(row("music.wav")).toBeFocused();
  // Nothing uses this file, so it goes without a question, and the next row takes the keys.
  await page.keyboard.press("Backspace");
  await expect(row("music.wav")).toHaveCount(0);
  expect(await present("trash/music.wav")).toBe(true);
  await expect(row("spare.wav")).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(row("spare.wav")).toHaveCount(0);
  expect(await present("trash/spare.wav")).toBe(true);
  await expect(media.getByRole("listitem")).toHaveCount(2);

  // Undo and redo are the editor's own: each press is one file.
  await page.keyboard.press("Control+z");
  await expect(row("spare.wav")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(row("music.wav")).toBeVisible();
  expect(await present("assets/music.wav")).toBe(true);
  expect(await present("assets/spare.wav")).toBe(true);
});

test("review: undo or MCP rename cannot leave a missing source available to Insert", async ({
  page,
  request,
  baseURL,
}) => {
  const { project, media, row, sources } = await open(page, request);
  await row("talk.mp4").dblclick();
  await expect(page.locator(".edit-source-name")).toHaveText("talk.mp4");
  await row("talk.mp4").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await media.getByRole("textbox", { name: "Rename talk.mp4" }).fill("renamed");
  await page.keyboard.press("Enter");
  await expect(page.locator(".edit-source-name")).toHaveText("renamed.mp4");
  expect(
    (
      await request.post(`/api/cutroom/projects/${project.id}/history/undo`)
    ).ok(),
  ).toBe(true);
  await page.keyboard.press("F9");
  await expect(page.locator(".edit-source")).toHaveCount(0);
  expect(await sources()).toEqual(["assets/talk.mp4", "assets/talk.mp4"]);

  await expect(row("talk.mp4")).toBeVisible();
  await row("talk.mp4").dblclick();
  const client = new Client({ name: "media-source-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: new URL(baseURL!).origin } },
      }),
    );
    const renamed = await client.callTool({
      name: "media_rename",
      arguments: {
        projectId: project.id,
        path: "assets/talk.mp4",
        name: "external.mp4",
      },
    });
    expect(renamed.isError).not.toBe(true);
  } finally {
    await client.close();
  }
  await page.keyboard.press("F9");
  await expect(page.locator(".edit-source")).toHaveCount(0);
  expect(await sources()).toEqual([
    "assets/external.mp4",
    "assets/external.mp4",
  ]);
  await row("external.mp4").dblclick();
  expect(
    (
      await request.post(`/api/cutroom/projects/${project.id}/history/undo`)
    ).ok(),
  ).toBe(true);
  await expect(page.locator(".edit-source")).toHaveCount(0);
  await row("talk.mp4").dblclick();
  expect(
    (
      await request.post(`/api/cutroom/projects/${project.id}/history/redo`)
    ).ok(),
  ).toBe(true);
  await expect(page.locator(".edit-source")).toHaveCount(0);
});
