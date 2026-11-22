import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { HttpError } from "../src/shared/errors";
import { ProjectDocumentSchema, TranscriptSchema } from "../src/shared/project";
import type { Project } from "../src/shared/project";
import { AGENT_HEADER } from "../src/shared/review";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { createCaptionRoutes } from "../src/server/captions/routes";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createProjectRoutes } from "../src/server/projects/routes";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { createTranscriptService } from "../src/server/transcript/service";
import { projectFixture } from "./project-fixture";

const source = `<!doctype html><html><head></head><body><main data-composition-id="main" data-width="1280" data-height="720" data-fps="25" data-duration="12"><video id="talk" class="clip" src="talk.mp4" data-start="0" data-duration="12" data-track-index="0"></video></main></body></html>`;
const words = [
  { id: "w1", text: "Make", start: 1, end: 1.4 },
  { id: "w2", text: "room", start: 1.5, end: 2 },
];
const PathSchema = z.object({ composition: z.string() });

let fixture: Awaited<ReturnType<typeof projectFixture>>;
let project: Project;
const at = (path: string) => join(project.path, path);
const text = (path: string) => readFile(at(path), "utf8");
const exists = (path: string) => Bun.file(at(path)).exists();
const send = (path: string, method = "GET", body?: unknown, agent = false) =>
  fixture.app.request(`/api/cutroom/projects/${project.id}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(agent && { [AGENT_HEADER]: "external" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const json = async (path: string, method = "GET", body?: unknown) => {
  const response = await send(path, method, body);
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return JSON.parse(text) as unknown;
};
const commands = async (path: string, list: unknown[], agent = false) => {
  const view = TimelineViewSchema.parse(
    await json(`/timeline?composition=${encodeURIComponent(path)}`),
  );
  const response = await send(
    "/commands",
    "POST",
    { composition: path, expectedRevision: view.revision, commands: list },
    agent,
  );
  expect(response.ok, await response.clone().text()).toBe(true);
};
const rename = (composition: string, name: string) =>
  send("/timelines/rename", "POST", { composition, name });
const create = async (body: { name?: string } = {}) =>
  PathSchema.parse(await json("/timelines", "POST", body)).composition;
const step = (direction: "undo" | "redo") =>
  json(`/history/${direction}`, "POST");
const stateFile = async (path: string) =>
  JSON.parse(await text(path).catch(() => "{}")) as unknown;

/**
 * Every record Cutroom keys by a timeline's path, outside the timeline file itself, which carries
 * its clips, grades and versions. A rename must leave none of them behind.
 */
async function keyedBy(path: string) {
  const document = ProjectDocumentSchema.parse(
    JSON.parse(await text("cutroom.json")),
  );
  const review = z
    .object({
      items: z.array(
        z.object({
          content: z.object({ compositionPath: z.string() }).optional(),
        }),
      ),
    })
    .parse(await stateFile(".cutroom/review.json"));
  const ledger = z
    .object({
      ledger: z.object({
        targets: z.array(z.object({ composition: z.string() })),
      }),
    })
    .parse(await stateFile(".cutroom/review-ledger.json"));
  const view = z
    .object({
      timelines: z.record(z.string(), z.unknown()),
      open: z.string().optional(),
    })
    .parse(await stateFile(".cutroom/view.json"));
  const records = {
    file: await exists(path),
    "cutroom.json timelines": Object.hasOwn(document.timelines, path),
    "cutroom.json transcripts": document.transcripts.some(
      (transcript) => transcript.sourceFile === path,
    ),
    "cutroom.json notes": document.annotations.some(
      (note) => note.compositionPath === path,
    ),
    "review.json sent notes": review.items.some(
      (item) => item.content?.compositionPath === path,
    ),
    "review ledger agent edits": ledger.ledger.targets.some(
      (target) => target.composition === path,
    ),
    "view.json timelines": Object.hasOwn(view.timelines, path),
    "view.json open": view.open === path,
    "scene mounts": (await text("Reel.html")).includes(
      `data-composition-src="${path}"`,
    ),
  };
  return Object.entries(records).flatMap(([name, has]) => (has ? [name] : []));
}
const allRecords = [
  "file",
  "cutroom.json timelines",
  "cutroom.json transcripts",
  "cutroom.json notes",
  "review.json sent notes",
  "review ledger agent edits",
  "view.json timelines",
  "view.json open",
  "scene mounts",
];

beforeEach(async () => {
  fixture = await projectFixture();
  const timeline = createTimelineRoutes(fixture.store, fixture.review);
  fixture.app.route("/api/cutroom", timeline);
  fixture.app.route(
    "/api/cutroom",
    createCaptionRoutes(
      fixture.store,
      fixture.review,
      createTranscriptService(fixture.store),
      timeline.editInWindow,
    ),
  );
  project = await fixture.store.create({ name: "Interview" });
  await writeFile(at("index.html"), source);
  await writeFile(at("talk.mp4"), "not decoded in this test");
});
afterEach(() => fixture.close());

/** A second timeline with something in every store keyed by its path. */
async function timelineWithRecords() {
  const transcript = TranscriptSchema.parse(
    await json("/transcripts/import", "POST", {
      mediaPath: "talk.mp4",
      elementId: "talk",
      words,
    }),
  );
  await json("/captions", "POST", {
    action: "generate",
    transcriptId: transcript.id,
  });
  await commands("index.html", [
    { type: "setMarker", frame: 25, name: "Beat" },
  ]);
  const cut = PathSchema.parse(
    await json("/timelines/duplicate", "POST", { name: "Cut" }),
  ).composition;
  await json(`/timeline-view?composition=${encodeURIComponent(cut)}`, "PUT", {
    heights: { "0": 120 },
    destinations: { video: 1 },
  });
  await json("/timeline-open", "PUT", { composition: cut });
  const note = await fixture.review.add(
    project,
    { body: "Tighten the open", time: 1, compositionPath: cut },
    undefined,
  );
  await commands(
    cut,
    [{ type: "setClip", clipId: "talk", label: "Agent" }],
    true,
  );
  // Another timeline plays this one as a scene.
  await json("/source", "PUT", {
    path: "Reel.html",
    expectedVersion: null,
    content: `<!doctype html><html><body><main data-composition-id="reel" data-width="1280" data-height="720" data-duration="12"><div id="scene" class="clip" data-composition-src="${cut}" data-start="0" data-duration="12" data-track-index="0"></div></main></body></html>`,
  });
  return { cut, note };
}

test("a rename carries every record keyed by the timeline's path, and undo and redo carry them back and forth", async () => {
  const { cut, note } = await timelineWithRecords();
  const html = await text(cut);
  expect(await keyedBy(cut)).toEqual(allRecords);

  const response = await rename(cut, "Final");
  expect(response.status, await response.clone().text()).toBe(200);
  expect(PathSchema.parse(await response.json()).composition).toBe(
    "Final.html",
  );
  expect(await keyedBy(cut)).toEqual([]);
  expect(await keyedBy("Final.html")).toEqual(allRecords);
  // The file itself, with its clips, grades and versions, is unchanged.
  expect(await text("Final.html")).toBe(html);
  const queued = async () =>
    (await fixture.review.list(project)).find(({ id }) => id === note.id)
      ?.review.status;
  // A sent note whose timeline moved is still the same request.
  expect(await queued()).toBe("queued");
  expect(
    TimelineViewSchema.parse(await json("/timeline?composition=Final.html"))
      .agentChanges,
  ).toEqual(["talk"]);

  await step("undo");
  expect(await keyedBy("Final.html")).toEqual([]);
  expect(await keyedBy(cut)).toEqual(allRecords);
  expect(await queued()).toBe("queued");

  await step("redo");
  expect(await keyedBy(cut)).toEqual([]);
  expect(await keyedBy("Final.html")).toEqual(allRecords);
  expect(await queued()).toBe("queued");
});

test("a rename never takes a name in use, and index.html keeps its name", async () => {
  const cut = PathSchema.parse(
    await json("/timelines/duplicate", "POST", { name: "Cut" }),
  ).composition;
  await create({ name: "Alt" });
  const refused = await rename(cut, "Alt");
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain("Alt.html already exists");
  expect((await rename(cut, "index")).status).toBe(409);
  expect(await text("Alt.html")).toContain('data-composition-id="main"');
  expect(await exists(cut)).toBe(true);

  const main = await rename("index.html", "Main");
  expect(main.status).toBe(400);
  expect(await main.text()).toContain("Rename the project instead");
  expect((await rename("compositions/intro.html", "Intro")).status).toBe(400);
  expect((await rename(cut, "a‮b")).status).toBe(400);
  expect((await rename(cut, "x".repeat(201))).status).toBe(400);
  // Another file whose name differs only in case is still another file.
  await json("/source", "PUT", {
    path: "CUT.html",
    expectedVersion: null,
    content: source,
  });
  expect((await rename(cut, "CUT")).status).toBe(409);
  expect(await text(cut)).toContain('id="talk"');
  await step("undo");
  // A change of case renames the file in place.
  const cased = await rename(cut, "CUT");
  expect(cased.status).toBe(200);
  expect(await exists("CUT.html")).toBe(true);
});

test("a timeline that is exporting refuses a rename until the export ends", async () => {
  const cut = PathSchema.parse(
    await json("/timelines/duplicate", "POST", { name: "Cut" }),
  ).composition;
  let exporting: string | undefined = cut;
  const app = new Hono().route(
    "/api/cutroom",
    createProjectRoutes(
      fixture.store,
      fixture.review,
      undefined,
      undefined,
      undefined,
      undefined,
      () => exporting,
    ),
  );
  app.onError((error, c) =>
    c.json(
      { error: error.message },
      error instanceof HttpError ? error.status : 500,
    ),
  );
  const renameHere = () =>
    app.request(`/api/cutroom/projects/${project.id}/timelines/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ composition: cut, name: "Final" }),
    });
  const refused = await renameHere();
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain("Cut is exporting");
  expect(await exists(cut)).toBe(true);
  exporting = "index.html";
  expect((await renameHere()).status).toBe(200);
  expect(await exists("Final.html")).toBe(true);
});

