import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";

const timelineFixture = async () => {
  const fixture = await projectFixture();
  fixture.app.route("/api/cutroom", createTimelineRoutes(fixture.store));
  const project = await fixture.store.create({ name: "Timeline" });
  const files = () =>
    Promise.all(
      ["index.html", "cutroom.json"].map((file) =>
        readFile(join(project.path, file), "utf8"),
      ),
    );
  return { ...fixture, project, files };
};

test("a command batch is atomic, one undo step, and refuses stale revisions", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  try {
    const original = await fixture.files();
    const history = async () =>
      z
        .object({ entries: z.array(z.object({ label: z.string() })) })
        .parse(
          await (
            await fixture.request(`/projects/${project.id}/history`)
          ).json(),
        ).entries;
    const read = TimelineViewSchema.parse(
      await (await fixture.request(`/projects/${project.id}/timeline`)).json(),
    );
    expect(read.timeline.clips.map((clip) => clip.id)).toEqual([
      "rule",
      "headline",
      "caption",
    ]);
    const post = (body: unknown) =>
      fixture.request(`/projects/${project.id}/commands`, "POST", body);

    const failed = await post({
      expectedRevision: read.revision,
      commands: [
        { type: "split", at: 180 },
        { type: "remove", clipIds: ["missing"] },
      ],
    });
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({
      code: "not_found",
      command: 1,
    });
    expect(await fixture.files()).toEqual(original);
    expect(await history()).toHaveLength(0);

    const edited = await post({
      expectedRevision: read.revision,
      label: "Tighten intro",
      commands: [
        { type: "split", at: 180 },
        {
          type: "remove",
          clipIds: ["rule-2", "headline-2", "caption-2"],
          ripple: true,
        },
        { type: "setTrack", index: 2, locked: true },
        { type: "setMarker", frame: 90, name: "Beat" },
      ],
    });
    expect(edited.status).toBe(200);
    const view = TimelineViewSchema.parse(await edited.json());
    expect(view.timeline.duration).toBe(180);
    expect(view.timeline.clips.map((clip) => clip.duration)).toEqual([
      180, 180, 180,
    ]);
    expect(view.timeline.markers.map((marker) => marker.name)).toEqual([
      "Beat",
    ]);
    expect(
      TimelineViewSchema.parse(
        await (
          await fixture.request(`/projects/${project.id}/timeline`)
        ).json(),
      ),
    ).toEqual(view);
    expect((await history()).map((entry) => entry.label)).toEqual([
      "Tighten intro",
    ]);

    const stale = await post({
      expectedRevision: read.revision,
      commands: [{ type: "setRange", in: 0 }],
    });
    expect(stale.status).toBe(409);

    const undo = await fixture.request(
      `/projects/${project.id}/history/undo`,
      "POST",
    );
    expect(undo.status).toBe(200);
    expect(await fixture.files()).toEqual(original);
  } finally {
    await fixture.close();
  }
});

