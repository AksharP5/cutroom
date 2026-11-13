import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

/** A project whose root holds 3-second shots on V1, four unless asked, and any `extra` clips. */
async function open(
  page: Page,
  request: APIRequestContext,
  name: string,
  { count = 4, extra = [] as string[] } = {},
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", { data: { name } })
    ).json(),
  );
  const index = join(project.path, "index.html");
  const shots = Array.from(
    { length: count },
    (_, n) =>
      `<div id="shot-${n + 1}" class="clip" data-start="${n * 3}" data-duration="3" data-track-index="0">Shot ${n + 1}</div>`,
  );
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      /<main([^>]*)data-duration="12"([^>]*)>[\s\S]*<\/main>/,
      `<main$1data-duration="${count * 3}"$2>\n${[...shots, ...extra].join("\n")}\n</main>`,
    ),
  );
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(
    count + extra.length,
  );
  await page.getByRole("region", { name: "Viewer" }).click();
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  return {
    timeline,
    read,
    clips: async () =>
      (await read()).timeline.clips.map((clip) => [
        clip.id,
        clip.start,
        clip.duration,
      ]),
    /** An agent's edit through the same endpoint MCP uses; returns the clips it left. */
    agent: async (commands: unknown[]) => {
      const { revision } = await read();
      const response = await request.post(`${api}/commands`, {
        data: { expectedRevision: revision, label: "Agent", commands },
      });
      expect(response.ok()).toBe(true);
      return TimelineViewSchema.parse(await response.json()).timeline.clips;
    },
    /**
     * Holds the editor's next edit request until the returned function is called, so an agent's
     * edit lands first and the editor's revision is stale.
     */
    hold: async () => {
      let open = () => {};
      const gate = new Promise<void>((resolve) => (open = resolve));
      let held = false;
      await page.route(`**${api}/commands`, async (route) => {
        if (!held) {
          held = true;
          await gate;
        }
        await route.fulfill({ response: await route.fetch() });
      });
      return open;
    },
    /** Types a time into the transport, as `SSFF`. */
    seek: async (time: string) => {
      await page.getByRole("button", { name: /^Current time/ }).click();
      await page.getByLabel("Go to time").pressSequentially(time);
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("button", { name: /^Current time/ }),
      ).toHaveText(`00:00:${time.slice(0, 2)}:${time.slice(2)}`);
    },
  };
}

test("Q, W, E and Shift+X cut a sequence, each one undo step", async ({
  page,
  request,
}) => {
  const { timeline, clips, seek } = await open(page, request, "Keys");
  const states: unknown[][][] = [await clips()];
  const press = async (key: string, expected: unknown[][]) => {
    await page.keyboard.press(key);
    await expect.poll(clips).toEqual(expected);
    states.push(expected);
  };

  // The timeline shows a ripple trim before the server answers.
  await page.route("**/api/cutroom/projects/*/commands", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ response: await route.fetch() });
  });
  await seek("0100");
  await page.keyboard.press("q");
  await expect(timeline.locator('[data-clip="shot-2"]')).toHaveCSS(
    "--s",
    "60",
    { timeout: 300 },
  );
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    "00:00:00:00",
    { timeout: 300 },
  );
  await expect.poll(clips).toEqual([
    ["shot-1", 0, 60],
    ["shot-2", 60, 90],
    ["shot-3", 150, 90],
    ["shot-4", 240, 90],
  ]);
  states.push(await clips());
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    "00:00:00:00",
  );
  await page.unroute("**/api/cutroom/projects/*/commands");

  await seek("0400");
  await press("w", [
    ["shot-1", 0, 60],
    ["shot-2", 60, 60],
    ["shot-3", 120, 90],
    ["shot-4", 210, 90],
  ]);
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    "00:00:04:00",
  );
  await seek("0500");
  await press("e", [
    ["shot-1", 0, 60],
    ["shot-2", 60, 60],
    ["shot-3", 120, 30],
    [expect.stringMatching(/^shot-3-[a-z0-9]{6}$/), 150, 60],
    ["shot-4", 210, 90],
  ]);
  await page.keyboard.press("Shift+V");
  await expect(timeline.locator("[data-clip].selected")).toHaveCount(1);
  await press("Shift+X", [
    ["shot-1", 0, 60],
    ["shot-2", 60, 60],
    ["shot-3", 120, 30],
    ["shot-4", 150, 90],
  ]);

  for (const state of states.toReversed().slice(1)) {
    await page.keyboard.press("Control+z");
    await expect.poll(clips).toEqual(state);
  }
});

