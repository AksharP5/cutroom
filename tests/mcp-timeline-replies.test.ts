import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { projectFixture } from "./project-fixture";

async function connect() {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Replies" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "reply-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
    ),
  );
  const result = async (name: string, args: Record<string, unknown>) => {
    const answer = await client.callTool({
      name,
      arguments: { projectId: project.id, ...args },
    });
    expect(answer.isError).not.toBe(true);
    return z
      .object({ structuredContent: z.object({ result: z.unknown() }) })
      .parse(answer).structuredContent.result;
  };
  const read = async (args: Record<string, unknown> = {}) =>
    TimelineViewSchema.parse(await result("timeline_read", args));
  return {
    project,
    result,
    read,
    async close() {
      await client.close();
      server.stop(true);
      await fixture.close();
    },
  };
}

test("timeline_edit creates a named audio group and reports its routed clips", async () => {
  const mcp = await connect();
  try {
    const path = join(mcp.project.path, "index.html");
    const source = `<main data-composition-id="main" data-duration="4"><audio id="lead" src="voice.wav" data-start="0" data-duration="2" data-track-index="1"></audio><audio id="pickup" src="voice.wav" data-start="2" data-duration="2" data-track-index="2"></audio></main>`;
    await writeFile(path, source);
    const before = await mcp.read();
    const reply = await mcp.result("timeline_edit", {
      expectedRevision: before.revision,
      commands: [
        {
          type: "routeAudioGroup",
          clipIds: ["lead", "pickup"],
          group: { label: "Voices", volume: 0.25 },
        },
      ],
    });
    const id = z
      .object({
        changes: z.object({
          authoredAudioGroups: z.object({
            added: z.tuple([
              z.object({ id: z.string().regex(/^cutroom-bus-/) }),
            ]),
          }),
        }),
      })
      .parse(reply).changes.authoredAudioGroups.added[0].id;
    expect(reply).toMatchObject({
      changes: {
        authoredAudioGroups: {
          added: [{ id, label: "Voices", volume: 0.25 }],
        },
        clips: {
          changed: [
            { id: "lead", authoredAudioGroupId: id },
            { id: "pickup", authoredAudioGroupId: id },
          ],
        },
      },
    });
    expect(
      (await mcp.read()).timeline.clips.map(
        ({ authoredAudioGroupId }) => authoredAudioGroupId,
      ),
    ).toEqual([id, id]);
    await mcp.result("history_undo", {});
    expect(await readFile(path, "utf8")).toBe(source);
  } finally {
    await mcp.close();
  }
});

test("timeline_edit answers with the next revision and only what changed", async () => {
  const mcp = await connect();
  try {
    const before = await mcp.read();
    const marker = await mcp.result("timeline_edit", {
      expectedRevision: before.revision,
      commands: [{ type: "setMarker", id: "beat", frame: 30, name: "Beat" }],
    });
    // The whole timeline and the edit ledger stay out unless asked for.
    expect(marker).toEqual({
      revision: (await mcp.read()).revision,
      composition: "index.html",
      changes: {
        markers: {
          added: [
            {
              id: "beat",
              frame: 30,
              duration: 0,
              name: "Beat",
              note: "",
              color: "blue",
            },
          ],
        },
      },
    });

    const caption = before.timeline.clips.find((clip) => clip.id === "caption");
    if (!caption) throw new Error("The new project has no caption clip.");
    const razor = z
      .object({
        revision: z.string(),
        changes: z.object({
          clips: z.object({
            added: z.array(z.object({ id: z.string(), start: z.number() })),
            changed: z.array(z.record(z.string(), z.unknown())),
          }),
        }),
      })
      .parse(
        await mcp.result("timeline_edit", {
          expectedRevision: (marker as { revision: string }).revision,
          commands: [
            {
              type: "split",
              at: caption.start + 60,
              clipIds: ["caption"],
              ids: { caption: ["caption-tail"] },
            },
          ],
        }),
      );
    // The new piece arrives whole, so its id is known without another read.
    expect(razor.changes.clips.added).toEqual([
      expect.objectContaining({
        id: "caption-tail",
        start: caption.start + 60,
      }),
    ]);
    // A changed clip names only the fields that changed.
    expect(razor.changes.clips.changed).toEqual([
      { id: "caption", duration: 60 },
    ]);

    const full = TimelineViewSchema.parse(
      await mcp.result("timeline_edit", {
        expectedRevision: razor.revision,
        fullTimeline: true,
        commands: [{ type: "removeMarker", id: "beat" }],
      }),
    );
    expect(full).toEqual(await mcp.read());
  } finally {
    await mcp.close();
  }
});

test("timeline_read narrows to a frame range and tracks, and holds the edit ledger back unless asked", async () => {
  const mcp = await connect();
  try {
    const all = await mcp.read();
    await mcp.result("timeline_edit", {
      expectedRevision: all.revision,
      commands: [
        { type: "setMarker", frame: 10 },
        { type: "setMarker", frame: 200 },
        { type: "setClip", clipId: "caption", opacity: 0.5 },
      ],
    });
    const whole = await mcp.read();
    expect(whole.clipEdits).toBeUndefined();
    expect(
      (await mcp.read({ clipEdits: true })).clipEdits?.map(
        (edit) => edit.clipId,
      ),
    ).toEqual(["caption"]);

    const tracks = [...new Set(whole.timeline.clips.map((clip) => clip.track))];
    expect(tracks.length).toBeGreaterThan(1);
    const [track] = tracks;
    const narrowed = await mcp.read({ from: 0, to: 100, tracks: [track] });
    expect(narrowed.revision).toBe(whole.revision);
    expect(narrowed.timeline.tracks).toEqual(whole.timeline.tracks);
    expect(narrowed.timeline.clips).toEqual(
      whole.timeline.clips.filter(
        (clip) => clip.track === track && clip.start < 100,
      ),
    );
    expect(narrowed.timeline.markers.map((marker) => marker.frame)).toEqual([
      10,
    ]);
  } finally {
    await mcp.close();
  }
});

test("setClip scale, rotation and crop answer as changed fields and read back as the clip's transform", async () => {
  const mcp = await connect();
  try {
    const before = await mcp.read();
    const edit = z
      .object({
        changes: z.object({
          clips: z.object({
            changed: z.array(z.record(z.string(), z.unknown())),
          }),
        }),
      })
      .parse(
        await mcp.result("timeline_edit", {
          expectedRevision: before.revision,
          commands: [
            {
              type: "setClip",
              clipId: "caption",
              scale: 1.1,
              rotation: 90,
              crop: { left: 40 },
            },
          ],
        }),
      );
    const transform = {
      scaleX: 1.1,
      scaleY: 1.1,
      rotation: 90,
      crop: { top: 0, right: 0, bottom: 0, left: 40 },
    };
    expect(edit.changes.clips.changed).toEqual([
      { id: "caption", ...transform },
    ]);
    const caption = (await mcp.read()).timeline.clips.find(
      (clip) => clip.id === "caption",
    );
    expect(caption).toMatchObject(transform);
  } finally {
    await mcp.close();
  }
});
