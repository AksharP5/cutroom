import { z } from "zod";
import { expect, test } from "bun:test";
import {
  readFile,
  writeFile,
  rename,
  utimes,
  stat,
  mkdir,
  copyFile,
} from "node:fs/promises";
import { join } from "node:path";
import { moveSourceMarks, projectViews } from "../src/server/projects/view";
import {
  SourceMarksSaveSchema,
  SourceMarksSchema,
  TimelineViewSettingsSchema,
} from "../src/shared/timeline/view";
import { sourceMarksFixture } from "./source-marks-fixture";

test("identical media survives touch and restore; superseded versions stay bounded and rename moves pending marks", async () => {
  const f = await sourceMarksFixture();
  try {
    const url = `${f.endpoint}/source-marks?path=talk.wav`;
    const read = async () =>
      SourceMarksSaveSchema.parse(await (await f.request(url)).json());
    let view = await read();
    expect(
      (await f.request(url, "PUT", { ...view, in: 2, out: 5 })).status,
    ).toBe(200);
    const original = await readFile(f.path);
    await utimes(f.path, new Date(), new Date(Date.now() + 10000));
    expect(SourceMarksSchema.parse(await read())).toEqual({ in: 2, out: 5 });
    await writeFile(f.path, original);
    expect(SourceMarksSchema.parse(await read())).toEqual({ in: 2, out: 5 });
    for (const duration of [4, 6, 8]) {
      f.make(duration);
      view = await read();
      expect(SourceMarksSchema.parse(view)).toEqual({ in: null, out: null });
      expect(
        (await f.request(url, "PUT", { ...view, in: 1, out: 2 })).status,
      ).toBe(200);
    }
    const file = join(f.project.path, ".cutroom/view.json");
    const paths = async () =>
      Object.keys(
        z
          .object({ sources: z.record(z.string(), z.unknown()) })
          .parse(JSON.parse(await readFile(file, "utf8"))).sources,
      );
    expect(await paths()).toEqual(["talk.wav"]);
    view = await read();
    const saving = projectViews.saveSource(f.project, "talk.wav", {
      ...view,
      in: 2,
      out: 3,
    });
    await rename(f.path, join(f.project.path, "renamed.wav"));
    await moveSourceMarks(f.project, "talk.wav", "renamed.wav");
    await saving;
    await moveSourceMarks(f.project, "renamed.wav", "./renamed.wav");
    expect(await paths()).toEqual(["renamed.wav"]);
    expect(
      SourceMarksSchema.parse(
        await (
          await f.request(`${f.endpoint}/source-marks?path=renamed.wav`)
        ).json(),
      ),
    ).toEqual({ in: 2, out: 3 });
    await rename(join(f.project.path, "renamed.wav"), f.path);
    // A removed file's entry stays dormant when unrelated view preferences are saved.
    await f.request(`${f.endpoint}/timeline-view`, "PUT", {
      density: "compact",
    });
    expect(await paths()).toEqual(["renamed.wav"]);
  } finally {
    await f.close();
  }
});

test("legacy versions collapse to one entry per path while missing files remain dormant", async () => {
  const f = await sourceMarksFixture();
  try {
    const info = await stat(f.path);
    await mkdir(join(f.project.path, ".cutroom"), { recursive: true });
    const file = join(f.project.path, ".cutroom/view.json");
    await writeFile(
      file,
      JSON.stringify({
        timelines: {},
        sources: {
          [JSON.stringify(["talk.wav", info.size - 4, 1])]: { in: 1, out: 2 },
          [JSON.stringify(["talk.wav", info.size, 2])]: { in: 2, out: 3 },
          [JSON.stringify(["missing.wav", 100, 3])]: { in: null, out: 1 },
        },
      }),
    );
    expect(
      SourceMarksSchema.parse(
        await (
          await f.request(`${f.endpoint}/source-marks?path=talk.wav`)
        ).json(),
      ),
    ).toEqual({ in: 2, out: 3 });
    await f.request(`${f.endpoint}/timeline-view`, "PUT", {
      density: "compact",
    });
    const saved = z
      .object({ sources: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(await readFile(file, "utf8")));
    expect(Object.keys(saved.sources).sort()).toEqual([
      "missing.wav",
      "talk.wav",
    ]);
  } finally {
    await f.close();
  }
});

test("an unmarked rename clears the destination's previous marks without changing other preferences", async () => {
  const f = await sourceMarksFixture();
  try {
    const destination = join(f.project.path, "destination.wav");
    await copyFile(f.path, destination);
    const url = `${f.endpoint}/source-marks?path=destination.wav`;
    const view = SourceMarksSaveSchema.parse(
      await (await f.request(url)).json(),
    );
    expect(
      (await f.request(url, "PUT", { ...view, in: 4, out: 5 })).status,
    ).toBe(200);
    await f.request(`${f.endpoint}/timeline-view`, "PUT", {
      destinations: { video: 2 },
    });
    await rename(f.path, destination);
    await moveSourceMarks(f.project, "talk.wav", "destination.wav");
    expect(
      SourceMarksSchema.parse(await (await f.request(url)).json()),
    ).toEqual({ in: null, out: null });
    const file = z
      .object({
        sources: z.record(z.string(), z.unknown()),
        timelines: z.record(z.string(), TimelineViewSettingsSchema),
      })
      .parse(
        JSON.parse(
          await readFile(join(f.project.path, ".cutroom/view.json"), "utf8"),
        ),
      );
    expect(file.sources).toEqual({});
    expect(file.timelines["index.html"]?.destinations).toEqual({ video: 2 });
  } finally {
    await f.close();
  }
});