test("a new timeline is empty at the main timeline's format, numbered after the ones there, and one undo step", async () => {
  expect(await create()).toBe("Timeline 2.html");
  await writeFile(at("Timeline 4.html"), source);
  expect(await create()).toBe("Timeline 3.html");
  expect(await create()).toBe("Timeline 5.html");
  expect(await create({ name: "Alt" })).toBe("Alt.html");
  expect(await create({ name: "Alt" })).toBe("Alt 2.html");

  const view = TimelineViewSchema.parse(
    await json("/timeline?composition=Timeline%202.html"),
  );
  expect(view.timeline.clips).toEqual([]);
  expect(view.timeline.fps).toEqual({ num: 25, den: 1 });
  expect(view.size).toEqual({ width: 1280, height: 720 });
  // Edits to other timelines after it do not hold up its undo.
  await commands("index.html", [
    { type: "setMarker", frame: 25, name: "Beat" },
  ]);
  const entries = z
    .object({
      entries: z.array(z.object({ id: z.string(), label: z.string() })),
    })
    .parse(await json("/history")).entries;
  const made = entries.find(({ label }) => label === "Create Alt 2")!;
  const undone = await send("/history/undo", "POST", { entryId: made.id });
  expect(undone.status, await undone.clone().text()).toBe(200);
  expect(await exists("Alt 2.html")).toBe(false);
  expect(await exists("Alt.html")).toBe(true);
  await step("undo");
  expect(
    ProjectDocumentSchema.parse(JSON.parse(await text("cutroom.json")))
      .timelines["index.html"]?.markers ?? [],
  ).toEqual([]);
});

test("agents create and rename timelines through MCP", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "timeline-rename-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const call = async (name: string, args: Record<string, unknown>) =>
      PathSchema.parse(
        z
          .object({ structuredContent: z.object({ result: z.unknown() }) })
          .parse(
            await client.callTool({
              name,
              arguments: { projectId: project.id, ...args },
            }),
          ).structuredContent.result,
      ).composition;
    const created = await call("timeline_create", {});
    expect(created).toBe("Timeline 2.html");
    expect(
      await call("timeline_rename", { composition: created, name: "B-roll" }),
    ).toBe("B-roll.html");
    expect(await exists("B-roll.html")).toBe(true);
    expect(await exists(created)).toBe(false);
  } finally {
    await client.close();
    await server.stop(true);
  }
});
