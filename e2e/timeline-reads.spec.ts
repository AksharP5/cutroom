import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { seekFrame } from "./position-helpers";

async function makeReadProject(request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", { data: { name: "Reads" } })
    ).json(),
  );
  const index = join(project.path, "index.html");
  const shots = Array.from(
    { length: 4 },
    (_, n) =>
      `<div id="shot-${n + 1}" class="clip" data-start="${n * 3}" data-duration="3" data-track-index="0">Shot ${n + 1}</div>`,
  );
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      /(<main[^>]*>)[\s\S]*<\/main>/,
      `$1\n${shots.join("\n")}\n</main>`,
    ),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  return { project, api, index };
}

/**
 * One edit writes several project files. A burst of notifications gets one read,
 * including in another tab that did not receive the command response.
 */
test("file events make one read and outside edits still show", async ({
  page,
  request,
}) => {
  const { project, api, index } = await makeReadProject(request);
  const reads = { timeline: 0, history: 0 };
  page.on("request", (sent) => {
    if (sent.method() !== "GET") return;
    const path = new URL(sent.url()).pathname;
    if (path === `${api}/timeline`) reads.timeline++;
    if (path === `${api}/history`) reads.history++;
  });
  await page.goto(`/#project/${project.id}`);
  const clips = page
    .getByRole("region", { name: "Timeline" })
    .locator("[data-clip]");
  await expect(clips).toHaveCount(4);
  await page.getByRole("region", { name: "Viewer" }).click();
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("0100");
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: "Viewer" }).click();

  /** Reads after `change` once the timeline shows `count` clips and every file event has landed. */
  const readsFor = async (change: () => Promise<unknown>, count: number) => {
    // Earlier file events and their reads land first.
    await page.waitForTimeout(1000);
    reads.timeline = 0;
    reads.history = 0;
    await change();
    await expect(clips).toHaveCount(count);
    await page.waitForTimeout(1000);
    return { ...reads };
  };

  const other = await page.context().newPage();
  try {
    await other.goto(`/#project/${project.id}`);
    const otherClips = other
      .getByRole("region", { name: "Timeline" })
      .locator("[data-clip]");
    await expect(otherClips).toHaveCount(4);
    await page.bringToFront();
    // The edit reads its history. The file notifications share one read.
    expect(await readsFor(() => page.keyboard.press("e"), 5)).toEqual({
      timeline: 1,
      history: 2,
    });
    await expect(otherClips).toHaveCount(5);
  } finally {
    await other.close();
  }
  // Undo returns the view and history. File events still trigger the shared refresh.
  expect(await readsFor(() => page.keyboard.press("Control+z"), 4)).toEqual({
    timeline: 1,
    history: 1,
  });
  const toolbar = page.getByRole("toolbar", { name: "Tools", exact: true });
  const undo = toolbar.getByRole("button", { name: "Undo", exact: true });
  const redo = toolbar.getByRole("button", { name: "Redo", exact: true });
  await expect(undo).toBeDisabled();
  await expect(redo).toBeEnabled();
  const requested = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<void>();
  const commands = `**${api}/commands`;
  await page.route(commands, async (route) => {
    requested.resolve();
    await respond.promise;
    await route.fulfill({
      status: 422,
      json: { error: "The edit was refused." },
    });
  });
  try {
    await page.keyboard.press("e");
    await requested.promise;
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
  } finally {
    respond.resolve();
  }
  await expect(undo).toBeDisabled();
  await expect(redo).toBeEnabled();
  await page.unroute(commands);

  expect(
    await readsFor(async () => {
      const { revision } = TimelineViewSchema.parse(
        await (await request.get(`${api}/timeline`)).json(),
      );
      const response = await request.post(`${api}/commands`, {
        data: {
          expectedRevision: revision,
          label: "Agent",
          commands: [{ type: "remove", clipIds: ["shot-4"], ripple: false }],
        },
      });
      expect(response.ok()).toBe(true);
    }, 3),
  ).toEqual({ timeline: 1, history: 1 });

  // Different paths reach the tab as separate events while an outside edit waits to show.
  const twoShots = (await readFile(index, "utf8")).replace(
    /<div[^>]*\bid="shot-3"[^>]*>Shot 3<\/div>/,
    "",
  );
  let finishedWriting = false;
  const writes = (async () => {
    await writeFile(index, twoShots);
    for (let i = 0; i < 40; i++) {
      await writeFile(join(project.path, `progress-${i}.txt`), String(i));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    finishedWriting = true;
  })();
  try {
    await expect(clips).toHaveCount(2);
    expect(finishedWriting).toBe(false);
  } finally {
    await writes;
  }
});

