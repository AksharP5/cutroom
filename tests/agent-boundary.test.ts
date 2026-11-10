import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMcpServer } from "../src/server/mcp/server";
import { readSource } from "../src/server/projects/store";
import { AGENT_HEADER } from "../src/shared/review";
import { toolApproval } from "../src/server/agents/tool-approval";
import { projectFixture } from "./project-fixture";

test("an active conversation cannot write another project's JavaScript or add its annotations through MCP", async () => {
  const fixture = await projectFixture();
  const own = await fixture.store.create({ name: "Claude project" });
  const other = await fixture.store.create({ name: "Codex project" });
  await writeFile(join(other.path, "motion.js"), "const motion = 'original';");
  const source = await readSource(other, "motion.js");
  const turn = await fixture.review.beginTurn(own, {
    kind: "message",
    id: "message",
    token: "claude-token",
  });
  const server = createMcpServer({
    agentToken: "claude-token",
    fetch: (url, init) => fixture.app.request(url, init),
  });
  const client = new Client({ name: "project-binding", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(remote);
    await client.connect(local);
    const write = await client.callTool({
      name: "source_write",
      arguments: {
        projectId: other.id,
        path: "motion.js",
        expectedVersion: source.version,
        content: "attacker wrote this",
      },
    });
    expect(write.isError).toBe(true);
    expect(await readFile(join(other.path, "motion.js"), "utf8")).toBe(
      source.content,
    );
    const add = await client.callTool({
      name: "annotation_add",
      arguments: {
        projectId: other.id,
        kind: "comment",
        body: "Wrong project",
        time: 0,
      },
    });
    expect(add.isError).toBe(true);
    expect((await fixture.store.document(other)).annotations).toEqual([]);
    const ownSource = await readSource(own);
    const args = {
      projectId: own.id,
      path: "index.html",
      file_path: "harmless.txt",
      expectedVersion: ownSource.version,
      content: ownSource.content.replace(
        "Drop media in, or ask your agent to start.",
        "Approved edit",
      ),
    };
    expect(
      toolApproval("mcp__cutroom_studio__source_write", args, own.path).title,
    ).toBe("Write index.html?");
    expect(
      (await client.callTool({ name: "source_write", arguments: args }))
        .isError,
    ).not.toBe(true);
    expect((await readSource(own)).content).toBe(args.content);
    expect(await Bun.file(join(own.path, "harmless.txt")).exists()).toBe(false);
    expect(
      (
        await client.callTool({
          name: "annotation_add",
          arguments: {
            projectId: own.id,
            kind: "comment",
            body: "Valid note",
            time: 0,
          },
        })
      ).isError,
    ).not.toBe(true);
    expect((await fixture.store.document(own)).annotations).toHaveLength(1);
    await turn.end();
    expect(
      (
        await client.callTool({
          name: "annotation_add",
          arguments: {
            projectId: own.id,
            kind: "comment",
            body: "After stop",
            time: 0,
          },
        })
      ).isError,
    ).toBe(true);
    expect((await fixture.store.document(own)).annotations).toHaveLength(1);
  } finally {
    await client.close();
    await server.close();
    await turn.end();
    await fixture.close();
  }
});

test("a source-write approval ignores a spoofed file_path and names the path MCP writes", () => {
  const approval = toolApproval(
    "mcp__cutroom_studio__source_write",
    {
      projectId: "project",
      path: "index.html",
      file_path: "harmless.txt",
      content: "changed",
      expectedVersion: "version",
    },
    "/project",
  );
  expect(approval.title).toBe("Write index.html?");
  expect(approval.input).not.toHaveProperty("file_path");
});

test("every project mutation rejects cross-project and ended-run tokens before parsing or repair", async () => {
  const fixture = await projectFixture();
  const { createTimelineRoutes } =
    await import("../src/server/timeline/routes");
  const { createHyperframesApi } =
    await import("../src/server/hyperframes/api");
  const { createWorkspaceRoutes } = await import("../src/server/workspace");
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/editor", editor);
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  fixture.app.route(
    "/api/cutroom",
    createWorkspaceRoutes({
      projects: fixture.store,
      review: fixture.review,
      dataDir: fixture.directory,
      projectsDir: fixture.store.projectsDir,
      mcpCommand: "cutroom mcp",
    }),
  );
  const own = await fixture.store.create({ name: "Active project" });
  const other = await fixture.store.create({ name: "Other project" });
  const turn = await fixture.review.beginTurn(own, {
    kind: "message",
    id: "turn",
    token: "active-token",
  });
  // Enumerate the routers themselves so adding a mutating endpoint adds a boundary check here.
  const routes = [
    ...new Map(
      fixture.app.routes
        .filter(
          (route) =>
            ["POST", "PUT", "PATCH", "DELETE"].includes(route.method) &&
            route.path.includes("/projects/:id/"),
        )
        .map((route) => [`${route.method} ${route.path}`, route]),
    ).values(),
  ];
  try {
    expect(routes.length).toBeGreaterThan(40);
    for (const active of [true, false]) {
      if (!active) await turn.end();
      for (const { method, path } of routes) {
        const url = path
          .replace(":id", active ? other.id : own.id)
          .replace(/:[\w]+/g, "missing")
          .replaceAll("*", "index.html");
        const response = await fixture.app.request(url, {
          method,
          headers: {
            [AGENT_HEADER]: "active-token",
            "content-type": "application/json",
          },
          body: "not valid JSON",
        });
        expect(
          response.status,
          `${method} ${path} with ${active ? "another project's" : "an ended run's"} token: ${await response.text()}`,
        ).toBe(409);
      }
    }
  } finally {
    await turn.end();
    await editor.dispose();
    await fixture.close();
  }
});

test("repair and non-HTML fast paths validate the binding even when called directly", async () => {
  const fixture = await projectFixture();
  const own = await fixture.store.create({ name: "Active" });
  const other = await fixture.store.create({ name: "Repair" });
  const turn = await fixture.review.beginTurn(own, {
    kind: "message",
    id: "turn",
    token: "active",
  });
  try {
    await writeFile(join(other.path, "motion.js"), "original");
    await mkdir(join(other.path, ".cutroom"), { recursive: true });
    for (const broken of ["review", "document"]) {
      await writeFile(
        join(
          other.path,
          broken === "review" ? ".cutroom/review.json" : "cutroom.json",
        ),
        "broken",
      );
      for (const composition of ["motion.js", "index.html"]) {
        let ran = false;
        await expect(
          fixture.review.editComposition(
            other,
            composition,
            "active",
            async () => {
              ran = true;
            },
          ),
        ).rejects.toThrow("No Cutroom run");
        expect(ran).toBe(false);
        const source = await readSource(other, composition);
        const response = await fixture.app.request(
          `/api/cutroom/projects/${other.id}/source`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              [AGENT_HEADER]: "active",
            },
            body: JSON.stringify({
              path: composition,
              expectedVersion: source.version,
              content: "attacker",
            }),
          },
        );
        expect(response.status).toBe(409);
        expect((await readSource(other, composition)).content).toBe(
          source.content,
        );
      }
    }
  } finally {
    await turn.end();
    await fixture.close();
  }
});

