import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isMissing } from "../src/server/projects/path";
import { ProjectSchema } from "../src/shared/project";
import { z } from "zod";
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

test("source marks survive reload and project switches without entering undo history", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const a = await open(page, request);
  const range = page.locator(".edit-range");
  const history = async () =>
    (await request.get(`/api/cutroom/projects/${a.project.id}/history`)).json();
  const before = await history();
  await (await a.file("talk.mp4")).dblclick();
  await seek(page, "200");
  await page.keyboard.press("i");
  await seek(page, "429");
  await page.keyboard.press("o");
  await expect(range).toHaveText("In 00:00:02:00Out 00:00:04:29");
  await page.screenshot({ path: testInfo.outputPath("before-reload.png") });
  // Observe the acknowledged disk save before reloading, as with destination tracks.
  await expect
    .poll(
      async () =>
        await readFile(
          join(a.project.path, ".cutroom/view.json"),
          "utf8",
        ).catch(() => ""),
    )
    .toContain('"out": 5');
  expect(await history()).toEqual(before);

  await page.reload();
  await expect(
    page.getByRole("region", { name: "Timeline" }).locator("[data-clip]"),
  ).toHaveCount(2);
  await (await a.file("talk.mp4")).dblclick();
  await expect(a.source).toBeVisible();
  await expect(range).toHaveText("In 00:00:02:00Out 00:00:04:29");
  await expect(a.clock).toHaveText("00:00:02:00");
  await expect
    .poll(() => colour(page, a.source.locator("video")))
    .toBe("green");
  await page.screenshot({ path: testInfo.outputPath("after-reload.png") });

  const b = await open(page, request);
  await (await b.file("talk.mp4")).dblclick();
  await expect(range).toBeHidden();
  await seek(page, "100");
  await page.keyboard.press("i");
  await seek(page, "129");
  await page.keyboard.press("o");
  await expect(range).toHaveText("In 00:00:01:00Out 00:00:01:29");
  await expect
    .poll(async () =>
      (
        await request.get(
          `/api/cutroom/projects/${b.project.id}/source-marks?path=talk.mp4`,
        )
      ).json(),
    )
    .toMatchObject({ in: 1, out: 2 });

  await page.evaluate((id) => {
    location.hash = `project/${id}`;
  }, a.project.id);
  await (await a.file("talk.mp4")).dblclick();
  await expect(range).toHaveText("In 00:00:02:00Out 00:00:04:29");
  // A's next save is held while B opens. A's completion cannot overwrite B's marks.
  const saving = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route("**/source-marks?**", async (route) => {
    if (route.request().method() === "PUT") {
      saving.resolve();
      await release.promise;
    }
    await route.continue();
  });
  await seek(page, "300");
  await page.keyboard.press("i");
  await saving.promise;
  try {
    await page.evaluate((id) => {
      location.hash = `project/${id}`;
    }, b.project.id);
    await (await b.file("talk.mp4")).dblclick();
    await expect(range).toHaveText("In 00:00:01:00Out 00:00:01:29");
  } finally {
    release.resolve();
  }
  await expect
    .poll(async () =>
      (
        await request.get(
          `/api/cutroom/projects/${a.project.id}/source-marks?path=talk.mp4`,
        )
      ).json(),
    )
    .toMatchObject({ in: 3, out: 5 });
  await expect(range).toHaveText("In 00:00:01:00Out 00:00:01:29");
  await page.unroute("**/source-marks?**");
  await page.evaluate((id) => {
    location.hash = `project/${id}`;
  }, a.project.id);
  await (await a.file("talk.mp4")).dblclick();
  await expect(range).toHaveText("In 00:00:03:00Out 00:00:04:29");
  expect(await a.read()).toEqual(a.before);
  expect(await history()).toEqual(before);

  const client = new Client({ name: "source-marks-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  try {
    const result = z
      .object({
        structuredContent: z.object({
          result: z.object({
            in: z.number().nullable(),
            out: z.number().nullable(),
          }),
        }),
      })
      .parse(
        await client.callTool({
          name: "source_marks",
          arguments: { projectId: a.project.id, path: "talk.mp4" },
        }),
      );
    expect(result.structuredContent.result).toEqual({ in: 3, out: 5 });
  } finally {
    await client.close();
  }

  // Marks name source seconds, even when the project's frame rate changes.
  const composition = join(a.project.path, "index.html");
  await writeFile(
    composition,
    (await readFile(composition, "utf8")).replace(
      "<main ",
      '<main data-fps="24" ',
    ),
  );
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Timeline" }).locator("[data-clip]"),
  ).toHaveCount(2);
  expect((await a.read()).fps).toEqual({ num: 24, den: 1 });
  await (await a.file("talk.mp4")).dblclick();
  await expect(range).toHaveText("In 00:00:03:00Out 00:00:04:23");
});