test("Undo and Redo skip their own timeline read and keep another writer's change", async ({
  page,
  request,
}) => {
  const { project, api, index } = await makeReadProject(request);
  const url = `/#project/${project.id}`;
  await page.goto(url);
  const clips = page
    .getByRole("region", { name: "Timeline" })
    .locator("[data-clip]");
  await expect(clips).toHaveCount(4);
  async function split(frame: number) {
    await seekFrame(page, frame);
    await page.getByRole("region", { name: "Viewer" }).click();
    const saved = page.waitForResponse((response) =>
      response.url().endsWith(`${api}/commands`),
    );
    await page.keyboard.press("e");
    expect((await saved).ok()).toBe(true);
  }
  // The first edit also records inferred track settings. The second changes just the HTML.
  await split(30);
  const beforeSplit = await readFile(index);
  await split(60);
  const afterSplit = await readFile(index);
  await expect(clips).toHaveCount(6);

  const other = await page.context().newPage();
  try {
    await other.goto(url);
    const otherClips = other
      .getByRole("region", { name: "Timeline" })
      .locator("[data-clip]");
    await expect(otherClips).toHaveCount(6);
    await page.bringToFront();
    await page.waitForTimeout(1000);
    const reads: string[] = [];
    page.on("request", (sent) => {
      const path = new URL(sent.url()).pathname;
      if (
        sent.method() === "GET" &&
        (path === `${api}/timeline` || path === `${api}/history`)
      )
        reads.push(path);
    });
    for (const [key, count, bytes] of [
      ["Control+z", 5, beforeSplit],
      ["Control+Shift+z", 6, afterSplit],
    ] as const) {
      await page.keyboard.press(key);
      await expect(clips).toHaveCount(count);
      // The observing tab has only the file event. Its watcher read must still land.
      await expect(otherClips).toHaveCount(count);
      // Allow the initiating tab's event coalescing window to drain.
      await page.waitForTimeout(500);
      expect(reads).toEqual([]);
      expect(await readFile(index)).toEqual(bytes);
    }

    const undoRoute = `**${api}/history/undo`;
    const redo = page.getByRole("button", { name: "Redo", exact: true });
    // A save can land even if its response is lost. The initiating tab must read again.
    await page.route(
      undoRoute,
      async (route) => {
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort("failed");
      },
      { times: 1 },
    );
    await page.keyboard.press("Control+z");
    await expect(otherClips).toHaveCount(5);
    await expect(redo).toBeEnabled();
    await expect(clips).toHaveCount(5);
    await page
      .getByRole("alert")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await page.keyboard.press("Control+Shift+z");
    await expect(redo).toBeDisabled();
    await expect(otherClips).toHaveCount(6);

    // Deliver an already-computed Undo response after an outside rewrite of the same file.
    const answered = Promise.withResolvers<void>();
    const deliver = Promise.withResolvers<void>();
    await page.route(undoRoute, async (route) => {
      const response = await route.fetch();
      answered.resolve();
      await deliver.promise;
      await route.fulfill({ response });
    });
    try {
      await page.keyboard.press("Control+z");
      await answered.promise;
      const outside = beforeSplit
        .toString("utf8")
        .replace(/<div[^>]*\bid="shot-4"[^>]*>Shot 4<\/div>/, "");
      await writeFile(index, outside);
      await expect(otherClips).toHaveCount(4);
      deliver.resolve();
      await expect(clips).toHaveCount(4);
      await expect(page.locator('[data-clip="shot-4"]')).toHaveCount(0);
      await expect(
        page.getByRole("status").filter({ hasText: "Outside edit" }),
      ).toBeVisible();
      expect(await readFile(index, "utf8")).toBe(outside);
    } finally {
      deliver.resolve();
      await page.unroute(undoRoute);
    }
  } finally {
    await other.close();
  }
});

