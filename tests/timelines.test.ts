import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { CaptionsViewSchema } from "../src/shared/captions";
import { ProjectDocumentSchema, TranscriptSchema } from "../src/shared/project";
import type { Project } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { createCaptionRoutes } from "../src/server/captions/routes";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { createTranscriptService } from "../src/server/transcript/service";
import { projectFixture } from "./project-fixture";

const source = `<!doctype html><html><head></head><body><main data-composition-id="main" data-width="1920" data-height="1080" data-duration="12"><video id="talk" class="clip" src="talk.mp4" data-start="0" data-duration="12" data-track-index="0"></video></main></body></html>`;
const words = [
  { id: "w1", text: "Make", start: 1, end: 1.4 },
  { id: "w2", text: "room", start: 1.5, end: 2 },
  { id: "w3", text: "now.", start: 2.1, end: 2.6 },
  { id: "w4", text: "Cut", start: 4, end: 4.5 },
  { id: "w5", text: "this", start: 4.6, end: 5 },
  { id: "w6", text: "Keep", start: 7, end: 7.4 },
  { id: "w7", text: "going", start: 7.5, end: 8 },
];
const DuplicateSchema = z.object({
  composition: z.string(),
  historyId: z.string(),
});

let fixture: Awaited<ReturnType<typeof projectFixture>>;
let project: Project;
const at = (path: string) => join(project.path, path);
const text = (path: string) => readFile(at(path), "utf8");
const exists = (path: string) => Bun.file(at(path)).exists();
const json = async (path: string, method = "GET", body?: unknown) => {
  const response = await fixture.request(
    `/projects/${project.id}${path}`,
    method,
    body,
  );
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return JSON.parse(text) as unknown;
};
const document = async () =>
  ProjectDocumentSchema.parse(JSON.parse(await text("cutroom.json")));
const duplicate = async (body: { composition?: string; name?: string }) =>
  DuplicateSchema.parse(await json("/timelines/duplicate", "POST", body));

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

test("a duplicate is one undo step that copies the timeline's settings, and gives its script and captions new ids", async () => {
  const transcript = TranscriptSchema.parse(
    await json("/transcripts/import", "POST", {
      mediaPath: "talk.mp4",
      elementId: "talk",
      words,
    }),
  );
  const captions = CaptionsViewSchema.parse(
    await json("/captions", "POST", {
      action: "generate",
      transcriptId: transcript.id,
    }),
  );
  await json(`/transcripts/${transcript.id}/cuts`, "POST", {
    wordIds: ["w4", "w5"],
    action: "cut",
  });
  const view = TimelineViewSchema.parse(await json("/timeline"));
  await json("/commands", "POST", {
    composition: "index.html",
    expectedRevision: view.revision,
    commands: [
      { type: "setTrack", index: 0, name: "Talk", locked: true },
      { type: "setMarker", id: "beat", frame: 30, name: "Beat" },
    ],
  });
  await json("/timeline-view?composition=index.html", "PUT", {
    heights: { "0": 120 },
    destinations: { video: 1 },
  });
  const original = await text("index.html");
  const before = await document();

  const copy = await duplicate({ composition: "index.html" });
  expect(copy.composition).toBe("Interview copy.html");

  const after = await document();
  expect(after.timelines[copy.composition]).toEqual(
    before.timelines["index.html"]!,
  );
  const copied = after.transcripts.find(
    (item) => item.sourceFile === copy.composition,
  )!;
  expect(copied.id).not.toBe(transcript.id);
  expect(copied).toMatchObject({
    elementId: transcript.elementId,
    words: transcript.words,
    cutWordIds: ["w4", "w5"],
  });
  // The copy's captions are their own file, following the copy's transcript.
  const copyCaptions = CaptionsViewSchema.parse(
    ((await json("/captions")) as { captions: unknown[] }).captions.find(
      (item) => CaptionsViewSchema.parse(item).transcriptId === copied.id,
    ),
  );
  expect(copyCaptions.file).toBe("compositions/captions-2.html");
  expect(copyCaptions.stale).toBe(false);
  // Byte for byte, apart from the ids that must stay unique.
  expect(
    (await text(copy.composition))
      .replaceAll(copied.id, transcript.id)
      .replace("compositions/captions-2.html", captions.file),
  ).toBe(original);
  expect(await json(`/timeline-view?composition=${copy.composition}`)).toEqual(
    await json("/timeline-view?composition=index.html"),
  );

  // The copy's script and captions edit the copy alone.
  const duplicated = await text(copy.composition);
  const originalCaptions = await text(captions.file);
  await json(`/transcripts/${copied.id}/cuts`, "POST", {
    wordIds: ["w4", "w5"],
    action: "restore",
  });
  expect(await text(copy.composition)).not.toBe(duplicated);
  expect(await text("index.html")).toBe(original);
  expect(await text(captions.file)).toBe(originalCaptions);
  await json("/history/undo", "POST");

  const undo = await json("/history/undo", "POST");
  expect(undo).toMatchObject({
    entry: { label: "Undid: Duplicate Interview" },
  });
  expect(await exists(copy.composition)).toBe(false);
  expect(await exists("compositions/captions-2.html")).toBe(false);
  expect(await document()).toEqual(before);
  expect(await text("index.html")).toBe(original);

  await json("/history/redo", "POST");
  expect(await text(copy.composition)).toBe(duplicated);
  expect(await exists("compositions/captions-2.html")).toBe(true);
  expect(await document()).toEqual(after);
});

