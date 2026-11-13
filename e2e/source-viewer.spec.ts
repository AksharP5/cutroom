import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);

/**
 * A 12 second source whose colour says where you are in it: red for two seconds, green for
 * three, then blue. One four second clip of it is on V1 with its sound on A1.
 */
async function open(page: Page, request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: `Source viewer ${Date.now()}`,
          duration: 12,
          width: 320,
          height: 240,
        },
      })
    ).json(),
  );
  const colour = (name: string, seconds: number) => [
    "-f",
    "lavfi",
    "-i",
    `color=${name}:s=320x240:r=30:d=${seconds}`,
  ];
  await exec("ffmpeg", [
    "-v",
    "error",
    ...colour("red", 2),
    ...colour("lime", 3),
    ...colour("blue", 7),
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=12",
    "-filter_complex",
    "[0][1][2]concat=n=3:v=1[v]",
    "-map",
    "[v]",
    "-map",
    "3:a",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    "15",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "talk.mp4"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=8",
    join(project.path, "music.wav"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    ...colour("yellow", 1),
    "-frames:v",
    "1",
    join(project.path, "card.png"),
  ]);
  const path = join(project.path, "index.html");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      /<main([^>]*)>[\s\S]*<\/main>/,
      `<main$1>
    <video src="talk.mp4" muted id="picture" class="clip" data-start="0" data-duration="4" data-track-index="0" data-link="pair"></video>
    <audio src="talk.mp4" id="sound" class="clip" data-start="0" data-duration="4" data-track-index="1" data-link="pair"></audio>
    </main>`,
    ),
  );
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(2);
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
  const before = await read();
  /** Clips made since the test began: kind, track, start, length, and seconds into the source. */
  const added = async () =>
    (await read()).clips
      .filter((clip) => !before.clips.some((old) => old.id === clip.id))
      .map((clip) => [
        clip.kind,
        clip.track,
        clip.start,
        clip.duration,
        clip.mediaStart,
      ]);
  /** A Media row, once its length is known and it can be opened or placed. */
  const file = async (name: string) => {
    const row = page.locator(`.media-row[data-path="${name}"]`);
    await expect(row).toHaveAttribute("draggable", "true");
    return row;
  };
  return {
    project,
    read,
    before,
    added,
    file,
    source: page.getByRole("group", { name: "Source" }),
    clock: page.getByRole("button", { name: /^Current time/ }),
  };
}

/** The colour in the middle of what `locator` shows, as the screen has it. */
async function colour(page: Page, locator: Locator) {
  const png = (await locator.screenshot()).toString("base64");
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const context = new OffscreenCanvas(1, 1).getContext("2d")!;
    context.drawImage(image, -image.width / 2, -image.height / 2);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return red! > 200 && green! < 80 && blue! < 80
      ? "red"
      : green! > 200 && red! < 80 && blue! < 80
        ? "green"
        : blue! > 200 && red! < 80 && green! < 80
          ? "blue"
          : "other";
  }, png);
}

async function seek(page: Page, time: string) {
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially(time);
  await page.keyboard.press("Enter");
}

