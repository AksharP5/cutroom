import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";

test("shutdown closes admission immediately and repeated callers share cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-shutdown-"));
  const runtime = await createApp({
    dataDir: root,
    projectsDir: join(root, "projects"),
  });
  try {
    const closing = runtime.dispose();
    const response = await runtime.app.request(
      "http://127.0.0.1:4317/api/cutroom/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Late project" }),
      },
    );
    expect(response.status).toBe(503);
    expect(runtime.dispose()).toBe(closing);
    await closing;
    expect(
      (await runtime.app.request("http://127.0.0.1:4317/health")).status,
    ).toBe(503);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("the copied external MCP command connects to the selected local port", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { z } = await import("zod");
  const root = await mkdtemp(join(tmpdir(), "cutroom-custom-port-"));
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  await probe.stop(true);
  const runtime = await createApp({
    dataDir: root,
    projectsDir: join(root, "projects"),
    port,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: runtime.app.fetch,
  });
  const client = new Client({ name: "cutroom-port-test", version: "1" });
  try {
    await runtime.projects.create({ name: "Custom port project" });
    const response = await fetch(`${server.url}api/cutroom/status`);
    const { mcpCommand } = z
      .object({ mcpCommand: z.string() })
      .parse(await response.json());
    await client.connect(
      new StdioClientTransport({
        command: "/bin/sh",
        args: ["-c", mcpCommand],
        stderr: "ignore",
      }),
    );
    const result = await client.callTool({ name: "projects_list" });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("Custom port project");
  } finally {
    await client.close();
    await runtime.dispose();
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