test("Q on a later shot parks at its start before the server answers and preserves a later seek", async ({
  page,
  request,
}) => {
  const { clips, seek, hold } = await open(page, request, "Q playhead");
  const release = await hold();
  await seek("0415");
  await page.keyboard.press("q");
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    "00:00:03:00",
  );
  await seek("0600");
  release();
  await expect.poll(clips).toEqual([
    ["shot-1", 0, 90],
    ["shot-2", 90, 45],
    ["shot-3", 135, 90],
    ["shot-4", 225, 90],
  ]);
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    "00:00:06:00",
  );
});

for (const seekAgain of [false, true]) {
  test(`a server-refused Q ${seekAgain ? "preserves a later seek" : "restores the playhead"}`, async ({
    page,
    request,
  }) => {
    const { clips, seek } = await open(page, request, "Refused Q playhead");
    const initial = await clips();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/cutroom/projects/*/commands", async (route) => {
      await gate;
      await route.fulfill({
        status: 422,
        json: { error: "Track 0 is locked.", code: "locked" },
      });
    });
    await seek("0415");
    await page.keyboard.press("q");
    await expect(
      page.getByRole("button", { name: /^Current time/ }),
    ).toHaveText("00:00:03:00");
    if (seekAgain) await seek("0600");
    release();
    await expect(page.locator(".toast")).toContainText("V1 is locked.");
    await expect(
      page.getByRole("button", { name: /^Current time/ }),
    ).toHaveText(seekAgain ? "00:00:06:00" : "00:00:04:15");
    expect(await clips()).toEqual(initial);
  });
}

test("a server-refused W on the last clip puts the playhead back where it was", async ({
  page,
  request,
}) => {
  const { clips, seek } = await open(page, request, "Refused W at the end");
  const initial = await clips();
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/cutroom/projects/*/commands", async (route) => {
    await gate;
    await route.fulfill({
      status: 422,
      json: { error: "Track 0 is locked.", code: "locked" },
    });
  });
  await seek("1015");
  await page.keyboard.press("w");
  // The shortened timeline ends at the cut, so the playhead parks on its last frame.
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    "00:00:10:14",
  );
  release();
  await expect(page.locator(".toast")).toContainText("V1 is locked.");
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    "00:00:10:15",
  );
  expect(await clips()).toEqual(initial);
});

test("a refused edit is taken back and the header shows the engine's reason", async ({
  page,
  request,
}) => {
  const { timeline, clips, seek } = await open(page, request, "Refusals");

  // The shared engine refuses before anything is sent.
  await timeline.getByRole("button", { name: "Auto-select V1" }).click();
  await expect.poll(async () => (await clips()).length).toBe(4);
  await seek("0100");
  await page.keyboard.press("e");
  await expect(page.locator(".toast span")).toHaveText(
    "No clip on an unlocked auto-select track spans 00:00:01:00.",
  );
  await page.getByRole("button", { name: "Dismiss" }).click();

  // The server refuses after the timeline already showed the lift. Nobody else edited, so the
  // header gives the engine's reason in timeline terms.
  await page.route("**/api/cutroom/projects/*/commands", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      status: 422,
      json: {
        error:
          "Command 1 (remove): Clip shot-2 would overlap shot-3 on track 0.",
        code: "overlap",
        command: 0,
      },
    });
  });
  await timeline.locator('[data-clip="shot-2"]').click();
  await page.keyboard.press("x");
  await expect(timeline.locator('[data-clip="shot-2"]')).toHaveCount(0);
  await expect(timeline.locator('[data-clip="shot-2"]')).toHaveCount(1);
  await expect(page.locator(".toast span")).toHaveText(
    "Clip shot-2 would overlap shot-3 on V1.",
  );
  expect(await clips()).toHaveLength(4);

  // The next edit that lands clears the refusal. X twice, faster than the first lands, is one lift.
  await page.unroute("**/api/cutroom/projects/*/commands");
  await timeline.locator('[data-clip="shot-2"]').click();
  await page.keyboard.press("x");
  await page.keyboard.press("x");
  await expect.poll(clips).toEqual([
    ["shot-1", 0, 90],
    ["shot-3", 180, 90],
    ["shot-4", 270, 90],
  ]);
  await expect(page.locator(".toast")).toHaveCount(0);
});

