import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { keymap } from "../src/client/keymap";
import type { Action } from "../src/client/keymap";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { createPositionProject } from "./position-helpers";

/** Picture on V1 with its linked sound on A1, and a title on V2, from a 12 second source. */
async function open(page: Page, request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: `Context menus ${Date.now()}` },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=12",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "source.mp4"),
  ]);
  const path = join(project.path, "index.html");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      /<main([^>]*)data-duration="12"([^>]*)>[\s\S]*<\/main>/,
      `<main$1data-duration="12"$2>
    <video src="source.mp4" muted id="picture" class="clip" data-label="Picture" data-start="0" data-duration="4" data-track-index="0" data-link="pair"></video>
    <audio src="source.mp4" id="sound" class="clip" data-label="Sound" data-start="0" data-duration="4" data-track-index="1" data-link="pair"></audio>
    <div id="title" class="clip" data-label="Title" data-start="6" data-duration="2" data-track-index="2">Title</div>
    </main>`,
    ),
  );
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(3);
  await expect(page.locator(".tl-grid")).toHaveAttribute(
    "data-refit",
    "settled",
  );
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline;
  return { project, timeline, read, before: await read() };
}

const menu = (page: Page, name: string | RegExp = /./) =>
  page.getByRole("menu", { name });
/** A menu row backed by a keymap action, found by the label the keymap gives it. */
const row = (list: Locator, action: Action) =>
  list.getByRole("menuitem", { name: keymap[action].label, exact: true });

