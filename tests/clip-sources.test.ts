import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClipSourcesSchema } from "../src/shared/code";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";

test("each clip's source offset is where its element starts, with or without an id, in any composition", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  try {
    const project = await fixture.store.create({ name: "Sources" });
    const index = join(project.path, "index.html");
    await writeFile(
      index,
      (await readFile(index, "utf8")).replace(
        /(<main[^>]*>)[\s\S]*<\/main>/,
        `$1
<div id="card" class="clip" data-start="0" data-duration="2" data-track-index="0">Card</div>
<p class="clip" data-start="2" data-duration="2" data-track-index="0">No id</p>
</main>`,
      ),
    );
    await mkdir(join(project.path, "compositions"));
    const scene = `<template>
  <div data-composition-id="intro" data-width="1920" data-height="1080" data-duration="4">
    <h1 id="intro-title" class="clip" data-start="0" data-duration="4" data-track-index="0">Intro</h1>
  </div>
</template>
`;
    await writeFile(join(project.path, "compositions", "intro.html"), scene);

    const read = async (composition: string) =>
      ClipSourcesSchema.parse(
        await (
          await fixture.request(
            `/projects/${project.id}/timeline/sources?composition=${encodeURIComponent(composition)}`,
          )
        ).json(),
      );
    const root = await read("index.html");
    const html = await readFile(index, "utf8");
    const at = (offset: number | undefined) =>
      offset === undefined ? "" : html.slice(offset, offset + 16);
    expect(at(root.clips.card)).toBe('<div id="card" c');
    const anonymous = Object.entries(root.clips).find(([id]) => id !== "card");
    expect(at(anonymous?.[1])).toBe('<p class="clip" ');

    const intro = await read("compositions/intro.html");
    expect(
      scene.slice(intro.clips["intro-title"], intro.clips["intro-title"]! + 19),
    ).toBe('<h1 id="intro-title');
  } finally {
    await fixture.close();
  }
});
