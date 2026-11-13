import { expect, test } from "bun:test";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { SourceSchema } from "../src/shared/project";
import { projectFixture } from "./project-fixture";

test("source creation is exclusive, undoable, and uses the existing source path protections", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Create title" });
  const path = "compositions/nested/title.html";
  const content =
    '<template><div data-composition-id="title">Title</div></template>';
  const write = (
    path: string,
    expectedVersion: string | null = null,
    content = "changed",
  ) =>
    fixture.request(`/projects/${project.id}/source`, "PUT", {
      path,
      content,
      expectedVersion,
    });
  try {
    const created = await write(path, null, content);
    expect(created.status).toBe(200);
    const source = SourceSchema.parse(await created.json());
    expect(source.content).toBe(content);
    expect((await write(path)).status).toBe(409);
    expect(await readFile(join(project.path, path), "utf8")).toBe(content);
    expect((await write(path, "stale")).status).toBe(409);
    expect((await write(path, source.version, "updated")).status).toBe(200);
    expect(
      (await fixture.request(`/projects/${project.id}/history/undo`, "POST"))
        .status,
    ).toBe(200);
    expect(await readFile(join(project.path, path), "utf8")).toBe(content);
    expect(
      (await fixture.request(`/projects/${project.id}/history/undo`, "POST"))
        .status,
    ).toBe(200);
    expect(await Bun.file(join(project.path, path)).exists()).toBe(false);
    expect(
      (await fixture.request(`/projects/${project.id}/history/redo`, "POST"))
        .status,
    ).toBe(200);
    expect(await readFile(join(project.path, path), "utf8")).toBe(content);
    await mkdir(join(project.path, ".private"));
    await symlink(join(project.path, ".private"), join(project.path, "alias"));
    await symlink(fixture.directory, join(project.path, "outside"));
    for (const blocked of [
      "../escape.html",
      "outside/escape.html",
      "alias/title.html",
      ".cutroom/state.json",
      "compositions/.private/title.html",
      "package.json",
      "vite.config.js",
      "CLAUDE.md",
      "assets/movie.mp4",
    ])
      expect((await write(blocked)).status, blocked).toBe(403);
    expect((await write("compositions/missing.html", "stale")).status).toBe(
      404,
    );
  } finally {
    await fixture.close();
  }
});