test("creation and import require a live token but have no target-project grant", async () => {
  const fixture = await projectFixture();
  const own = await fixture.store.create({ name: "Active" });
  const other = await fixture.store.create({ name: "Import target" });
  const turn = await fixture.review.beginTurn(own, {
    kind: "message",
    id: "turn",
    token: "active",
  });
  try {
    for (const [path, body] of [
      ["/projects", { name: "Created after approval" }],
      ["/projects/import", { path: other.path }],
    ] as const) {
      const request = (token: string) =>
        fixture.app.request(`/api/cutroom${path}`, {
          method: "POST",
          headers: {
            [AGENT_HEADER]: token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      expect((await request("invalid")).status).toBe(409);
      expect((await request("active")).status).toBe(
        path === "/projects" ? 201 : 200,
      );
    }
  } finally {
    await turn.end();
    await fixture.close();
  }
});

test("native tokens cannot change agent controls, grants, owner review actions, or render jobs", async () => {
  const fixture = await projectFixture();
  const { createAgentService } = await import("../src/server/agents/service");
  const { createAgentRoutes } = await import("../src/server/agents/routes");
  const { createHyperframesApi } =
    await import("../src/server/hyperframes/api");
  const agents = await createAgentService({
    projects: fixture.store,
    review: fixture.review,
    dataDir: join(fixture.directory, "agents"),
  });
  const agentRoutes = createAgentRoutes(agents);
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/cutroom", agentRoutes);
  fixture.app.route("/api/editor", editor);
  const project = await fixture.store.create({ name: "Owner controls" });
  const turn = await fixture.review.beginTurn(project, {
    kind: "message",
    id: "turn",
    token: "active",
  });
  try {
    const controls = [
      ...agentRoutes.routes
        .filter((route) => ["POST", "PATCH"].includes(route.method))
        .map((route) => ({ ...route, path: `/api/cutroom${route.path}` })),
      ...editor.routes
        .filter(
          (route) =>
            ["POST", "DELETE"].includes(route.method) &&
            route.path.startsWith("/render/"),
        )
        .map((route) => ({ ...route, path: `/api/editor${route.path}` })),
      {
        method: "POST",
        path: `/api/cutroom/projects/${project.id}/review/note/human`,
      },
    ];
    for (const token of ["active", "external"])
      for (const { method, path } of controls) {
        const response = await fixture.app.request(
          path.replace(":id", project.id).replace(":jobId", "job"),
          {
            method,
            headers: {
              [AGENT_HEADER]: token,
              "content-type": "application/json",
            },
            body: "bad JSON",
          },
        );
        expect(response.status, `${method} ${path}`).toBe(409);
      }
    expect(await agents.permissions(project.id)).toEqual({
      alwaysAllowCutroomEdits: false,
    });
  } finally {
    await turn.end();
    await agents.dispose();
    await editor.dispose();
    await fixture.close();
  }
});

test("transcription cancellation checks the job's project before cancelling it", async () => {
  const fixture = await projectFixture();
  const { createTranscriptService } =
    await import("../src/server/transcript/service");
  const { createProjectRoutes } = await import("../src/server/projects/routes");
  const { Hono } = await import("hono");
  const { HttpError } = await import("../src/shared/errors");
  const own = await fixture.store.create({ name: "Caller" });
  const other = await fixture.store.create({ name: "Transcribing" });
  const service = createTranscriptService(fixture.store, {
    availability: async () => ({
      available: true,
      binary: "/installed/whisper",
      modelsDir: "/installed/models",
      models: ["ggml-small.en.bin"],
      model: "small.en",
    }),
    transcribe: async (options) =>
      new Promise((_, reject) => {
        const abort = () => reject(new Error("Cancelled"));
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      }),
  });
  const api = new Hono().route(
    "/",
    createProjectRoutes(fixture.store, fixture.review, service),
  );
  api.onError((error, c) =>
    c.json(
      { error: error.message },
      error instanceof HttpError ? error.status : 500,
    ),
  );
  const turn = await fixture.review.beginTurn(own, {
    kind: "message",
    id: "turn",
    token: "active",
  });
  try {
    await writeFile(
      join(other.path, "index.html"),
      '<main data-composition-id="main" data-duration="2"><audio id="speech" class="clip" src="speech.wav" data-start="0" data-duration="2"></audio></main>',
    );
    await writeFile(join(other.path, "speech.wav"), "fixture audio");
    const job = await service.start(other, {
      sourceFile: "index.html",
      mediaPath: "speech.wav",
      elementId: "speech",
      language: "en",
    });
    const cancelled = await api.request(`/transcription-jobs/${job.id}`, {
      method: "DELETE",
      headers: { [AGENT_HEADER]: "active" },
    });
    expect(cancelled.status).toBe(409);
    expect(service.getJob(job.id).status).toBe("running");
    expect(
      (await api.request(`/transcription-jobs/${job.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
  } finally {
    await turn.end();
    await service.dispose();
    await fixture.close();
  }
});