test("review: saves stay ordered and coalesce across source navigation", async ({
  page,
  request,
}) => {
  const a = await open(page, request);
  const endpoint = `/api/cutroom/projects/${a.project.id}/source-marks?path=talk.mp4`;
  await (await a.file("talk.mp4")).dblclick();
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sent: number[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("source-marks"))
      sent.push(z.object({ in: z.number() }).parse(request.postDataJSON()).in);
  });
  let first = true;
  await page.route("**/source-marks?**", async (route) => {
    if (first && route.request().method() === "PUT") {
      first = false;
      held.resolve();
      await release.promise;
    }
    await route.continue();
  });
  await seek(page, "400");
  await page.keyboard.press("i");
  await held.promise;
  await seek(page, "500");
  await page.keyboard.press("i");
  await seek(page, "600");
  await page.keyboard.press("i");
  await seek(page, "500");
  await page.keyboard.press("i");
  await (await a.file("music.wav")).dblclick();
  await (await a.file("talk.mp4")).dblclick();
  const landed = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("source-marks") &&
      response.request().postDataJSON().in === 4,
  );
  release.resolve();
  await landed;
  await expect
    .poll(async () => (await (await request.get(endpoint)).json()).in, {
      timeout: 3000,
    })
    .toBe(5);
  await expect(page.locator(".edit-range")).toContainText("In 00:00:05:00");
  expect(sent).toEqual([4, 5]);
});

test("review: an older read cannot replace a newer cross-tab mark", async ({
  page,
  request,
}) => {
  const a = await open(page, request);
  const endpoint = `/api/cutroom/projects/${a.project.id}/source-marks?path=talk.mp4`;
  await (await a.file("talk.mp4")).dblclick();
  await seek(page, "400");
  await page.keyboard.press("i");
  await expect
    .poll(async () => (await (await request.get(endpoint)).json()).in)
    .toBe(4);
  const old = await (await request.get(endpoint)).json();
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  await page.route("**/source-marks?**", async (route) => {
    if (first && route.request().method() === "GET") {
      first = false;
      const response = await route.fetch();
      held.resolve();
      await release.promise;
      return route.fulfill({ response });
    }
    await route.continue();
  });
  await request.put(endpoint, { data: old });
  await held.promise;
  const other = await page.context().newPage();
  try {
    await other.goto(`/#project/${a.project.id}`);
    await expect(
      other.getByRole("region", { name: "Timeline" }).locator("[data-clip]"),
    ).toHaveCount(2);
    await other.locator('.media-row[data-path="talk.mp4"]').dblclick();
    await expect(other.locator(".edit-range")).toContainText("In 00:00:04:00");
    await seek(other, "500");
    await other.keyboard.press("i");
    await expect(page.locator(".edit-range")).toContainText("In 00:00:05:00");
    const delivered = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes("source-marks"),
    );
    release.resolve();
    await delivered;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await page.locator(".edit-range").textContent()).toContain(
      "In 00:00:05:00",
    );
  } finally {
    release.resolve();
    await other.close();
  }
});

test("review: a one-frame NTSC source range stays nonempty at 24 fps", async ({
  page,
  request,
}) => {
  const a = await open(page, request);
  const path = join(a.project.path, "index.html");
  const original = await readFile(path, "utf8");
  await writeFile(
    path,
    original.replace("<main ", '<main data-fps="30000/1001" '),
  );
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Timeline" }).locator("[data-clip]"),
  ).toHaveCount(2);
  await (await a.file("talk.mp4")).dblclick();
  await seek(page, "5");
  await page.keyboard.press("i");
  await page.keyboard.press("o");
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(
              `/api/cutroom/projects/${a.project.id}/source-marks?path=talk.mp4`,
            )
          ).json()
        ).out,
    )
    .toBeGreaterThan(0);
  await writeFile(path, original.replace("<main ", '<main data-fps="24" '));
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Timeline" }).locator("[data-clip]"),
  ).toHaveCount(2);
  await (await a.file("talk.mp4")).dblclick();
  await expect(page.locator(".edit-range")).toBeVisible();
  await expect(a.source.getByTitle("Length to place")).toHaveText(
    "00:00:00:01",
    { timeout: 3000 },
  );
  await page.keyboard.press("F9");
  await expect.poll(a.added).toEqual([
    ["video", 0, 0, 1, 0.208333],
    ["audio", 1, 0, 1, 0.208333],
  ]);
});