test("a taken name gets the next number, and only a root-level timeline can be duplicated", async () => {
  expect(await duplicate({ name: "Cut" })).toMatchObject({
    composition: "Cut.html",
  });
  expect(await duplicate({ name: "Cut" })).toMatchObject({
    composition: "Cut 2.html",
  });
  expect(await duplicate({ composition: "Cut.html" })).toMatchObject({
    composition: "Cut copy.html",
  });
  expect(await duplicate({ name: "../Cut" })).toMatchObject({
    composition: "-Cut.html",
  });
  for (const file of ["Cut.html", "Cut 2.html", "Cut copy.html"])
    expect(await text(file)).toBe(source);
  expect(await json("/timelines")).toEqual({
    timelines: [
      "index.html",
      "-Cut.html",
      "Cut 2.html",
      "Cut copy.html",
      "Cut.html",
    ],
  });
  const scene = await fixture.request(
    `/projects/${project.id}/timelines/duplicate`,
    "POST",
    { composition: "compositions/intro.html" },
  );
  expect(scene.status).toBe(400);
});

test("the project reopens on the last timeline, and on index.html once that file is gone", async () => {
  const { composition } = await duplicate({ name: "Cut" });
  expect(await json("/timeline-open")).toEqual({ composition: "index.html" });
  await json("/timeline-open", "PUT", { composition });
  // A fresh server reads what the last one saved in the project.
  await fixture.store.close();
  const reopened = await projectFixture();
  try {
    const moved = await reopened.store.importProject({ path: project.path });
    reopened.app.route(
      "/api/cutroom",
      createTimelineRoutes(reopened.store, reopened.review),
    );
    const open = async () =>
      (await reopened.request(`/projects/${moved.id}/timeline-open`)).json();
    expect(await open()).toEqual({ composition: "Cut.html" });
    await rm(at("Cut.html"));
    expect(await open()).toEqual({ composition: "index.html" });
  } finally {
    await reopened.close();
  }
});

test("agents duplicate a timeline and edit the copy through MCP", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "timeline-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const result = (value: unknown) =>
      z
        .object({ structuredContent: z.object({ result: z.unknown() }) })
        .parse(value).structuredContent.result;
    const { composition } = DuplicateSchema.pick({ composition: true }).parse(
      result(
        await client.callTool({
          name: "timeline_duplicate",
          arguments: { projectId: project.id, name: "Agent cut" },
        }),
      ),
    );
    expect(composition).toBe("Agent cut.html");
    const read = TimelineViewSchema.parse(
      result(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: project.id, composition },
        }),
      ),
    );
    await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        composition,
        expectedRevision: read.revision,
        commands: [{ type: "remove", clipIds: ["talk"] }],
      },
    });
    expect(await text(composition)).not.toContain('id="talk"');
    expect(await text("index.html")).toBe(source);
    expect(
      result(
        await client.callTool({
          name: "project_read",
          arguments: { projectId: project.id },
        }),
      ),
    ).toMatchObject({ timelines: ["index.html", "Agent cut.html"] });
  } finally {
    await client.close();
    await server.stop(true);
  }
});

test("a duplicate lints as a timeline of its own, not as a second entry or a scene", async () => {
  fixture.app.route(
    "/api",
    createHyperframesApi(fixture.store, fixture.review),
  );
  const starter = await fixture.store.create({ name: "Starter" });
  const lint = async () =>
    z
      .object({
        findings: z.array(z.object({ code: z.string(), file: z.string() })),
      })
      .parse(
        await (
          await fixture.app.request(`/api/projects/${starter.id}/lint`)
        ).json(),
      )
      .findings.map(({ code, file }) => `${file}: ${code}`)
      .sort();
  const before = await lint();
  const copy = await fixture.request(
    `/projects/${starter.id}/timelines/duplicate`,
    "POST",
    {},
  );
  expect(copy.status).toBe(201);
  expect(await lint()).toEqual(
    [
      ...before,
      ...before.map((line) => line.replace("index.html", "Starter copy.html")),
    ].sort(),
  );
});

test("Home dates the project by its latest timeline, not only index.html", async () => {
  const { composition } = await duplicate({ name: "Cut" });
  const old = new Date("2020-01-01");
  for (const file of ["index.html", "cutroom.json", composition])
    await utimes(at(file), old, old);
  const edited = new Date("2025-06-01");
  await utimes(at(composition), edited, edited);
  expect((await fixture.store.list())[0]?.updatedAt).toBe(edited.toISOString());
});

test("a timeline's Changes leave out edits made in another timeline", async () => {
  const { composition } = await duplicate({ name: "Cut" });
  const view = TimelineViewSchema.parse(await json("/timeline"));
  await json("/commands", "POST", {
    composition: "index.html",
    expectedRevision: view.revision,
    commands: [{ type: "remove", clipIds: ["talk"] }],
  });
  const edited = async (path: string) =>
    (await fixture.review.clipChanges(project, path)).clipEdits.map(
      (edit) => edit.composition,
    );
  expect(await edited("index.html")).toContain("index.html");
  expect(await edited(composition)).toEqual([]);
});
