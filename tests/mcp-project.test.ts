import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { createProjectRoutes } from "../src/server/projects/routes";
import { createReviewService } from "../src/server/projects/review";
import { createTranscriptService } from "../src/server/transcript/service";
import {
  ProjectSchema,
  SourceSchema,
  TranscriptJobSchema,
} from "../src/shared/project";
import { createMcpHttpHandler, localApiBase } from "../src/server/mcp/server";
import { projectFixture } from "./project-fixture";
import { z } from "zod";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { editSummary } from "../src/shared/toolRow";
import { createTimelineRoutes } from "../src/server/timeline/routes";

test("marker names and colours round-trip through MCP, disk, and undo history", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Marker review beats" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "marker-test", version: "1" });
  const resultSchema = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const read = async () =>
      resultSchema.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: project.id },
        }),
      ).structuredContent.result;
    const before = await read();
    const edited = resultSchema.parse(
      await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: before.revision,
          commands: [
            {
              type: "setMarker",
              id: "downbeat",
              frame: 45,
              duration: 12,
              name: "Downbeat",
              note: "Keep this cue",
              color: "purple",
            },
          ],
        },
      }),
    ).structuredContent.result;
    const expected = [
      {
        id: "downbeat",
        frame: 45,
        duration: 12,
        name: "Downbeat",
        note: "Keep this cue",
        color: "purple" as const,
      },
    ];
    expect(edited.timeline.markers).toEqual(expected);
    expect((await read()).timeline.markers).toEqual(expected);
    expect(
      TimelineViewSchema.parse(
        await (
          await fixture.request(`/projects/${project.id}/timeline`)
        ).json(),
      ).timeline.markers,
    ).toEqual(expected);
    expect(
      (
        await client.callTool({
          name: "history_undo",
          arguments: { projectId: project.id },
        })
      ).isError,
    ).not.toBe(true);
    expect((await read()).timeline.markers).toEqual([]);
    expect(
      (
        await client.callTool({
          name: "history_redo",
          arguments: { projectId: project.id },
        })
      ).isError,
    ).not.toBe(true);
    expect((await read()).timeline.markers).toEqual(expected);
    const current = await read();
    expect(
      (
        await client.callTool({
          name: "timeline_edit",
          arguments: {
            projectId: project.id,
            expectedRevision: current.revision,
            commands: [{ type: "removeMarker", id: "downbeat" }],
          },
        })
      ).isError,
    ).not.toBe(true);
    expect((await read()).timeline.markers).toEqual([]);
  } finally {
    await client.close();
    await server.stop(true);
    await fixture.close();
  }
});

