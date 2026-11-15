import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";

/** Three 3-second shots on V1, a card on V2 at 9 s, and markers at 1 s and 5 s. */
async function open(page: Page, request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Resolve keys" },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  const shots = [1, 2, 3].map(
    (n) =>
      `<div id="shot-${n}" class="clip" data-start="${(n - 1) * 3}" data-duration="3" data-track-index="0">Shot ${n}</div>`,
  );
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      /<main([^>]*)>[\s\S]*<\/main>/,
      `<main$1>\n${shots.join("\n")}\n<div id="card" class="clip" data-start="9" data-duration="3" data-track-index="1">Card</div>\n</main>`,
    ),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  const response = await request.post(`${api}/commands`, {
    data: {
      expectedRevision: (await read()).revision,
      commands: [
        { type: "setMarker", frame: 30, name: "One" },
        { type: "setMarker", frame: 150, name: "Five" },
      ],
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(4);
  const clip = async (id: string) => {
    const found = (await read()).timeline.clips.find((item) => item.id === id);
    return found && [found.track, found.start, found.duration];
  };
  return {
    clip,
    select: (id: string) =>
      timeline
        .locator(`[data-clip="${id}"]`)
        .click({ position: { x: 20, y: 10 } }),
    clock: page.getByRole("button", { name: /^Current time/ }),
    notice: page.getByRole("status"),
  };
}

test(", and . nudge the selected clip a frame, overwriting its neighbour, each one undo step", async ({
  page,
  request,
}) => {
  const { clip, select } = await open(page, request);
  await select("shot-2");
  await page.keyboard.press(".");
  await expect.poll(() => clip("shot-2")).toEqual([0, 91, 90]);
  await expect.poll(() => clip("shot-3")).toEqual([0, 181, 89]);
  await page.keyboard.press("Control+z");
  await expect.poll(() => clip("shot-3")).toEqual([0, 180, 90]);
  await expect.poll(() => clip("shot-2")).toEqual([0, 90, 90]);
  await page.keyboard.press("Shift+Comma");
  await expect.poll(() => clip("shot-2")).toEqual([0, 85, 90]);
  await expect.poll(() => clip("shot-1")).toEqual([0, 0, 85]);
  await page.keyboard.press(",");
  await expect.poll(() => clip("shot-2")).toEqual([0, 84, 90]);
});

test("Alt+Up and Alt+Down move the selected clip between video tracks and say when there is none", async ({
  page,
  request,
}) => {
  const { clip, select } = await open(page, request);
  // The card is on the top video track already. A refusal is the engine's reason, as W's is.
  await select("card");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.getByRole("alert")).toContainText(
    "No track above the selected clips.",
  );
  await select("shot-1");
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => clip("shot-1")).toEqual([1, 0, 90]);
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => clip("shot-1")).toEqual([0, 0, 90]);
});

test("a refusal shown while an earlier edit is saving stays after that edit lands", async ({
  page,
  request,
}) => {
  const { clip, select } = await open(page, request);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/cutroom/projects/*/commands", async (route) => {
    await held;
    await route.continue();
  });
  await select("shot-1");
  await page.keyboard.press("Alt+ArrowUp");
  // While the move is saving, the card cannot go up: it is on the top video track.
  await select("card");
  await page.keyboard.press("Alt+ArrowUp");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("No track above the selected clips.");
  // The move's reply is followed by a history read; the refusal must outlive both.
  const settled = page.waitForResponse(
    (response) =>
      response.url().endsWith("/history") &&
      response.request().method() === "GET",
  );
  release();
  await settled;
  await expect.poll(() => clip("shot-1")).toEqual([1, 0, 90]);
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  await expect(alert).toContainText("No track above the selected clips.");
});

test("Shift+Up and Shift+Down go to the previous and next marker", async ({
  page,
  request,
}) => {
  const { clock, notice } = await open(page, request);
  await seekFrame(page, 0);
  await page.locator(".edit-timeline").focus();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(clock).toHaveText("00:00:01:00");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(clock).toHaveText("00:00:05:00");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(notice).toContainText("No marker after the playhead.");
  await expect(clock).toHaveText("00:00:05:00");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(clock).toHaveText("00:00:01:00");
});

test("Ctrl+D types a new duration into the inspector, and R says when a clip has no speed", async ({
  page,
  request,
}) => {
  const { clip, select, notice } = await open(page, request);
  await page.keyboard.press("Control+d");
  await expect(notice).toContainText("Select one clip to change its duration.");
  await select("shot-3");
  await page.keyboard.press("Control+d");
  const duration = page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("textbox", { name: "Duration", exact: true });
  await expect(duration).toBeFocused();
  await page.keyboard.type("00:00:02:00");
  await page.keyboard.press("Enter");
  await expect.poll(() => clip("shot-3")).toEqual([0, 180, 60]);
  await select("shot-1");
  await page.keyboard.press("r");
  await expect(notice).toContainText("This clip has no speed to change.");
});

test("preset keys Cutroom lacks say so instead of nothing", async ({
  page,
  request,
}) => {
  const { select, notice } = await open(page, request);
  await select("shot-1");
  await page.keyboard.press("v");
  await expect(notice).toContainText(
    "Cutroom has no edit point selection yet (V).",
  );
  await page.keyboard.press("Shift+r");
  await expect(notice).toContainText(
    "Cutroom has no freeze frames yet (Shift+R).",
  );
});
