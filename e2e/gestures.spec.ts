import { startMediaDrag } from "./media-drag";
import { execFile } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";

/**
 * A project with four 3-second shots on V1 and a title on V2 over the first, opened in the
 * editor a new install gets. `at` gives the screen point of a frame on a track's row.
 */
async function open(
  page: Page,
  request: APIRequestContext,
  name: string,
  linked = false,
) {
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
        `<div id="shot-${n + 1}" class="clip" data-start="${n * 3}" data-duration="3" data-track-index="0"${linked && n === 3 ? ' data-link="pair"' : ""}>Shot ${n + 1}</div>`,
    ),
    '<div id="title" class="clip" data-start="0" data-duration="3" data-track-index="1">Title</div>',
    ...(linked
      ? [
          '<audio id="partner" data-start="9" data-duration="3" data-track-index="2" data-link="pair"></audio>',
        ]
      : []),
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
  await expect(timeline.locator("[data-clip]")).toHaveCount(clips.length);
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
    await expect(timeline.locator(".tl-grid")).toHaveAttribute(
      "data-refit",
      "settled",
    );
    // Clips still sliding after the last edit are not yet where a frame is.
    await expect(lanes).not.toHaveAttribute("data-sliding");
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
    const lane = await lanes
      .locator(".tl-lane")
      .nth({ V2: 0, V1: 1, A1: 2 }[row])
      .boundingBox();
    if (!lane) throw new Error(`No bounds for ${row}`);
    return { x: box.x + frame * ppf, y: lane.y + lane.height / 2 };
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
  const agent = async (commands: CommandInput[]) => {
    const view = TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
    const response = await request.post(`${api}/commands`, {
      data: { expectedRevision: view.revision, label: "Agent", commands },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  return { project, timeline, read, at, drag, agent, initial: await read() };
}

async function refusalEvidence(page: Page, name: string) {
  const directory = process.env.CUTROOM_REFUSAL_EVIDENCE;
  if (!directory) return;
  await expect(page.locator(".toast")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: join(directory, name) });
}

const shots = [
  ["shot-1", 0, 0, 90],
  ["shot-2", 0, 90, 90],
  ["shot-3", 0, 180, 90],
  ["shot-4", 0, 270, 90],
];
const title = ["title", 1, 0, 90];

for (const target of ["shot-4", "partner"]) {
  test(`a held drag refuses an agent's change to ${target}`, async ({
    page,
    request,
  }) => {
    const { timeline, read, at, drag, agent } = await open(
      page,
      request,
      "Concurrent drag",
      true,
    );
    let sent = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/commands")) sent++;
    });
    await drag(await at(300), await at(330), false);
    await agent([{ type: "move", clipIds: [target], by: 15, linked: false }]);
    await expect
      .poll(() =>
        timeline
          .locator(`[data-clip="${target}"]`)
          .evaluate((clip) => clip.style.getPropertyValue("--s")),
      )
      .toBe("285");
    const after = await read();
    await page.mouse.up();
    await expect(page.locator(".toast span")).toHaveText(
      "An agent changed those clips first.",
    );
    expect(sent).toBe(0);
    expect(await read()).toEqual(after);
    await expect(timeline.locator(".tl-readout")).toBeHidden();
  });
}