/** The id of the V1 clip that starts at a frame, as the timeline shows it. */
const pieceAt = (page: Page, frame: number) =>
  page
    .getByRole("region", { name: "Timeline" })
    .locator("[data-clip]")
    .evaluateAll(
      (clips, at) =>
        clips
          .find(
            (clip) =>
              getComputedStyle(clip).getPropertyValue("--s").trim() ===
              String(at),
          )
          ?.getAttribute("data-clip") ?? "",
      frame,
    );

test("a cut the server has not seen keeps its id, so its selection survives an agent's cut", async ({
  page,
  request,
}) => {
  const { timeline, clips, seek, agent, hold } = await open(
    page,
    request,
    "Selection",
  );
  const release = await hold();
  await seek("0100");
  await page.keyboard.press("e");
  const piece = await pieceAt(page, 30);
  expect(piece).toMatch(/^shot-1-[a-z0-9]{6}$/);
  await timeline.locator(`[data-clip="${piece}"]`).click();
  const theirs = (
    await agent([{ type: "split", at: 210, clipIds: ["shot-3"] }])
  ).find((clip) => clip.start === 210)!.id;
  expect(theirs).not.toBe(piece);
  release();

  // The razor is rebuilt on the agent's timeline under the same id, and stays selected.
  await expect.poll(clips).toContainEqual([piece, 30, 60]);
  await expect(timeline.locator("[data-clip].selected")).toHaveAttribute(
    "data-clip",
    piece,
  );
});

test("X on a clip an agent deleted is refused, even after the agent cuts where it was", async ({
  page,
  request,
}) => {
  const { timeline, clips, agent, hold } = await open(page, request, "Gone");
  const release = await hold();
  await timeline.locator('[data-clip="shot-2"]').click();
  await page.keyboard.press("x");
  const after = await agent([
    { type: "remove", clipIds: ["shot-2"], ripple: true },
    { type: "split", at: 150, clipIds: ["shot-3"] },
  ]);
  release();
  await expect
    .poll(clips)
    .toEqual(after.map((clip) => [clip.id, clip.start, clip.duration]));
  expect(after.map((clip) => clip.start)).toEqual([0, 90, 150, 180]);
  await expect(page.locator(".toast span")).toHaveText(
    "An agent changed those clips first. Press it again.",
  );
});

test("X never lifts an agent's piece over the same frames as the editor's refused cut", async ({
  page,
  request,
}) => {
  const { timeline, clips, seek, agent, hold } = await open(
    page,
    request,
    "Overlap",
  );
  const release = await hold();
  await seek("0100");
  await page.keyboard.press("e");
  const piece = await pieceAt(page, 30);
  await timeline.locator(`[data-clip="${piece}"]`).click();
  await page.keyboard.press("x");
  // The agent cuts the same clip at 1:15, so its piece covers most of the editor's.
  const theirs = (
    await agent([{ type: "split", at: 45, clipIds: ["shot-1"] }])
  ).find((clip) => clip.start === 45)!.id;
  release();
  // Shot 1 changed under the razor, so the razor and the X on its piece are taken back.
  await expect(page.locator(".toast span")).toHaveText(
    "An agent changed those clips first. Press it again.",
  );
  await expect.poll(clips).toEqual([
    ["shot-1", 0, 45],
    [theirs, 45, 45],
    ["shot-2", 90, 90],
    ["shot-3", 180, 90],
    ["shot-4", 270, 90],
  ]);
});