for (const failure of ["network", "503", "503-after-ready", "409"] as const) {
  test(`restart: source saves recover from ${failure} without replaying identity conflicts`, async ({
    browser,
    playwright,
  }, info) => {
    const baseURL = "http://127.0.0.1:4952";
    const log = createWriteStream(info.outputPath("server.log"));
    const start = () => {
      const child = spawn("bun", ["src/server/index.ts"], {
        env: {
          ...process.env,
          CUTROOM_PORT: "4952",
          CUTROOM_DATA_DIR: info.outputPath("server/data"),
          CUTROOM_PROJECTS_DIR: info.outputPath("server/projects"),
          HYPERFRAMES_NO_TELEMETRY: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      return child;
    };
    const stop = async (child: ReturnType<typeof start>) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "close");
      child.kill("SIGTERM");
      await exited;
    };
    const request = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { origin: baseURL },
    });
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1720, height: 1050 },
    });
    const page = await context.newPage();
    let server = start();
    const ready = async () =>
      expect
        .poll(
          async () =>
            z.object({ dataDir: z.string() }).safeParse(
              await request
                .get("/api/cutroom/status", { timeout: 500 })
                .then((response) => response.json())
                .catch(() => null),
            ).data?.dataDir,
          { timeout: 15000 },
        )
        .toBe(info.outputPath("server/data"));
    try {
      await ready();
      const a = await open(page, request);
      const endpoint = `/api/cutroom/projects/${a.project.id}/source-marks?path=talk.mp4`;
      await (await a.file("talk.mp4")).dblclick();
      await seek(page, "400");
      await page.keyboard.press("i");
      const disk = async () =>
        z
          .object({
            sources: z.record(
              z.string(),
              z.object({ in: z.number().nullable() }),
            ),
          })
          .parse(
            JSON.parse(
              await readFile(
                join(a.project.path, ".cutroom/view.json"),
                "utf8",
              ).catch((error: unknown) => {
                if (isMissing(error)) return '{"sources":{}}';
                throw error;
              }),
            ),
          ).sources["talk.mp4"]?.in;
      await expect.poll(disk).toBe(4);
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const attempts: number[] = [];
      let first = true;
      await page.route("**/source-marks?**", async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        const input = z
          .object({ in: z.number() })
          .parse(route.request().postDataJSON());
        attempts.push(input.in);
        if (!first || input.in !== 5) return route.continue();
        first = false;
        held.resolve();
        await release.promise;
        if (failure === "network") return route.continue();
        return route.fulfill({
          status: failure === "409" ? 409 : 503,
          contentType: failure !== "409" ? "text/plain" : "application/json",
          body:
            failure !== "409"
              ? "Server unavailable"
              : JSON.stringify({ error: "Source identity changed" }),
        });
      });
      await seek(page, "500");
      await page.keyboard.press("i");
      await held.promise;
      if (failure !== "409" && failure !== "503-after-ready") {
        await seek(page, "600");
        await page.keyboard.press("i");
      }
      await stop(server);
      const reconnected = page.waitForResponse(
        (response) =>
          response.url().includes("/events?") && response.status() === 200,
      );
      if (failure === "503-after-ready") {
        server = start();
        await ready();
        await reconnected;
        await page.waitForTimeout(250);
      }
      const failed =
        failure === "network"
          ? page.waitForEvent("requestfailed", {
              predicate: (request) =>
                request.method() === "PUT" &&
                request.url().includes("source-marks"),
            })
          : page.waitForResponse(
              (response) =>
                response.request().method() === "PUT" &&
                response.status() === (failure === "409" ? 409 : 503),
            );
      release.resolve();
      await failed;
      // Let the failure settle before closing the viewer and reconnecting.
      await page.waitForTimeout(250);
      await a.source.getByRole("button", { name: "Close source" }).click();
      if (failure !== "503-after-ready") {
        server = start();
        await ready();
        await reconnected;
      }
      const expected =
        failure === "409" ? 4 : failure === "503-after-ready" ? 5 : 6;
      if (failure === "409") {
        await page.waitForTimeout(250);
        expect(attempts).toEqual([5]);
      }
      await expect.poll(disk, { timeout: 5000 }).toBe(expected);
      expect(
        z
          .object({ in: z.number() })
          .parse(await (await request.get(endpoint)).json()).in,
      ).toBe(expected);
      await (await a.file("talk.mp4")).dblclick();
      await expect(page.locator(".edit-range")).toContainText(
        `In 00:00:0${expected}:00`,
      );
      await page.screenshot({ path: info.outputPath("after-reconnect.png") });
    } finally {
      await context.close();
      await request.dispose();
      await stop(server);
      const finished = once(log, "finish");
      log.end();
      await finished;
    }
  });
}
