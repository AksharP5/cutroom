import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { startMediaDrag } from "./media-drag";

async function open(page: Page, request: APIRequestContext, extra = "") {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Ripple feedback" },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>body{margin:0;background:#171717;color:white;font-family:sans-serif}.clip{position:absolute;left:10%;top:40%;font-size:72px}</style></head><body><main data-composition-id="main" data-width="1920" data-height="1080" data-duration="40" data-fps="30">
    <div id="shot" class="clip" data-label="Project title" data-start="0" data-duration="30" data-track-index="0">Every edit has a consequence<br>Second line stays out of the timeline</div>
    <div id="after" class="clip" data-label="End title" data-start="30" data-duration="10" data-track-index="0">A clear finish</div>${extra}
    </main></body></html>`,
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="shot"]')).toBeVisible();
  await expect(page.locator(".tl-grid")).toHaveAttribute(
    "data-refit",
    "settled",
  );
  const seek = async (digits: string) => {
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page.getByLabel("Go to time").pressSequentially(digits);
    await page.keyboard.press("Enter");
  };
  return { project, base, read, seek };
}

const otherTracks = Array.from(
  { length: 5 },
  (_, i) =>
    `<div id="other-${i}" class="clip" data-label="Title ${i + 1}" data-start="${i + 2}" data-duration="2" data-track-index="${i + 1}">Title text ${i + 1}</div>`,
).join("");

test("a multi-track Q reports removed time and deleted clips, and its Undo restores the edit", async ({
  page,
  request,
}, info) => {
  const { read, seek } = await open(page, request, otherTracks);
  const before = (await read()).timeline;
  await page.screenshot({ path: info.outputPath("before-ripple.png") });
  await seek("2717");
  await page.keyboard.press("q");
  const notice = page
    .getByRole("status")
    .filter({ hasText: "Removed 27:17 from 6 tracks. 5 clips deleted." });
  await expect(notice).toBeVisible();
  await page.screenshot({ path: info.outputPath("large-ripple.png") });
  await notice.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await read()).timeline).toEqual(before);
  await expect(notice).toHaveCount(0);
  // Local edit receipts and local undo must never reappear as outside edits.
  await page.waitForTimeout(1000);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("later history removes the ripple Undo even when the timeline is unchanged", async ({
  page,
  request,
}) => {
  const { base, seek, read } = await open(page, request, otherTracks);
  await seek("2717");
  await page.keyboard.press("q");
  const notice = page.getByRole("status").filter({ hasText: "Removed 27:17" });
  await expect(notice).toBeVisible();
  const { revision } = await read();
  expect(
    (
      await request.post(`${base}/review`, {
        data: {
          body: "Keep this note",
          time: 0,
          compositionPath: "index.html",
        },
      })
    ).ok(),
  ).toBe(true);
  await expect(notice).toHaveCount(0);
  expect((await read()).revision).toBe(revision);
});

test("a simple same-track Q stays silent", async ({ page, request }) => {
  const { read, seek } = await open(page, request);
  await seek("0100");
  await page.keyboard.press("q");
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.find((clip) => clip.id === "shot")
          ?.duration,
    )
    .toBe(870);
  await page.waitForTimeout(1000);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("an outside notice waits behind ripple Undo without resetting its hold", async ({
  page,
  request,
}) => {
  const { project, read, seek } = await open(page, request, otherTracks);
  await seek("2717");
  await page.clock.install();
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      "Every edit has a consequence",
      "Changed on disk",
    ),
  );
  await expect(page.locator('[data-clip-label="shot"] .tl-text')).toHaveText(
    "Changed on disk",
  );
  const before = (await read()).timeline;
  await page.keyboard.press("q");
  const ripple = page.getByRole("status").filter({ hasText: "Removed 27:17" });
  await expect(
    ripple.getByRole("button", { name: "Undo", exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(1000);
  await expect(
    ripple.getByRole("button", { name: "Undo", exact: true }),
  ).toBeVisible();
  await ripple.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await read()).timeline).toEqual(before);
  const outside = page
    .getByRole("status")
    .filter({ hasText: "Outside edit updated 1 clip." });
  await expect(outside).toBeVisible();
  await page.clock.fastForward(1000);
  await expect(outside).toBeVisible();
  await page.clock.fastForward(4000);
  await expect(outside).toHaveCount(0);
});

test("owner imports, media drops, view preferences and source saves stay silent", async ({
  page,
  request,
}) => {
  const { base, read } = await open(
    page,
    request,
    '<div id="other" class="clip" data-start="2" data-duration="2" data-track-index="1">Another title</div>',
  );
  await page.evaluate(() => {
    const notices: string[] = [];
    Reflect.set(window, "ownerNotices", notices);
    new MutationObserver(() => {
      const text = document.querySelector(
        '.toast[role="status"] span',
      )?.textContent;
      if (text) notices.push(text);
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  const media = page.getByRole("region", { name: "Media", exact: true });
  await media.locator('input[type="file"]').setInputFiles({
    name: "owner.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>',
    ),
  });
  const row = media.getByRole("listitem").filter({ hasText: "owner.svg" });
  await startMediaDrag(page, row);
  const lane = (await page.locator('.tl-lane[data-row="1"]').boundingBox())!;
  const ppf = await page
    .locator(".tl-grid")
    .evaluate((grid) => Number(grid.style.getPropertyValue("--ppf")));
  await page.mouse.move(lane.x + 300 * ppf, lane.y + lane.height / 2, {
    steps: 10,
  });
  await page.mouse.move(lane.x + 300 * ppf, lane.y + lane.height / 2);
  await page.mouse.up();
  await expect
    .poll(async () =>
      (await read()).timeline.clips.some(
        (clip) => clip.src === "assets/owner.svg",
      ),
    )
    .toBe(true);
  await page.getByRole("combobox", { name: "Track density" }).click();
  await page.getByRole("option", { name: "Compact", exact: true }).click();
  const source = SourceSchema.parse(
    await (await request.get(`${base}/source`)).json(),
  );
  expect(
    (
      await request.put(`${base}/source`, {
        data: {
          path: "index.html",
          expectedVersion: source.version,
          content: source.content.replace(
            "Every edit has a consequence",
            "Owner source save",
          ),
        },
      })
    ).ok(),
  ).toBe(true);
  await expect(page.locator('[data-clip-label="shot"] .tl-text')).toHaveText(
    "Owner source save",
  );
  await page.waitForTimeout(1000);
  expect(
    await page.evaluate(() => Reflect.get(window, "ownerNotices")),
  ).toEqual([]);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("outside agent moves coalesce by clip, preserve focus, and expire", async ({
  page,
  request,
}, info) => {
  const { base, read } = await open(page, request, otherTracks);
  await page.getByRole("textbox", { name: "Message your agent" }).focus();
  await page.evaluate(() => {
    const notices: string[] = [];
    Object.assign(window, { feedbackNotices: notices });
    new MutationObserver(() => {
      const text = document.querySelector(
        '.toast[role="status"] span',
      )?.textContent;
      if (text && notices.at(-1) !== text) notices.push(text);
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  for (const id of ["other-0", "other-1", "other-2", "other-0"]) {
    const { revision } = await read();
    expect(
      (
        await request.post(`${base}/commands`, {
          headers: {
            "x-cutroom-agent": "external",
            "x-cutroom-agent-name": "Checkpoint",
          },
          data: {
            expectedRevision: revision,
            label: "Moved title",
            commands: [{ type: "move", clipIds: [id], by: 15 }],
          },
        })
      ).ok(),
    ).toBe(true);
  }
  const notice = page
    .getByRole("status")
    .filter({ hasText: "Checkpoint moved 3 clips." });
  await expect(notice).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message your agent" }),
  ).toBeFocused();
  await page.screenshot({ path: info.outputPath("agent-notice.png") });
  expect(
    await page.evaluate(() => Reflect.get(window, "feedbackNotices")),
  ).toEqual(["Checkpoint moved 3 clips."]);
  await expect(notice).toHaveCount(0, { timeout: 6000 });
});

test("title text uses its first line at normal and compact heights and refreshes after a file edit", async ({
  page,
  request,
}, info) => {
  const { project, base } = await open(page, request);
  const text = page.locator('[data-clip-label="shot"] .tl-text');
  await expect(text).toHaveText("Every edit has a consequence");
  await page.screenshot({ path: info.outputPath("titles-normal.png") });
  await page.getByRole("combobox", { name: "Track density" }).click();
  await page.getByRole("option", { name: "Compact", exact: true }).click();
  const height = page.getByRole("separator", { name: "Height V1" });
  await expect(height).toHaveAttribute("aria-valuenow", "32");
  await height.focus();
  await height.press("ArrowUp");
  await height.press("ArrowUp");
  await expect(height).toHaveAttribute("aria-valuenow", "28");
  const clip = (await page.locator('[data-clip="shot"]').boundingBox())!;
  const bodyText = (await text.boundingBox())!;
  expect(bodyText.y).toBeGreaterThan(clip.y + 12);
  expect(bodyText.y + bodyText.height).toBeLessThanOrEqual(
    clip.y + clip.height,
  );
  await page.screenshot({ path: info.outputPath("titles-compact.png") });
  const source = SourceSchema.parse(
    await (await request.get(`${base}/source`)).json(),
  );
  // The watcher path also covers edits made outside the API.
  await writeFile(
    join(project.path, "index.html"),
    source.content.replace(
      "Every edit has a consequence",
      "A title updated on disk &amp; in the timeline",
    ),
  );
  await expect(text).toHaveText("A title updated on disk & in the timeline");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Outside edit updated 1 clip." }),
  ).toBeVisible();
  // A narrow clip hides the preview rather than spilling into the next one.
  const current = SourceSchema.parse(
    await (await request.get(`${base}/source`)).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    current.content.replace(
      'data-duration="30" data-track-index="0"',
      'data-duration="0.1" data-track-index="0"',
    ),
  );
  await expect(text).toHaveCount(0);
});
