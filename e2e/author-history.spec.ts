import type { APIRequestContext } from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { REVIEW_LEDGER_PATH } from "../src/shared/review";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { clipVersions } from "../src/server/projects/changes";
import { seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";

test("author undo and redo preserve migrated review marks, acceptance, and unrelated files", async ({
  page,
  request,
  baseURL,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Author history", width: 640, height: 360, duration: 10 },
      })
    ).json(),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async (detail = false) =>
    TimelineViewSchema.parse(
      await (
        await request.get(`${api}/timeline${detail ? "?clipEdits=1" : ""}`)
      ).json(),
    );
  const client = new Client({ name: "Codex", version: "1" });
  const otherClient = new Client({ name: "Codex", version: "1" });
  const connect = (client: Client) =>
    client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
  await connect(client);
  await connect(otherClient);
  try {
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
    const picture = page.frameLocator("iframe[data-live]").locator("#headline");
    await expect(picture).toHaveText("Author history");
    await seekFrame(page, 60);
    await page.keyboard.press("m");
    const marker = page.getByRole("button", { name: "Marker Marker 1" });
    await expect(marker).toBeVisible();
    await expect
      .poll(async () => (await read()).timeline.markers.length)
      .toBe(1);
    const markerBefore = (await read()).timeline.markers;
    const beforeSignature = (await clipVersions(project, "index.html")).get(
      "headline",
    );

    const edited = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: (await read()).revision,
        commands: [
          { type: "setClip", clipId: "headline", text: "Codex opening" },
        ],
      },
    });
    expect(edited.isError, JSON.stringify(edited.content)).not.toBe(true);
    const { historyId } = z
      .object({ historyId: z.string() })
      .parse(edited.structuredContent);
    await expect(picture).toHaveText("Codex opening");
    const mark = page.locator('[data-agent-change="headline"]');
    await expect(mark).toBeVisible();
    const edit = (await read(true)).clipEdits?.find(
      (row) => row.clipId === "headline",
    );
    expect(edit).toMatchObject({ historyId, accepted: false });
    const signature = (await clipVersions(project, "index.html")).get(
      "headline",
    );
    const legacy = JSON.stringify({
      schemaVersion: 1,
      items: [],
      clipEdits: [{ ...edit, signature, beforeSignature }],
    });
    const ledger = join(project.path, ".cutroom/review.json");
    await rm(join(project.path, REVIEW_LEDGER_PATH));
    await writeFile(ledger, legacy);
    await page.reload();
    await expect(picture).toHaveText("Codex opening");
    await expect(mark).toBeVisible();
    expect(JSON.parse(await readFile(ledger, "utf8"))).toMatchObject({
      schemaVersion: 1,
      clipEdits: [],
    });
    expect(
      await readFile(join(project.path, ".cutroom/review.v1.json"), "utf8"),
    ).toBe(legacy);
    expect((await read(true)).clipEdits).toContainEqual(edit);

    const media = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=",
      "base64",
    );
    const uploaded = await request.post(
      `/api/projects/${project.id}/upload?dir=assets`,
      {
        multipart: {
          file: { name: "imported.png", mimeType: "image/png", buffer: media },
        },
      },
    );
    expect(uploaded.ok(), await uploaded.text()).toBe(true);
    await writeFile(join(project.path, "assets/outside.png"), media);
    await expect(page.getByText("imported.png", { exact: true })).toBeVisible();
    await expect(page.getByText("outside.png", { exact: true })).toBeVisible();
    expect(
      (
        await request.post(`/api/projects/${project.id}/history/checkpoint`)
      ).ok(),
    ).toBe(true);
    const historyBefore = await (await request.get(`${api}/history`)).json();
    expect(historyBefore.entries).toContainEqual(
      expect.objectContaining({
        label: "Imported 1 file",
        author: { kind: "person", name: "You" },
        step: false,
        files: expect.arrayContaining([
          expect.objectContaining({ path: "assets/imported.png" }),
        ]),
      }),
    );
    expect(historyBefore.entries).toContainEqual(
      expect.objectContaining({
        label: "Added 1 file",
        author: { kind: "outside", name: "Outside" },
        step: false,
        files: expect.arrayContaining([
          expect.objectContaining({ path: "assets/outside.png" }),
        ]),
      }),
    );
    const html = await readFile(join(project.path, "index.html"), "utf8");
    const beforeUndo = await picture.screenshot();

    await page.keyboard.press("Control+z");
    await expect(marker).toHaveCount(0);
    await expect.poll(async () => (await read()).timeline.markers).toEqual([]);
    await expect(picture).toHaveText("Codex opening");
    await expect(mark).toBeVisible();
    expect(await picture.screenshot()).toEqual(beforeUndo);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(html);
    expect(await readFile(join(project.path, "assets/imported.png"))).toEqual(
      media,
    );
    expect(await readFile(join(project.path, "assets/outside.png"))).toEqual(
      media,
    );

    await page.keyboard.press("Control+z");
    await expect(page.getByText("Nothing of yours to undo")).toBeVisible();
    await expect(page.getByText("imported.png", { exact: true })).toBeVisible();
    await expect(page.getByText("outside.png", { exact: true })).toBeVisible();

    await page.keyboard.press("Control+Shift+z");
    await expect(marker).toBeVisible();
    await expect
      .poll(async () => (await read()).timeline.markers)
      .toEqual(markerBefore);
    await expect(picture).toHaveText("Codex opening");
    await expect(mark).toBeVisible();

    const history = (client: Client, name: string) =>
      client.callTool({ name, arguments: { projectId: project.id } });
    const stranger = await history(otherClient, "history_undo");
    expect(stranger.structuredContent).toMatchObject({
      result: { entry: null },
    });
    expect(
      (await history(client, "history_undo")).structuredContent,
    ).toMatchObject({
      result: {
        originalId: historyId,
        entry: { who: { kind: "agent", name: "Codex" } },
      },
    });
    await expect(picture).toHaveText("Author history");
    await expect(marker).toBeVisible();
    await expect(mark).toHaveCount(0);
    expect((await read(true)).clipEdits).not.toContainEqual(edit);
    expect(
      (await history(client, "history_redo")).structuredContent,
    ).toMatchObject({
      result: {
        originalId: historyId,
        entry: { who: { kind: "agent", name: "Codex" } },
      },
    });
    await expect(picture).toHaveText("Codex opening");
    await expect(marker).toBeVisible();
    await expect(mark).toBeVisible();
    expect((await read(true)).clipEdits).toContainEqual(edit);

    await page.getByRole("button", { name: "Review", exact: true }).click();
    const change = page
      .getByRole("complementary", { name: "Inspector" })
      .getByRole("button", { name: /^Set text to .*Codex opening/ });
    await expect(change).toBeVisible();
    const acceptChange = page
      .getByRole("complementary", { name: "Inspector" })
      .getByRole("button", { name: "Accept", exact: true });
    await expect(acceptChange).toBeVisible();
    const accept = page.getByRole("button", {
      name: "Accept all agent changes",
    });
    await accept.click();
    await expect(acceptChange).toHaveCount(0);
    await expect(change).toBeVisible();
    await expect(mark).toHaveCount(0);
    await expect(picture).toHaveText("Codex opening");

    await history(client, "history_undo");
    await expect(picture).toHaveText("Author history");
    await history(client, "history_redo");
    await expect(picture).toHaveText("Codex opening");
    await expect(marker).toBeVisible();
    await expect(mark).toHaveCount(0);
    expect((await read(true)).clipEdits).toContainEqual({
      ...edit,
      accepted: true,
    });
  } finally {
    await Promise.all([client.close(), otherClient.close()]);
  }
});

