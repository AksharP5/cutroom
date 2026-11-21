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

test("same-device imports keep their inode, use free names, and stay outside Undo", async () => {
  const first = join(root, "recording.mp4");
  const second = join(root, "track.wav");
  await writeFile(first, "new recording");
  await chmod(first, 0o600);
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
  expect((await stat(assets("recording 2.mp4"))).mode & 0o777).toBe(0o600);
  expect((await stat(assets("track.wav"))).ino).toBe((await stat(second)).ino);
  expect(await readFile(assets("recording.mp4"), "utf8")).toBe(
    "existing recording",
  );
  expect(
    history.list().filter((entry) => entry.label.startsWith("Import ")),
  ).toHaveLength(1);

  expect(await (await step("undo")).json()).toMatchObject({ entry: null });
  expect(await (await step("redo")).json()).toMatchObject({ entry: null });
  expect(await readFile(first, "utf8")).toBe("new recording");
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
  await chmod(source, 0o641);
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
  expect((await stat(assets("recording.mov"))).mode & 0o777).toBe(0o641);
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
  // Free space can grow before the request reaches the import worker.
  const { blocks, bsize } = await statfs(assets(), { bigint: true });
  await truncate(source, Number((blocks + 1n) * bsize));
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
  for (const control of ["\u202e", "\u0085", "\u2028", "\u2029"]) {
    const name = join(root, `footage${control}.mp4`);
    await writeFile(name, "footage");
    await expect(send([name])).rejects.toThrow("full path");
  }
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

test("startup reclaims abandoned copy files and hard-link names", async () => {
  const source = join(root, "original.mp4");
  const cross = join(await otherFilesystem(), "recording.mov");
  const legacy = `.import-${crypto.randomUUID()}.hf012345.tmp`;
  const live = `.import-${process.pid}-${crypto.randomUUID()}.hf012345.tmp`;
  const copySize = 4 * 1024 * 1024;
  await writeFile(source, "original bytes");
  await writeFile(cross, Buffer.alloc(copySize, 17));
  await writeFile(assets(live), "live import");
  await writeFile(assets(".import-notes.tmp"), "owner's note");

  // Start the real copy and hard-link staging, then kill its process after a chunk lands.
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { createApp } from "./src/server/app";
     import { importMedia } from "./src/server/projects/mediaImport";
     import { createReviewService } from "./src/server/projects/review";
     const { dataDir, projectsDir, id, sources } = JSON.parse(process.argv[1]);
     const { projects } = await createApp({ dataDir, projectsDir });
     let firstChunk = true;
     await importMedia(projects, createReviewService(projects), await projects.get(id), { sources }, {
       signal: new AbortController().signal,
       async progress({ copied }) {
         if (copied === 0) return;
         if (firstChunk) {
           firstChunk = false;
           await Bun.sleep(100);
           return;
         }
         process.kill(process.pid, "SIGKILL");
       },
     });`,
      JSON.stringify({
        dataDir: data,
        projectsDir: join(root, "projects"),
        id: project.id,
        sources: await Promise.all([openIdentity(source), openIdentity(cross)]),
      }),
    ],
    { cwd: join(import.meta.dir, ".."), timeout: 3000 },
  );
  expect(child.signalCode).toBe("SIGKILL");
  expect((await stat(source)).nlink).toBe(2);
  const staged = (await mediaNames()).filter(
    (name) => /^\.import-\d+-/.test(name) && name !== live,
  );
  expect(staged).toHaveLength(2);
  const sizes = await Promise.all(
    staged.map(async (name) => (await stat(assets(name))).size),
  );
  const partial = Math.max(...sizes);
  expect(partial).toBeGreaterThan("original bytes".length);
  expect(partial).toBeLessThan(copySize);

  await writeFile(assets(legacy), "old partial");

  await runtime.dispose();
  runtime = await createApp({
    dataDir: data,
    projectsDir: join(root, "projects"),
    port: 4936,
  });
  expect(await mediaNames()).toEqual([
    live,
    ".import-notes.tmp",
    "fonts",
    "vendor",
  ]);
  expect((await stat(source)).nlink).toBe(1);
  expect(await readFile(source, "utf8")).toBe("original bytes");
});

test("copy imports wait for the previous copy before checking disk and starting", async () => {
  const directory = await otherFilesystem();
  const first = join(directory, "first.mov");
  const second = join(directory, "second.mov");
  await writeFile(first, "first");
  await writeFile(second, "second");
  const source = async (path: string) => ({
    sources: [await openIdentity(path)],
  });
  const firstInput = await source(first);
  const secondInput = await source(second);
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const reviews = createReviewService(runtime.projects);
  const signal = new AbortController().signal;
  const copying = importMedia(runtime.projects, reviews, project, firstInput, {
    signal,
    progress: ({ copied }) => {
      if (copied === 0) {
        started.resolve();
        return resume.promise;
      }
    },
  });
  await started.promise;
  let began = false;
  const waiting = importMedia(runtime.projects, reviews, project, secondInput, {
    signal,
    progress: () => {
      began = true;
    },
  });
  try {
    // A concurrent hard link still publishes while both copies are pending.
    const local = join(root, "local.mov");
    await writeFile(local, "local");
    expect(await send([local])).toEqual({ files: ["assets/local.mov"] });
    expect(began).toBe(false);
    expect(await mediaNames()).toEqual(["fonts", "local.mov", "vendor"]);
  } finally {
    resume.resolve();
    await Promise.all([copying, waiting]);
  }
  expect(began).toBe(true);
  expect(await mediaNames()).toEqual([
    "first.mov",
    "fonts",
    "local.mov",
    "second.mov",
    "vendor",
  ]);
});

test("a duplicate job cannot replace an active import", async () => {
  const source = join(await otherFilesystem(), "recording.mp4");
  await writeFile(source, Buffer.alloc(4 * 1024 * 1024));
  const endpoint = `${baseUrl}/projects/${project.id}/media/import/${crypto.randomUUID()}`;
  const body = JSON.stringify({ sources: [await openIdentity(source)] });
  const start = () =>
    runtime.mediaImport.fetch(new Request(endpoint, { method: "POST", body }));
  const first = await start();
  const duplicate = await start();
  expect(duplicate.status).toBe(409);
  expect(await first.text()).toContain('"files":["assets/recording.mp4"]');
  expect(await mediaNames()).toEqual(["fonts", "recording.mp4", "vendor"]);
});

test("editing, removing, undoing and redoing imported media preserve the original bytes", async () => {
  const source = join(root, "logo.svg");
  const original =
    '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';
  const edited = original.replace('r="5"', 'r="8"');
  await writeFile(source, original);
  await send([source]);
  expect((await stat(assets("logo.svg"))).ino).toBe((await stat(source)).ino);

  const endpoint = `${baseUrl}/api/cutroom/projects/${project.id}`;
  const request = (path: string, method: string, body?: unknown) =>
    runtime.app.request(endpoint + path, {
      method,
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const { version } = await (
    await request("/source?path=assets/logo.svg", "GET")
  ).json();
  expect(
    (
      await request("/source", "PUT", {
        path: "assets/logo.svg",
        expectedVersion: version,
        content: edited,
      })
    ).status,
  ).toBe(200);
  expect(await readFile(assets("logo.svg"), "utf8")).toBe(edited);
  expect(await readFile(source, "utf8")).toBe(original);

  expect(
    (await request("/media/remove", "POST", { path: "assets/logo.svg" }))
      .status,
  ).toBe(200);
  expect(await readFile(join(project.path, "trash", "logo.svg"), "utf8")).toBe(
    edited,
  );
  expect(await readFile(source, "utf8")).toBe(original);
  const step = async (direction: "undo" | "redo") => {
    expect((await request(`/history/${direction}`, "POST")).status).toBe(200);
    expect(await readFile(source, "utf8")).toBe(original);
  };

  await step("undo");
  expect(await readFile(assets("logo.svg"), "utf8")).toBe(edited);
  await step("undo");
  expect(await readFile(assets("logo.svg"), "utf8")).toBe(original);
  expect(await (await request("/history/undo", "POST")).json()).toMatchObject({
    entry: null,
  });
  expect(await readFile(assets("logo.svg"), "utf8")).toBe(original);
  await step("redo");
  expect(await readFile(assets("logo.svg"), "utf8")).toBe(edited);
  await step("redo");
  expect(await readFile(join(project.path, "trash", "logo.svg"), "utf8")).toBe(
    edited,
  );
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
    port: Number(new URL(baseUrl).port),
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
    expect(entry?.who).toMatchObject({
      kind: "agent",
      name: "Media import test",
    });
    expect(entry?.who.key).toMatch(/^session:/);
    const listed = await client.callTool({
      name: "history_list",
      arguments: { projectId: project.id },
    });
    expect(listed.isError ?? false).toBe(false);
    expect(listed.structuredContent).toMatchObject({
      result: {
        entries: [{ id: entry?.id, mine: true, step: false }],
      },
    });
  } finally {
    await client.close();
    await http.close();
    await publicHttp.stop(true);
  }
});