test("unrelated agent edits leave a held drag's original destination intact", async ({
  page,
  request,
}) => {
  const { timeline, read, at, drag, agent } = await open(
    page,
    request,
    "Unrelated drag",
  );
  await drag(await at(300), await at(330), false);
  await agent([{ type: "move", clipIds: ["title"], by: 15 }]);
  await expect
    .poll(() =>
      timeline
        .locator('[data-clip="title"]')
        .evaluate((clip) => clip.style.getPropertyValue("--s")),
    )
    .toBe("15");
  await page.mouse.up();
  await expect
    .poll(read)
    .toEqual([
      ...shots.slice(0, 3),
      ["shot-4", 0, 300, 90],
      ["title", 1, 15, 90],
    ]);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("an agent changing a linked partner before send also refuses the released drag", async ({
  page,
  request,
}) => {
  const { timeline, read, at, drag, agent } = await open(
    page,
    request,
    "Queued drag",
    true,
  );
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route("**/commands", async (route) => {
    if (first) {
      first = false;
      await gate;
    }
    await route.fulfill({ response: await route.fetch() });
  });
  await drag(await at(300), await at(330));
  await expect
    .poll(() =>
      timeline
        .locator('[data-clip="shot-4"]')
        .evaluate((clip) => clip.style.getPropertyValue("--s")),
    )
    .toBe("300");
  await agent([{ type: "move", clipIds: ["partner"], by: 15, linked: false }]);
  const after = await read();
  release();
  await expect(page.locator(".toast span")).toHaveText(
    "An agent changed those clips first.",
  );
  expect(await read()).toEqual(after);
});

for (const arrival of ["move", "insert"] as const) {
  for (const timing of ["held", "retry"] as const) {
    test(`an agent's ${arrival} into an empty overwrite destination refuses the ${timing} drag`, async ({
      page,
      request,
    }, testInfo) => {
      const { project, timeline, read, at, drag, agent } = await open(
        page,
        request,
        "Occupied destination",
      );
      await agent([
        { type: "trim", clipId: "shot-4", edge: "end", to: 300 },
        { type: "trim", clipId: "title", edge: "end", to: 30 },
      ]);
      await expect
        .poll(() =>
          timeline
            .locator('[data-clip="shot-4"]')
            .evaluate((clip) => clip.style.getPropertyValue("--d")),
        )
        .toBe("30");
      await expect
        .poll(() =>
          timeline
            .locator('[data-clip="title"]')
            .evaluate((clip) => clip.style.getPropertyValue("--d")),
        )
        .toBe("30");
      await timeline
        .getByRole("button", { name: "Zoom in", exact: true })
        .click();
      if (arrival === "insert")
        await writeFile(
          join(project.path, "incoming.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>',
        );
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let sent = 0;
      const statuses: number[] = [];
      if (timing === "retry")
        await page.route("**/commands", async (route) => {
          sent++;
          if (sent === 1) await gate;
          const response = await route.fetch();
          statuses.push(response.status());
          await route.fulfill({ response });
        });
      else
        page.on("request", (request) => {
          if (request.url().endsWith("/commands")) sent++;
        });
      try {
        // shot-4 [270,300) is held over the initially empty [330,360).
        await drag(await at(285), await at(345), timing === "retry");
        if (timing === "retry") await expect.poll(() => sent).toBe(1);
        await agent(
          arrival === "move"
            ? [{ type: "move", clipIds: ["title"], by: 330, trackBy: -1 }]
            : [
                {
                  type: "insert",
                  track: 0,
                  at: 330,
                  clip: {
                    id: "incoming",
                    kind: "image",
                    src: "incoming.svg",
                    duration: 30,
                  },
                },
              ],
        );
        const after = await read();
        release();
        await expect(page.locator(".toast span")).toHaveText(
          "An agent changed those clips first.",
        );
        if (timing === "held") {
          await expect(timeline.locator(".tl-readout")).toBeHidden();
          await page.mouse.up();
        } else {
          await expect.poll(() => statuses).toEqual([409]);
        }
        await expect.poll(read).toEqual(after);
        await expect
          .poll(() =>
            timeline
              .locator('[data-clip="shot-4"]')
              .evaluate((clip) => clip.style.getPropertyValue("--s")),
          )
          .toBe("270");
        await expect(
          timeline.locator(
            `[data-clip="${arrival === "move" ? "title" : "incoming"}"]`,
          ),
        ).toBeVisible();
        expect(sent).toBe(timing === "held" ? 0 : 1);
        await at(345);
        await page.screenshot({
          path: testInfo.outputPath("destination-refused.png"),
        });
      } finally {
        release();
      }
    });
  }
}

for (const key of ["c", "Control", "Meta"]) {
  test(`${key} changes a stationary drag's snap before release`, async ({
    page,
    request,
  }) => {
    const { timeline, read, at, drag, agent } = await open(
      page,
      request,
      "Stationary snap",
    );
    await agent([{ type: "setMarker", frame: 480 }]);
    await expect(timeline.locator(".tl-marker")).toHaveCount(1);
    // The shot's end reaches 482, then snaps back to 480.
    await drag(await at(300), await at(422), false);
    const snap = timeline.locator(".tl-snap");
    await expect(snap).toBeVisible();
    if (key === "c") await page.keyboard.press(key);
    else await page.keyboard.down(key);
    await expect(snap).toBeHidden();
    if (key === "Control") {
      await page.keyboard.up(key);
      await expect(snap).toBeVisible();
      await page.keyboard.down(key);
      await expect(snap).toBeHidden();
    }
    await page.mouse.up();
    if (key !== "c") await page.keyboard.up(key);
    await expect
      .poll(read)
      .toEqual([...shots.slice(0, 3), ["shot-4", 0, 392, 90], title]);
  });
}

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

  // Over another clip, only the covered frames disappear.
  await drag(await at(300, "V2"), await at(60, "V2"));
  await expect
    .poll(read)
    .toEqual([
      ...shots.slice(0, 3),
      ["title", 1, 0, 30],
      ["shot-4", 1, 30, 90],
    ]);

  for (const state of [
    [...shots.slice(0, 3), title, ["shot-4", 1, 270, 90]],
    [...shots.slice(0, 3), title, ["shot-4", 1, 330, 90]],
    [...shots.slice(0, 3), ["shot-4", 0, 330, 90], title],
    initial,
  ]) {
    await page.keyboard.press("Control+z");
    await expect.poll(read).toEqual(state);
  }
});

test("a drag overwrites and splits the covered clip, with one undo step", async ({
  page,
  request,
}) => {
  const { timeline, read, at, drag, agent } = await open(
    page,
    request,
    "Move overwrite",
  );
  await agent([{ type: "trim", clipId: "shot-4", edge: "end", to: 300 }]);
  await expect
    .poll(() =>
      timeline
        .locator('[data-clip="shot-4"]')
        .evaluate((clip) => clip.style.getPropertyValue("--d")),
    )
    .toBe("30");
  // Keep the same zoom across the edit rather than fitting the changed timeline length.
  await timeline.getByRole("button", { name: "Zoom in", exact: true }).click();
  const before = await read();
  const beforeImage = process.env.CUTROOM_OVERWRITE_EVIDENCE;
  if (beforeImage)
    await page.screenshot({ path: join(beforeImage, "before.png") });
  let commands = 0;
  page.on("request", (sent) => {
    if (sent.url().endsWith("/commands")) commands++;
  });
  await page.keyboard.press("c");
  await drag(await at(285), await at(135), false);
  await expect(timeline.locator(".tl-lanes")).not.toHaveAttribute(
    "data-refused",
    "",
  );
  await expect(timeline.locator(".tl-piece:visible")).toHaveCount(1);
  const covered = timeline.locator('[data-clip="shot-2"]');
  await expect
    .poll(() =>
      covered.evaluate(
        (clip) => new DOMMatrix(getComputedStyle(clip).transform).a,
      ),
    )
    .toBeCloseTo(1 / 3);
  expect(commands).toBe(0);
  if (beforeImage)
    await page.screenshot({ path: join(beforeImage, "preview.png") });
  await page.mouse.up();
  const after = [
    shots[0],
    ["shot-2", 0, 90, 30],
    ["shot-4", 0, 120, 30],
    [expect.stringMatching(/^shot-2-[a-z0-9]{6}$/), 0, 150, 30],
    shots[2],
    title,
  ];
  await expect.poll(read).toEqual(after);
  await expect(timeline.locator("[data-clip]")).toHaveCount(6);
  expect(commands).toBe(1);
  if (beforeImage) {
    await at(135);
    await page.screenshot({ path: join(beforeImage, "after.png") });
  }
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);
  await expect(timeline.locator("[data-clip]")).toHaveCount(5);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(read).toEqual(after);
  // A fully covered clip disappears while held; cancellation restores its box and name.
  await drag(await at(135), await at(105), false);
  await expect(covered).toBeHidden();
  await expect(timeline.locator('[data-clip-label="shot-2"]')).toBeHidden();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(covered).toBeVisible();
  await expect(timeline.locator('[data-clip-label="shot-2"]')).toBeVisible();
  expect(commands).toBe(1);
  expect(await read()).toEqual(after);
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
  const hold = async (destination: () => ReturnType<typeof at>) => {
    await expect(timeline.locator(".tl-grid")).toHaveAttribute(
      "data-refit",
      "settled",
    );
    await startMediaDrag(page, row);
    const to = await destination();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.move(to.x, to.y);
  };

  // Picture is refused on an audio track: the ghost says so and the drop does nothing.
  await hold(() => at(420, "A1"));
  await expect(timeline.locator(".tl-lanes")).toHaveAttribute(
    "data-refused",
    "",
  );
  await page.mouse.up();
  expect(await read()).toEqual(initial);

  await refusalEvidence(page, "picture-drop.png");
  await expect(page.locator(".toast")).toContainText(
    "Clip red.mp4 is picture and A1 is an audio track.",
  );

  // Free space takes the clip as it is.
  await hold(() => at(420));
  await expect(timeline.locator(".tl-ghost")).toBeVisible();
  await page.mouse.up();
  const placed = [
    ...shots,
    [expect.stringMatching(/^red-[a-z0-9]{6}$/), 0, 420, 60],
    title,
  ];
  await expect.poll(read).toEqual(placed);

  // Overwrite is the default. The interview's tail keeps its original end.
  await hold(() => at(92));
  await page.mouse.up();
  await expect
    .poll(read)
    .toEqual([
      shots[0],
      [expect.stringMatching(/^red-[a-z0-9]{6}$/), 0, 90, 60],
      ["shot-2", 0, 150, 30],
      shots[2],
      shots[3],
      [expect.stringMatching(/^red-[a-z0-9]{6}$/), 0, 420, 60],
      title,
    ]);
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(placed);

  // Ctrl+Shift explicitly inserts and opens the auto-select tracks.
  await hold(() => at(90));
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  const insertPoint = await at(90.5);
  await page.mouse.move(insertPoint.x, insertPoint.y);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
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

test("a refused audio drop explains the destination track kind", async ({
  page,
  request,
}) => {
  const { project, timeline, read, at, agent } = await open(
    page,
    request,
    "Refused audio drop",
  );
  await promisify(execFile)("ffmpeg", [
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=2",
    "-y",
    join(project.path, "tone.wav"),
  ]);
  // A filename beginning with an existing clip id must remain a filename in a refusal.
  await agent([
    {
      type: "insert",
      track: 2,
      at: 0,
      mode: "place",
      clip: { id: "tone", src: "tone.wav", kind: "audio", duration: 60 },
    },
  ]);
  await expect(timeline.locator('[data-clip="tone"]')).toBeVisible();
  // A copied file's name starts with that id and continues after a space.
  await copyFile(
    join(project.path, "tone.wav"),
    join(project.path, "tone (1).wav"),
  );
  const initial = await read();
  const row = page
    .getByRole("region", { name: "Media", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "tone (1).wav" });
  await startMediaDrag(page, row);
  const to = await at(420);
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.move(to.x, to.y);
  await expect(timeline.locator(".tl-lanes")).toHaveAttribute(
    "data-refused",
    "",
  );
  await page.mouse.up();
  await refusalEvidence(page, "audio-drop.png");
  await expect(page.locator(".toast")).toContainText(
    "Clip tone (1).wav is audio and V1 is a video track.",
  );
  expect(await read()).toEqual(initial);
});

test("a refused move names its locked destination", async ({
  page,
  request,
}) => {
  const { timeline, read, at, drag, initial } = await open(
    page,
    request,
    "Locked destination",
  );
  await timeline.getByRole("button", { name: "Lock V2", exact: true }).click();
  await drag(await at(300), await at(300, "V2"));
  await refusalEvidence(page, "locked-track.png");
  await expect(page.locator(".toast")).toContainText("V2 is locked.");
  expect(await read()).toEqual(initial);
});

test("a trim after an overwrite names the short sound partner", async ({
  page,
  request,
}) => {
  const { project, timeline, agent, read } = await open(
    page,
    request,
    "Short sound partner",
    true,
  );
  await promisify(execFile)("ffmpeg", [
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=2",
    "-y",
    join(project.path, "tone.wav"),
  ]);
  await agent([
    { type: "setClip", clipId: "shot-4", label: "red.mp4" },
    { type: "setClip", clipId: "partner", label: "red.mp4" },
    {
      type: "insert",
      mode: "overwrite",
      track: 2,
      at: 300,
      clip: { src: "tone.wav", kind: "audio", duration: 60 },
    },
  ]);
  await expect(timeline.locator('[data-clip="partner"]')).toHaveAttribute(
    "style",
    /--d: 30/,
  );
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("1100");
  await page.keyboard.press("Enter");
  await timeline.locator('[data-clip="shot-4"]').click();
  const before = await read();
  await page.keyboard.press("q");
  await refusalEvidence(page, "short-partner.png");
  await expect(page.locator(".toast")).toContainText(
    "Clip red.mp4 on A1 would be shorter than one frame.",
  );
  expect(await read()).toEqual(before);
});

test("a Media-panel drag during a pending Fit keeps its scale and aimed drop frame", async ({
  page,
  request,
}) => {
  const { project, timeline, read, agent } = await open(
    page,
    request,
    "Media drag holds Fit",
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
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const grid = timeline.locator(".tl-grid");
  // Leave time to grab the media while the real edit motion is still running.
  await grid.evaluate((element: HTMLElement) =>
    element.style.setProperty("--duration-edit", "3000ms"),
  );
  await agent([{ type: "move", clipIds: ["shot-4"], by: 120 }]);
  await expect(timeline.locator('[data-clip="shot-4"]')).toHaveCSS(
    "--s",
    "390",
  );
  await expect(timeline.locator(".tl-lanes")).toHaveAttribute(
    "data-sliding",
    "",
  );
  await expect(grid).toHaveAttribute("data-refit", "pending");
  await startMediaDrag(page, row);
  await expect(grid).toHaveAttribute("data-gesturing", "");
  const ppf = await grid.evaluate((element: HTMLElement) =>
    Number(element.style.getPropertyValue("--ppf")),
  );
  const lanes = timeline.locator(".tl-lanes");
  const box = (await lanes.boundingBox())!;
  const lane = (await lanes.locator(".tl-lane").nth(1).boundingBox())!;
  const aimed = 130;
  const target = { x: box.x + aimed * ppf, y: lane.y + lane.height / 2 };
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await expect(timeline.locator(".tl-ghost")).toBeVisible();
  // Cross the edit's actual animation boundary with the native drag still held.
  await expect(timeline.locator(".tl-lanes")).not.toHaveAttribute(
    "data-sliding",
  );
  await expect
    .poll(() =>
      grid.evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.timeline === document.timeline)
            .length,
      ),
    )
    .toBe(0);
  const held = await grid.evaluate((element: HTMLElement) =>
    Number(element.style.getPropertyValue("--ppf")),
  );
  await page.mouse.move(target.x, target.y);
  await page.mouse.up();
  await expect(grid).not.toHaveAttribute("data-gesturing", "");
  expect.soft(held).toBe(ppf);
  await expect
    .poll(
      async () =>
        (await read()).find(([id]) => String(id).startsWith("red-"))?.[2],
    )
    .toBe(aimed);
});

test("a ruler scrub holds a pending Fit until pointer release", async ({
  page,
  request,
}) => {
  const { timeline, agent } = await open(page, request, "Scrub holds Fit");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const grid = timeline.locator(".tl-grid");
  await grid.evaluate((element: HTMLElement) =>
    element.style.setProperty("--duration-edit", "1500ms"),
  );
  await agent([{ type: "move", clipIds: ["shot-4"], by: 120 }]);
  await expect(grid).toHaveAttribute("data-refit", "pending");
  const scale = () =>
    grid.evaluate((element: HTMLElement) =>
      Number(element.style.getPropertyValue("--ppf")),
    );
  const before = await scale();
  const lanes = (await timeline.locator(".tl-lanes").boundingBox())!;
  const ruler = (await timeline.locator(".tl-ruler").boundingBox())!;
  const target = { x: lanes.x + 130 * before, y: ruler.y + ruler.height / 2 };
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await expect(grid).toHaveAttribute("data-gesturing", "");
  await expect(timeline.locator(".tl-lanes")).not.toHaveAttribute(
    "data-sliding",
  );
  await expect
    .poll(() =>
      grid.evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.timeline === document.timeline)
            .length,
      ),
    )
    .toBe(0);
  expect(await scale()).toBe(before);
  // Switching windows mid-scrub keeps the press, so the scale stays held.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(grid).toHaveAttribute("data-gesturing", "");
  expect(await scale()).toBe(before);
  await page.mouse.move(target.x, target.y);
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    "00:00:04:10",
  );
  await page.mouse.up();
  await expect(grid).not.toHaveAttribute("data-gesturing", "");
  await expect(grid).toHaveAttribute("data-refit", "settled");
  const fitted = await scale();
  expect(fitted).toBeLessThan(before);

  // Only automatic Fit waits: an explicit zoom during a press still applies.
  await page.mouse.down();
  await expect(grid).toHaveAttribute("data-gesturing", "");
  await page.keyboard.press("Control+=");
  await expect.poll(scale).toBeGreaterThan(fitted);
  await page.mouse.up();
});

