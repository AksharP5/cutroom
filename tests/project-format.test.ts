import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { projectFixture } from "./project-fixture";

test("MCP creates exact rates and shares the format preview, write, and undo history", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "project-format-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const result = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      return z.object({ result: z.unknown() }).parse(response.structuredContent)
        .result;
    };
    const fps = { num: 30000, den: 1001 };
    const project = ProjectSchema.parse(
      await result("project_create", { name: "Exact project", fps }),
    );
    const index = join(project.path, "index.html");
    const endpoint = `/projects/${project.id}`;
    const read = async () =>
      TimelineViewSchema.parse(
        await (await fixture.request(`${endpoint}/timeline`)).json(),
      );
    expect(await readFile(index, "utf8")).toContain('data-fps="30000/1001"');
    expect((await read()).timeline.fps).toEqual(fps);
    expect(
      (
        await fixture.request("/projects", "POST", {
          name: "Decimal",
          fps: 29.97,
        })
      ).status,
    ).toBe(400);

    // The first clip starts off the old grid. Its follower shares its exact end.
    const html =
      '<main data-composition-id="main" data-fps="30000/1001" data-width="1920" data-height="1080" data-duration="2"><div id="one" data-start="0.018" data-duration="0.069"></div><div id="two" data-start="one" data-end="0.25"></div></main>';
    await writeFile(index, html);
    const before = await read();
    expect(before.timeline.clips[0]?.start).toBe(1);
    const format = { width: 1080, height: 1920, fps: { num: 24, den: 1 } };
    const args = { projectId: project.id, expectedRevision: before.revision };
    const preview = await result("timeline_format_preview", {
      ...args,
      format,
    });
    expect(preview).toMatchObject({ movedEdges: 3, maxShiftMs: 18 });
    expect(await readFile(index, "utf8")).toBe(html);
    const command = { type: "setFormat", ...format };
    const applied = await fixture.request(`${endpoint}/commands`, "POST", {
      expectedRevision: before.revision,
      commands: [command],
    });
    const data = await applied.json();
    expect(applied.status, JSON.stringify(data)).toBe(200);
    const after = TimelineViewSchema.parse(data);
    expect(after.size).toEqual({ width: 1080, height: 1920 });
    expect(after.timeline.fps).toEqual(format.fps);
    expect(
      after.timeline.clips.map(({ start, duration }) => [start, duration]),
    ).toEqual([
      [0, 2],
      [2, 4],
    ]);
    const written = await readFile(index, "utf8");
    expect(written).toContain('data-start="one"');

    expect(
      (await fixture.request(`${endpoint}/history/undo`, "POST")).status,
    ).toBe(200);
    expect(await readFile(index, "utf8")).toBe(html);
    expect((await read()).timeline).toEqual(before.timeline);
    expect(
      (await fixture.request(`${endpoint}/history/redo`, "POST")).status,
    ).toBe(200);
    expect(await readFile(index, "utf8")).toBe(written);
    expect((await read()).timeline).toEqual(after.timeline);
    await fixture.request(`${endpoint}/history/undo`, "POST");
    const mixed = await result("timeline_edit", {
      ...args,
      expectedRevision: (await read()).revision,
      commands: [command],
      fullTimeline: true,
    });
    expect(TimelineViewSchema.parse(mixed).timeline).toEqual(after.timeline);
    expect(await readFile(index, "utf8")).toBe(written);
  } finally {
    await client.close();
    await server.stop(true);
    await fixture.close();
  }
});

