import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createApp } from "../src/server/app";
import { createWorkspaceRoutes } from "../src/server/workspace";
import { createReviewService } from "../src/server/projects/review";
import { createProjectStore } from "../src/server/projects/store";
import { ProjectSchema } from "../src/shared/project";
import { volumePoints } from "../src/shared/timeline/mix";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

test("foreign browser origins and rebinding hosts cannot access local projects", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cutroom-origin-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const runtime = await createApp({
    dataDir,
    projectsDir: join(dataDir, "projects"),
  });
  cleanup.push(() => runtime.dispose());
  expect(
    (
      await runtime.app.request("http://127.0.0.1:4317/api/cutroom/projects", {
        headers: { origin: "https://outside.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await runtime.app.request("http://outside.example/api/cutroom/projects"))
      .status,
  ).toBe(403);
  expect(
    (await runtime.app.request("http://127.0.0.1:4317/api/cutroom/projects"))
      .status,
  ).toBe(200);
});

test("cross-site reads can reach only isolated previews, while trusted parent loads and native clients keep working", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cutroom-fetch-site-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const runtime = await createApp({
    dataDir,
    projectsDir: join(dataDir, "projects"),
  });
  cleanup.push(() => runtime.dispose());
  const project = await runtime.projects.create({
    name: "Fetch Metadata boundary",
  });
  await writeFile(
    join(project.path, "evil.html"),
    "<script>window.escaped = true;</script>",
  );
  const baseUrl = "http://127.0.0.1:4317";
  const preview = `/api/projects/${project.id}/preview/evil.html`;
  for (const path of [
    preview,
    "/api/cutroom/projects",
    "/api/runtime.js",
    "/health",
    "/",
    "/mcp",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      expect(
        (
          await runtime.app.request(`${baseUrl}${path}`, {
            method,
            headers: { "sec-fetch-site": "cross-site" },
          })
        ).status,
      ).toBe(403);
    }
  }
  for (const headers of [
    new Headers(),
    new Headers({ "sec-fetch-site": "same-origin" }),
  ]) {
    expect(
      (await runtime.app.request(`${baseUrl}${preview}`, { headers })).status,
    ).toBe(200);
    expect(
      (
        await runtime.app.request(`${baseUrl}/api/cutroom/projects`, {
          headers,
        })
      ).status,
    ).toBe(200);
  }
  const redirect = await runtime.app.request(
    `${baseUrl}/api/projects/${project.id}/isolated-preview`,
    {
      headers: { "sec-fetch-site": "same-origin" },
    },
  );
  expect(redirect.status).toBe(302);
  const location = z.string().parse(redirect.headers.get("location"));
  const isolated = await runtime.app.request(location, {
    headers: { origin: "null", "sec-fetch-site": "cross-site" },
  });
  expect(isolated.status).toBe(200);
  expect(isolated.headers.get("content-security-policy")).toContain(
    "sandbox allow-scripts",
  );
});

test("every mutation requires an explicit workspace Origin, and MCP refuses any other Origin it is sent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cutroom-mutation-origin-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const runtime = await createApp({
    dataDir,
    projectsDir: join(dataDir, "projects"),
  });
  cleanup.push(() => runtime.dispose());
  for (const path of [
    "/api/cutroom/projects",
    "/api/cutroom/agents/sessions/test/responses",
    "/api/projects/test/files/index.html",
    "/api/telemetry",
    "/mcp",
  ]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const origin of [
        ...(path === "/mcp" ? [] : [undefined]),
        "null",
        "http://127.0.0.1:4318",
        "https://outside.example",
      ]) {
        const response = await runtime.app.request(
          `http://127.0.0.1:4317${path}`,
          {
            method,
            headers: origin ? { origin } : {},
          },
        );
        expect(response.status).toBe(403);
      }
    }
  }
  const response = await runtime.app.request(
    "http://127.0.0.1:4317/api/cutroom/projects",
    {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:4317",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Authorized project" }),
    },
  );
  expect(response.status).toBe(201);
});