test("D and then X act on the editor's piece while an agent cuts elsewhere", async ({
  page,
  request,
}) => {
  const { timeline, clips, read, seek, agent, hold } = await open(
    page,
    request,
    "Disable",
  );
  const release = await hold();
  await seek("0100");
  await page.keyboard.press("e");
  const piece = await pieceAt(page, 30);
  await timeline.locator(`[data-clip="${piece}"]`).click();
  await page.keyboard.press("d");
  const theirs = (
    await agent([{ type: "split", at: 210, clipIds: ["shot-3"] }])
  ).find((clip) => clip.start === 210)!.id;
  release();
  const enabled = async () =>
    Object.fromEntries(
      (await read()).timeline.clips.map((clip) => [clip.id, clip.enabled]),
    );
  await expect.poll(enabled).toMatchObject({ [piece]: false, [theirs]: true });

  await page.keyboard.press("x");
  await expect.poll(clips).toEqual([
    ["shot-1", 0, 30],
    ["shot-2", 90, 90],
    ["shot-3", 180, 30],
    [theirs, 210, 60],
    ["shot-4", 270, 90],
  ]);
  expect((await enabled())[theirs]).toBe(true);
});

test("a key pressed right after an agent's edit is applied on top of it", async ({
  page,
  request,
}) => {
  const { read, seek, agent, hold } = await open(page, request, "Marker");
  const release = await hold();
  await seek("0100");
  await page.keyboard.press("m");
  await agent([{ type: "setMarker", frame: 200 }]);
  release();
  await expect
    .poll(async () => (await read()).timeline.markers.map((m) => m.frame))
    .toEqual([30, 200]);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("when a cut is refused, a queued X on its piece is taken back too", async ({
  page,
  request,
}) => {
  const { timeline, clips, seek, agent, hold } = await open(
    page,
    request,
    "Refused cut",
  );
  const release = await hold();
  await seek("0100");
  await page.keyboard.press("e");
  const piece = await pieceAt(page, 30);
  await timeline.locator(`[data-clip="${piece}"]`).click();
  await page.keyboard.press("x");
  // Before the editor's cut lands, an agent gives that exact id to a piece of shot 3.
  await agent([
    { type: "split", at: 210, clipIds: ["shot-3"], ids: { "shot-3": [piece] } },
  ]);
  release();

  // The cut is refused because the id is taken, and the X that named its piece never runs.
  await expect(page.locator(".toast span")).toHaveText(
    "An agent changed those clips first. Press it again.",
  );
  await expect.poll(clips).toEqual([
    ["shot-1", 0, 90],
    ["shot-2", 90, 90],
    ["shot-3", 180, 30],
    [piece, 210, 60],
    ["shot-4", 270, 90],
  ]);
  await expect(timeline.locator("[data-clip].selected")).toHaveCount(0);
});

test("a title shortened by ripple keeps its id, so queued X lifts the whole title", async ({
  page,
  request,
}) => {
  const { timeline, clips, hold } = await open(page, request, "Spanning", {
    count: 5,
    extra: [
      `<div id="title" class="clip" data-start="1" data-duration="13" data-track-index="1">Title</div>`,
    ],
  });
  const release = await hold();
  await timeline.locator('[data-clip="shot-2"]').click();
  await timeline
    .locator('[data-clip="shot-4"]')
    .click({ modifiers: ["Control"] });
  await page.keyboard.press("Shift+X");
  // Both removed ranges shorten the same title before the server answers.
  await expect(timeline.locator('[data-clip^="title"]')).toHaveCount(1);
  expect(
    await timeline
      .locator('[data-clip="title"]')
      .evaluate((element) => [
        getComputedStyle(element).getPropertyValue("--s").trim(),
        getComputedStyle(element).getPropertyValue("--d").trim(),
      ]),
  ).toEqual(["30", "210"]);
  await timeline.locator('[data-clip="title"]').click();
  await page.keyboard.press("x");
  release();
  await expect
    .poll(async () =>
      (await clips()).filter(([id]) => String(id).startsWith("title")),
    )
    .toEqual([]);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("Q and E pressed on a selected shot act on that shot only, even after an agent removes it", async ({
  page,
  request,
}) => {
  const { timeline, clips, seek, agent, hold } = await open(
    page,
    request,
    "Frozen",
  );
  const release = await hold();
  await seek("0400");
  await timeline.locator('[data-clip="shot-2"]').click();
  await page.keyboard.press("q");
  // Q parks on the cut; seek inside the surviving shot before queuing its razor.
  await seek("0400");
  await page.keyboard.press("e");
  // The agent ripple deletes shot 2, so shot 3 slides under the playhead.
  const after = await agent([
    { type: "remove", clipIds: ["shot-2"], ripple: true },
  ]);
  release();

  // Neither key falls back to shot 3 or to every track: both are refused, and nothing changes.
  await expect(page.locator(".toast span")).toHaveText(
    "An agent changed those clips first. Press it again.",
  );
  await expect
    .poll(clips)
    .toEqual(after.map((clip) => [clip.id, clip.start, clip.duration]));
  expect(after.map((clip) => [clip.id, clip.start])).toEqual([
    ["shot-1", 0],
    ["shot-3", 90],
    ["shot-4", 180],
  ]);
});

test("an X on a shortened title is refused when the ripple is refused", async ({
  page,
  request,
}) => {
  const { timeline, clips, agent, hold } = await open(page, request, "Tail", {
    count: 5,
    extra: [
      `<div id="title" class="clip" data-start="1" data-duration="13" data-track-index="1">Title</div>`,
    ],
  });
  const release = await hold();
  await timeline.locator('[data-clip="shot-2"]').click();
  await timeline
    .locator('[data-clip="shot-4"]')
    .click({ modifiers: ["Control"] });
  await page.keyboard.press("Shift+X");
  // X snapshots the shortened title, not its earlier uncut state.
  await expect(timeline.locator('[data-clip^="title"]')).toHaveCount(1);
  await timeline.locator('[data-clip="title"]').click();
  await page.keyboard.press("x");
  // The agent lifts shot 4 first, so the ripple delete no longer applies.
  const after = await agent([{ type: "remove", clipIds: ["shot-4"] }]);
  release();

  await expect(page.locator(".toast span")).toHaveText(
    "An agent changed those clips first. Press it again.",
  );
  // The original title stays whole because X cannot lift the shorter version it saw.
  await expect
    .poll(clips)
    .toEqual(after.map((clip) => [clip.id, clip.start, clip.duration]));
  expect(after.find((clip) => clip.id === "title")?.duration).toBe(390);
  await expect(timeline.locator("[data-clip].selected")).toHaveCount(0);
});

for (const [name, change] of [
  // An agent ripple trims a second off shot 1, so shot 2 starts a second earlier.
  [
    "ripple trims the shot before",
    { type: "trim", clipId: "shot-1", edge: "end", to: 60, ripple: true },
  ],
  // An agent moves shot 2 up to V2 and a second earlier.
  [
    "moves the shot",
    { type: "move", clipIds: ["shot-2"], by: -30, trackBy: 1 },
  ],
] as const)
  test(`Q and E at absolute frames are refused when an agent ${name} first`, async ({
    page,
    request,
  }) => {
    const { clips, seek, agent, hold } = await open(page, request, "Moved");
    const release = await hold();
    // At 4s both keys act on shot 2, which the view shows at 3s to 6s.
    await seek("0400");
    await page.keyboard.press("q");
    await seek("0400");
    await page.keyboard.press("e");
    const after = await agent([change]);
    release();

    // The same frames would now cut shot 2 somewhere else, so neither key is sent.
    await expect(page.locator(".toast span")).toHaveText(
      "An agent changed those clips first. Press it again.",
    );
    await expect
      .poll(clips)
      .toEqual(after.map((clip) => [clip.id, clip.start, clip.duration]));
  });

for (const { key, all, backward } of [
  { key: "y", all: false, backward: false },
  { key: "Alt+y", all: true, backward: false },
  { key: "Control+y", all: false, backward: true },
  { key: "Control+Alt+y", all: true, backward: true },
]) {
  test(`${key} selects ${backward ? "backward" : "forward"} on ${all ? "all" : "auto-select"} unlocked tracks at a clip boundary`, async ({
    page,
    request,
  }) => {
    const { timeline, seek, agent } = await open(
      page,
      request,
      "Select by playhead",
      {
        extra: [
          '<div id="off-before" class="clip" data-start="0" data-duration="3" data-track-index="1">Off before</div>',
          '<div id="off-at" class="clip" data-start="3" data-duration="3" data-track-index="1">Off at</div>',
          '<div id="off-after" class="clip" data-start="6" data-duration="3" data-track-index="1">Off after</div>',
          '<div id="locked-before" class="clip" data-start="0" data-duration="3" data-track-index="2">Locked before</div>',
          '<div id="locked-at" class="clip" data-start="3" data-duration="3" data-track-index="2">Locked at</div>',
          '<div id="locked-after" class="clip" data-start="6" data-duration="3" data-track-index="2">Locked after</div>',
        ],
      },
    );
    await agent([
      { type: "setTrack", index: 1, autoSelect: false },
      { type: "setTrack", index: 2, locked: true },
    ]);
    await expect(
      timeline.getByRole("button", { name: "Auto-select V2", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      timeline.getByRole("button", { name: "Lock V3", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const selected = () =>
      timeline
        .locator("[data-clip].selected")
        .evaluateAll((clips) =>
          clips.map((clip) => clip.getAttribute("data-clip")).sort(),
        );
    const select = async (time: string, expected: string[]) => {
      await seek(time);
      await page.keyboard.press(key);
      await expect.poll(selected).toEqual(expected.sort());
    };
    if (backward) {
      await select("0229", ["shot-1", ...(all ? ["off-before"] : [])]);
      await select("0300", [
        "shot-1",
        "shot-2",
        ...(all ? ["off-before", "off-at"] : []),
      ]);
      await select("0301", [
        "shot-1",
        "shot-2",
        ...(all ? ["off-before", "off-at"] : []),
      ]);
      await select("0000", ["shot-1", ...(all ? ["off-before"] : [])]);
    } else {
      await select("0229", [
        "shot-2",
        "shot-3",
        "shot-4",
        ...(all ? ["off-at", "off-after"] : []),
      ]);
      await select("0300", [
        "shot-2",
        "shot-3",
        "shot-4",
        ...(all ? ["off-at", "off-after"] : []),
      ]);
      await select("0301", ["shot-3", "shot-4", ...(all ? ["off-after"] : [])]);
      await select("1100", []);
    }
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  });
}

test("Q and W at a cut preserve the incoming clip and the rest of the film, including MCP", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const { timeline, clips, read } = await open(page, request, "Cut boundary", {
    extra: [
      '<audio id="music" class="clip" data-start="0" data-duration="12" data-track-index="2"></audio>',
    ],
  });
  const initial = await clips();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: /^Current time/ })).toHaveText(
    "00:00:03:00",
  );
  await page.screenshot({ path: testInfo.outputPath("parked.png") });
  await page.keyboard.press("w");
  await page.screenshot({ path: testInfo.outputPath("after-w.png") });
  await expect(page.locator(".toast")).toContainText(
    "shot-2 would be shorter than one frame",
  );
  expect(await clips()).toEqual(initial);
  await page.getByRole("button", { name: "Dismiss" }).click();
  await page.keyboard.press("q");
  expect(await clips()).toEqual(initial);
  await page.keyboard.press("Shift+V");
  await expect(timeline.locator('[data-clip="shot-2"]')).toHaveClass(
    /selected/,
  );
  await expect(timeline.locator('[data-clip="shot-1"]')).not.toHaveClass(
    /selected/,
  );
  // With the incoming shot selected alone, E at its first frame cannot cut the music instead.
  await timeline.locator('[data-clip="shot-2"]').click({ modifiers: ["Alt"] });
  await page.keyboard.press("e");
  expect(await clips()).toEqual(initial);
  await page.keyboard.press("x");
  await expect.poll(clips).toEqual(initial.filter(([id]) => id !== "shot-2"));
  await page.keyboard.press("Control+z");
  await expect.poll(clips).toEqual(initial);
  const client = new Client({ name: "cut-boundary-proof", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: new URL(baseURL!).origin } },
    }),
  );
  try {
    const view = await read();
    const result = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: page.url().split("#project/")[1],
        expectedRevision: view.revision,
        commands: [
          { type: "trim", clipId: "shot-2", edge: "end", to: 90, ripple: true },
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("shorter than one frame");
    expect(await clips()).toEqual(initial);
  } finally {
    await client.close();
  }
});