async function rippleProject(request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Ripple history", width: 640, height: 360, duration: 10 },
      })
    ).json(),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const source = join(project.path, "index.html");
  const markup = await readFile(source, "utf8");
  await writeFile(
    source,
    markup.replace(
      /<div id="rule"[\s\S]*?<\/div>/,
      '<div id="cut" class="clip" data-start="0" data-duration="1" data-track-index="0">Cut</div>' +
        '<div id="next" class="clip" data-start="2" data-duration="1" data-track-index="0">Next</div>' +
        '<div id="last" class="clip" data-start="4" data-duration="1" data-track-index="0">Last</div>',
    ),
  );
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  const starts = async () =>
    (await read()).timeline.clips
      .filter(({ track }) => track === 0)
      .map(({ id, start, duration }) => [id, start, duration]);
  return { project, read, starts };
}

test("a later MCP trim blocks ripple undo and Undo both reverses the named edits", async ({
  page,
  request,
  baseURL,
}, info) => {
  const { project, read, starts } = await rippleProject(request);
  const original = await starts();
  const client = new Client({ name: "Codex", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  try {
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
    await page.locator('[data-clip="cut"]').click();
    await page.keyboard.press("Shift+X");
    await expect(page.locator('[data-clip="cut"]')).toHaveCount(0);
    await expect.poll(starts).toEqual([
      ["next", 30, 30],
      ["last", 90, 30],
    ]);
    const agent = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: (await read()).revision,
        commands: [{ type: "trim", clipId: "last", edge: "end", to: 105 }],
      },
    });
    expect(agent.isError, JSON.stringify(agent.content)).not.toBe(true);
    await expect.poll(starts).toEqual([
      ["next", 30, 30],
      ["last", 90, 15],
    ]);
    await page.keyboard.press("Control+z");
    const toast = page.locator(".toast");
    await expect(toast).toContainText("Codex");
    await expect(toast).toContainText(/trim/i);
    await expect(toast).toContainText(
      "This also takes back the edit by Codex.",
    );
    const both = page.getByRole("button", { name: "Undo both", exact: true });
    await expect(both).toBeVisible();
    await expect(page.locator('[data-clip="cut"]')).toHaveCount(0);
    expect(await starts()).toEqual([
      ["next", 30, 30],
      ["last", 90, 15],
    ]);
    const cut = page.frameLocator("iframe[data-live]").locator("#cut");
    await expect(cut).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("blocked-undo.png") });
    await both.click();
    await expect(page.locator('[data-clip="cut"]')).toBeVisible();
    await expect.poll(starts).toEqual(original);
    await expect(cut).toHaveText("Cut");
    await page.screenshot({ path: info.outputPath("both-edits-undone.png") });

    await page.keyboard.press("Control+Shift+z");
    await expect.poll(starts).toEqual([
      ["next", 30, 30],
      ["last", 90, 30],
    ]);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(starts).toEqual([
      ["next", 30, 30],
      ["last", 90, 15],
    ]);
  } finally {
    await client.close();
  }
});

