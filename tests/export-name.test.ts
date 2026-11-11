import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExportDestinationSchema } from "../src/shared/export";
import { projectFixture } from "./project-fixture";

test("export defaults read the chosen folder, fill numbering gaps and never reserve a file", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "Cut" });
    const defaults = async (directory?: string) => {
      const query = new URLSearchParams({ filename: "Cut.mp4" });
      if (directory) query.set("directory", directory);
      const response = await fixture.request(
        `/projects/${project.id}/export-defaults?${query}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return ExportDestinationSchema.parse(await response.json());
    };
    const initial = await defaults();
    expect(initial).toEqual({
      directory: join(project.path, ".cutroom/renders"),
      filename: "Cut.mp4",
    });
    expect(existsSync(initial.directory)).toBe(false);
    await mkdir(initial.directory, { recursive: true });
    await writeFile(join(initial.directory, "Cut.mp4"), "first export");
    expect((await defaults()).filename).toBe("Cut 2.mp4");
    // A directory or a dangling link takes a name just as surely as a regular file.
    await mkdir(join(initial.directory, "Cut 2.mp4"));
    await symlink("missing", join(initial.directory, "Cut 4.mp4"));
    expect((await defaults()).filename).toBe("Cut 3.mp4");
    expect(existsSync(join(initial.directory, "Cut 3.mp4"))).toBe(false);

    const chosen = join(fixture.directory, "chosen");
    await mkdir(chosen);
    expect((await defaults(chosen)).filename).toBe("Cut.mp4");
    await writeFile(join(chosen, "Cut.mp4"), "another export");
    expect((await defaults(chosen)).filename).toBe("Cut 2.mp4");
    const invalid = await fixture.request(
      `/projects/${project.id}/export-defaults?filename=Cut.mp4&directory=relative`,
    );
    expect(invalid.status).toBe(400);
  } finally {
    await fixture.close();
  }
});
