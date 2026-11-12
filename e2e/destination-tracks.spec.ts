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
