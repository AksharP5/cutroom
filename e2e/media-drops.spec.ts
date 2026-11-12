import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { startMediaDrag } from "./media-drag";
import { expect, test } from "./fixtures";

async function createMediaProject(
  request: APIRequestContext,
  twoPairs = false,
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Predictable media drops",
          duration: 20,
          width: 320,
          height: 240,
        },
      })
    ).json(),
  );
  const exec = promisify(execFile);
  for (const [name, seconds, frequency] of [
    ["Interview", 12, 440],
    ["B-roll", 2, 660],
    ["Music", 20, 880],
  ] as const) {
    await exec("ffmpeg", [
      "-v",
      "error",
      ...(name === "Music"
        ? []
        : ["-f", "lavfi", "-i", `testsrc2=s=320x180:r=30:d=${seconds}`]),
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=${seconds}`,
      ...(name === "Music"
        ? []
        : [
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-shortest",
          ]),
      join(project.path, `${name}.${name === "Music" ? "wav" : "mp4"}`),
    ]);
  }
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      /<main[^>]*>[\s\S]*<\/main>/,
      `<main id="main" data-composition-id="main" data-fps="30" data-width="320" data-height="180" data-duration="20">
<video id="interview" src="Interview.mp4" data-start="0" data-duration="12" data-track-index="${twoPairs ? 1 : 0}" data-link="pair" muted></video>
<audio id="dialogue" src="Interview.mp4" data-start="0" data-duration="12" data-track-index="3" data-link="pair"></audio>
${
  twoPairs
    ? `<video id="background" src="Interview.mp4" data-start="0" data-duration="12" data-track-index="0" data-link="background" muted></video>
<audio id="background-sound" src="Interview.mp4" data-start="0" data-duration="12" data-track-index="2" data-link="background"></audio>`
    : ""
}
<audio id="music" src="Music.wav" data-start="0" data-duration="20" data-track-index="4"></audio></main>`,
    ),
  );
  return project;
}

test("media overwrite, modifier insert and edge tracks match MCP and undo one step each", async ({
  page,
  request,
  baseURL,
}, info) => {
  const project = await createMediaProject(request);
  const path = `/api/cutroom/projects/${project.id}/timeline`;
  const read = async () =>
    TimelineViewSchema.parse(await (await request.get(path)).json()).timeline;
  const initial = await read();
  const client = new Client({ name: "media-drop-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  const agentRead = async () =>
    z
      .object({ structuredContent: z.object({ result: TimelineViewSchema }) })
      .parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: project.id },
        }),
      ).structuredContent.result.timeline;
  const at = async (frame: number, selector = ".tl-lane.video") => {
    const lanes = (await page.locator(".tl-lanes").boundingBox())!;
    const lane = (await page.locator(selector).first().boundingBox())!;
    const ppf = Number(
      await page
        .locator(".tl-grid")
        .evaluate((e) => e.style.getPropertyValue("--ppf")),
    );
    return { x: lanes.x + (frame + 0.5) * ppf, y: lane.y + 20 };
  };
  const hold = async (name: string) =>
    startMediaDrag(
      page,
      page
        .getByRole("region", { name: "Media", exact: true })
        .getByRole("listitem")
        .filter({ hasText: name }),
    );
  const filmstripAtClip = () =>
    page.locator(".tl-lanes canvas").evaluate((canvas: HTMLCanvasElement) => {
      const clip = document
        .querySelector('[data-clip="interview"]')!
        .getBoundingClientRect();
      const box = canvas.getBoundingClientRect();
      return canvas
        .getContext("2d")!
        .getImageData(
          Math.round(((clip.x + 20 - box.x) * canvas.width) / box.width),
          Math.round(((clip.y + 30 - box.y) * canvas.height) / box.height),
          1,
          1,
        ).data[3];
    });
  const undo = async () => {
    await page
      .getByRole("toolbar", { name: "Tools", exact: true })
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect.poll(read).toEqual(initial);
    expect(await agentRead()).toEqual(initial);
  };
  try {
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator("iframe[data-live]")).toBeVisible();
    await expect(page.locator("[data-clip]")).toHaveCount(3);
    await hold("B-roll.mp4");
    let point = await at(120);
    await page.mouse.move(point.x, point.y, { steps: 12 });
    await expect(page.locator(".tl-ghost")).toBeVisible();
    // Both linked destinations show their surviving heads and tails before release.
    await expect(page.locator(".tl-piece:not([hidden])")).toHaveCount(2);
    await page.mouse.up();
    await expect.poll(async () => (await read()).clips.length).toBe(7);
    const overwritten = await read();
    expect(overwritten.tracks).toEqual(initial.tracks);
    expect(overwritten.clips.find((c) => c.id === "music")).toEqual(
      initial.clips.find((c) => c.id === "music"),
    );
    expect(
      overwritten.clips
        .filter((c) => c.src === "Interview.mp4")
        .map((c) => [c.track, c.start, c.duration]),
    ).toEqual([
      [0, 0, 120],
      [0, 180, 180],
      [3, 0, 120],
      [3, 180, 180],
    ]);
    expect(
      overwritten.clips.find(
        (c) => c.src === "B-roll.mp4" && c.kind === "audio",
      ),
    ).toMatchObject({ track: 3, start: 120, duration: 60 });
    expect(await agentRead()).toEqual(overwritten);
    await page.screenshot({ path: info.outputPath("overwrite.png") });
    await undo();

    await hold("B-roll.mp4");
    point = await at(120);
    await page.mouse.move(point.x, point.y, { steps: 12 });
    await expect(page.locator(".tl-piece:not([hidden])")).toHaveCount(2);
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.mouse.move(point.x, point.y);
    await expect(page.locator(".tl-ghost")).toContainText("Insert:");
    await expect(page.locator(".tl-readout")).toContainText("to overwrite");
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await expect.poll(async () => (await read()).clips.length).toBe(8);
    const inserted = await read();
    expect(
      inserted.clips
        .filter((c) => c.src === "Interview.mp4")
        .map((c) => [c.track, c.start, c.duration]),
    ).toEqual([
      [0, 0, 120],
      [0, 180, 240],
      [3, 0, 120],
      [3, 180, 240],
    ]);
    expect(
      inserted.clips
        .filter((c) => c.src === "Music.wav")
        .map((c) => [c.start, c.duration]),
    ).toEqual([
      [0, 120],
      [180, 480],
    ]);
    expect(await agentRead()).toEqual(inserted);
    await undo();

    // Pointer capture allows a clip to reach the top band even above the lanes' original box.
    await expect.poll(filmstripAtClip).toBe(255);
    point = await at(60);
    const lanes = (await page.locator(".tl-lanes").boundingBox())!;
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x, lanes.y - 8, { steps: 12 });
    await expect
      .poll(() =>
        page
          .locator(".tl-lane.video")
          .first()
          .evaluate((e) => (e as HTMLElement).offsetTop),
      )
      .toBeGreaterThan(0);
    await expect.poll(filmstripAtClip).toBe(255);
    await page.screenshot({ path: info.outputPath("new-track-preview.png") });
    await page.mouse.up();
    await expect.poll(async () => (await read()).tracks.length).toBe(4);
    await expect
      .poll(() =>
        page
          .locator(".tl-lane.video")
          .first()
          .evaluate((e) => (e as HTMLElement).offsetTop),
      )
      .toBe(0);
    const moved = await read();
    expect(moved.clips.find((c) => c.id === "interview")).toMatchObject({
      track: 5,
      start: 0,
      duration: 360,
    });
    expect(moved.clips.find((c) => c.id === "dialogue")).toEqual(
      initial.clips.find((c) => c.id === "dialogue"),
    );
    expect(await agentRead()).toEqual(moved);
    await undo();

    await hold("Music.wav");
    let last = (await page.locator(".tl-lane.audio").last().boundingBox())!;
    point = await at(0);
    await page.mouse.move(point.x, last.y + last.height + 7, { steps: 12 });
    await expect(page.locator(".tl-ghost")).toContainText("New audio track");
    await page.mouse.up();
    await expect.poll(async () => (await read()).tracks.length).toBe(4);
    const bottom = await read();
    expect(
      bottom.clips.filter((c) => c.src === "Music.wav").map((c) => c.track),
    ).toEqual([4, 5]);
    expect(await agentRead()).toEqual(bottom);
    await undo();

    // A picture ghost left over from a valid row must become a visible refusal at the bottom.
    await hold("B-roll.mp4");
    point = await at(120);
    await page.mouse.move(point.x, point.y, { steps: 12 });
    await expect(page.locator(".tl-ghost")).toBeVisible();
    last = (await page.locator(".tl-lane.audio").last().boundingBox())!;
    await page.mouse.move(point.x, last.y + last.height + 7, { steps: 6 });
    await expect(page.locator(".tl-lanes")).toHaveAttribute("data-refused", "");
    await page.mouse.up();
    await expect(page.locator(".toast")).toContainText("is an audio track");
    expect(await read()).toEqual(initial);
    expect(await agentRead()).toEqual(initial);
  } finally {
    await client.close();
  }
});

test("overwriting V2 previews and cuts A2 while preserving the V1/A1 pair", async ({
  page,
  request,
}, info) => {
  const project = await createMediaProject(request, true);
  const path = `/api/cutroom/projects/${project.id}/timeline`;
  const read = async () =>
    TimelineViewSchema.parse(await (await request.get(path)).json()).timeline;
  const initial = await read();
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("[data-clip]")).toHaveCount(5);
  await startMediaDrag(
    page,
    page
      .getByRole("region", { name: "Media", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "B-roll.mp4" }),
  );
  const lanes = (await page.locator(".tl-lanes").boundingBox())!;
  const lane = (await page.locator(".tl-lane.video").first().boundingBox())!;
  const ppf = Number(
    await page
      .locator(".tl-grid")
      .evaluate((e) => e.style.getPropertyValue("--ppf")),
  );
  await page.mouse.move(lanes.x + 120.5 * ppf, lane.y + 20, { steps: 12 });
  await expect(page.locator(".tl-ghost")).toContainText("Overwrite:");
  await expect(page.locator(".tl-readout")).toBeVisible();
  await expect(page.locator(".tl-readout")).toContainText(
    "Ctrl/Cmd+Shift to insert",
  );
  // The preview cuts A2, leaving A1's box and waveform at their original full length.
  const dialogue = page.locator('[data-clip="dialogue"]');
  const background = page.locator('[data-clip="background-sound"]');
  await expect(dialogue).toHaveAttribute("data-held", "");
  await expect(background).not.toHaveAttribute("data-held");
  await expect(page.locator(".tl-piece:not([hidden])")).toHaveCount(2);
  const tailRows = await page
    .locator(".tl-piece:not([hidden])")
    .evaluateAll((pieces) => pieces.map((e) => e.getBoundingClientRect().y));
  const dialogueRow = (await dialogue.boundingBox())!.y;
  expect(tailRows).toContain(dialogueRow);
  expect(tailRows).not.toContain((await background.boundingBox())!.y);
  await page.screenshot({ path: info.outputPath("two-pair-preview.png") });
  await page.mouse.up();
  await expect.poll(async () => (await read()).clips.length).toBe(9);
  const edited = await read();
  expect(edited.tracks).toEqual(initial.tracks);
  expect(edited.clips.filter((c) => [0, 2, 4].includes(c.track))).toEqual(
    initial.clips.filter((c) => [0, 2, 4].includes(c.track)),
  );
  expect(
    edited.clips
      .filter((c) => c.src === "Interview.mp4" && [1, 3].includes(c.track))
      .map((c) => [c.track, c.start, c.duration]),
  ).toEqual([
    [1, 0, 120],
    [1, 180, 180],
    [3, 0, 120],
    [3, 180, 180],
  ]);
  expect(
    edited.clips.find((c) => c.src === "B-roll.mp4" && c.kind === "audio"),
  ).toMatchObject({ track: 3, start: 120, duration: 60 });
  await page.screenshot({ path: info.outputPath("two-pair-overwrite.png") });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(read).toEqual(initial);
});
