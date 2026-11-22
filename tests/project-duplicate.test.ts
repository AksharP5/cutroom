import { afterEach, beforeEach, expect, test } from "bun:test";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createApp } from "../src/server/app";
import { browserExecutable } from "../src/server/hyperframes/render";
import { copyName } from "../src/server/projects/duplicate";
import {
  DuplicateJobSchema,
  ProjectSchema,
  SourceSchema,
} from "../src/shared/project";
import type { DuplicateJob, Project } from "../src/shared/project";

const HistorySchema = z.object({
  entries: z.array(z.object({ id: z.string(), label: z.string() })),
});
const origin = "http://127.0.0.1:4317";

let root: string;
let runtime: Awaited<ReturnType<typeof createApp>>;
const start = () =>
  createApp({
    dataDir: join(root, "data"),
    projectsDir: join(root, "projects"),
  });
const request = (path: string, method = "GET", body?: unknown) =>
  runtime.app.request(`${origin}/api/cutroom${path}`, {
    method,
    headers: { origin, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const history = async (project: Project) =>
  HistorySchema.parse(
    await (await request(`/projects/${project.id}/history`)).json(),
  ).entries;
const editTitle = async (project: Project, text: string) => {
  const source = SourceSchema.parse(
    await (await request(`/projects/${project.id}/source`)).json(),
  );
  const content = source.content.replace(
    /(<div id="headline"[^>]*>)[^<]*/,
    `$1${text}`,
  );
  const saved = await request(`/projects/${project.id}/source`, "PUT", {
    content,
    expectedVersion: source.version,
  });
  expect(saved.status).toBe(200);
  return content;
};
const duplicate = async (project: Project) => {
  const started = await request(`/projects/${project.id}/duplicate`, "POST");
  expect(started.status).toBe(202);
  let job: DuplicateJob = DuplicateJobSchema.parse(await started.json());
  while (job.state.status === "running") {
    await Bun.sleep(5);
    job = DuplicateJobSchema.parse(
      await (await request(`/duplicates/${job.id}`)).json(),
    );
  }
  return job;
};
const copyOf = async (job: DuplicateJob) => {
  expect(job.state).toEqual({ status: "done", progress: 1 });
  return ProjectSchema.parse(
    await (await request(`/projects/${job.projectId}`)).json(),
  );
};
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  // /var/tmp is a real disk, where clones and hard links behave as they do for projects.
  root = await mkdtemp("/var/tmp/cutroom-duplicate.test-");
  runtime = await start();
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

test("a copy starts its own history, and an edit and undo in it leave the original's alone", async () => {
  const original = await runtime.projects.create({ name: "Rough cut" });
  const edited = await editTitle(original, "First pass");
  const before = await history(original);
  expect(before.length).toBeGreaterThan(0);

  const copy = await copyOf(await duplicate(original));
  expect(copy.name).toBe("Rough cut copy");
  expect(dirname(copy.path)).toBe(dirname(original.path));
  expect(await readFile(join(copy.path, "index.html"), "utf8")).toBe(edited);
  expect(await history(copy)).toEqual([]);
  expect(
    await readFile(join(copy.path, ".hyperframes", "history-id"), "utf8"),
  ).not.toBe(
    await readFile(join(original.path, ".hyperframes", "history-id"), "utf8"),
  );

  await editTitle(copy, "Experiment");
  expect(await history(copy)).toHaveLength(1);
  expect(
    (await request(`/projects/${copy.id}/history/undo`, "POST")).status,
  ).toBe(200);
  expect(await readFile(join(copy.path, "index.html"), "utf8")).toBe(edited);
  expect(await history(original)).toEqual(before);
  expect(await readFile(join(original.path, "index.html"), "utf8")).toBe(
    edited,
  );
});

test("media is cloned or linked and identical; the original's outputs, trash and outside links stay behind", async () => {
  const original = await runtime.projects.create({ name: "Footage" });
  const at = (path: string) => join(original.path, path);
  const write = async (path: string, content: string | Uint8Array) => {
    await mkdir(dirname(at(path)), { recursive: true });
    await writeFile(at(path), content);
  };
  const footage = crypto.getRandomValues(new Uint8Array(4 * 1024 * 1024));
  await write("assets/clip.mp4", footage);
  await write(".cutroom/view.json", "{}\n");
  await write(".cutroom/ids.json", "{}\n");
  await write(".cutroom/review.json", "{}\n");
  await write(".cutroom/attachments/note.png", "png");
  await write(".cutroom/review-ledger.json", "{}\n");
  await write(".cutroom/history-skips.json", "[]\n");
  await write(".cutroom/renders/Footage.mp4", "render");
  await write(".cutroom/renders.json", "{}\n");
  await write(".cutroom/cache/proxy/proxy.mp4", "proxy");
  await write(".cutroom/cache/.media-scratch/part.mp4", "partial");
  await write("trash/old.mp4", "removed");
  await write(".thumbnails/index.jpg", "thumb");
  await symlink("clip.mp4", at("assets/alias.mp4"));
  await symlink("../../outside.mp4", at("assets/escape.mp4"));
  await symlink("/etc/hostname", at("assets/absolute.mp4"));

  const copy = await copyOf(await duplicate(original));
  const copied = (path: string) => join(copy.path, path);

  expect(new Uint8Array(await readFile(copied("assets/clip.mp4")))).toEqual(
    footage,
  );
  const clones = await copyFile(
    at("assets/clip.mp4"),
    join(root, "probe"),
    constants.COPYFILE_FICLONE_FORCE,
  ).then(
    () => true,
    () => false,
  );
  // A clone is its own file sharing the original's blocks; without clones, a hard link.
  const [source, target] = await Promise.all([
    stat(at("assets/clip.mp4")),
    stat(copied("assets/clip.mp4")),
  ]);
  expect(target.ino === source.ino).toBe(!clones);
  if (clones)
    expect(
      await readFile(copied(".cutroom/cache/proxy/proxy.mp4"), "utf8"),
    ).toBe("proxy");
  else
    expect(await exists(copied(".cutroom/cache/proxy/proxy.mp4"))).toBe(false);

  for (const kept of [
    "cutroom.json",
    ".cutroom/view.json",
    ".cutroom/ids.json",
    ".cutroom/review.json",
    ".cutroom/attachments/note.png",
    "assets/vendor/gsap.min.js",
  ])
    expect(await readFile(copied(kept), "utf8")).toBe(
      await readFile(at(kept), "utf8"),
    );
  expect(await readFile(copied("assets/alias.mp4"))).toEqual(
    await readFile(at("assets/clip.mp4")),
  );
  for (const left of [
    ".cutroom/review-ledger.json",
    ".cutroom/history-skips.json",
    ".cutroom/renders",
    ".cutroom/renders.json",
    ".cutroom/cache/.media-scratch",
    "trash",
    ".thumbnails",
    "assets/escape.mp4",
    "assets/absolute.mp4",
  ])
    expect(await exists(copied(left))).toBe(false);
  expect(
    (await readdir(dirname(copy.path))).filter((name) =>
      name.startsWith(".cutroom-duplicate-"),
    ),
  ).toEqual([]);
});

test("copies are named after the original and never take a name in use", async () => {
  const original = await runtime.projects.create({ name: "Promo" });
  const first = await copyOf(await duplicate(original));
  const second = await copyOf(await duplicate(original));
  const ofCopy = await copyOf(await duplicate(first));
  expect([first.name, second.name, ofCopy.name]).toEqual([
    "Promo copy",
    "Promo copy 2",
    "Promo copy copy",
  ]);
  expect(new Set([first.path, second.path, ofCopy.path]).size).toBe(3);
  expect(copyName("x".repeat(120), [])).toBe(`${"x".repeat(115)} copy`);
});

test("agents can duplicate but not cancel a duplicate", async () => {
  const original = await runtime.projects.create({ name: "Agent's" });
  const job = await duplicate(original);
  const cancel = await runtime.app.request(
    `${origin}/api/cutroom/duplicates/${job.id}/cancel`,
    { method: "POST", headers: { origin, "x-cutroom-agent": "external" } },
  );
  expect(cancel.status).toBe(403);
});

test("a duplicate killed mid-copy leaves nothing on the list, and the next start removes its staging folder", async () => {
  const original = await runtime.projects.create({ name: "Crash" });
  // Enough files that the copy is still running when it is killed.
  await mkdir(join(original.path, "scenes"));
  await Promise.all(
    Array.from({ length: 4000 }, (_, index) =>
      writeFile(
        join(original.path, "scenes", `${index}.html`),
        `<p>${index}</p>`,
      ),
    ),
  );
  await runtime.dispose();

  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { createApp } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/app.ts"))});
      const runtime = await createApp(${JSON.stringify({ dataDir: join(root, "data"), projectsDir: join(root, "projects") })});
      await runtime.app.request(${JSON.stringify(`${origin}/api/cutroom/projects/${original.id}/duplicate`)}, { method: "POST", headers: { origin: ${JSON.stringify(origin)} } });
      await new Promise(() => {});`,
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  const parent = dirname(original.path);
  const staging = async () =>
    (await readdir(parent)).filter((name) =>
      name.startsWith(".cutroom-duplicate-"),
    );
  const deadline = Date.now() + 20_000;
  while (
    !(await staging()).length ||
    (await readdir(join(parent, (await staging())[0]!)).catch(() => []))
      .length < 3
  ) {
    if (Date.now() > deadline) throw new Error("The copy never started.");
    await Bun.sleep(1);
  }
  child.kill("SIGKILL");
  await child.exited;

  const [left] = await staging();
  expect(left).toMatch(new RegExp(`^\\.cutroom-duplicate-${child.pid}-`));
  // Folders the sweep must not touch: one without the marker, and one of a live process.
  const unmarked = `.cutroom-duplicate-${child.pid}-00000000-0000-4000-8000-000000000000`;
  const live = `.cutroom-duplicate-${process.pid}-00000000-0000-4000-8000-000000000001`;
  await mkdir(join(parent, unmarked));
  await mkdir(join(parent, live));
  await writeFile(join(parent, live, ".cutroom-duplicate"), "");

  runtime = await start();
  expect((await runtime.projects.list()).map(({ id }) => id)).toEqual([
    original.id,
  ]);
  expect((await staging()).toSorted()).toEqual([live, unmarked].toSorted());
  expect(await readdir(parent)).toHaveLength(3);
}, 60_000);

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "a project cannot be duplicated while it exports",
  async () => {
    const project = await runtime.projects.create({ name: "Exporting" });
    const started = await runtime.app.request(
      `${origin}/api/projects/${project.id}/render`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          format: "mp4",
          quality: "draft",
          fps: "30",
          cutroom: { filename: "Exporting.mp4", directory: root, range: null },
        }),
      },
    );
    expect(started.status).toBe(200);
    const { jobId } = z
      .object({ jobId: z.string() })
      .parse(await started.json());
    const refused = await request(`/projects/${project.id}/duplicate`, "POST");
    expect(refused.status).toBe(409);
    expect(
      z.object({ error: z.string() }).parse(await refused.json()).error,
    ).toContain("then duplicate it");
    await runtime.app.request(`${origin}/api/render/${jobId}/cancel`, {
      method: "POST",
      headers: { origin },
    });
  },
  60_000,
);
