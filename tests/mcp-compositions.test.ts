import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { SourceSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { projectFixture } from "./project-fixture";

const scene = (id: string, body = "") => `<template>
  <div id="${id}-root" data-composition-id="${id}" data-width="1920" data-height="1080" data-duration="4">
    <div id="${id}-words" class="clip" data-start="0" data-duration="4" data-track-index="0">Scene</div>
    ${body}
  </div>
</template>
`;

test("an agent places a scene with a typed insert, reads it back, and undoes it", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Scenes" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "composition-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
    ),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { projectId: project.id, ...args } });
  const result = async (name: string, args: Record<string, unknown>) => {
    const answer = await call(name, args);
    expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
    return z
      .object({ structuredContent: z.object({ result: z.unknown() }) })
      .parse(answer).structuredContent.result;
  };
  const read = async (composition = "index.html") =>
    TimelineViewSchema.parse(await result("timeline_read", { composition }));
  const refusal = async (composition: string, src: string) => {
    const answer = await call("timeline_edit", {
      composition,
      expectedRevision: (await read(composition)).revision,
      commands: [
        {
          type: "insert",
          track: 3,
          at: 0,
          clip: { kind: "composition", src, duration: 30 },
        },
      ],
    });
    expect(answer.isError).toBe(true);
    return JSON.stringify(answer.content);
  };
  try {
    for (const [path, content] of [
      ["compositions/intro.html", scene("intro")],
      [
        "compositions/outer.html",
        scene(
          "outer",
          '<div id="inner" class="clip" data-composition-id="intro" data-composition-src="intro.html" data-start="0" data-duration="4" data-track-index="1"></div>',
        ),
      ],
    ])
      await result("source_write", { path, expectedVersion: null, content });

    const before = await read();
    const placed = z
      .object({
        changes: z.object({
          clips: z.object({ added: z.array(z.object({ id: z.string() })) }),
        }),
      })
      .parse(
        await result("timeline_edit", {
          expectedRevision: before.revision,
          commands: [
            {
              type: "insert",
              track: 3,
              at: 60,
              clip: {
                kind: "composition",
                id: "intro-scene",
                src: "compositions/intro.html",
                duration: 120,
                label: "Intro",
              },
            },
          ],
        }),
      );
    expect(placed.changes.clips.added.map((clip) => clip.id)).toEqual([
      "intro-scene",
    ]);
    expect(
      (await read()).timeline.clips.find((clip) => clip.id === "intro-scene"),
    ).toMatchObject({
      kind: "composition",
      src: "compositions/intro.html",
      track: 3,
      start: 60,
      duration: 120,
      mediaStart: 0,
      label: "Intro",
    });
    // The host is the documented recipe's markup, so HyperFrames plays it as written.
    const root = SourceSchema.parse(await result("source_read", {}));
    expect(root.content).toContain(
      '<div id="intro-scene" class="clip" data-composition-id="intro" data-composition-src="compositions/intro.html" data-start="2" data-duration="4" data-track-index="3" data-width="1920" data-height="1080" data-timeline-label="Intro"></div>',
    );

    // A scene placed in a scene is written from that scene's folder.
    const outer = await read("compositions/outer.html");
    await result("timeline_edit", {
      composition: "compositions/outer.html",
      expectedRevision: outer.revision,
      commands: [
        {
          type: "insert",
          track: 2,
          at: 0,
          clip: { kind: "composition", src: "intro.html", duration: 30 },
        },
      ],
    });
    expect(
      (await read("compositions/outer.html")).timeline.clips.filter(
        (clip) => clip.kind === "composition",
      ),
    ).toHaveLength(2);

    expect(await refusal("compositions/intro.html", "outer.html")).toContain(
      "would play itself",
    );
    expect(await refusal("index.html", "compositions/missing.html")).toContain(
      "is not a composition file",
    );

    await result("history_undo", {});
    await result("history_undo", {});
    expect(
      (await read()).timeline.clips.some((clip) => clip.id === "intro-scene"),
    ).toBe(false);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});