test("an MCP agent reads and edits the timeline through the batch endpoint", async () => {
  const fixture = await timelineFixture();
  const seeks: string[] = [];
  const handler = createMcpHttpHandler({
    fetch: (url, init) => {
      // Frame capture needs Chromium; the seek it is asked for is what matters here.
      if (!url.includes("/thumbnail/")) return fixture.app.request(url, init);
      seeks.push(new URL(url).searchParams.get("t") ?? "");
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({
    name: "cutroom-timeline-test",
    version: "1.0.0",
  });
  const result = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    // The server measures inserted media, so agents are never asked for its length.
    const edit = (await client.listTools()).tools.find(
      (tool) => tool.name === "timeline_edit",
    );
    expect(JSON.stringify(edit?.inputSchema)).toContain("insert");
    expect(JSON.stringify(edit?.inputSchema)).not.toContain("sourceDuration");
    const read = result.parse(
      await client.callTool({
        name: "timeline_read",
        arguments: { projectId: fixture.project.id },
      }),
    ).structuredContent.result;
    const editCall = {
      name: "timeline_edit",
      arguments: {
        projectId: fixture.project.id,
        expectedRevision: read.revision,
        label: "Delay caption",
        commands: [{ type: "trim", clipId: "caption", edge: "start", to: 60 }],
      },
    };
    const edited = result.parse(await client.callTool(editCall))
      .structuredContent.result;
    expect(
      edited.timeline.clips.find((clip) => clip.id === "caption"),
    ).toMatchObject({ start: 60, duration: 300 });
    const [html] = await fixture.files();
    expect(html).toContain(
      `id="caption" class="clip caption" data-start="2" data-duration="10"`,
    );
    const stale = await client.callTool(editCall);
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain("409");
    const view = await client.callTool({
      name: "timeline_view",
      arguments: { projectId: fixture.project.id, frame: 1 },
    });
    expect(view.isError).not.toBe(true);
    expect(seeks).toEqual([String(1 / 30)]);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});

test("the entry document reads its live tree and a scene file its template", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  try {
    await writeFile(
      join(project.path, "index.html"),
      `<body><template><main data-root="true" data-composition-id="main" data-duration="4"><div id="card" class="clip" data-start="0" data-duration="1">Card</div></main></template></body>`,
    );
    const entry = await fixture.request(`/projects/${project.id}/timeline`);
    expect(entry.status).toBe(422);
    expect(await entry.json()).toMatchObject({ code: "unsupported" });
    await mkdir(join(project.path, "scenes"));
    const scene = `<template id="intro-template"><div data-composition-id="intro" data-duration="4"><div id="card" class="clip" data-start="0" data-duration="1">Card</div></div></template>`;
    await writeFile(join(project.path, "scenes", "intro.html"), scene);
    const read = TimelineViewSchema.parse(
      await (
        await fixture.request(
          `/projects/${project.id}/timeline?composition=scenes/intro.html`,
        )
      ).json(),
    );
    expect(read.timeline.clips.map((clip) => clip.id)).toEqual(["card"]);
    const moved = await fixture.request(
      `/projects/${project.id}/commands`,
      "POST",
      {
        composition: "scenes/intro.html",
        expectedRevision: read.revision,
        commands: [{ type: "move", clipIds: ["card"], by: 30 }],
      },
    );
    expect(moved.status).toBe(200);
    expect(
      await readFile(join(project.path, "scenes", "intro.html"), "utf8"),
    ).toBe(
      scene
        .replace(`data-start="0"`, `data-start="1"`)
        .replace(`data-duration="4"`, `data-duration="5"`),
    );
  } finally {
    await fixture.close();
  }
});

test("./index.html, /index.html, and index.html are one composition with one revision", async () => {
  const fixture = await timelineFixture();
  try {
    const read = async (path: string) => {
      const response = await fixture.request(
        `/projects/${fixture.project.id}/timeline?composition=${encodeURIComponent(path)}`,
      );
      return TimelineViewSchema.parse(await response.json());
    };
    const dotted = await read("./index.html");
    expect(dotted.composition).toBe("index.html");
    const edited = await fixture.request(
      `/projects/${fixture.project.id}/commands`,
      "POST",
      {
        composition: "./index.html",
        expectedRevision: dotted.revision,
        commands: [{ type: "setTrack", index: 0, name: "Rule" }],
      },
    );
    expect(edited.status).toBe(200);
    const plain = await read("index.html");
    expect(plain.revision).toBe(
      TimelineViewSchema.parse(await edited.json()).revision,
    );
    expect((await read("/index.html")).revision).toBe(plain.revision);
    expect(plain.timeline.tracks[0]?.name).toBe("Rule");
  } finally {
    await fixture.close();
  }
});

test.skipIf(!Bun.which("ffprobe"))(
  "a file ffprobe cannot read is probed once per version, not on every read",
  async () => {
    const fixture = await timelineFixture();
    const configured = process.env.HYPERFRAMES_FFPROBE_PATH;
    try {
      const { path } = fixture.project;
      const calls = join(path, "probe-calls.txt");
      const counting = join(path, "counting-ffprobe");
      await writeFile(
        counting,
        `#!/bin/sh\necho call >> "${calls}"\nexec "${Bun.which("ffprobe")}" "$@"\n`,
        { mode: 0o755 },
      );
      await writeFile(join(path, "broken.wav"), "not audio");
      await writeFile(
        join(path, "index.html"),
        `<main data-composition-id="main" data-duration="4"><audio id="bed" src="broken.wav" data-start="0" data-duration="1" data-track-index="0"></audio></main>`,
      );
      process.env.HYPERFRAMES_FFPROBE_PATH = counting;
      for (let read = 0; read < 3; read++)
        expect(
          (await fixture.request(`/projects/${fixture.project.id}/timeline`))
            .status,
        ).toBe(200);
      expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(
        1,
      );
    } finally {
      if (configured === undefined) delete process.env.HYPERFRAMES_FFPROBE_PATH;
      else process.env.HYPERFRAMES_FFPROBE_PATH = configured;
      await fixture.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "media without data-duration is measured with ffprobe",
  async () => {
    const fixture = await timelineFixture();
    try {
      const { path } = fixture.project;
      const made = Bun.spawnSync(
        [
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=8000:cl=mono",
          "-t",
          "2",
          join(path, "bed.wav"),
        ],
        { stderr: "pipe" },
      );
      expect(made.exitCode).toBe(0);
      await writeFile(
        join(path, "index.html"),
        `<main data-composition-id="main" data-duration="4"><audio id="bed" src="bed.wav" data-start="1" data-track-index="0"></audio></main>`,
      );
      const read = () =>
        fixture.request(`/projects/${fixture.project.id}/timeline`);
      // Measuring while ffprobe is unavailable must not be remembered once it is back.
      const configured = process.env.HYPERFRAMES_FFPROBE_PATH;
      process.env.HYPERFRAMES_FFPROBE_PATH = join(path, "missing-ffprobe");
      try {
        const unmeasured = await read();
        expect(unmeasured.status).toBe(422);
        expect(await unmeasured.text()).toContain("could not be measured");
      } finally {
        if (configured === undefined)
          delete process.env.HYPERFRAMES_FFPROBE_PATH;
        else process.env.HYPERFRAMES_FFPROBE_PATH = configured;
      }
      const { timeline } = TimelineViewSchema.parse(
        await (await read()).json(),
      );
      expect(timeline.clips[0]).toMatchObject({
        id: "bed",
        start: 30,
        duration: 60,
        sourceDuration: 2,
      });
    } finally {
      await fixture.close();
    }
  },
);
