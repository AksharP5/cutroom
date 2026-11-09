import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
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
