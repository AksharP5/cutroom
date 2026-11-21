import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  cancelMediaImport,
  importSocketPath,
  openImportSource,
  openImportSocket,
  requestMediaImport,
} from "../src/local/mediaImport";
import { createApp } from "../src/server/app";
import { importMedia } from "../src/server/projects/mediaImport";
import { createReviewService } from "../src/server/projects/review";
import type { Project } from "../src/shared/project";

const baseUrl = "http://127.0.0.1:4936";
let root: string;
let data: string;
let socket: string;
let runtime: Awaited<ReturnType<typeof createApp>>;
let listener: ReturnType<typeof Bun.serve>;
let socketDir: Awaited<ReturnType<typeof openImportSocket>>;
let project: Project;
let tmpfs: string | undefined;

const assets = (name = "") => join(project.path, "assets", name);
const mediaNames = async () => (await readdir(assets())).sort();
const openIdentity = async (path: string) => {
  const { file, identity } = await openImportSource(path);
  await file.close();
  return { path, identity };
};
const send = (paths: string[], signal = new AbortController().signal) =>
  requestMediaImport(socket, project.id, paths, { signal });

beforeEach(async () => {
  root = await mkdtemp("/var/tmp/cutroom-import.test-");
  // The user can put CUTROOM_DATA_DIR deeper than the OS's socket-address limit.
  data = join(root, "data-" + "x".repeat(80));
  runtime = await createApp({
    dataDir: data,
    projectsDir: join(root, "projects"),
    port: 4936,
  });
  project = await runtime.projects.create({ name: "Path import" });
  socket = importSocketPath(baseUrl, data);
  socketDir = await openImportSocket(socket, true);
  listener = Bun.serve({
    unix: socketDir.address,
    fetch: runtime.mediaImport.fetch,
  });
});

afterEach(async () => {
  await listener.stop(true);
  await socketDir.handle.close();
  await runtime.dispose();
  if (tmpfs) {
    await rm(tmpfs, { recursive: true, force: true });
    tmpfs = undefined;
  }
  await rm(root, { recursive: true, force: true });
});

async function otherFilesystem() {
  // Linux CI gives the tests a tmpfs. Only the small cross-device fixtures go there.
  tmpfs = await mkdtemp("/dev/shm/cutroom-import.test-");
  expect((await stat(tmpfs)).dev).not.toBe((await stat(assets())).dev);
  return tmpfs;
}

test("same-device imports keep their inode, use free names, and undo or redo in one step", async () => {
  const first = join(root, "recording.mp4");
  const second = join(root, "track.wav");
  await writeFile(first, "new recording");
  await writeFile(second, "new track");
  await writeFile(assets("recording.mp4"), "existing recording");
  const history = await runtime.projects.history(project);
  await history.checkpoint();
  const projectUrl = `${baseUrl}/api/cutroom/projects/${project.id}`;
  const step = (direction: "undo" | "redo") =>
    runtime.app.request(`${projectUrl}/history/${direction}`, {
      method: "POST",
      headers: { Origin: baseUrl },
    });

  expect(await send([first, second])).toEqual({
    files: ["assets/recording 2.mp4", "assets/track.wav"],
  });
  expect((await stat(assets("recording 2.mp4"))).ino).toBe(
    (await stat(first)).ino,
  );
  expect((await stat(assets("track.wav"))).ino).toBe((await stat(second)).ino);
  expect(await readFile(assets("recording.mp4"), "utf8")).toBe(
    "existing recording",
  );
  expect(
    history.list().filter((entry) => entry.label.startsWith("Import ")),
  ).toHaveLength(1);

  expect((await step("undo")).status).toBe(200);
  expect(await mediaNames()).toEqual(["fonts", "recording.mp4", "vendor"]);
  expect(await readFile(first, "utf8")).toBe("new recording");
  expect((await step("redo")).status).toBe(200);
  expect(await mediaNames()).toEqual([
    "fonts",
    "recording 2.mp4",
    "recording.mp4",
    "track.wav",
    "vendor",
  ]);
  expect(await readFile(assets("recording 2.mp4"), "utf8")).toBe(
    "new recording",
  );
  expect(await readFile(assets("track.wav"), "utf8")).toBe("new track");
});

test("a different filesystem copies the complete file and reports progress", async () => {
  const source = join(await otherFilesystem(), "recording.mov");
  const content = Buffer.alloc(3 * 1024 * 1024, 17);
  await writeFile(source, content);
  const progress: number[] = [];

  expect(
    await requestMediaImport(socket, project.id, [source], {
      signal: new AbortController().signal,
      progress: ({ copied }) => progress.push(copied),
    }),
  ).toEqual({ files: ["assets/recording.mov"] });
  expect(progress[0]).toBe(0);
  expect(progress.at(-1)).toBe(content.length);
  expect(await readFile(assets("recording.mov"))).toEqual(content);
  expect(await mediaNames()).toEqual(["fonts", "recording.mov", "vendor"]);
});

