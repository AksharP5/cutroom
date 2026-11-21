import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test.each(["directory", "socket"])(
  "the public server still starts when the private import %s path is occupied",
  async (blocked) => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-import-socket-"));
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const { origin } = probe.url;
    const port = String(probe.port);
    await probe.stop(true);
    const directory = join(root, ".media-import");
    const occupied =
      blocked === "socket" ? join(directory, `${port}.sock`) : directory;
    if (blocked === "socket") await mkdir(directory, { mode: 0o700 });
    await writeFile(occupied, "already here");
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../src/server/index.ts")],
      {
        env: {
          ...process.env,
          CUTROOM_PORT: port,
          CUTROOM_DATA_DIR: root,
          CUTROOM_PROJECTS_DIR: join(root, "projects"),
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const errors = new Response(child.stderr).text();
    try {
      let health: Response | undefined;
      const deadline = Date.now() + 8000;
      while (!health?.ok && Date.now() < deadline && child.exitCode === null) {
        health = await fetch(`${origin}/health`).catch(() => undefined);
        if (!health?.ok) await Bun.sleep(30);
      }
      expect(health?.ok).toBe(true);
      expect((await fetch(`${origin}/api/cutroom/projects`)).status).toBe(200);
      expect(await readFile(occupied, "utf8")).toBe("already here");
    } finally {
      child.kill();
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
    expect(await errors).toContain("Local media import is unavailable");
  },
  10_000,
);
