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
import { z } from "zod";
import { createApp } from "../src/server/app";
import { createWorkspaceRoutes } from "../src/server/workspace";
import { createProjectStore } from "../src/server/projects/store";
import { ProjectSchema } from "../src/shared/project";

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

test("every mutation requires an explicit workspace Origin, including approval, upstream, and MCP routes", async () => {
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
        undefined,
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
