import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "../src/server/app";
import { browserExecutable } from "../src/server/hyperframes/render";
import { createProjectStore } from "../src/server/projects/store";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { projectFixture } from "./project-fixture";
import { addStarterClips } from "./starter-clips";

const HistorySchema = z.object({
  entries: z.array(z.object({ id: z.string(), label: z.string() })),
});

test("a renamed project keeps its new name after a restart, in the same folder", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "Rough cut" });
    await addStarterClips(project);
    for (const name of ["", "Bell\u0007", "Cut\nv2", "abc‮gpj.mp4"])
      expect(
        (await fixture.request(`/projects/${project.id}`, "PATCH", { name }))
          .status,
      ).toBe(400);
    const renamed = await fixture.request(`/projects/${project.id}`, "PATCH", {
      name: "  Final cut  ",
    });
    expect(renamed.status).toBe(200);
    expect(ProjectSchema.parse(await renamed.json())).toMatchObject({
      id: project.id,
      name: "Final cut",
      path: project.path,
    });
    await fixture.store.close();
    const restarted = await createProjectStore({
      dataDir: join(fixture.directory, "data"),
      projectsDir: join(fixture.directory, "projects"),
    });
    try {
      expect(await restarted.list()).toMatchObject([
        { id: project.id, name: "Final cut", path: project.path },
      ]);
    } finally {
      await restarted.close();
    }
  } finally {
    await fixture.close();
  }
});

test("removing a project keeps its folder and history, and importing the folder again restores the history", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "Keep me" });
    await addStarterClips(project);
    const original = SourceSchema.parse(
      await (await fixture.request(`/projects/${project.id}/source`)).json(),
    );
    const content = original.content.replace(
      "Drop media in, or ask your agent to start.",
      "An edit worth keeping.",
    );
    expect(
      (
        await fixture.request(`/projects/${project.id}/source`, "PUT", {
          content,
          expectedVersion: original.version,
        })
      ).status,
    ).toBe(200);
    const before = HistorySchema.parse(
      await (await fixture.request(`/projects/${project.id}/history`)).json(),
    );
    expect(before.entries.length).toBeGreaterThan(0);
    const files = (await readdir(project.path)).toSorted();
    // Closing a history releases its owner lock; everything it recorded stays.
    const historyFiles = async () =>
      (
        await readdir(join(fixture.directory, "data", "history"), {
          recursive: true,
        })
      )
        .filter((file) => !file.includes("owner.pid"))
        .toSorted();
    const recorded = await historyFiles();

    expect(
      (await fixture.request(`/projects/${project.id}`, "DELETE")).status,
    ).toBe(200);
    expect(await fixture.store.list()).toEqual([]);
    expect(
      (await fixture.request(`/projects/${project.id}/source`)).status,
    ).toBe(404);
    expect((await readdir(project.path)).toSorted()).toEqual(files);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      content,
    );
    expect(await historyFiles()).toEqual(recorded);

    const imported = ProjectSchema.parse(
      await (
        await fixture.request("/projects/import", "POST", {
          path: project.path,
        })
      ).json(),
    );
    expect(imported.id).not.toBe(project.id);
    expect(
      HistorySchema.parse(
        await (
          await fixture.request(`/projects/${imported.id}/history`)
        ).json(),
      ).entries,
    ).toEqual(before.entries);
    expect(
      (await fixture.request(`/projects/${imported.id}/history/undo`, "POST"))
        .status,
    ).toBe(200);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      original.content,
    );
  } finally {
    await fixture.close();
  }
});

test("agents cannot remove a project", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "Owner only" });
    await addStarterClips(project);
    const response = await fixture.app.request(
      `/api/cutroom/projects/${project.id}`,
      { method: "DELETE", headers: { "x-cutroom-agent": "external" } },
    );
    expect(response.status).toBe(403);
    expect(await fixture.store.list()).toMatchObject([{ id: project.id }]);
  } finally {
    await fixture.close();
  }
});

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "a project cannot be removed while it exports",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-remove-export-"));
    const runtime = await createApp({
      dataDir: join(root, "data"),
      projectsDir: join(root, "projects"),
    });
    const origin = "http://127.0.0.1:4317";
    const request = (path: string, method = "GET", body?: unknown) =>
      runtime.app.request(`${origin}/api${path}`, {
        method,
        headers: { origin, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    try {
      const project = await runtime.projects.create({ name: "Exporting" });
      await addStarterClips(project);
      const started = await request(`/projects/${project.id}/render`, "POST", {
        format: "mp4",
        quality: "draft",
        fps: "30",
        cutroom: { filename: "Exporting.mp4", directory: root, range: null },
      });
      expect(started.status).toBe(200);
      const { jobId } = z
        .object({ jobId: z.string() })
        .parse(await started.json());

      const refused = await request(
        `/cutroom/projects/${project.id}`,
        "DELETE",
      );
      expect(refused.status).toBe(409);
      expect(
        z.object({ error: z.string() }).parse(await refused.json()).error,
      ).toContain('"Exporting" is exporting');
      expect(await runtime.projects.list()).toMatchObject([{ id: project.id }]);

      expect((await request(`/render/${jobId}/cancel`, "POST")).status).toBe(
        200,
      );
      expect(
        (await request(`/cutroom/projects/${project.id}`, "DELETE")).status,
      ).toBe(200);
      expect(await runtime.projects.list()).toEqual([]);
      expect((await stat(join(project.path, "index.html"))).isFile()).toBe(
        true,
      );
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
