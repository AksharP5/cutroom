import { expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SourceMarksSchema,
  TimelineViewSettingsSchema,
} from "../src/shared/timeline/view";
import { sourceMarksFixture } from "./source-marks-fixture";

test("review: a save for the old media identity is refused after replacement", async () => {
  const f = await sourceMarksFixture();
  try {
    // Equal byte sizes with different durations exercise both parts of the identity.
    f.make(12, 96000);
    const identity = { size: (await stat(f.path)).size, duration: 12 };
    f.make(3, 384000);
    expect((await stat(f.path)).size).toBe(identity.size);
    const saved = await f.request(
      `${f.endpoint}/source-marks?path=talk.wav`,
      "PUT",
      { identity, in: 7, out: 9 },
    );
    expect(saved.status).toBe(409);
    expect(
      SourceMarksSchema.parse(
        await (
          await f.request(`${f.endpoint}/source-marks?path=talk.wav`)
        ).json(),
      ),
    ).toEqual({ in: null, out: null });
  } finally {
    await f.close();
  }
});

test("review: one malformed source entry does not discard valid sources or timeline preferences", async () => {
  const f = await sourceMarksFixture();
  try {
    const info = await stat(f.path);
    await mkdir(join(f.project.path, ".cutroom"), { recursive: true });
    await writeFile(
      join(f.project.path, ".cutroom/view.json"),
      JSON.stringify({
        timelines: {
          "index.html": { destinations: { video: 2 } },
        },
        sources: {
          [JSON.stringify(["talk.wav", info.size, info.mtimeMs])]: {
            in: 2,
            out: 5,
          },
          bad: { in: -1, out: "bad" },
        },
      }),
    );
    const view = TimelineViewSettingsSchema.parse(
      await (await f.request(`${f.endpoint}/timeline-view`)).json(),
    );
    expect(view.destinations).toEqual({ video: 2 });
    expect(
      SourceMarksSchema.parse(
        await (
          await f.request(`${f.endpoint}/source-marks?path=talk.wav`)
        ).json(),
      ),
    ).toEqual({ in: 2, out: 5 });
    expect(
      (
        await f.request(`${f.endpoint}/timeline-view`, "PUT", {
          ...view,
          density: "compact",
        })
      ).status,
    ).toBe(200);
    expect(
      JSON.parse(
        await readFile(join(f.project.path, ".cutroom/view.json"), "utf8"),
      ).timelines["index.html"].destinations,
    ).toEqual({ video: 2 });
    expect(
      SourceMarksSchema.parse(
        await (
          await f.request(`${f.endpoint}/source-marks?path=talk.wav`)
        ).json(),
      ),
    ).toEqual({ in: 2, out: 5 });
  } finally {
    await f.close();
  }
});