async function openSlipProject({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Trim burst" },
      })
    ).json(),
  );
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    "3",
    join(project.path, "sound.wav"),
  ]);
  const path = join(project.path, "index.html");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      /(<main[^>]*>)[\s\S]*<\/main>/,
      '$1\n<audio id="sound" src="sound.wav" data-start="0" data-duration="1" data-media-start="0.4" data-track-index="1"></audio>\n</main>',
    ),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const view = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  const sourceFrame = async () => {
    const { timeline } = await view();
    const mediaStart = timeline.clips.find(
      ({ id }) => id === "sound",
    )?.mediaStart;
    return mediaStart === null || mediaStart === undefined
      ? null
      : Math.round((mediaStart * timeline.fps.num) / timeline.fps.den);
  };
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="sound"]').click();
  const initial = (await sourceFrame())!;
  const toolbar = page.getByRole("toolbar", { name: "Tools", exact: true });
  const undo = toolbar.getByRole("button", { name: "Undo", exact: true });
  const redo = toolbar.getByRole("button", { name: "Redo", exact: true });
  const hold = async (frames: number) => {
    await page.keyboard.down("Alt");
    for (let i = 0; i < frames; i++) await page.keyboard.down("Comma");
  };
  const release = async () => {
    await page.keyboard.up("Alt");
    await page.keyboard.up("Comma");
  };
  return { api, hold, initial, redo, release, sourceFrame, undo, view };
}

test("one held slip saves on release and undoes every repeated frame", async ({
  page,
  request,
}) => {
  const { api, hold, initial, redo, release, sourceFrame, undo } =
    await openSlipProject({ page, request });
  const saves: unknown[] = [];
  let reads = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === `${api}/timeline`) reads++;
    if (request.method() === "POST" && path === `${api}/commands`)
      saves.push(request.postDataJSON());
  });
  await expect(undo).toBeDisabled();
  await hold(6);
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
  await page.waitForTimeout(650);
  expect(saves).toEqual([]);
  expect(await sourceFrame()).toBe(initial);
  await release();
  await expect.poll(sourceFrame).toBe(initial + 6);
  await page.waitForTimeout(650);
  expect(reads).toBe(0);
  expect(saves).toEqual([
    expect.objectContaining({
      label: "Slipped 6 frames later in its source, without its linked clips",
      commands: [expect.objectContaining({ type: "slip", by: 6 })],
    }),
  ]);

  await page.keyboard.press("Control+z");
  await expect.poll(sourceFrame).toBe(initial);
  await expect(redo).toBeEnabled();
  await page.keyboard.press("Alt+Comma");
  await page.keyboard.press("Alt+Comma");
  await expect.poll(sourceFrame).toBe(initial + 2);
  await page.keyboard.press("Control+z");
  await expect.poll(sourceFrame).toBe(initial + 1);
  await page.keyboard.press("Control+z");
  await expect.poll(sourceFrame).toBe(initial);
});

test("a refused held slip rolls back the whole gesture once", async ({
  page,
  request,
}) => {
  const { api, hold, initial, release, sourceFrame, undo } =
    await openSlipProject({ page, request });
  let refused = 0;
  await page.route(`**${api}/commands`, async (route) => {
    refused++;
    await route.fulfill({
      status: 422,
      json: { error: "The held slip was refused." },
    });
  });
  await hold(6);
  await expect(undo).toBeEnabled();
  await release();
  await expect(
    page.getByRole("alert", { name: "" }).filter({
      hasText: "The held slip was refused.",
    }),
  ).toHaveCount(1);
  await expect(undo).toBeDisabled();
  expect(refused).toBe(1);
  expect(await sourceFrame()).toBe(initial);
});