test("format preview and commit refuse a clip that would collapse, without touching disk", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  try {
    const project = await fixture.store.create({ name: "One frame" });
    const index = join(project.path, "index.html");
    const html =
      '<main data-composition-id="main" data-fps="60"><div id="flash" data-start="0" data-duration="0.016667"></div></main>';
    await writeFile(index, html);
    const path = `/projects/${project.id}`;
    const view = TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
    const format = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
    const expectedRevision = view.revision;
    for (const [route, body] of [
      ["format-preview", { expectedRevision, format }],
      [
        "commands",
        { expectedRevision, commands: [{ type: "setFormat", ...format }] },
      ],
    ] as const) {
      const response = await fixture.request(`${path}/${route}`, "POST", body);
      expect(response.status).toBe(422);
      expect(await response.text()).toContain("shorter than one frame");
    }
    expect(await readFile(index, "utf8")).toBe(html);
    const history = await fixture.store.history(project);
    expect(history.list()).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("a rate change keeps cut, transition, marker and range times together", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  try {
    const project = await fixture.store.create({
      name: "Dissolve at two seconds",
    });
    const index = join(project.path, "index.html");
    await writeFile(
      index,
      '<main data-composition-id="main" data-fps="30"><img id="left" src="left.png" data-start="0" data-duration="2"><img id="right" src="right.png" data-start="2" data-duration="2"></main>',
    );
    const path = `/projects/${project.id}`;
    const view = TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
    const prepared = await fixture.request(`${path}/commands`, "POST", {
      expectedRevision: view.revision,
      commands: [
        {
          type: "setTransition",
          from: "left",
          to: "right",
          transition: { duration: 12 },
        },
        { type: "setMarker", id: "pace", frame: 31, duration: 6 },
        { type: "setRange", in: 30, out: 91 },
      ],
    });
    const before = await prepared.json();
    expect(prepared.status, JSON.stringify(before)).toBe(200);
    const format = await fixture.request(`${path}/commands`, "POST", {
      expectedRevision: TimelineViewSchema.parse(before).revision,
      commands: [
        {
          type: "setFormat",
          fps: { num: 60, den: 1 },
          width: 1920,
          height: 1080,
        },
      ],
    });
    const after = await format.json();
    expect(format.status, JSON.stringify(after)).toBe(200);
    const { timeline } = TimelineViewSchema.parse(after);
    expect(
      timeline.clips.map(({ start, duration }) => [start, duration]),
    ).toEqual([
      [0, 120],
      [120, 120],
    ]);
    expect(timeline.clips[0]?.transitionOut).toMatchObject({
      duration: 24,
      alignment: "center",
    });
    expect(timeline.clips[1]?.transitionIn).toEqual(
      timeline.clips[0]?.transitionOut,
    );
    expect(timeline.markers[0]).toMatchObject({ frame: 62, duration: 12 });
    expect(timeline.range).toEqual({ in: 60, out: 182 });
  } finally {
    await fixture.close();
  }
});

test("regridding a speed ramp keeps its in-point and curve phase together", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  try {
    const project = await fixture.store.create({ name: "Speed ramp" });
    const automation = JSON.stringify({
      version: 1,
      lanes: [
        {
          target: "rate",
          points: [
            { t: 0, v: 0.5 },
            { t: 4, v: 2 },
          ],
        },
      ],
    });
    await writeFile(
      join(project.path, "index.html"),
      `<main data-composition-id="main" data-fps="30"><video id="ramp" src="ramp.mp4" muted data-start="0.02" data-duration="5" data-automation='${automation}'></video></main>`,
    );
    const path = `/projects/${project.id}`;
    const before = TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
    const edit = await fixture.request(`${path}/commands`, "POST", {
      expectedRevision: before.revision,
      commands: [
        {
          type: "setFormat",
          fps: { num: 60, den: 1 },
          width: 1920,
          height: 1080,
        },
      ],
    });
    const body = await edit.json();
    expect(edit.status, JSON.stringify(body)).toBe(200);
    const after = TimelineViewSchema.parse(body);
    const { mediaStart, automation: projected } = before.timeline.clips[0]!;
    expect(after.timeline.clips[0]).toMatchObject({
      start: 1,
      duration: 300,
      mediaStart,
      automation: projected,
    });
  } finally {
    await fixture.close();
  }
});
