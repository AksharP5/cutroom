import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);

/**
 * An interview with its sound: six seconds on V1 (track 0) and A1 (track 1), under an empty V2
 * (track 2) and A2 (track 3). Media holds the interview, three seconds of music and a still.
 */
async function open(page: Page, request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: `Destinations ${Date.now()}`,
          duration: 12,
          width: 320,
          height: 240,
        },
      })
    ).json(),
  );
  const tone = (frequency: number, seconds: number) => [
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:duration=${seconds}`,
  ];
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=teal:s=320x240:r=30:d=8",
    ...tone(440, 8),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "interview.mp4"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    ...tone(220, 3),
    join(project.path, "music.wav"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=orange:s=320x240:d=1",
    "-frames:v",
    "1",
    join(project.path, "still.png"),
  ]);
  const path = join(project.path, "index.html");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      /<main([^>]*)>[\s\S]*<\/main>/,
      `<main$1>
    <video src="interview.mp4" muted id="picture" class="clip" data-start="0" data-duration="6" data-track-index="0" data-link="pair"></video>
    <audio src="interview.mp4" id="sound" class="clip" data-start="0" data-duration="6" data-track-index="1" data-link="pair"></audio>
    </main>`,
    ),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const view = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  expect(
    (
      await request.post(`${api}/commands`, {
        data: {
          expectedRevision: (await view()).revision,
          commands: [
            { type: "setTrack", index: 2, kind: "video" },
            { type: "setTrack", index: 3, kind: "audio" },
          ],
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/#project/${project.id}`);
  await expect(
    page.getByRole("region", { name: "Timeline" }).locator("[data-clip]"),
  ).toHaveCount(2);
  const before = (await view()).timeline;
  /** Every clip as kind, track, start and length, in a fixed order. */
  const clips = async () =>
    (await view()).timeline.clips
      .map((clip) => [clip.kind, clip.track, clip.start, clip.duration])
      .sort(
        (a, b) => Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2]),
      );
  /** The codes whose headers show them as the destination. */
  const destinations = () =>
    page
      .locator('.tl-head-id[aria-pressed="true"]')
      .evaluateAll((codes) => codes.map((code) => code.textContent).sort());
  /** Places a Media file at the playhead from its menu, with no drag. */
  const place = async (name: string, item: string) => {
    const row = page.locator(`.media-row[data-path="${name}"]`);
    await expect(row).toHaveAttribute("draggable", "true");
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: item, exact: true }).click();
  };
  const seek = async (time: string) => {
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page.getByLabel("Go to time").pressSequentially(time);
    await page.keyboard.press("Enter");
  };
  return { project, api, before, clips, destinations, place, seek };
}

const interview = [
  ["video", 0, 0, 180],
  ["audio", 1, 0, 180],
];

