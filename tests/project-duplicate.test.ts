import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  constants,
  copyFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { createApp } from "../src/server/app";
import { browserExecutable } from "../src/server/hyperframes/render";
import { copyName } from "../src/server/projects/duplicate";
import { onCopyQueue } from "../src/server/projects/mediaImport";
import {
  DuplicateJobSchema,
  ProjectSchema,
  SourceSchema,
} from "../src/shared/project";
import type { DuplicateJob, Project } from "../src/shared/project";
import { addStarterClips } from "./starter-clips";

const HistorySchema = z.object({
  entries: z.array(z.object({ id: z.string(), label: z.string() })),
});
const ErrorSchema = z.object({ error: z.string() });
const origin = "http://127.0.0.1:4317";

/** Whether a disk clones files; without clones a duplicate byte-copies large files. */
const clones = (base: string) => {
  const probe = mkdtempSync(join(base, "cutroom-clone-probe-"));
  try {
    writeFileSync(join(probe, "a"), "a");
    copyFileSync(
      join(probe, "a"),
      join(probe, "b"),
      constants.COPYFILE_FICLONE_FORCE,
    );
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
};
// /var/tmp is a real disk (btrfs here, so clones); the temp folder is tmpfs here, with no clones.
const disks = [...new Set(["/var/tmp", tmpdir()])].map((base) => ({
  base,
  clones: clones(base),
}));

describe.each(disks)("on $base", ({ base, clones }) => {
  let root: string;
  let runtime: Awaited<ReturnType<typeof createApp>>;
  const start = () =>
    createApp({
      dataDir: join(root, "data"),
      projectsDir: join(root, "projects"),
    });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    runtime.app.request(`${origin}/api/cutroom${path}`, {
      method,
      headers: { origin, "content-type": "application/json", ...headers },
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
  const begin = async (project: Project) => {
    const started = await request(`/projects/${project.id}/duplicate`, "POST");
    expect(started.status).toBe(202);
    return DuplicateJobSchema.parse(await started.json());
  };
  const settle = async (job: DuplicateJob) => {
    while (["running", "cancelling"].includes(job.state.status)) {
      await Bun.sleep(5);
      job = DuplicateJobSchema.parse(
        await (await request(`/duplicates/${job.id}`)).json(),
      );
    }
    return job;
  };
  const duplicate = async (project: Project) => settle(await begin(project));
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
  const staging = async () =>
    (await readdir(join(root, "projects"))).filter((name) =>
      name.startsWith(".cutroom-duplicate-"),
    );
  const listed = async () =>
    (await runtime.projects.list()).map(({ id }) => id);

  beforeEach(async () => {
    root = await mkdtemp(join(base, "cutroom-duplicate.test-"));
    runtime = await start();
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  test("a copy starts its own history, and an edit and undo in it leave the original's alone", async () => {
    const original = await runtime.projects.create({ name: "Rough cut" });
    await addStarterClips(original);
    const edited = await editTitle(original, "First pass");
    const before = await history(original);
    expect(before.length).toBeGreaterThan(0);

    const copy = await copyOf(await duplicate(original));
    expect(copy.name).toBe("Rough cut copy");
    expect(dirname(copy.path)).toBe(dirname(original.path));
    expect(await readFile(join(copy.path, "index.html"), "utf8")).toBe(edited);
    expect(await history(copy)).toEqual([]);

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

  test("the copy's files are its own: writing media in place in the copy leaves the original's bytes", async () => {
    const original = await runtime.projects.create({ name: "Footage" });
    await addStarterClips(original);
    const footage = crypto.getRandomValues(new Uint8Array(4 * 1024 * 1024));
    await writeFile(join(original.path, "assets/clip.mp4"), footage);
    const copy = await copyOf(await duplicate(original));
    const copied = join(copy.path, "assets/clip.mp4");
    expect(new Uint8Array(await readFile(copied))).toEqual(footage);
    const [source, target] = await Promise.all([
      stat(join(original.path, "assets/clip.mp4")),
      stat(copied),
    ]);
    expect(target.ino).not.toBe(source.ino);

    // What `ffmpeg -y` or an agent's write tool does to a file it rewrites.
    const file = await open(copied, "r+");
    await file.write(Buffer.from("rewritten in place"), 0, undefined, 0);
    await file.close();
    expect(
      new Uint8Array(await readFile(join(original.path, "assets/clip.mp4"))),
    ).toEqual(footage);
  });

  test("the copy keeps its notes and settings and leaves the original's history, outputs, cache and escaping links", async () => {
    const original = await runtime.projects.create({ name: "Sidecars" });
    await addStarterClips(original);
    const at = (path: string) => join(original.path, path);
    const write = async (path: string, content: string | Uint8Array) => {
      await mkdir(dirname(at(path)), { recursive: true });
      await writeFile(at(path), content);
    };
    const archive = crypto.getRandomValues(new Uint8Array(3 * 1024 * 1024));
    await write("assets/footage.zip", archive);
    await write(".cutroom/view.json", "{}\n");
    await write(".cutroom/ids.json", "{}\n");
    await write(".cutroom/attachments/note.png", "png");
    await write(
      ".cutroom/review.json",
      JSON.stringify({
        schemaVersion: 1,
        changes: [
          {
            composition: "index.html",
            clipId: "headline",
            signature: "x",
            noteIds: [],
          },
        ],
        items: [],
      }),
    );
    for (const left of [
      ".cutroom/review-ledger.json",
      ".cutroom/review.v1.json",
      ".cutroom/history-skips.json",
      ".cutroom/renders/Sidecars.mp4",
      ".cutroom/renders.json",
      ".cutroom/view.json.0b1c.tmp",
      ".cutroom/cache/proxy/proxy.mp4",
      "trash/old.mp4",
      ".thumbnails/index.jpg",
    ])
      await write(left, "the original's");
    await symlink("./footage.zip", at("assets/alias.zip"));
    // Resolves inside the original only through its folder's own name, so a
    // verbatim copy would point back at the original from the sibling copy.
    await symlink(
      `../../${basename(original.path)}/assets/footage.zip`,
      at("assets/through-parent.zip"),
    );
    await symlink("../.cutroom/renders/Sidecars.mp4", at("assets/render.mp4"));
    await symlink("/etc/hostname", at("assets/absolute.txt"));
    await symlink("../../outside.txt", at("assets/escape.txt"));
    // Each link alone stays inside; followed together they leave the project.
    await mkdir(at("p/q"), { recursive: true });
    await symlink("../..", at("p/q/s"));
    await symlink("p/q/s/..", at("t"));

    const copy = await copyOf(await duplicate(original));
    const copied = (path: string) => join(copy.path, path);
    for (const kept of [
      "cutroom.json",
      ".cutroom/view.json",
      ".cutroom/ids.json",
      ".cutroom/attachments/note.png",
      "assets/vendor/gsap.min.js",
    ])
      expect(await readFile(copied(kept), "utf8")).toBe(
        await readFile(at(kept), "utf8"),
      );
    expect(
      new Uint8Array(await readFile(copied("assets/footage.zip"))),
    ).toEqual(archive);
    expect(new Uint8Array(await readFile(copied("assets/alias.zip")))).toEqual(
      archive,
    );
    await expect(lstat(copied("assets/render.mp4"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readlink(copied("assets/alias.zip"))).toBe("footage.zip");
    expect(await readlink(copied("assets/through-parent.zip"))).toBe(
      "footage.zip",
    );
    await writeFile(copied("assets/through-parent.zip"), "the copy's");
    expect(new Uint8Array(await readFile(at("assets/footage.zip")))).toEqual(
      archive,
    );
    expect(await exists(copied("p/q/s"))).toBe(true);
    // Rows for the original's ledger stay behind with it.
    expect(
      JSON.parse(await readFile(copied(".cutroom/review.json"), "utf8")),
    ).toEqual({ schemaVersion: 1, items: [] });
    for (const left of [
      ".cutroom/review-ledger.json",
      ".cutroom/review.v1.json",
      ".cutroom/history-skips.json",
      ".cutroom/renders",
      ".cutroom/renders.json",
      ".cutroom/view.json.0b1c.tmp",
      ".cutroom/cache",
      "trash",
      ".thumbnails",
      "assets/absolute.txt",
      "assets/escape.txt",
      "t",
    ])
      expect(await exists(copied(left))).toBe(false);
    expect(await staging()).toEqual([]);
  });

  test("copies are named after the original and never take a name in use", async () => {
    const original = await runtime.projects.create({ name: "Promo" });
    await addStarterClips(original);
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

  test("an agent duplicates only the project its turn runs in, sees only its own jobs, and cannot cancel", async () => {
    const own = await runtime.projects.create({ name: "Agent's" });
    await addStarterClips(own);
    const other = await runtime.projects.create({ name: "Someone else's" });
    await addStarterClips(other);
    const theirs = await duplicate(other);
    await runtime.review.beginTurn(own, {
      kind: "message",
      id: "turn",
      token: "agent-token",
    });
    const agent = { "x-cutroom-agent": "agent-token" };
    expect(
      (
        await request(
          `/projects/${other.id}/duplicate`,
          "POST",
          undefined,
          agent,
        )
      ).status,
    ).toBe(409);
    const started = await request(
      `/projects/${own.id}/duplicate`,
      "POST",
      undefined,
      agent,
    );
    expect(started.status).toBe(202);
    const mine = await settle(DuplicateJobSchema.parse(await started.json()));
    const seen = z
      .object({ jobs: z.array(DuplicateJobSchema) })
      .parse(
        await (await request("/duplicates", "GET", undefined, agent)).json(),
      );
    expect(seen.jobs.map(({ id }) => id)).toEqual([mine.id]);
    expect(
      (await request(`/duplicates/${theirs.id}`, "GET", undefined, agent))
        .status,
    ).toBe(404);
    expect(
      (await request(`/duplicates/${mine.id}/cancel`, "POST", undefined, agent))
        .status,
    ).toBe(403);
  });

  test("a large file that changes before it is copied fails the duplicate and leaves nothing behind", async () => {
    const original = await runtime.projects.create({ name: "Changing" });
    await addStarterClips(original);
    const big = join(original.path, "assets/take.mov");
    await writeFile(big, new Uint8Array(2 * 1024 * 1024));
    // Hold the copy queue so the change lands between the snapshot and the copy.
    const gate = Promise.withResolvers<void>();
    const held = onCopyQueue(() => gate.promise);
    const job = await begin(original);
    await truncate(big, 1024 * 1024);
    gate.resolve();
    await held;
    const failed = await settle(job);
    expect(failed.state.status).toBe("failed");
    expect(failed.state).toMatchObject({
      error:
        "assets/take.mov changed while the project was being copied. Try again.",
    });
    expect(await listed()).toEqual([original.id]);
    expect(await staging()).toEqual([]);
  });

  test("a file name that is not UTF-8 is refused by name, without a server path", async () => {
    const original = await runtime.projects.create({ name: "Bytes" });
    await addStarterClips(original);
    writeFileSync(
      Buffer.concat([
        Buffer.from(join(original.path, "assets/take")),
        Buffer.from([0xff, 0x2e, 0x6d, 0x70, 0x34]),
      ]),
      "x",
    );
    const refused = await request(`/projects/${original.id}/duplicate`, "POST");
    expect(refused.status).toBe(422);
    const { error } = ErrorSchema.parse(await refused.json());
    expect(error).toStartWith('"assets/take');
    expect(error).toContain("not valid UTF-8");
    expect(error).not.toContain("/proc/");
    expect(await staging()).toEqual([]);
  });

  test.skipIf(clones)(
    "without clones, large files are byte-copied with progress, and Cancel mid-copy removes the copy",
    async () => {
      const original = await runtime.projects.create({ name: "Big" });
      await addStarterClips(original);
      const footage = join(original.path, "assets/footage.mp4");
      await writeFile(footage, new Uint8Array(256 * 1024 * 1024).fill(7));
      let job = await begin(original);
      while (!(job.state.progress > 0 && job.state.progress < 1)) {
        expect(job.state.status).toBe("running");
        await Bun.sleep(1);
        job = DuplicateJobSchema.parse(
          await (await request(`/duplicates/${job.id}`)).json(),
        );
      }
      expect(
        (await request(`/duplicates/${job.id}/cancel`, "POST")).status,
      ).toBe(200);
      expect((await settle(job)).state.status).toBe("cancelled");
      expect(await staging()).toEqual([]);
      expect(await listed()).toEqual([original.id]);

      const copy = await copyOf(await duplicate(original));
      const [source, target] = await Promise.all([
        stat(footage),
        stat(join(copy.path, "assets/footage.mp4")),
      ]);
      expect(target.ino).not.toBe(source.ino);
      expect(target.size).toBe(source.size);
    },
    60_000,
  );

  test("a duplicate killed mid-copy leaves nothing on the list, and the next start removes only its abandoned staging folder", async () => {
    const original = await runtime.projects.create({ name: "Crash" });
    await addStarterClips(original);
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
    const parent = join(root, "projects");
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
    const [crashed] = await staging();
    expect(crashed).toMatch(new RegExp(`^\\.cutroom-duplicate-${child.pid}-`));

    const old = new Date(Date.now() - 11 * 60 * 1000);
    const marker = (pid: number, host = hostname()) =>
      JSON.stringify({ host, boot: null, pid });
    const kept: string[] = [];
    // Folders the sweep must leave: each fails one of its checks.
    const make = async (
      suffix: string,
      contents: (folder: string) => Promise<void>,
    ) => {
      const name = `.cutroom-duplicate-${child.pid}-00000000-0000-4000-8000-${suffix}`;
      await contents(join(parent, name));
      kept.push(name);
    };
    const marked = async (folder: string, text: string, age = old) => {
      await mkdir(folder);
      await writeFile(join(folder, ".cutroom-duplicate"), text);
      await utimes(join(folder, ".cutroom-duplicate"), age, age);
    };
    await make("000000000001", (folder) => mkdir(folder));
    await make("000000000002", (folder) =>
      marked(folder, marker(child.pid), new Date()),
    );
    await make("000000000003", (folder) =>
      marked(folder, marker(child.pid, "another-machine")),
    );
    await make("000000000004", async (folder) => {
      await mkdir(folder);
      await writeFile(join(root, "elsewhere"), marker(child.pid));
      await utimes(join(root, "elsewhere"), old, old);
      await symlink(
        join(root, "elsewhere"),
        join(folder, ".cutroom-duplicate"),
      );
    });
    await make("000000000005", async (folder) => {
      await marked(join(root, "real"), marker(child.pid));
      await symlink(join(root, "real"), folder);
    });
    const live = `.cutroom-duplicate-${process.pid}-00000000-0000-4000-8000-000000000006`;
    await marked(join(parent, live), marker(process.pid));
    kept.push(live);
    await utimes(join(parent, crashed!, ".cutroom-duplicate"), old, old);

    runtime = await start();
    expect(await listed()).toEqual([original.id]);
    expect((await staging()).toSorted()).toEqual(kept.toSorted());
    expect(await exists(join(root, "real", ".cutroom-duplicate"))).toBe(true);
  }, 60_000);

  test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
    "a project cannot be duplicated while it exports",
    async () => {
      const project = await runtime.projects.create({ name: "Exporting" });
      await addStarterClips(project);
      const started = await runtime.app.request(
        `${origin}/api/projects/${project.id}/render`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            format: "mp4",
            quality: "draft",
            fps: "30",
            cutroom: {
              filename: "Exporting.mp4",
              directory: root,
              range: null,
            },
          }),
        },
      );
      expect(started.status).toBe(200);
      const { jobId } = z
        .object({ jobId: z.string() })
        .parse(await started.json());
      const refused = await request(
        `/projects/${project.id}/duplicate`,
        "POST",
      );
      expect(refused.status).toBe(409);
      expect(ErrorSchema.parse(await refused.json()).error).toContain(
        "then duplicate it",
      );
      await runtime.app.request(`${origin}/api/render/${jobId}/cancel`, {
        method: "POST",
        headers: { origin },
      });
    },
    60_000,
  );
});