test("a held edit survives reloading before keyup", async ({
  page,
  request,
}) => {
  const { hold, initial, release, sourceFrame } = await openSlipProject({
    page,
    request,
  });
  let prompted = false;
  page.once("dialog", async (dialog) => {
    prompted = dialog.type() === "beforeunload";
    await dialog.accept();
  });
  await hold(6);
  expect(await sourceFrame()).toBe(initial);
  await page.reload();
  await expect.poll(sourceFrame).toBe(initial + 6);
  expect(prompted).toBe(true);
  await release();
});

test("leaving with an Undo queued behind a save warns, and the Undo lands once the save does", async ({
  page,
  request,
}) => {
  const { api, hold, initial, release, sourceFrame, redo } =
    await openSlipProject({ page, request });
  const saving = Promise.withResolvers<void>();
  await page.route(`**${api}/commands`, async (route) => {
    await saving.promise;
    await route.continue();
  });
  await hold(3);
  await release();
  await page.keyboard.press("Control+z");
  const warnings: string[] = [];
  page.on("dialog", async (dialog) => {
    warnings.push(dialog.type());
    await dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => warnings).toEqual(["beforeunload"]);
  expect(page.isClosed()).toBe(false);
  saving.resolve();
  await expect.poll(sourceFrame).toBe(initial);
  await expect(redo).toBeEnabled();
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(warnings).toEqual(["beforeunload"]);
});

test("an Undo in flight when the page reloads still reaches the server", async ({
  page,
  request,
}) => {
  const { api, hold, initial, release, sourceFrame, undo } =
    await openSlipProject({ page, request });
  await hold(3);
  await release();
  await expect.poll(sourceFrame).toBe(initial + 3);
  await expect(undo).toBeEnabled();
  // Hold the request across the reload; only a keepalive request outlives its page.
  const sent = Promise.withResolvers<void>();
  const reloaded = Promise.withResolvers<void>();
  await page.route(`**${api}/history/undo`, async (route) => {
    sent.resolve();
    await reloaded.promise;
    await route.continue();
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("Control+z");
  await sent.promise;
  await page.reload();
  reloaded.resolve();
  await expect.poll(sourceFrame).toBe(initial);
});

test("blur and a project switch save a hold while its key is down", async ({
  page,
  request,
}) => {
  const { hold, initial, release, sourceFrame } = await openSlipProject({
    page,
    request,
  });
  const other = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Another project" },
      })
    ).json(),
  );
  await hold(3);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect.poll(sourceFrame).toBe(initial + 3);
  await release();
  await hold(3);
  expect(await sourceFrame()).toBe(initial + 3);
  await page.evaluate((id) => {
    location.hash = `#project/${id}`;
  }, other.id);
  await expect(
    page.getByRole("button", { name: "Another project" }),
  ).toBeVisible();
  await expect.poll(sourceFrame).toBe(initial + 6);
  await release();
});

test("a different edit and Undo keep their order when a trim key is down", async ({
  page,
  request,
}) => {
  const { api, hold, initial, sourceFrame, view } = await openSlipProject({
    page,
    request,
  });
  const paths: string[] = [];
  page.on("request", (event) => {
    const path = new URL(event.url()).pathname;
    if (
      event.method() === "POST" &&
      (path === `${api}/commands` || path === `${api}/history/undo`)
    )
      paths.push(path.slice(api.length + 1));
  });
  await hold(3);
  await page.keyboard.up("Alt");
  await page.keyboard.press("m");
  await expect.poll(async () => (await view()).timeline.markers.length).toBe(1);
  expect(await sourceFrame()).toBe(initial + 3);
  await page.keyboard.up("Comma");

  await hold(3);
  await page.keyboard.up("Alt");
  const undone = page.waitForResponse(
    (event) =>
      event.request().method() === "POST" &&
      new URL(event.url()).pathname === `${api}/history/undo`,
  );
  await page.keyboard.press("Control+z");
  expect((await undone).ok()).toBe(true);
  await expect.poll(sourceFrame).toBe(initial + 3);
  expect(paths).toEqual(["commands", "commands", "commands", "history/undo"]);
  await page.keyboard.up("Comma");
  expect((await view()).timeline.markers).toHaveLength(1);
});

