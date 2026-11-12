import { expect, test } from "bun:test";
import { lintProject } from "@hyperframes/core/lint";
import {
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  AnnotationSchema,
  ProjectDocumentSchema,
  ProjectSchema,
  SourceSchema,
} from "../src/shared/project";
import { projectPath } from "../src/server/projects/path";
import { projectFixture } from "./project-fixture";

test("a removed project folder refuses paths that allow missing files", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "Removed folder" });
    await rm(project.path, { recursive: true });
    await expect(
      projectPath(project, "scenes/new.html", true),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await fixture.close();
  }
});

test("new projects ship a valid, self-contained Instrument Sans composition", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "A & B <cut>" });
    const source = await readFile(join(project.path, "index.html"), "utf8");
    expect(source).toContain("A &amp; B &lt;cut&gt;");
    expect(source).toContain("Drop media in, or ask your agent to start.");
    expect(
      await readFile(
        join(project.path, "assets/fonts/InstrumentSans-var.woff2"),
      ),
    ).toEqual(
      await readFile(
        new URL(
          "../src/client/fonts/InstrumentSans-var.woff2",
          import.meta.url,
        ),
      ),
    );
    expect(
      await readFile(join(project.path, "assets/fonts/LICENSE.txt"), "utf8"),
    ).toContain("SIL OPEN FONT LICENSE");
    const lint = await lintProject(project.path);
    expect(lint.results.flatMap(({ result }) => result.findings)).toEqual([]);
    await fixture.store.importProject({ path: project.path });
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      source,
    );
  } finally {
    await fixture.close();
  }
});

test("projects list most recently edited first", async () => {
  const fixture = await projectFixture();
  try {
    const names = async () =>
      (await fixture.store.list()).map((project) => project.name);
    const older = await fixture.store.create({ name: "Older" });
    await Bun.sleep(5);
    await fixture.store.create({ name: "Newer" });
    expect(await names()).toEqual(["Newer", "Older"]);
    await Bun.sleep(5);
    const source = SourceSchema.parse(
      await (await fixture.request(`/projects/${older.id}/source`)).json(),
    );
    const edited = await fixture.request(
      `/projects/${older.id}/source`,
      "PUT",
      {
        path: "index.html",
        content: source.content.replace("Older", "Older, edited"),
        expectedVersion: source.version,
      },
    );
    expect(edited.status).toBe(200);
    expect(await names()).toEqual(["Older", "Newer"]);
  } finally {
    await fixture.close();
  }
});

test("source writes require the exact version and remain undoable", async () => {
  const fixture = await projectFixture();
  try {
    const project = ProjectSchema.parse(
      await (
        await fixture.request("/projects", "POST", { name: "A real project" })
      ).json(),
    );
    const original = SourceSchema.parse(
      await (await fixture.request(`/projects/${project.id}/source`)).json(),
    );
    const content = original.content.replace(
      "Drop media in, or ask your agent to start.",
      "A revised composition.",
    );
    const saved = await fixture.request(
      `/projects/${project.id}/source`,
      "PUT",
      { content, expectedVersion: original.version },
    );
    expect(saved.status).toBe(200);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toContain(
      "A revised composition.",
    );
    const stale = await fixture.request(
      `/projects/${project.id}/source`,
      "PUT",
      { content: "stale", expectedVersion: original.version },
    );
    expect(stale.status).toBe(409);
    const undo = await fixture.request(
      `/projects/${project.id}/history/undo`,
      "POST",
    );
    expect(undo.status).toBe(200);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      original.content,
    );
    expect(
      (await fixture.request(`/projects/${project.id}/history/redo`, "POST"))
        .status,
    ).toBe(200);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      content,
    );
  } finally {
    await fixture.close();
  }
});