test("an external file drag freezes Fit while over the timeline and releases on exit", async ({
  page,
  request,
}) => {
  const { timeline, agent } = await open(
    page,
    request,
    "External drag holds Fit",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const grid = timeline.locator(".tl-grid");
  const lanes = timeline.locator(".tl-lanes");
  await grid.evaluate((element: HTMLElement) =>
    element.style.setProperty("--duration-edit", "1500ms"),
  );
  await agent([{ type: "move", clipIds: ["shot-4"], by: 120 }]);
  await expect(grid).toHaveAttribute("data-refit", "pending");
  const scale = () =>
    grid.evaluate((element: HTMLElement) =>
      Number(element.style.getPropertyValue("--ppf")),
    );
  const before = await scale();
  const dataTransfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["image"], "picture.png", { type: "image/png" }));
    return data;
  });
  await lanes.dispatchEvent("dragenter", { dataTransfer });
  await expect(grid).toHaveAttribute("data-gesturing", "");
  await expect(lanes).not.toHaveAttribute("data-sliding");
  await expect
    .poll(() =>
      grid.evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.timeline === document.timeline)
            .length,
      ),
    )
    .toBe(0);
  expect(await scale()).toBe(before);
  // OS drags have no in-page source to emit dragend when they leave.
  await lanes.dispatchEvent("dragleave", {
    dataTransfer,
    clientX: 0,
    clientY: 0,
  });
  await dataTransfer.dispose();
  await expect(grid).not.toHaveAttribute("data-gesturing", "");
  await expect(grid).toHaveAttribute("data-refit", "settled");
  expect(await scale()).toBeLessThan(before);
});
