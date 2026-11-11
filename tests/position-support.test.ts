import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { projectFixture } from "./project-fixture";
import { parseComposition } from "../src/server/timeline/composition";
import { unsupportedPositions } from "../src/server/timeline/positionSupport";
import { emptyTimelineSettings } from "../src/shared/timeline/schema";

test("position support refuses source shapes that cannot keep a draft and its committed offset exact", () => {
  const support = (body: string, head = "") =>
    unsupportedPositions(
      parseComposition(
        `<html><head>${head}</head><body><main id="main" data-composition-id="main" data-duration="2">${body}</main></body></html>`,
        emptyTimelineSettings(),
      ),
    );
  expect(
    support('<div data-start="0" data-duration="2"></div>')["clip-1"],
  ).toMatch(/unique clip id/);
  expect(
    support(
      '<div id="title" data-start="0" data-duration="2"></div>',
      '<script src="gsap.min.js"></script><style>#title{--offset:20px;translate:var(--offset) 10px}</style>',
    ).title,
  ).toMatch(/CSS translate and GSAP/);
  expect(
    support(
      '<div id="title" data-start="0" data-duration="2"></div>',
      "<style>#title{translate:20px 10px!important}</style>",
    ).title,
  ).toMatch(/important CSS translate/);
  expect(
    support(
      '<svg viewBox="0 0 640 480"><rect id="title" data-start="0" data-duration="2"/></svg>',
    ).title,
  ).toMatch(/transformed container/);
  expect(
    support(
      '<div id="title" data-start="0" data-duration="2"></div>',
      "<style>#title{translate:20px 10px}</style>",
    ),
  ).toEqual({});
});

test("a batch cannot bypass transformed ancestry by positioning a piece it just split", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  try {
    const project = await fixture.store.create({ name: "Scaled split" });
    const path = `/projects/${project.id}`;
    const source =
      '<main id="main" data-composition-id="main" data-fps="30" data-duration="2" style="transform:scale(.5)"><div id="title" data-start="0" data-duration="2">Title</div></main>';
    const file = join(project.path, "index.html");
    await writeFile(file, source);
    const before = TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
    const response = await fixture.request(`${path}/commands`, "POST", {
      expectedRevision: before.revision,
      commands: [
        {
          type: "split",
          clipIds: ["title"],
          at: 30,
          ids: { title: ["title-end"] },
        },
        { type: "setClip", clipId: "title-end", x: 40 },
      ],
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      command: 1,
      error: "Position is unavailable inside a transformed container.",
    });
    expect(await readFile(file, "utf8")).toBe(source);
    expect(
      TimelineViewSchema.parse(
        await (await fixture.request(`${path}/timeline`)).json(),
      ).revision,
    ).toBe(before.revision);
  } finally {
    await fixture.close();
  }
});