test("cancelling partway through a copy leaves neither the file nor staged links", async () => {
  const source = join(await otherFilesystem(), "cross-device.mov");
  const local = join(root, "same-device.mp4");
  await writeFile(source, Buffer.alloc(4 * 1024 * 1024, 8));
  await writeFile(local, "same-device recording");
  const controller = new AbortController();
  let bytesAtCancel = 0;
  await expect(
    importMedia(
      runtime.projects,
      createReviewService(runtime.projects),
      project,
      {
        sources: await Promise.all([openIdentity(local), openIdentity(source)]),
      },
      {
        signal: controller.signal,
        progress: ({ copied, total }) => {
          if (copied > 0 && copied < total) {
            bytesAtCancel = copied;
            controller.abort();
          }
        },
      },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(bytesAtCancel).toBeGreaterThan(0);
  expect(await mediaNames()).toEqual(["fonts", "vendor"]);
  expect((await stat(local)).nlink).toBe(1);
  expect((await runtime.projects.history(project)).list()).toHaveLength(0);
});

test("free space is checked before a cross-device copy starts", async () => {
  const source = join(await otherFilesystem(), "no-room.mp4");
  await writeFile(source, "");
  const disk = await statfs(assets(), { bigint: true });
  await truncate(source, Number((disk.bavail + 1n) * disk.bsize));
  let progressed = false;
  await expect(
    requestMediaImport(socket, project.id, [source], {
      signal: new AbortController().signal,
      progress: () => {
        progressed = true;
      },
    }),
  ).rejects.toThrow("not enough free space");
  expect(progressed).toBe(false);
  expect(await mediaNames()).toEqual(["fonts", "vendor"]);
});

test("the desktop cancel request confirms cleanup before the import returns", async () => {
  const source = join(await otherFilesystem(), "cancel-from-desktop.mp4");
  // Keep enough reads outstanding for a separate socket request to arrive during the copy.
  await writeFile(source, "");
  await truncate(source, 128 * 1024 * 1024);
  const id = crypto.randomUUID();
  let cancelling: Promise<void> | undefined;
  const result = await requestMediaImport(socket, project.id, [source], {
    id,
    signal: new AbortController().signal,
    progress: () => {
      cancelling ??= cancelMediaImport(socket, project.id, id);
    },
  });
  await cancelling;
  expect(cancelling).toBeDefined();
  expect(result).toBeNull();
  expect(await mediaNames()).toEqual(["fonts", "vendor"]);
});

test("absolute regular media only, with no links escaping through the project's assets folder", async () => {
  const source = join(root, "original.mp4");
  const alias = join(root, "linked.mp4");
  const fifo = join(root, "pipe.mp4");
  await writeFile(source, "footage");
  await symlink(source, alias);
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  await expect(send([alias])).rejects.toThrow("regular file");
  await expect(send([fifo])).rejects.toThrow("regular file");
  await expect(send(["original.mp4"])).rejects.toThrow("full path");
  await expect(send([join(root, "code.ts")])).rejects.toThrow("full path");
  const direct = await fetch(
    `${baseUrl}/projects/${project.id}/media/import/${crypto.randomUUID()}`,
    {
      unix: socketDir.address,
      method: "POST",
      body: JSON.stringify({ sources: [{ path: alias, identity: "forged" }] }),
    },
  );
  expect(await direct.text()).toContain("must be a regular file");
  if (process.getuid?.() !== 0) {
    await chmod(source, 0);
    await expect(send([source])).rejects.toThrow("Cannot read");
    await chmod(source, 0o600);
  }

  const external = join(root, "external");
  await mkdir(external);
  await rename(assets(), join(project.path, "previous-assets"));
  await symlink(external, assets());
  await expect(send([source])).rejects.toThrow("outside the project");
  expect(await readdir(external)).toEqual([]);
});

test("the stdio MCP bridge imports media while public HTTP callers cannot name source paths", async () => {
  const source = join(root, "from-agent.wav");
  await writeFile(source, "agent recording");
  const client = new Client({ name: "Media import test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "../src/server/mcp/stdio.ts")],
    env: { CUTROOM_URL: baseUrl, CUTROOM_DATA_DIR: data },
  });
  const call = (mcp: Client) =>
    mcp.callTool({
      name: "media_import",
      arguments: { projectId: project.id, paths: [source] },
    });

  const publicHttp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: runtime.app.fetch,
  });
  const http = new Client({ name: "HTTP-only import test", version: "1" });
  try {
    await http.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", publicHttp.url)),
    );
    const refused = await call(http);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("stdio MCP bridge");

    const fabricated = await runtime.app.request(
      `${baseUrl}/api/cutroom/projects/${project.id}/media/import/${crypto.randomUUID()}`,
      {
        method: "POST",
        headers: { Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ sources: [await openIdentity(source)] }),
      },
    );
    expect(fabricated.status).toBe(404);
    expect(await mediaNames()).toEqual(["fonts", "vendor"]);

    await client.connect(transport);
    expect((await call(client)).structuredContent).toEqual({
      result: { files: ["assets/from-agent.wav"] },
    });
    expect(await readFile(assets("from-agent.wav"), "utf8")).toBe(
      "agent recording",
    );
    const entry = (await runtime.projects.history(project)).list().at(-1);
    expect(entry?.who).toEqual({ kind: "agent", name: "Media import test" });
  } finally {
    await client.close();
    await http.close();
    await publicHttp.stop(true);
  }
});
