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
      "A new composition.",
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