test("an external MCP client edits the same project and undo history as the UI", async () => {
  const fixture = await projectFixture();
  const handler = createMcpHttpHandler({
    fetch: (url, init) => fixture.app.request(url, init),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({
    name: "cutroom-integration-test",
    version: "1.0.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("transcript_edit");
    const created = await client.callTool({
      name: "project_create",
      arguments: { name: "External agent" },
    });
    const project = z
      .object({ structuredContent: z.object({ result: ProjectSchema }) })
      .parse(created).structuredContent.result;
    const read = await client.callTool({
      name: "source_read",
      arguments: { projectId: project.id },
    });
    const original = z
      .object({ structuredContent: z.object({ result: SourceSchema }) })
      .parse(read).structuredContent.result;
    const content = original.content.replace(
      "Drop media in, or ask your agent to start.",
      "Changed through MCP.",
    );
    const saved = await client.callTool({
      name: "source_write",
      arguments: {
        projectId: project.id,
        content,
        expectedVersion: original.version,
      },
    });
    expect(saved.isError).not.toBe(true);
    const visible = SourceSchema.parse(
      await (await fixture.request(`/projects/${project.id}/source`)).json(),
    );
    expect(visible.content).toContain("Changed through MCP.");
    expect(
      (await fixture.review.clipChanges(project, "index.html")).clipEdits,
    ).toContainEqual(
      expect.objectContaining({
        by: "agent",
        agentName: "cutroom-integration-test",
      }),
    );
    const stale = await client.callTool({
      name: "source_write",
      arguments: {
        projectId: project.id,
        content: "stale",
        expectedVersion: original.version,
      },
    });
    expect(stale.isError).toBe(true);
    const undo = await client.callTool({
      name: "history_undo",
      arguments: { projectId: project.id },
    });
    expect(undo.isError).not.toBe(true);
    expect(
      SourceSchema.parse(
        await (await fixture.request(`/projects/${project.id}/source`)).json(),
      ).content,
    ).toBe(original.content);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});

test("the stdio bridge refuses remote or credential-bearing API origins", () => {
  expect(localApiBase("http://localhost:4317")).toBe("http://localhost:4317");
  expect(() => localApiBase("http://example.com")).toThrow("local HTTP");
  expect(() => localApiBase("http://user:password@localhost:4317")).toThrow(
    "local HTTP",
  );
});

test("the published stdio entry point connects an outside agent to the running server", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Stdio project" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => fixture.app.fetch(request),
  });
  const client = new Client({ name: "cutroom-stdio-test", version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../src/server/mcp/stdio.ts", import.meta.url)),
        ],
        env: {
          PATH: process.env.PATH ?? "",
          CUTROOM_URL: `http://127.0.0.1:${server.port}`,
        },
      }),
    );
    const result = await client.callTool({
      name: "projects_list",
      arguments: {},
    });
    const returned = z
      .object({
        structuredContent: z.object({
          result: z.object({ projects: z.array(ProjectSchema) }),
        }),
      })
      .parse(result);
    expect(returned.structuredContent.result.projects[0]?.id).toBe(project.id);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});

