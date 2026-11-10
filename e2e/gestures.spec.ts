import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

/**
 * A project with four 3-second shots on V1 and a title on V2 over the first, opened in the
 * editor a new install gets. `at` gives the screen point of a frame on a track's row.
 */
async function open(page: Page, request: APIRequestContext, name: string) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", { data: { name } })
    ).json(),
  );
  const index = join(project.path, "index.html");
  const clips = [
    ...Array.from(
      { length: 4 },
      (_, n) =>
        `<div id="shot-${n + 1}" class="clip" data-start="${n * 3}" data-duration="3" data-track-index="0">Shot ${n + 1}</div>`,
    ),
    '<div id="title" class="clip" data-start="0" data-duration="3" data-track-index="1">Title</div>',
  ];
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      /<main([^>]*)data-duration="12"([^>]*)>[\s\S]*<\/main>/,
      `<main$1data-duration="20"$2>\n${clips.join("\n")}\n</main>`,
    ),
  );
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(5);
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    ).timeline.clips.map((clip) => [
      clip.id,
      clip.track,
      clip.start,
      clip.duration,
    ]);
  const lanes = timeline.locator(".tl-lanes");
  const at = async (frame: number, row: "V2" | "V1" | "A1" = "V1") => {
    // Clips still sliding after the last edit are not yet where a frame is.
    await expect
      .poll(() =>
        lanes.evaluate(
          (element) =>
            element
              .getAnimations({ subtree: true })
              // Durations fade with the scroll position on a CSS animation that never ends.
              .filter((animation) => !(animation instanceof CSSAnimation))
              .length,
        ),
      )
      .toBe(0);
    const box = await lanes.boundingBox();
    if (!box) throw new Error("The timeline has no lanes.");
    const ppf = Number(
      await timeline
        .locator(".tl-grid")
        .evaluate((grid) => grid.style.getPropertyValue("--ppf")),
    );
    // Rows are 56px video tracks over 44px audio tracks, with a hairline under each.
    const y = { V2: 28, V1: 57 + 28, A1: 57 * 2 + 2 + 22 }[row];
    return { x: box.x + frame * ppf, y: box.y + y };
  };
  /** Presses at one frame and releases at another, moving through the frames between. */
  const drag = async (
    from: Awaited<ReturnType<typeof at>>,
    to: Awaited<ReturnType<typeof at>>,
    release = true,
  ) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    if (release) await page.mouse.up();
  };
  return { project, timeline, read, at, drag, initial: await read() };
}

const shots = [
  ["shot-1", 0, 0, 90],
  ["shot-2", 0, 90, 90],
  ["shot-3", 0, 180, 90],
  ["shot-4", 0, 270, 90],
];
const title = ["title", 1, 0, 90];

test("dragging a clip moves it along its track and onto another, one undo step each", async ({
  page,
  request,
}) => {
  const { timeline, read, at, drag, initial } = await open(
    page,
    request,
    "Drag move",
  );
  let commands = 0;
  page.on("request", (sent) => {
    if (sent.url().endsWith("/commands")) commands++;
  });
  expect(initial).toEqual([...shots, title]);

  // Nothing is sent while the pointer is down, and the clip is drawn where it will land.
  await drag(await at(300), await at(360), false);
  expect(commands).toBe(0);
  const held = await timeline
    .locator('[data-clip="shot-4"]')
    .evaluate((clip) => new DOMMatrix(getComputedStyle(clip).transform).e);
  expect(held).toBeGreaterThan(100);
  await page.mouse.up();
  await expect
    .poll(read)
    .toEqual([...shots.slice(0, 3), ["shot-4", 0, 330, 90], title]);
  expect(commands).toBe(1);

  // Up a track, where the far end of the title's track is free.
  await drag(await at(360), await at(360, "V2"));
  await expect
    .poll(read)
    .toEqual([...shots.slice(0, 3), title, ["shot-4", 1, 330, 90]]);

  // A dragged edge jumps to the nearest clip edge: a rough drop lands frame-exact against shot 3.
  await drag(await at(380, "V2"), await at(321, "V2"));
  await expect
    .poll(read)
    .toEqual([...shots.slice(0, 3), title, ["shot-4", 1, 270, 90]]);

  // Over another clip the engine refuses, and nothing changes.
  await drag(await at(300, "V2"), await at(60, "V2"));
  await expect(page.locator(".toast span")).toHaveText(
    "Clip shot-4 would overlap title on V2.",
  );
  await page.getByRole("button", { name: "Dismiss" }).click();

  for (const state of [
    [...shots.slice(0, 3), title, ["shot-4", 1, 330, 90]],
    [...shots.slice(0, 3), ["shot-4", 0, 330, 90], title],
    initial,
  ]) {
    await page.keyboard.press("Control+z");
    await expect.poll(read).toEqual(state);
  }
});