test("a cached own undo paints before its POST and reconciles without a timeline GET", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Fast undo", width: 640, height: 360, duration: 10 },
      })
    ).json(),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await seekFrame(page, 60);
  const save = page.waitForResponse((response) =>
    response.url().endsWith(`${api}/commands`),
  );
  await page.keyboard.press("m");
  await save;
  const marker = page.getByRole("button", { name: "Marker Marker 1" });
  await expect(marker).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toHaveAttribute("aria-description", /marker/);
  const allowUndo = Promise.withResolvers<void>();
  const allowReads = Promise.withResolvers<void>();
  await page.route(`**${api}/timeline`, async (route) => {
    await allowReads.promise;
    await route.continue();
  });
  await page.route(`**${api}/history/undo`, async (route) => {
    await allowUndo.promise;
    await route.continue();
  });
  try {
    const undo = page.waitForResponse((response) =>
      response.url().endsWith(`${api}/history/undo`),
    );
    await page.keyboard.press("Control+z");
    await expect(marker).toHaveCount(0);
    allowUndo.resolve();
    expect((await undo).ok()).toBe(true);
    await expect(
      page.getByRole("button", { name: "Redo", exact: true }),
    ).toBeEnabled();
    await expect(marker).toHaveCount(0);
  } finally {
    allowUndo.resolve();
    allowReads.resolve();
  }
});

