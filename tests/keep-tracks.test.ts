import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { applyAll } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
  TimelineViewSchema,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  parseComposition,
  patchComposition,
  settingsOf,
} from "../src/server/timeline/composition";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { projectFixture } from "./project-fixture";

const source = `<main data-composition-id="main" data-duration="12" data-fps="30">
<div id="picture" data-start="0" data-duration="12" data-track-index="0">Picture</div>
<div id="title" data-start="0" data-duration="12" data-track-index="1">Title</div></main>`;

test("lift retains track settings through HTML readback until explicit removal", () => {
  const parsed = parseComposition(source, emptyTimelineSettings());
  const commands = (input: CommandInput[]) =>
    input.map((command) => CommandSchema.parse(command));
  const before = applyAll(
    parsed.timeline,
    commands([
      {
        type: "setTrack",
        index: 0,
        name: "Picture",
        muted: true,
        autoSelect: false,
        enabled: false,
      },
    ]),
  );
  const lifted = applyAll(
    before,
    commands([{ type: "remove", clipIds: ["picture"] }]),
  );
  expect(lifted.tracks).toEqual(before.tracks);
  const html = patchComposition(parsed, lifted, new Map());
  const reloaded = parseComposition(html, settingsOf(lifted)).timeline;
  expect(reloaded.tracks).toEqual(before.tracks);
  const removed = applyAll(
    reloaded,
    commands([{ type: "removeTrack", index: 0 }]),
  );
  expect(removed.tracks).toEqual(
    before.tracks.filter((track) => track.index !== 0),
  );
  expect(removed.clips).toEqual(lifted.clips);
  expect(parseComposition(html, settingsOf(removed)).timeline).toEqual(removed);
});

test("explicit track removal refuses occupied, locked and missing tracks atomically", () => {
  const before = parseComposition(source, emptyTimelineSettings()).timeline;
  const remove = CommandSchema.parse({ type: "removeTrack", index: 0 });
  expect(() => applyAll(before, [remove])).toThrow("not empty");
  expect(() =>
    applyAll(before, [
      CommandSchema.parse({ type: "remove", clipIds: ["picture"] }),
      CommandSchema.parse({ type: "setTrack", index: 0, locked: true }),
      remove,
    ]),
  ).toThrow("locked");
  expect(() =>
    applyAll(before, [CommandSchema.parse({ type: "removeTrack", index: 8 })]),
  ).toThrow("not found");
  expect(before.clips).toHaveLength(2);
});

test("first lifts persist inferred tracks on disk, with history and MCP targeting of empty rows", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Persistent tracks" });
  const base = `/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.request(`${base}/timeline`)).json(),
    );
  const edit = async (commands: CommandInput[]) => {
    const response = await fixture.request(`${base}/commands`, "POST", {
      expectedRevision: (await read()).revision,
      commands,
    });
    expect(response.status).toBe(200);
    return TimelineViewSchema.parse(await response.json());
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 4918,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "empty-tracks-test", version: "1.0.0" });
  try {
    const before = await read();
    const lifted = await edit([
      { type: "remove", clipIds: ["rule", "headline"] },
    ]);
    expect(lifted.timeline.tracks).toEqual(before.timeline.tracks);
    expect((await read()).timeline).toEqual(lifted.timeline);
    const document = await fixture.store.document(project);
    expect(document.timelines["index.html"]?.tracks).toEqual(
      before.timeline.tracks,
    );
    const html = await readFile(join(project.path, "index.html"), "utf8");
    expect(
      parseComposition(html, document.timelines["index.html"]!).timeline.tracks,
    ).toEqual(before.timeline.tracks);
    await fixture.request(`${base}/history/undo`, "POST");
    expect((await read()).timeline).toEqual(before.timeline);
    await fixture.request(`${base}/history/redo`, "POST");
    expect((await read()).timeline).toEqual(lifted.timeline);

    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const result = z.object({
      structuredContent: z.object({ result: TimelineViewSchema }),
    });
    const agentRead = result.parse(
      await client.callTool({
        name: "timeline_read",
        arguments: { projectId: project.id },
      }),
    ).structuredContent.result;
    expect(agentRead.timeline.tracks).toEqual(before.timeline.tracks);
    // Target a row with no remaining clip, using its stable index.
    const placed = result.parse(
      await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: agentRead.revision,
          commands: [
            {
              type: "insert",
              track: 0,
              at: 0,
              clip: { kind: "image", src: "still.png", duration: 30 },
            },
          ],
        },
      }),
    ).structuredContent.result;
    expect(placed.timeline.clips.some((clip) => clip.track === 0)).toBe(true);
    const removed = result.parse(
      await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: placed.revision,
          commands: [{ type: "removeTrack", index: 1 }],
        },
      }),
    ).structuredContent.result;
    expect(removed.timeline.tracks.map((track) => track.index)).toEqual([0, 2]);
    expect((await read()).timeline).toEqual(removed.timeline);
    await fixture.request(`${base}/history/undo`, "POST");
    expect((await read()).timeline).toEqual(placed.timeline);
    await fixture.request(`${base}/history/redo`, "POST");
    expect((await read()).timeline).toEqual(removed.timeline);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});
