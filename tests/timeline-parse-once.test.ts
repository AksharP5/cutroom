import { expect, mock, test } from "bun:test";
import * as parse5 from "parse5";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

// Counts full parses of a composition: the source tree is the only parse that keeps locations.
let parses = 0;
const { parse } = parse5;
mock.module("parse5", () => ({
  ...parse5,
  parse: (...args: Parameters<typeof parse>) => {
    if (args[1]?.sourceCodeLocationInfo) parses++;
    return parse(...args);
  },
}));
const { createTimelineRoutes } = await import("../src/server/timeline/routes");
const { projectFixture } = await import("./project-fixture");
const { addStarterClips } = await import("./starter-clips");

test("an edit parses its composition once, and the next read and edit reuse that parse", async () => {
  const fixture = await projectFixture();
  try {
    fixture.app.route(
      "/api/cutroom",
      createTimelineRoutes(fixture.store, fixture.review),
    );
    const project = await fixture.store.create({ name: "Parse once" });
    await addStarterClips(project);
    const read = async () =>
      TimelineViewSchema.parse(
        await (
          await fixture.request(`/projects/${project.id}/timeline`)
        ).json(),
      );
    const trim = async (by: number) => {
      const view = await read();
      const [clip] = view.timeline.clips;
      const response = await fixture.request(
        `/projects/${project.id}/commands`,
        "POST",
        {
          expectedRevision: view.revision,
          commands: [
            {
              type: "trim",
              clipId: clip!.id,
              edge: "end",
              to: clip!.start + clip!.duration - by,
            },
          ],
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
    };
    await trim(1);
    parses = 0;
    // The edit reads the saved revision and writes the next one: only the written bytes are new.
    await trim(1);
    expect(parses).toBe(1);
    await read();
    expect(parses).toBe(1);
  } finally {
    await fixture.close();
  }
});