test("MCP transcription status retains the legacy job shape through successful and failed shared jobs", async () => {
  const fixture = await projectFixture();
  let fail = false;
  const service = createTranscriptService(fixture.store, {
    availability: async () => ({
      available: true,
      binary: "/installed/whisper",
      modelsDir: "/installed/models",
      models: ["ggml-small.en.bin"],
      model: "small.en",
    }),
    transcribe: async (options) => {
      if (fail) throw new Error("Engine failure");
      if (!options.dir) throw new Error("Expected scratch directory");
      const transcriptPath = join(options.dir, "words.json");
      await writeFile(
        transcriptPath,
        JSON.stringify([{ id: "hello", text: "Hello", start: 0, end: 1 }]),
      );
      return {
        kind: "transcribed",
        engine: "whisper",
        model: "small.en",
        detectedLanguage: "en",
        wordCount: 1,
        durationSeconds: 2,
        speechOnsetSeconds: 0,
        transcriptPath,
      };
    },
  });
  const api = new Hono().route(
    "/api/cutroom",
    createProjectRoutes(
      fixture.store,
      createReviewService(fixture.store),
      service,
    ),
  );
  const handler = createMcpHttpHandler({
    fetch: (url, init) => api.request(url, init),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({ name: "job-status-test", version: "1" });
  try {
    const project = await fixture.store.create({ name: "Job status" });
    await writeFile(
      join(project.path, "index.html"),
      '<html><body><main data-composition-id="main" data-duration="2"><audio id="speech" class="clip" src="speech.wav" data-start="0" data-duration="2"></audio></main></body></html>',
    );
    await writeFile(join(project.path, "speech.wav"), "fixture audio");
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    for (const shouldFail of [false, true]) {
      fail = shouldFail;
      const job = await service.start(project, {
        sourceFile: "index.html",
        mediaPath: "speech.wav",
        elementId: "speech",
        language: "en",
      });
      const deadline = performance.now() + 3000;
      while (job.status === "running") {
        if (performance.now() > deadline)
          throw new Error("Transcription job did not settle.");
        await Bun.sleep(5);
      }
      const result = await client.callTool({
        name: "transcription_status",
        arguments: { jobId: job.id },
      });
      const received = z
        .object({
          structuredContent: z.object({ result: TranscriptJobSchema }),
        })
        .parse(result).structuredContent.result;
      expect(received.status).toBe(shouldFail ? "failed" : "complete");
      expect(received.progress).toBe(shouldFail ? 0 : 1);
      expect(received.message).toBe(
        shouldFail ? "Transcription failed" : "Transcribed 1 words",
      );
      if (shouldFail) expect(received.error).toBe("Engine failure");
      else expect(received.transcriptId).toBeString();
    }
  } finally {
    await client.close();
    await service.dispose();
    await server.stop(true);
    await fixture.close();
  }
});

test("review_list gives an agent every stroke, the pin, and the range of a note made on the picture", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Picture notes" });
  const handler = createMcpHttpHandler({
    fetch: (url, init) => fixture.app.request(url, init),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({ name: "cutroom-review-test", version: "1.0.0" });
  const strokes = [
    {
      points: [
        { x: 0.2, y: 0.5 },
        { x: 0.4, y: 0.3 },
      ],
      color: "#f2c94c",
    },
    { points: [{ x: 0.7, y: 0.7 }], color: "#f2c94c" },
  ];
  try {
    // What the editor sends for a drawing with no words.
    const saved = await fixture.request(
      `/projects/${project.id}/annotations`,
      "POST",
      {
        kind: "drawing",
        body: "",
        time: 1,
        endTime: 2.5,
        compositionPath: "index.html",
        point: { x: 0.4, y: 0.3 },
        strokes,
      },
    );
    expect(saved.ok).toBe(true);
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const listed = await client.callTool({
      name: "review_list",
      arguments: { projectId: project.id },
    });
    const { items } = z
      .object({
        structuredContent: z.object({
          result: z.object({ items: z.array(z.unknown()) }),
        }),
      })
      .parse(listed).structuredContent.result;
    expect(items).toEqual([
      expect.objectContaining({
        kind: "drawing",
        time: 1,
        endTime: 2.5,
        point: { x: 0.4, y: 0.3 },
        strokes,
        review: expect.objectContaining({ status: "open" }),
      }),
    ]);
  } finally {
    await client.close();
    await server.stop(true);
    await fixture.close();
  }
});

test("title text edits through MCP write the source, undo in one step, and refuse nested markup", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Launch cut" });
  const file = join(project.path, "index.html");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "text-test", version: "1" });
  const resultSchema = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const read = async () =>
      resultSchema.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: project.id },
        }),
      ).structuredContent.result;
    const text = (view: Awaited<ReturnType<typeof read>>) =>
      view.timeline.clips.find((clip) => clip.id === "headline")?.text;
    const setText = async (words: string) =>
      client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: (await read()).revision,
          commands: [{ type: "setClip", clipId: "headline", text: words }],
        },
      });
    expect(text(await read())).toBe("Launch cut");
    const answer = await setText("Spring\nlaunch");
    const edited = resultSchema.parse(answer).structuredContent.result;
    expect(text(edited)).toBe("Spring\nlaunch");
    expect(await Bun.file(file).text()).toContain(">Spring<br>launch</div>");
    expect(edited.clipEdits?.[0]?.label).toBe("Set text to “Spring launch”");
    // The agent panel's row reads the sentence that ends the call's result.
    expect(
      editSummary("cutroom_studio: timeline_edit", JSON.stringify(answer)),
    ).toBe("Set text to “Spring launch” for Project title");
    await client.callTool({
      name: "history_undo",
      arguments: { projectId: project.id },
    });
    expect(text(await read())).toBe("Launch cut");
    expect(await Bun.file(file).text()).toContain(">Launch cut</div>");

    const source = await Bun.file(file).text();
    await writeFile(
      file,
      source.replace(">Launch cut</div>", "><em>Launch</em> cut</div>"),
    );
    const refused = await setText("Flattened");
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      "This text has markup inside it. Edit it in the source.",
    );
    expect(await Bun.file(file).text()).toContain("<em>Launch</em> cut");
  } finally {
    await client.close();
    await server.stop(true);
    await fixture.close();
  }
});