test("annotations persist with source history and metadata rejects stale replacement", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "Review" });
    const response = await fixture.request(
      `/projects/${project.id}/annotations`,
      "POST",
      {
        kind: "drawing",
        compositionPath: "scenes/intro.html",
        body: "Move the title",
        time: 2,
        point: { x: 0.3, y: 0.4 },
        strokes: [
          {
            points: [
              { x: 0.2, y: 0.3 },
              { x: 0.4, y: 0.5 },
            ],
          },
        ],
      },
    );
    expect(response.status).toBe(201);
    const annotation = AnnotationSchema.parse(await response.json());
    const document = await fixture.store.document(project);
    expect(document.annotations[0]?.id).toBe(annotation.id);
    expect(
      (await fixture.request(`/projects/${project.id}/history/undo`, "POST"))
        .status,
    ).toBe(200);
    expect((await fixture.store.document(project)).annotations).toHaveLength(0);
    expect(
      (await fixture.request(`/projects/${project.id}/history/redo`, "POST"))
        .status,
    ).toBe(200);
    expect((await fixture.store.document(project)).annotations).toHaveLength(1);
    const updated = AnnotationSchema.parse(
      await (
        await fixture.request(
          `/projects/${project.id}/annotations/${annotation.id}`,
          "PATCH",
          { body: "Move the title left" },
        )
      ).json(),
    );
    expect(updated.body).toBe("Move the title left");
    expect(updated.kind).toBe("drawing");
    expect(updated.compositionPath).toBe("scenes/intro.html");
    expect(updated.strokes[0]?.points).toHaveLength(2);
    const read = await fixture.store.document(project);
    const external = { ...read, annotations: [] };
    await writeFile(
      join(project.path, "cutroom.json"),
      JSON.stringify(external),
    );
    await expect(fixture.store.writeDocument(project, read)).rejects.toThrow(
      "changed outside",
    );
    expect(
      ProjectDocumentSchema.parse(
        JSON.parse(await readFile(join(project.path, "cutroom.json"), "utf8")),
      ).annotations,
    ).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("project APIs reject traversal and symlinks outside the registered folder", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "Path boundary" });
    await writeFile(
      join(fixture.directory, "outside.txt"),
      "private test content",
    );
    await symlink(
      join(fixture.directory, "outside.txt"),
      join(project.path, "linked.txt"),
    );
    expect(
      (
        await fixture.request(
          `/projects/${project.id}/source?path=${encodeURIComponent("../outside.txt")}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (await fixture.request(`/projects/${project.id}/source?path=linked.txt`))
        .status,
    ).toBe(403);
    expect(
      (
        await fixture.request(
          `/projects/${project.id}/source?path=missing.html`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fixture.request("/projects/import", "POST", {
          path: project.path,
        })
      ).status,
    ).toBe(200);
    expect(await fixture.store.list()).toHaveLength(1);
    await unlink(join(project.path, "cutroom.json"));
    await symlink(
      join(fixture.directory, "outside.txt"),
      join(project.path, "cutroom.json"),
    );
    expect(
      (await fixture.request(`/projects/${project.id}/document`)).status,
    ).toBe(403);
  } finally {
    await fixture.close();
  }
});

test("project shutdown drains admitted edits and refuses new mutations", async () => {
  const fixture = await projectFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const project = await fixture.store.create({ name: "Shutdown ordering" });
    const saving = fixture.store.mutate(project, "Finish note", async () => {
      entered();
      await gate;
      const document = await fixture.store.document(project);
      document.annotations.push(
        AnnotationSchema.parse({
          id: "saved",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          kind: "comment",
          body: "Persist before shutdown",
          time: 0,
        }),
      );
      await fixture.store.writeDocument(project, document);
    });
    await started;
    const closing = fixture.store.close();
    await expect(
      fixture.store.mutate(project, "Too late", async () => {}),
    ).rejects.toThrow("shutting down");
    release();
    await saving;
    await closing;
    expect((await fixture.store.document(project)).annotations[0]?.body).toBe(
      "Persist before shutdown",
    );
  } finally {
    release();
    await fixture.close();
  }
});

test("last edited uses the newest composition or document mtime, not registry activity", async () => {
  const f = await projectFixture();
  try {
    const p = await f.store.create({ name: "File dates" });
    const html = join(p.path, "index.html");
    const document = join(p.path, "cutroom.json");
    await utimes(html, new Date("2024-01-01"), new Date("2024-01-01"));
    await utimes(document, new Date("2024-02-01"), new Date("2024-02-01"));
    expect((await f.store.list())[0]?.updatedAt).toBe(
      "2024-02-01T00:00:00.000Z",
    );
    await utimes(html, new Date("2024-03-01"), new Date("2024-03-01"));
    expect((await f.store.list())[0]?.updatedAt).toBe(
      "2024-03-01T00:00:00.000Z",
    );
    await unlink(document);
    expect((await f.store.list())[0]?.updatedAt).toBe(
      "2024-03-01T00:00:00.000Z",
    );
  } finally {
    await f.close();
  }
});