test("the clip menu acts on the selection through the same edits as the keys", async ({
  page,
  request,
}) => {
  const { timeline, read, before } = await open(page, request);
  const clips = menu(page, "Clip");

  // A right-click selects the clip with its linked partner, as a click does.
  await timeline.locator('[data-clip="picture"]').click({ button: "right" });
  await expect(clips).toBeVisible();
  await expect(timeline.locator("[data-clip].selected")).toHaveCount(2);

  // Each row shows the keymap's own label and first key.
  for (const action of [
    "editCut",
    "editCopy",
    "editPaste",
    "editM2SplitClip",
    "editBackspace",
    "editDelete",
    "editClipEnabled",
    "editSelectClipsSelectTrackAfter",
  ] as const)
    await expect(row(clips, action).locator("kbd")).toHaveText(
      keymap[action].keys[0],
    );
  // Nothing is copied yet, and the playhead is at the clip's first frame, not inside it.
  await expect(row(clips, "editPaste")).toBeDisabled();
  await expect(row(clips, "editM2SplitClip")).toBeDisabled();

  // Arrows skip unavailable rows and wrap; letters search; Escape closes.
  await page.keyboard.press("ArrowDown");
  await expect(row(clips, "editCut")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(row(clips, "editBackspace")).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    clips.getByRole("menuitemcheckbox", { name: "Inspector" }),
  ).toBeFocused();
  await page.keyboard.press("r");
  await expect(row(clips, "editDelete")).toBeFocused();
  await page.keyboard.press("r");
  await expect(
    clips.getByRole("menuitem", { name: "Reveal media" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(clips).toBeHidden();
  // Escape closed the menu and nothing else: the clips are still selected.
  await expect(timeline.locator("[data-clip].selected")).toHaveCount(2);

  // Lift from the menu is the X key's edit, and one undo step.
  await timeline.locator('[data-clip="picture"]').click({ button: "right" });
  await row(clips, "editBackspace").click();
  await expect
    .poll(async () => (await read()).clips.map((clip) => clip.id))
    .toEqual(["title"]);
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);

  // The menu key and Shift+F10 open it for the selection, with the first row focused.
  await timeline.locator('[data-clip="title"]').click();
  for (const key of ["ContextMenu", "Shift+F10"]) {
    await page.keyboard.press(key);
    await expect(row(clips, "editCut")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(clips).toBeHidden();
  }
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("t");
  await expect(row(clips, "editClipEnabled")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await read()).clips.find((clip) => clip.id === "title")?.enabled,
    )
    .toBe(false);
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);

  // Empty lane: nothing stays selected, so only what needs no clip is offered.
  const lane = (await page.locator('.tl-lane[data-row="2"]').boundingBox())!;
  const shown = (await page.locator(".tl-scroll").boundingBox())!;
  await page.mouse.click(shown.x + shown.width - 60, lane.y + lane.height / 2, {
    button: "right",
  });
  await expect(timeline.locator("[data-clip].selected")).toHaveCount(0);
  await expect(row(clips, "editBackspace")).toBeDisabled();
  await expect(row(clips, "editSelectClipsSelectTrackAfter")).toBeEnabled();
  await page.keyboard.press("Escape");

  // Reveal media hands focus to the clip's file in Media.
  await timeline.locator('[data-clip="picture"]').click({ button: "right" });
  await clips.getByRole("menuitem", { name: "Reveal media" }).click();
  await expect(
    page.locator('.media-row[data-path="source.mp4"]'),
  ).toBeFocused();
});

test("the track menu presses the header's switches and returns focus to the header", async ({
  page,
  request,
}) => {
  const { read, before } = await open(page, request);
  const head = page.locator('.tl-head[data-row="0"]');
  const lock = head.getByRole("button", { name: "Lock V1" });
  const tracks = menu(page, "Track V1");

  await head.click({ button: "right", position: { x: 4, y: 4 } });
  await expect(
    tracks.getByRole("menuitemcheckbox", { name: "Lock" }),
  ).toHaveAttribute("aria-checked", "false");
  await tracks.getByRole("menuitemcheckbox", { name: "Lock" }).click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await head.click({ button: "right", position: { x: 4, y: 4 } });
  await expect(
    tracks.getByRole("menuitemcheckbox", { name: "Lock" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);
  await expect(lock).toHaveAttribute("aria-pressed", "false");

  // From the keyboard the menu hangs from the focused header and gives focus back on Escape.
  await lock.focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    tracks.getByRole("menuitemcheckbox", { name: "Lock" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tracks).toBeHidden();
  await expect(lock).toBeFocused();
  // Choosing a row returns focus too.
  await page.keyboard.press("ContextMenu");
  await page.keyboard.press("a");
  await expect(
    tracks.getByRole("menuitemcheckbox", { name: "Auto-select" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    head.getByRole("button", { name: "Auto-select V1" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(lock).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);

  // Audio headers offer mute, solo and arm; density is the corner control's setting.
  await page
    .locator(".tl-head.audio")
    .first()
    .click({ button: "right", position: { x: 4, y: 4 } });
  const audio = menu(page, "Track A1");
  for (const name of ["Mute", "Solo", "Arm"])
    await expect(
      audio.getByRole("menuitemcheckbox", { name, exact: true }),
    ).toBeVisible();
  await audio.getByRole("menuitemradio", { name: "Compact" }).click();
  await expect(
    page.getByRole("combobox", { name: "Track density" }),
  ).toHaveText("Compact");
});

test("the media menu places a file at the playhead, and the desktop reveals it", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const revealed: string[] = [];
    Object.assign(window, {
      revealed,
      cutroomDesktop: {
        exportFile: async () => {},
        reveal: async (path: string) => void revealed.push(path),
      },
    });
  });
  const { project, read, before } = await open(page, request);
  const file = page.locator('.media-row[data-path="source.mp4"]');
  const media = menu(page, "source.mp4");
  await expect(file).toHaveAttribute("draggable", "true");
  await page.keyboard.press("End");

  await file.click({ button: "right" });
  await media.getByRole("menuitem", { name: "Overwrite at playhead" }).click();
  await expect
    .poll(async () =>
      (await read()).clips
        .filter((clip) => !before.clips.some((old) => old.id === clip.id))
        .map((clip) => [clip.kind, clip.track, clip.start, clip.src]),
    )
    .toEqual([
      ["video", 0, 359, "source.mp4"],
      ["audio", 1, 359, "source.mp4"],
    ]);
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);

  // From the keyboard: the focused row's menu, and focus back on the row.
  await file.focus();
  await page.keyboard.press("ContextMenu");
  await expect(
    media.getByRole("menuitem", { name: "Insert at playhead" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(file).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await read()).clips.length)
    .toBe(before.clips.length + 2);
  await expect(file).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);

  await file.click({ button: "right" });
  await media.getByRole("menuitem", { name: "Reveal in folder" }).click();
  expect(await page.evaluate("revealed")).toEqual([
    join(project.path, "source.mp4"),
  ]);
});

test("a project tile's menu opens it, and a browser has no file manager to offer", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: `Tile menu ${Date.now()}` },
      })
    ).json(),
  );
  await page.goto("/");
  const tile = page.locator(".home-project").filter({
    has: page.locator(".home-name").getByText(project.name, { exact: true }),
  });
  const tiles = menu(page, project.name);

  await tile.focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    tiles.getByRole("menuitem", { name: "Open", exact: true }),
  ).toBeFocused();
  await expect(tiles.getByRole("menuitem")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(tiles).toBeHidden();
  await expect(tile).toBeFocused();
  await expect(page).toHaveURL(/\/$/);

  await tile.click({ button: "right" });
  await tiles.getByRole("menuitem", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#project/${project.id}`));
});