test("ripple undo restores the cut and preserves the agent's opacity in the rendered picture", async ({
  page,
  request,
  baseURL,
}, info) => {
  const { project, read, starts } = await rippleProject(request);
  const original = await starts();
  const client = new Client({ name: "Codex", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  try {
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
    await page.locator('[data-clip="cut"]').click();
    await page.keyboard.press("Shift+X");
    await expect.poll(starts).toEqual([
      ["next", 30, 30],
      ["last", 90, 30],
    ]);
    const agent = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: (await read()).revision,
        commands: [{ type: "setClip", clipId: "last", opacity: 0.4 }],
      },
    });
    expect(agent.isError, JSON.stringify(agent.content)).not.toBe(true);
    const last = page.frameLocator("iframe[data-live]").locator("#last");
    await expect(last).toHaveCSS("opacity", "0.4");
    await page.keyboard.press("Control+z");
    await expect(page.locator('[data-clip="cut"]')).toBeVisible();
    await expect.poll(starts).toEqual(original);
    await seekFrame(page, 125);
    await expect(last).toHaveCSS("opacity", "0.4");
    await expect(page.locator('[data-agent-change="last"]')).toBeVisible();
    await page.screenshot({
      path: info.outputPath("ripple-undone-agent-opacity-kept.png"),
    });
  } finally {
    await client.close();
  }
});

test("Skip leaves an outside edit in place and the next Undo targets the older owner edit", async ({
  page,
  request,
}) => {
  const { project, read } = await rippleProject(request);
  const api = `/api/cutroom/projects/${project.id}`;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  const edit = async (text: string, clipId: string) => {
    const response = await request.post(`${api}/commands`, {
      data: {
        expectedRevision: (await read()).revision,
        commands: [{ type: "setClip", clipId, text }],
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  await edit("Older owner edit", "next");
  await edit("Owner title", "last");
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toHaveAttribute("aria-description", /Owner title/);
  const file = join(project.path, "index.html");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(">Owner title<", ">Outside title<"),
  );
  const last = page.frameLocator("iframe[data-live]").locator("#last");
  await expect(last).toHaveText("Outside title");
  await page.keyboard.press("Control+z");
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.locator(".toast")).toContainText(
    /Kept .*Owner title.*Undo takes back .*Older owner edit/,
  );
  await expect(undo).toHaveAttribute("aria-description", /Older owner edit/);
  await page.reload();
  await expect(undo).toHaveAttribute("aria-description", /Older owner edit/);
  await page.keyboard.press("Control+z");
  await expect(
    page.frameLocator("iframe[data-live]").locator("#next"),
  ).toHaveText("Next");
  await expect(last).toHaveText("Outside title");
});

test("author undo processes eleven presses in order while the first response is held", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Undo burst", width: 640, height: 360, duration: 10 },
      })
    ).json(),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const header = "x-cutroom-history-entry";
  const steps: string[] = [];
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  for (let index = 0; index < 11; index++) {
    await seekFrame(page, index * 20 + 10);
    const saved = page.waitForResponse((response) =>
      response.url().endsWith(`${api}/commands`),
    );
    await page.keyboard.press("m");
    const id = (await saved).headers()[header];
    if (!id) throw new Error("The marker save did not return an entry ID.");
    steps.unshift(id);
  }
  const markers = page.getByRole("button", { name: /^Marker Marker / });
  await expect(markers).toHaveCount(11);
  const received: string[] = [];
  const firstSeen = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const body = z.object({ expectedEntryId: z.string() });
  await page.route(`**${api}/history/undo`, async (route) => {
    const { expectedEntryId } = body.parse(route.request().postDataJSON());
    received.push(expectedEntryId);
    firstSeen.resolve();
    await release.promise;
    await route.continue();
  });
  try {
    await page.keyboard.press("Control+z");
    await firstSeen.promise;
    for (let index = 1; index < 11; index++) {
      await page.waitForTimeout(100);
      await page.keyboard.press("Control+z");
    }
  } finally {
    release.resolve();
  }
  await expect(markers).toHaveCount(0);
  expect(received).toEqual(steps);
  await expect
    .poll(async () => {
      const response = await request.get(`${api}/timeline`);
      return TimelineViewSchema.parse(await response.json()).timeline.markers
        .length;
    })
    .toBe(0);
});