test("a part marked in the source viewer goes on the timeline by key, button and drag", async ({
  page,
  request,
  baseURL,
}) => {
  const { project, read, before, added, file, source, clock } = await open(
    page,
    request,
  );
  const picture = source.locator("video");
  const views = page.getByRole("group", { name: "Viewer" });

  // A double-click opens the file over the timeline's picture; the transport now drives it.
  await (await file("talk.mp4")).dblclick();
  await expect(source).toBeVisible();
  await expect(views.getByRole("button", { name: "Source" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".edit-duration")).toHaveText("00:00:12:00");

  // Mark the green part exactly: its first frame in, its last frame out.
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(clock).toHaveText("00:00:01:29");
  await expect.poll(() => colour(page, picture)).toBe("red");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => colour(page, picture)).toBe("green");
  await page.keyboard.press("i");
  await seek(page, "429");
  await expect.poll(() => colour(page, picture)).toBe("green");
  await page.keyboard.press("o");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => colour(page, picture)).toBe("blue");
  const range = page.locator(".edit-range");
  await expect(range).toHaveText("In 00:00:02:00Out 00:00:04:29");
  await expect(source.getByTitle("Length to place")).toHaveText("00:00:03:00");
  // Marking a source is not a timeline edit.
  expect((await read()).range).toEqual(before.range);

  // Space plays the source, with the timeline left where it was.
  await page.keyboard.press("Shift+i");
  await page.keyboard.press("Space");
  await expect
    .poll(() => picture.evaluate((video: HTMLVideoElement) => video.paused))
    .toBe(false);
  await page.keyboard.press("Space");
  await expect
    .poll(() => picture.evaluate((video: HTMLVideoElement) => video.paused))
    .toBe(true);

  // Each file keeps its marks while another is open.
  await (await file("music.wav")).dblclick();
  await expect(source.locator("canvas")).toBeVisible();
  await expect(range).toBeHidden();
  await (await file("talk.mp4")).dblclick();
  await expect(range).toHaveText("In 00:00:02:00Out 00:00:04:29");
  await expect(clock).toHaveText("00:00:02:00");

  // Scrubbing the timeline shows the timeline; the source stays loaded.
  const ruler = (await page.locator(".tl-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + 40, ruler.y + ruler.height / 2);
  await expect(source).toBeHidden();
  await expect(views.getByRole("button", { name: "Timeline" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await seek(page, "800");

  // F9 inserts the marked part at the timeline's playhead, with its linked sound.
  await page.keyboard.press("F9");
  await expect.poll(added).toEqual([
    ["video", 0, 240, 90, 2],
    ["audio", 1, 240, 90, 2],
  ]);
  // The playhead moved to the end of the new clip, and the picture there is the marked part.
  await expect(clock).toHaveText("00:00:11:00");
  const stage = page.locator(".edit-picture");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => colour(page, stage)).toBe("green");
  await seek(page, "800");
  await expect.poll(() => colour(page, stage)).toBe("green");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => colour(page, stage)).toBe("other");
  // One undo step.
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);

  // Alt+Q shows the source again, and its Overwrite button places the same part.
  await seek(page, "800");
  await page.keyboard.press("Alt+q");
  await expect(source).toBeVisible();
  await source.getByRole("button", { name: "Overwrite" }).click();
  await expect.poll(added).toEqual([
    ["video", 0, 240, 90, 2],
    ["audio", 1, 240, 90, 2],
  ]);
  // Resolve's default switches to the timeline after a source edit.
  await expect(source).toBeHidden();
  await expect(
    views.getByRole("button", { name: "Timeline", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+q");
  await expect(source).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);

  // Dragging the source's picture onto a track places the marked part where it is dropped.
  const held = source.locator(".edit-source-media");
  const box = (await held.boundingBox())!;
  await held.hover();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, {
    steps: 2,
  });
  // The drop bands appear at dragstart, and the undo above may still be refitting the zoom.
  await expect(page.locator(".tl-drop-above")).toBeVisible();
  await expect(page.locator(".tl-grid")).toHaveAttribute(
    "data-refit",
    "settled",
  );
  const lanes = (await page.locator(".tl-lanes").boundingBox())!;
  const lane = (await page.locator(".tl-lane.video").first().boundingBox())!;
  const ppf = Number(
    await page
      .locator(".tl-grid")
      .evaluate((grid) => grid.style.getPropertyValue("--ppf")),
  );
  await page.mouse.move(lanes.x + 200.5 * ppf, lane.y + 20, { steps: 12 });
  await expect(page.locator(".tl-ghost")).toBeVisible();
  await page.mouse.up();
  await expect.poll(added).toEqual([
    ["video", 0, 200, 90, 2],
    ["audio", 1, 200, 90, 2],
  ]);
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);

  // An agent places the same part through timeline_edit, as one undo step.
  const client = new Client({ name: "source-range-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  try {
    const { revision } = TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
    const result = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: revision,
        commands: [
          {
            type: "insert",
            mode: "overwrite",
            track: 0,
            at: 240,
            clip: {
              kind: "video",
              src: "talk.mp4",
              mediaStart: 2,
              duration: 90,
            },
          },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
  } finally {
    await client.close();
  }
  await expect.poll(added).toEqual([
    ["video", 0, 240, 90, 2],
    ["audio", 1, 240, 90, 2],
  ]);
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);

  // Closing unloads the file: the switch goes, and F9 has nothing to place.
  await source.getByRole("button", { name: "Close source" }).click();
  await expect(source).toBeHidden();
  await expect(views).toBeHidden();
  await page.keyboard.press("F9");
  await expect(
    page.getByText("Open a file from Media to place it."),
  ).toBeVisible();
  expect(await read()).toEqual(before);
});

test("audio shows its waveform and a still runs five seconds, each on a track of its kind", async ({
  page,
  request,
}) => {
  const { read, before, added, file, source, clock } = await open(
    page,
    request,
  );

  // Enter opens the focused file. Audio is a waveform, drawn once its peaks arrive.
  await (await file("music.wav")).focus();
  await page.keyboard.press("Enter");
  const wave = source.locator("canvas");
  await expect
    .poll(() =>
      wave.evaluate((canvas: HTMLCanvasElement) =>
        canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height)
          .data.some((value) => value > 0),
      ),
    )
    .toBe(true);
  // The list lets go of the arrows: Down and Up move the source to its end and back.
  await expect(await file("music.wav")).not.toBeFocused();
  const start = (await clock.textContent())!;
  await page.keyboard.press("ArrowDown");
  await expect(clock).not.toHaveText(start);
  await page.keyboard.press("ArrowUp");
  await expect(clock).toHaveText(start);
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("i");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("o");
  // From the timeline's last frame the clip goes after it, so placements follow one another.
  await page.keyboard.press("Alt+q");
  await seek(page, "1129");
  await expect(clock).toHaveText("00:00:11:29");
  await page.keyboard.press("F10");
  await expect.poll(added).toEqual([["audio", 1, 360, 31, 1]]);
  await page.keyboard.press("F10");
  await expect.poll(added).toEqual([
    ["audio", 1, 360, 31, 1],
    ["audio", 1, 391, 31, 1],
  ]);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);

  // A still from the menu: five seconds unless marked shorter.
  await (await file("card.png")).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in source viewer" }).click();
  await expect(source.locator("img")).toBeVisible();
  await expect(page.locator(".edit-duration")).toHaveText("00:00:05:00");
  await source.locator(".edit-source-media").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Overwrite with source at playhead" })
    .click();
  await expect.poll(added).toEqual([["image", 0, 360, 150, null]]);
});