test("edges resize with Select and ripple or roll with Trim, and the blade cuts where it clicks", async ({
  page,
  request,
}) => {
  const { timeline, read, at, drag, initial } = await open(
    page,
    request,
    "Drag trim",
  );
  const states: unknown[][][] = [initial];
  const expectClips = async (expected: unknown[][]) => {
    await expect.poll(read).toEqual(expected);
    states.push(expected);
  };

  // Select: the last shot's end comes in a second, and nothing else moves.
  await drag(await at(359), await at(329));
  await expectClips([...shots.slice(0, 3), ["shot-4", 0, 270, 60], title]);

  // Trim: the first shot's end comes in a second and every later clip closes up.
  await page.keyboard.press("t");
  await expect(page.getByRole("button", { name: /^Trim/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await drag(await at(87), await at(57));
  await expectClips([
    ["shot-1", 0, 0, 60],
    ["shot-2", 0, 60, 90],
    ["shot-3", 0, 150, 90],
    ["shot-4", 0, 240, 60],
    ["title", 1, 0, 60],
  ]);

  // Trim, on the cut between shots 2 and 3: the cut rolls and no clip changes place.
  await drag(await at(150), await at(165));
  await expectClips([
    ["shot-1", 0, 0, 60],
    ["shot-2", 0, 60, 105],
    ["shot-3", 0, 165, 75],
    ["shot-4", 0, 240, 60],
    ["title", 1, 0, 60],
  ]);

  // Blade: a click cuts the clip under it at that frame.
  await page.keyboard.press("b");
  const cut = await at(200);
  await page.mouse.click(cut.x, cut.y);
  await expectClips([
    ["shot-1", 0, 0, 60],
    ["shot-2", 0, 60, 105],
    ["shot-3", 0, 165, 35],
    [expect.stringMatching(/^shot-3-[a-z0-9]{6}$/), 0, 200, 40],
    ["shot-4", 0, 240, 60],
    ["title", 1, 0, 60],
  ]);
  await expect(timeline.locator("[data-clip]")).toHaveCount(6);

  for (const state of states.toReversed().slice(1)) {
    await page.keyboard.press("Control+z");
    await expect.poll(read).toEqual(state);
  }
});

test("Esc cancels a drag and keeps the tool and the selection", async ({
  page,
  request,
}) => {
  const { timeline, read, at, drag, initial } = await open(
    page,
    request,
    "Drag cancel",
  );
  let commands = 0;
  page.on("request", (sent) => {
    if (sent.url().endsWith("/commands")) commands++;
  });
  await page.keyboard.press("t");
  await drag(await at(87), await at(40), false);
  await expect(timeline.locator(".tl-readout")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(timeline.locator(".tl-readout")).toBeHidden();
  await page.mouse.up();

  await expect(page.getByRole("button", { name: /^Trim/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(timeline.locator("[data-clip].selected")).toHaveCount(1);
  await expect(timeline.locator('[data-clip="shot-1"]')).toHaveCSS(
    "transform",
    "none",
  );
  expect(commands).toBe(0);
  expect(await read()).toEqual(initial);
});

test("media dragged from the Media panel lands on a track as one undo step", async ({
  page,
  request,
}) => {
  const { project, timeline, read, at, initial } = await open(
    page,
    request,
    "Media drop",
  );
  await promisify(execFile)("ffmpeg", [
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x180:r=30:d=2",
    "-y",
    join(project.path, "red.mp4"),
  ]);
  const row = page
    .getByRole("region", { name: "Media", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "red.mp4" });
  await expect(row).toHaveAttribute("draggable", "true");
  const hold = async (to: Awaited<ReturnType<typeof at>>) => {
    await row.hover();
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.move(to.x, to.y);
  };

  // Picture is refused on an audio track: the ghost says so and the drop does nothing.
  await hold(await at(420, "A1"));
  await expect(timeline.locator(".tl-lanes")).toHaveAttribute(
    "data-refused",
    "",
  );
  await page.mouse.up();
  expect(await read()).toEqual(initial);

  // Free space takes the clip as it is.
  await hold(await at(420));
  await expect(timeline.locator(".tl-ghost")).toBeVisible();
  await page.mouse.up();
  const placed = [
    ...shots,
    [expect.stringMatching(/^red-[a-z0-9]{6}$/), 0, 420, 60],
    title,
  ];
  await expect.poll(read).toEqual(placed);

  // Over a clip it is inserted: the cut it lands on opens, and every track makes room.
  await hold(await at(92));
  await page.mouse.up();
  await expect
    .poll(read)
    .toEqual([
      shots[0],
      [expect.stringMatching(/^red-[a-z0-9]{6}$/), 0, 90, 60],
      ["shot-2", 0, 150, 90],
      ["shot-3", 0, 240, 90],
      ["shot-4", 0, 330, 90],
      [expect.stringMatching(/^red-[a-z0-9]{6}$/), 0, 480, 60],
      title,
    ]);

  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(placed);
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(initial);
});