test("a right-click on the picture picks the clip drawn there and opens its menu", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(
    request,
    { name: "Picture menu", width: 640, height: 360, duration: 4 },
    `<!doctype html><html><head><style>
html,body{margin:0;background:#142039}
main{position:relative;width:640px;height:360px;overflow:hidden}
.clip{position:absolute}
#shot{inset:0;background:#24406b}
#title{left:60px;top:100px;width:200px;height:50px;background:#d9482b}
</style></head><body>
<main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="4">
<div id="shot" class="clip" data-start="0" data-duration="4" data-track-index="0" data-label="Shot"></div>
<div id="title" class="clip" data-start="0" data-duration="4" data-track-index="1" data-label="Title"></div>
</main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  const box = (await page.locator(".edit-picture").boundingBox())!;
  const scale = box.width / 640;
  const enabled = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline.clips.map((clip) => [clip.id, clip.enabled]);
  const clips = menu(page, "Clip");

  await page.mouse.click(box.x + 100 * scale, box.y + 120 * scale, {
    button: "right",
  });
  await expect(clips).toBeVisible();
  await expect(page.locator('[data-clip="title"]')).toHaveClass(/selected/);
  await row(clips, "editClipEnabled").click();
  await expect.poll(enabled).toEqual([
    ["shot", true],
    ["title", false],
  ]);
  await page.keyboard.press("Control+z");
  await expect.poll(enabled).toEqual([
    ["shot", true],
    ["title", true],
  ]);
});

test("Ctrl+Alt+K lists every binding from the keymap, searchable, and closes with Escape", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Shortcut sheet" },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.getByRole("toolbar", { name: "Tools" })).toBeVisible();
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  const binding = (action: Action) =>
    sheet
      .locator("dl > div")
      .filter({
        has: page
          .locator("dt")
          .getByText(keymap[action].label, { exact: true }),
      })
      .locator("kbd");

  // Shift+/ is Resolve's Play Around Current Clip, so it is left alone.
  await page.keyboard.press("Shift+?");
  await expect(sheet).toBeHidden();
  await page.keyboard.press("Control+Alt+k");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("dt")).toHaveCount(Object.keys(keymap).length);
  await expect(binding("editDelete")).toHaveText(["Shift+X", "Delete"]);
  await expect(
    sheet.getByRole("region", { name: "Edit" }).locator("dt").first(),
  ).toHaveText(keymap.editCopy.label);

  // The search field has focus, so typing filters and never runs a shortcut.
  await page.keyboard.type("ripple");
  await expect(sheet.locator("dt")).toHaveText([
    keymap.trimRippleStartToPlayhead.label,
    keymap.trimRippleEndToPlayhead.label,
    keymap.editDelete.label,
  ]);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // Settings leads to the same sheet.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: keymap.resolveCustomizedActions.label })
    .click();
  await expect(sheet).toBeVisible();
});