test("author undo refuses queued presses when another owner edit advances history", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Advanced undo", width: 640, height: 360, duration: 10 },
      })
    ).json(),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await seekFrame(page, 60);
  const saved = page.waitForResponse((response) =>
    response.url().endsWith(`${api}/commands`),
  );
  await page.keyboard.press("m");
  const entryId = (await saved).headers()["x-cutroom-history-entry"];
  expect(entryId).toBeTruthy();
  const firstSeen = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const replies: number[] = [];
  const targets: string[] = [];
  const body = z.object({ expectedEntryId: z.string() });
  await page.route(`**${api}/history/undo`, async (route) => {
    targets.push(body.parse(route.request().postDataJSON()).expectedEntryId);
    firstSeen.resolve();
    await release.promise;
    const response = await route.fetch();
    replies.push(response.status());
    await route.fulfill({ response });
  });
  try {
    await page.keyboard.press("Control+z");
    await firstSeen.promise;
    await page.keyboard.press("Control+z");
    const standing = TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
    const edit = await request.post(`${api}/commands`, {
      data: {
        expectedRevision: standing.revision,
        commands: [
          {
            type: "setClip",
            clipId: "headline",
            text: "An edit from the other tab",
          },
        ],
      },
    });
    expect(edit.ok()).toBe(true);
  } finally {
    release.resolve();
  }
  await expect.poll(() => replies).toEqual([409, 409]);
  expect(targets).toEqual([entryId, entryId]);
  await expect(page.locator(".toast")).toContainText(
    "The next history action changed.",
  );
  await expect(
    page.getByRole("button", { name: "Marker Marker 1" }),
  ).toBeVisible();
  await expect(
    page.frameLocator("iframe[data-live]").locator("#headline"),
  ).toHaveText("An edit from the other tab");
});

test("author undo targets a saved timeline edit before history refreshes", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Undo before refresh",
          width: 640,
          height: 360,
          duration: 10,
        },
      })
    ).json(),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await seekFrame(page, 60);
  const historyRead = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  await page.route(`**${api}/history`, async (route) => {
    historyRead.resolve();
    await resume.promise;
    await route.continue();
  });
  const undo = page.waitForResponse((response) =>
    response.url().endsWith(`${api}/history/undo`),
  );
  try {
    const saved = page.waitForResponse((response) =>
      response.url().endsWith(`${api}/commands`),
    );
    await page.keyboard.press("m");
    const entryId = (await saved).headers()["x-cutroom-history-entry"];
    await historyRead.promise;
    await page.keyboard.press("Control+z");
    resume.resolve();
    const response = await undo;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toMatchObject({
      expectedEntryId: entryId,
    });
    await expect(
      page.getByRole("button", { name: "Marker Marker 1" }),
    ).toHaveCount(0);
  } finally {
    resume.resolve();
  }
});

test("a press refused for an edit the page has not seen leaves the next press working", async ({
  page,
  request,
}) => {
  const { project, read } = await rippleProject(request);
  const api = `/api/cutroom/projects/${project.id}`;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  const before = await read();
  // Hold history reads so the page presses Undo before it has seen the edit.
  const held = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname === `${api}/history`,
    async (route) => {
      if (route.request().method() === "GET") await held.promise;
      await route.continue();
    },
  );
  const response = await request.post(`${api}/commands`, {
    data: {
      expectedRevision: before.revision,
      label: "Unseen title",
      commands: [{ type: "setClip", clipId: "last", text: "Unseen title" }],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.keyboard.press("Control+z");
  held.resolve();
  await expect(page.locator(".toast")).toContainText(
    "The next history action changed",
  );
  expect((await read()).timeline).not.toEqual(before.timeline);
  await expect(undo).toHaveAttribute("aria-description", "Unseen title");
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await read()).timeline)
    .toEqual(before.timeline);
});