test("disabled destinations place only picture or only sound through F9, F10 and the media menu, persist, and follow MCP", async ({
  page,
  request,
  baseURL,
}, info) => {
  const { project, api, before, destinations, place, seek } = await open(
    page,
    request,
  );
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=orange:s=320x240:r=30:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=3",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "broll.mp4"),
  ]);
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  const code = (id: string) =>
    page.getByRole("button", { name: `${id} destination`, exact: true });
  const source = page.locator('.media-row[data-path="broll.mp4"]');
  await expect(source).toHaveAttribute("draggable", "true");
  await code("V2").click();
  await code("A1").click();
  await source.dblclick();
  await expect(
    page.getByRole("group", { name: "Source", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("F10");
  await expect
    .poll(async () =>
      (await read()).timeline.clips.some((c) => c.src === "broll.mp4"),
    )
    .toBe(true);
  await page.screenshot({ path: info.outputPath("picture-only.png") });
  const picture = await read();
  await writeFile(
    info.outputPath("picture-only.json"),
    JSON.stringify(picture.timeline.clips, null, 2),
  );
  expect(picture.timeline.clips.filter((c) => c.kind === "audio")).toEqual(
    before.clips.filter((c) => c.kind === "audio"),
  );
  expect(
    picture.timeline.clips.filter((c) => c.src === "broll.mp4"),
  ).toMatchObject([{ kind: "video", track: 2, hasAudio: false }]);
  await expect(code("A1")).toHaveAttribute("aria-pressed", "false");
  await seek("0000");
  await page.keyboard.press("F9");
  await expect
    .poll(async () =>
      (await read()).timeline.clips
        .filter((c) => c.kind === "audio")
        .map((c) => [c.src, c.start, c.duration]),
    )
    .toEqual([["interview.mp4", 90, 180]]);
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await read()).timeline)
    .toEqual(picture.timeline);
  await expect
    .poll(async () => (await request.get(`${api}/timeline-view`)).json())
    .toMatchObject({
      destinations: { video: 2, audio: 1, audioEnabled: false },
    });
  await page.reload();
  await expect.poll(destinations).toEqual(["V2"]);
  await page.keyboard.press("Control+Alt+1");
  await page.keyboard.press("Alt+2");
  await expect.poll(destinations).toEqual(["A1"]);
  await page.locator('.media-row[data-path="broll.mp4"]').dblclick();
  await page.keyboard.press("Alt+q");
  await seek("0000");
  await page.keyboard.press("F9");
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.filter(
          (c) => c.kind === "audio" && c.src === "broll.mp4",
        ).length,
    )
    .toBe(1);
  expect(
    (await read()).timeline.clips.filter((c) => c.kind === "video"),
  ).toHaveLength(2);
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await read()).timeline)
    .toEqual(picture.timeline);
  await seek("0000");
  await page.keyboard.press("F10");
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.filter(
          (c) => c.kind === "audio" && c.src === "broll.mp4",
        ).length,
    )
    .toBe(1);
  expect(
    (await read()).timeline.clips.filter((c) => c.kind === "video"),
  ).toEqual(picture.timeline.clips.filter((c) => c.kind === "video"));
  await page.screenshot({ path: info.outputPath("sound-only.png") });
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await read()).timeline)
    .toEqual(picture.timeline);
  await page.keyboard.press("Alt+0");
  await expect.poll(destinations).toEqual([]);
  const parked = await page
    .getByRole("button", { name: /^Current time/ })
    .textContent();
  await page.keyboard.press("F10");
  await expect(page.getByRole("status")).toContainText("Enable a destination");
  expect((await read()).timeline).toEqual(picture.timeline);
  await expect
    .poll(() =>
      page.getByRole("button", { name: /^Current time/ }).textContent(),
    )
    .toBe(parked);
  await page.keyboard.press("Control+Alt+9");
  await expect.poll(destinations).toEqual(["A1"]);
  await seek("0000");
  await place("broll.mp4", "Overwrite at playhead");
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.filter(
          (c) => c.kind === "audio" && c.src === "broll.mp4",
        ).length,
    )
    .toBe(1);
  expect(
    (await read()).timeline.clips.filter((c) => c.kind === "video"),
  ).toEqual(picture.timeline.clips.filter((c) => c.kind === "video"));
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await read()).timeline)
    .toEqual(picture.timeline);
  const client = new Client({ name: "destination-switches", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  try {
    const revision = (await read()).revision;
    const result = await client.callTool({
      name: "timeline_destinations",
      arguments: {
        projectId: project.id,
        videoEnabled: true,
        audioEnabled: false,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(
      z
        .object({
          structuredContent: z.object({
            result: z.object({
              video: z.number(),
              audio: z.number(),
              videoEnabled: z.boolean(),
              audioEnabled: z.boolean(),
            }),
          }),
        })
        .parse(result).structuredContent.result,
    ).toEqual({ video: 2, audio: 1, videoEnabled: true, audioEnabled: false });
    await expect.poll(destinations).toEqual(["V2"]);
    expect((await read()).revision).toBe(revision);
    await page.reload();
    await expect.poll(destinations).toEqual(["V2"]);
    await page.keyboard.press("Alt+9");
    await expect.poll(destinations).toEqual([]);
    await page.keyboard.press("Alt+9");
    await expect.poll(destinations).toEqual(["V2"]);
    await page.keyboard.press("Alt+0");
    await expect.poll(destinations).toEqual([]);
    await page.keyboard.press("Alt+0");
    await expect.poll(destinations).toEqual(["A1", "V2"]);
  } finally {
    await client.close();
  }
});

test("a missing destination names the absent track instead of swallowing its key", async ({
  page,
  request,
}, info) => {
  const { api, destinations } = await open(page, request);
  const view = TimelineViewSchema.parse(
    await (await request.get(`${api}/timeline`)).json(),
  );
  expect(
    (
      await request.post(`${api}/commands`, {
        data: {
          expectedRevision: view.revision,
          commands: [{ type: "removeTrack", index: 3 }],
        },
      })
    ).ok(),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "A2 destination", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Control+Alt+2");
  await page.screenshot({ path: info.outputPath("missing-a2.png") });
  await expect(page.getByRole("status")).toContainText("No A2 yet");
  await expect.poll(destinations).toEqual(["A1", "V1"]);
});

test("placed media goes to the destination tracks chosen in the headers by click and key", async ({
  page,
  request,
}) => {
  const { project, api, clips, destinations, place, seek } = await open(
    page,
    request,
  );
  const code = (id: string) =>
    page.getByRole("button", { name: `${id} destination`, exact: true });
  // Nothing chosen yet: V1 and A1.
  await expect.poll(destinations).toEqual(["A1", "V1"]);

  // B-roll over the interview: choose V2 by its Resolve key, and the still lands there.
  await seek("100");
  await page.keyboard.press("Alt+2");
  await expect.poll(destinations).toEqual(["A1", "V2"]);
  await place("still.png", "Overwrite at playhead");
  await expect.poll(clips).toEqual([...interview, ["image", 2, 30, 150]]);

  // Music under it: choose A2 by its code. The interview's sound on A1 is left whole.
  await code("A2").click();
  await expect.poll(destinations).toEqual(["A2", "V2"]);
  await seek("100");
  await place("music.wav", "Overwrite at playhead");
  const placed = [...interview, ["image", 2, 30, 150], ["audio", 3, 30, 90]];
  await expect.poll(clips).toEqual(placed);

  // One placement is one undo step, and choosing a destination is none.
  await page.keyboard.press("Control+z");
  await expect.poll(clips).toEqual(placed.slice(0, 3));
  await expect.poll(destinations).toEqual(["A2", "V2"]);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(clips).toEqual(placed);

  // A video's own sound follows the audio destination, and insert opens both tracks for it.
  await page.locator('.media-row[data-path="interview.mp4"]').dblclick();
  await expect(page.getByRole("group", { name: "Source" })).toBeVisible();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("o");
  await page.keyboard.press("Alt+q");
  await seek("200");
  await page.keyboard.press("F9");
  await expect.poll(clips).toEqual([
    ...interview.flatMap(([kind, track]) => [
      [kind, track, 0, 60],
      [kind, track, 90, 120],
    ]),
    ["image", 2, 30, 30],
    ["video", 2, 60, 30],
    ["image", 2, 90, 120],
    ["audio", 3, 30, 30],
    ["audio", 3, 60, 30],
    ["audio", 3, 90, 60],
  ]);
  await page.keyboard.press("Control+z");
  await expect.poll(clips).toEqual(placed);

  // The step keys move to the header above or below, and the choice survives a reload.
  await page.keyboard.press("Control+Shift+ArrowDown");
  await page.keyboard.press("Control+Alt+ArrowUp");
  await expect.poll(destinations).toEqual(["A1", "V1"]);
  await page.keyboard.press("Control+Shift+ArrowUp");
  await expect.poll(destinations).toEqual(["A1", "V2"]);
  await expect
    .poll(async () => (await request.get(`${api}/timeline-view`)).json())
    .toMatchObject({ destinations: { video: 2, audio: 1 } });
  await page.reload();
  await expect.poll(destinations).toEqual(["A1", "V2"]);
  expect(
    JSON.parse(
      await readFile(join(project.path, ".cutroom/view.json"), "utf8"),
    ),
  ).toMatchObject({
    timelines: { "index.html": { destinations: { video: 2, audio: 1 } } },
  });

  // A locked destination refuses the placement and says which track; nothing moves elsewhere.
  await page.getByRole("button", { name: "Lock V2", exact: true }).click();
  await seek("400");
  await place("still.png", "Overwrite at playhead");
  await expect(page.getByRole("alert")).toContainText("V2 is locked.");
  await expect.poll(async () => (await clips()).length).toBe(placed.length);
});

test("an overwrite that takes part of another clip says so, with Undo", async ({
  page,
  request,
}) => {
  const { clips, place, seek } = await open(page, request);
  // Music sent to A1 replaces three seconds of the interview's sound.
  await seek("100");
  await place("music.wav", "Overwrite at playhead");
  await expect
    .poll(clips)
    .toEqual([
      interview[0],
      ["audio", 1, 0, 30],
      ["audio", 1, 30, 90],
      ["audio", 1, 120, 60],
    ]);
  const notice = page
    .getByRole("status")
    .filter({ hasText: "Replaced part of interview.mp4." });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(clips).toEqual(interview);
});

test("an agent reads and sets the destinations, and the open editor follows", async ({
  page,
  request,
  baseURL,
}) => {
  const { project, clips, destinations, place, seek } = await open(
    page,
    request,
  );
  const client = new Client({ name: "destination-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  const call = async (tracks: { video?: number; audio?: number } = {}) =>
    z
      .object({
        structuredContent: z.object({
          result: z.object({ video: z.number(), audio: z.number() }),
        }),
      })
      .parse(
        await client.callTool({
          name: "timeline_destinations",
          arguments: { projectId: project.id, ...tracks },
        }),
      ).structuredContent.result;
  try {
    expect(await call()).toEqual({ video: 0, audio: 1 });
    // The owner's choice in the editor is what the agent reads.
    await page.keyboard.press("Control+Alt+2");
    await expect.poll(() => call()).toEqual({ video: 0, audio: 3 });
    // The agent's choice shows in the headers without a reload, and placement uses it.
    expect(await call({ video: 2 })).toEqual({ video: 2, audio: 3 });
    await expect.poll(destinations).toEqual(["A2", "V2"]);
    await seek("100");
    await place("still.png", "Overwrite at playhead");
    await expect.poll(clips).toEqual([...interview, ["image", 2, 30, 150]]);
    const refused = await client.callTool({
      name: "timeline_destinations",
      arguments: { projectId: project.id, video: 3 },
    });
    expect(refused.isError).toBe(true);
    expect(await call()).toEqual({ video: 2, audio: 3 });
  } finally {
    await client.close();
  }
});

test("a project's destinations show after a switch made while the last project is still saving", async ({
  page,
  request,
}) => {
  const view = "**/timeline-view?**";
  // Project B has V2 and A2 saved.
  const b = await open(page, request);
  await page.keyboard.press("Alt+2");
  await page.keyboard.press("Control+Alt+2");
  await expect
    .poll(async () => (await request.get(`${b.api}/timeline-view`)).json())
    .toMatchObject({ destinations: { video: 2, audio: 3 } });

  // In project A a choice is still being saved when the owner switches back to B.
  const a = await open(page, request);
  await expect.poll(a.destinations).toEqual(["A1", "V1"]);
  const saving = Promise.withResolvers<void>();
  const saved = Promise.withResolvers<void>();
  await page.route(view, async (route) => {
    if (route.request().method() === "PUT") {
      saving.resolve();
      await saved.promise;
    }
    await route.continue();
  });
  await page
    .getByRole("button", { name: "V2 destination", exact: true })
    .click();
  await saving.promise;
  await page.evaluate((id) => {
    location.hash = `project/${id}`;
  }, b.project.id);
  await expect.poll(b.destinations).toEqual(["A2", "V2"]);
  // Placement uses what the headers show.
  await b.seek("100");
  await b.place("still.png", "Overwrite at playhead");
  await expect.poll(b.clips).toEqual([...interview, ["image", 2, 30, 150]]);
  saved.resolve();
  await expect
    .poll(async () => (await request.get(`${a.api}/timeline-view`)).json())
    .toMatchObject({ destinations: { video: 2 } });
  await expect.poll(b.destinations).toEqual(["A2", "V2"]);
});

test("a destination answer read before a newer choice never replaces it", async ({
  page,
  request,
}) => {
  const b = await open(page, request);
  await page.keyboard.press("Alt+2");
  await page.keyboard.press("Control+Alt+2");
  await expect
    .poll(async () => (await request.get(`${b.api}/timeline-view`)).json())
    .toMatchObject({ destinations: { video: 2, audio: 3 } });
  const read = Promise.withResolvers<void>();
  const late = Promise.withResolvers<void>();
  // The first read is held with the answer it got. Later reads never answer, so nothing else
  // can correct what the held one leaves on screen.
  let held = false;
  await page.route("**/timeline-view?**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (held) return;
    held = true;
    const response = await route.fetch();
    read.resolve();
    await late.promise;
    await route.fulfill({ response });
  });
  // An agent's change makes the editor read; that read holds V1 and A2.
  expect(
    (
      await request.put(`${b.api}/timeline-destinations`, {
        data: { video: 0 },
      })
    ).ok(),
  ).toBe(true);
  await read.promise;
  // The choice is made and its save has answered before the old read arrives.
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/timeline-view") &&
      response.request().method() === "PUT",
  );
  await page
    .getByRole("button", { name: "A1 destination", exact: true })
    .click();
  await saved;
  // Let the page finish with the save's answer; only then is the old read purely late.
  await page.waitForTimeout(200);
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/timeline-view") &&
      response.request().method() === "GET",
  );
  late.resolve();
  await answered;
  await page.waitForTimeout(300);
  expect(await b.destinations()).toEqual(["A1", "V2"]);
});
