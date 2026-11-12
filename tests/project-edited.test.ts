import { expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectFixture } from "./project-fixture";

test("Home dates follow linked authoring sources without counting media, private state or unrelated files", async () => {
  const f = await projectFixture();
  try {
    const project = await f.store.create({ name: "Linked authoring" });
    for (const dir of ["scenes", "code", ".cutroom", "media"])
      await mkdir(join(project.path, dir), { recursive: true });
    const sources = new Map([
      [
        "index.html",
        '<main><div data-composition-src="scenes/card.html"></div><script type="module" src="code/main.js"></script><video src="media/footage.mp4"></video><link href=".cutroom/private.css"><p>"unrelated.html"</p><!-- <script src="unused.js"></script> --></main>',
      ],
      [
        "scenes/card.html",
        '<template><div data-composition-src="../end.html"></div><link href="theme.css"><link href="root-theme.css"></template>',
      ],
      [
        "scenes/theme.css",
        '@import "../shared.css"; .title { background:url(../art.svg) }',
      ],
      ["root-theme.css", "/* installed root-relative dependency */"],
      ["shared.css", '@import "scenes/theme.css";'],
      ["end.html", '<div data-composition-src="scenes/card.html"></div>'],
      ["art.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ["code/main.js", 'import "./helper.js"; fetch("../copy.json");'],
      ["code/helper.js", 'import "./main.js";'],
      ["copy.json", '{"title":"A title"}'],
    ]);
    for (const [path, source] of sources)
      await writeFile(join(project.path, path), source);
    const old = new Date("2020-01-01");
    for (const path of [...sources.keys(), "cutroom.json"])
      await utimes(join(project.path, path), old, old);
    for (const path of [
      "media/footage.mp4",
      "media/unlinked.html",
      ".cutroom/private.css",
      "unrelated.html",
      "unused.js",
    ]) {
      await writeFile(join(project.path, path), "not an authoring dependency");
      await utimes(
        join(project.path, path),
        new Date("2030-01-01"),
        new Date("2030-01-01"),
      );
    }
    for (const [i, path] of [...sources.keys()]
      .filter((path) => path !== "index.html")
      .entries()) {
      const edited = new Date(Date.UTC(2024, 0, 1, 0, 0, i));
      await utimes(join(project.path, path), edited, edited);
      expect((await f.store.list())[0]?.updatedAt).toBe(edited.toISOString());
    }
  } finally {
    await f.close();
  }
});

test("Home dates follow a link added to a file that was already read", async () => {
  const f = await projectFixture();
  try {
    const project = await f.store.create({ name: "New link" });
    const old = new Date("2020-01-01");
    const index = join(project.path, "index.html");
    await writeFile(index, "<main></main>");
    for (const path of ["index.html", "cutroom.json"])
      await utimes(join(project.path, path), old, old);
    expect((await f.store.list())[0]?.updatedAt).toBe(old.toISOString());

    const late = new Date("2025-01-01");
    await writeFile(join(project.path, "late.html"), "<div></div>");
    await utimes(join(project.path, "late.html"), late, late);
    // Same timestamp, new content: the link must still be found.
    await writeFile(
      index,
      '<main><div data-composition-src="late.html"></div></main>',
    );
    await utimes(index, old, old);
    expect((await f.store.list())[0]?.updatedAt).toBe(late.toISOString());
  } finally {
    await f.close();
  }
});