test("releasing one physical key keeps the other key's hold unsaved", async ({
  page,
  request,
}) => {
  const { hold, initial, sourceFrame } = await openSlipProject({
    page,
    request,
  });
  await hold(3);
  await page.keyboard.down("Period");
  await page.keyboard.down("Period");
  await expect.poll(sourceFrame).toBe(initial + 3);
  await page.keyboard.up("Comma");
  await page.waitForTimeout(350);
  expect(await sourceFrame()).toBe(initial + 3);
  await page.keyboard.up("Alt");
  await page.keyboard.up("Period");
  await expect.poll(sourceFrame).toBe(initial + 1);
});

test("a held slip retries once after an unrelated edit wins the revision", async ({
  page,
  request,
}) => {
  const { api, hold, initial, release, sourceFrame, view } =
    await openSlipProject({ page, request });
  const responses: number[] = [];
  await page.route(`**${api}/commands`, async (route) => {
    if (!responses.length) {
      const { revision } = await view();
      const outside = await request.post(`${api}/commands`, {
        data: {
          expectedRevision: revision,
          label: "Agent marker",
          commands: [{ type: "setMarker", frame: 6, name: "Agent marker" }],
        },
      });
      expect(outside.ok()).toBe(true);
    }
    const response = await route.fetch();
    responses.push(response.status());
    await route.fulfill({ response });
  });
  await hold(6);
  await release();
  await expect.poll(sourceFrame).toBe(initial + 6);
  // The server applies the retry before the route handler records its status.
  await expect.poll(() => responses).toEqual([409, 200]);
  expect((await view()).timeline.markers.map(({ name }) => name)).toEqual([
    "Agent marker",
  ]);
  await page.keyboard.press("Control+z");
  await expect.poll(sourceFrame).toBe(initial);
  expect((await view()).timeline.markers).toHaveLength(1);
});

test("an outside change appears while the slip key is still down", async ({
  page,
  request,
}) => {
  const { api, hold, initial, release, sourceFrame, view } =
    await openSlipProject({ page, request });
  await hold(3);
  const { revision } = await view();
  const outside = await request.post(`${api}/commands`, {
    data: {
      expectedRevision: revision,
      label: "Agent marker",
      commands: [{ type: "setMarker", frame: 6, name: "Agent marker" }],
    },
  });
  expect(outside.ok()).toBe(true);
  await expect(page.getByTitle(/^Agent marker/)).toBeVisible();
  expect(await sourceFrame()).toBe(initial);
  await hold(3);
  await release();
  await expect.poll(sourceFrame).toBe(initial + 6);
  await page.keyboard.press("Control+z");
  await expect.poll(sourceFrame).toBe(initial);
  expect((await view()).timeline.markers).toHaveLength(1);
});

test("an outside edit to the held clip keeps its own source timing", async ({
  page,
  request,
}) => {
  const { api, hold, initial, release, sourceFrame, view } =
    await openSlipProject({ page, request });
  await hold(3);
  const { revision } = await view();
  const outside = await request.post(`${api}/commands`, {
    data: {
      expectedRevision: revision,
      label: "Agent slip",
      commands: [
        { type: "slip", clipId: "sound", by: 1, linked: false },
        { type: "setMarker", frame: 6, name: "Agent slip" },
      ],
    },
  });
  expect(outside.ok()).toBe(true);
  await expect(page.getByTitle(/^Agent slip/)).toBeVisible();
  const refused = page.getByRole("alert").filter({
    hasText: "An agent changed those clips first.",
  });
  await expect(refused).toHaveCount(1);
  await hold(3);
  await release();
  await expect(refused).toHaveCount(1);
  expect(await sourceFrame()).toBe(initial + 1);
});