test("F9 and F10 from Source reveal Timeline after a successful placement", async ({
  page,
  request,
}, testInfo) => {
  const { read, before, file, source } = await open(page, request);
  const views = page.getByRole("group", { name: "Viewer" });
  for (const key of ["F9", "F10"]) {
    await seek(page, "200");
    await (await file("talk.mp4")).dblclick();
    await expect(source).toBeVisible();
    await page.keyboard.press("i");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("o");
    expect(await read()).toEqual(before);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/cutroom/projects/*/commands", async (route) => {
      await gate;
      await route.fulfill({ response: await route.fetch() });
    });
    try {
      await page.keyboard.press(key);
      await expect(source).toBeHidden();
      await expect(
        views.getByRole("button", { name: "Timeline", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    } finally {
      release();
    }
    await expect.poll(read).not.toEqual(before);
    await page.unroute("**/api/cutroom/projects/*/commands");
    if (key === "F9")
      await page.screenshot({
        path: testInfo.outputPath("after-source-f9.png"),
      });
    await page.keyboard.press("Control+z");
    await expect.poll(read).toEqual(before);
  }
});

test("timeline edit keys immediately edit and reveal Timeline while Source is shown", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const { read, before, file, source } = await open(page, request);
  const timeline = page.getByRole("region", { name: "Timeline" });
  const selected = () =>
    timeline
      .locator("[data-clip].selected")
      .evaluateAll((clips) =>
        clips.map((clip) => clip.getAttribute("data-clip")).sort(),
      );
  await seek(page, "200");
  await expect
    .poll(() => colour(page, page.locator(".edit-picture")))
    .toBe("green");
  await page.keyboard.press("Shift+v");
  const selection = await selected();
  expect(selection).toEqual(["picture", "sound"]);
  const copied = page.waitForResponse(/\/timeline\/copy$/);
  await page.keyboard.press("Control+c");
  expect((await copied).ok()).toBe(true);

  let commands = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/commands"))
      commands++;
  });
  for (const key of [
    "q",
    "w",
    "e",
    "Control+Backslash",
    "x",
    "Shift+x",
    "Backspace",
    "Delete",
    "d",
    "m",
    "Control+x",
    "Control+v",
    "Control+Shift+v",
  ]) {
    await test.step(key, async () => {
      await seek(page, "200");
      await (await file("talk.mp4")).dblclick();
      await expect(source).toBeVisible();
      commands = 0;
      await page.keyboard.press(key);
      await expect.poll(read).not.toEqual(before);
      if (key === "q")
        await page.screenshot({
          path: testInfo.outputPath("after-press-q.png"),
        });
      await expect(source).toBeHidden();
      expect(commands).toBe(1);
      if (key === "q") {
        await expect
          .poll(() => colour(page, page.locator(".edit-picture")))
          .toBe("green");
        await page.screenshot({ path: testInfo.outputPath("visible-q.png") });
      }
      await page.keyboard.press("Control+z");
      await expect.poll(read).toEqual(before);
      // Removing clips prunes selection; restore it for the next selected edit.
      await seek(page, "200");
      await page.keyboard.press("Shift+v");
    });
  }
});