test.skipIf(!Bun.which("ffmpeg"))(
  "a local MCP client without an Origin connects and edits, while foreign origins and rebinding hosts are refused",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cutroom-mcp-client-"));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    cleanup.push(() => server.stop(true));
    const port = z.number().parse(server.port);
    const runtime = await createApp({
      dataDir,
      projectsDir: join(dataDir, "projects"),
      port,
    });
    cleanup.push(() => runtime.dispose());
    server.reload({ fetch: runtime.app.fetch });
    const project = await runtime.projects.create({ name: "MCP client" });
    for (const [name, expression] of [
      ["voice.wav", "0.1*sin(2*PI*440*t)*between(t,1,2)"],
      ["music.wav", "0.3*sin(2*PI*110*t)"],
    ] as const)
      expect(
        Bun.spawnSync([
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `aevalsrc='${expression}':d=3:s=48000`,
          join(project.path, name),
        ]).exitCode,
      ).toBe(0);
    await writeFile(
      join(project.path, "index.html"),
      `<main data-composition-id="main" data-duration="3" data-fps="30"><audio id="voice" src="voice.wav" data-start="0" data-duration="3" data-track-index="0"></audio><audio id="music" src="music.wav" data-start="0" data-duration="3" data-track-index="1"></audio></main>`,
    );
    const initialize = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "probe", version: "1" },
          },
        }),
      });
    for (const origin of [
      "https://outside.example",
      "null",
      `http://127.0.0.1:${port + 1}`,
    ])
      expect((await initialize({ origin })).status).toBe(403);
    // A DNS-rebinding page reaches the socket under its own name, with or without an Origin.
    for (const host of [
      `rebind.example:${port}`,
      `127.0.0.1.rebind.example:${port}`,
    ])
      expect((await initialize({ host })).status).toBe(403);

    // The stock SDK client sends no Origin, as `claude mcp add --transport http` and Codex do.
    const client = new Client({ name: "no-origin-client", version: "1" });
    cleanup.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://localhost:${port}/mcp`),
      ),
    );
    const listed = await client.callTool({ name: "projects_list" });
    expect(listed.isError).not.toBe(true);
    expect(JSON.stringify(listed)).toContain("MCP client");
    for (const [name, args] of [
      ["audio_duck", { bed: "music" }],
      ["audio_loudness", { clipIds: ["voice"] }],
    ] as const) {
      const result = await client.callTool({
        name,
        arguments: { projectId: project.id, ...args },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    }
    const response = await runtime.app.request(
      `http://127.0.0.1:${port}/api/cutroom/projects/${project.id}/timeline`,
    );
    const { timeline } = TimelineViewSchema.parse(await response.json());
    const voice = timeline.clips.find(({ id }) => id === "voice");
    const music = timeline.clips.find(({ id }) => id === "music");
    expect(voice?.volume ?? 1).toBeGreaterThan(1);
    expect(
      volumePoints(music?.automation ?? null, timeline.fps)?.some(
        ({ gain }) => gain < 1,
      ),
    ).toBe(true);
  },
  30_000,
);

test("annotation captures cannot write through a project symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-attachment-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), "cutroom-outside-"));
  cleanup.push(() => rm(outside, { recursive: true, force: true }));
  const store = await createProjectStore({ dataDir: root });
  cleanup.push(() => store.close());
  const project = await store.create({ name: "Capture boundary" });
  await symlink(outside, join(project.path, ".cutroom"));
  const app = createWorkspaceRoutes({
    projects: store,
    review: createReviewService(store),
    dataDir: root,
    projectsDir: store.projectsDir,
    mcpCommand: "cutroom mcp",
  });
  app.onError((error, c) => c.json({ error: error.message }, 403));
  const response = await app.request(`/projects/${project.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:4317",
    },
    body: JSON.stringify({ image: "data:image/png;base64,iVBORw0KGgo=" }),
  });
  expect(response.status).toBe(403);
  expect(await readdir(outside)).toEqual([]);
});

test("user-selected attachments are copied into the project and project files are reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-import-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = await createProjectStore({ dataDir: root });
  cleanup.push(() => store.close());
  const project = await store.create({ name: "References" });
  const source = join(root, "reference.txt");
  await writeFile(source, "A chosen reference");
  const app = createWorkspaceRoutes({
    projects: store,
    review: createReviewService(store),
    dataDir: root,
    projectsDir: store.projectsDir,
    mcpCommand: "cutroom mcp",
  });
  const importFile = (path: string) =>
    app.request(`/projects/${project.id}/attachments/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4317",
      },
      body: JSON.stringify({ path }),
    });
  const response = await importFile(source);
  expect(response.status).toBe(201);
  const attachment = (await response.json()) as { path: string };
  expect(
    attachment.path.startsWith(join(project.path, ".cutroom", "attachments")),
  ).toBe(true);
  expect(await readFile(attachment.path, "utf8")).toBe("A chosen reference");
  expect(await readFile(source, "utf8")).toBe("A chosen reference");
  const reused = await importFile(attachment.path);
  expect(reused.status).toBe(200);
  expect(await reused.json()).toEqual(attachment);
});

test("review captures stay out of the project file list", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cutroom-listing-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const runtime = await createApp({
    dataDir,
    projectsDir: join(dataDir, "projects"),
  });
  cleanup.push(() => runtime.dispose());
  const request = (path: string, init?: RequestInit) =>
    runtime.app.request(`http://127.0.0.1:4317/api${path}`, init);
  const project = ProjectSchema.parse(
    await (
      await request("/cutroom/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:4317",
        },
        body: JSON.stringify({ name: "Review captures" }),
      })
    ).json(),
  );
  const capture = await request(`/cutroom/projects/${project.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:4317",
    },
    body: JSON.stringify({ image: "data:image/png;base64,iVBORw0KGgo=" }),
  });
  expect(capture.status).toBe(201);
  const { files } = z
    .object({ files: z.array(z.string()) })
    .parse(await (await request(`/projects/${project.id}`)).json());
  expect(files).toContain("index.html");
  expect(files.filter((file) => file.startsWith(".cutroom/"))).toEqual([]);
});
