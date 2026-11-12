import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectStore } from "../src/server/projects/store";
import { createAnimationBaselines } from "../src/server/projects/animation";
import { parseComposition } from "../src/server/timeline/composition";
import { emptyTimelineSettings } from "../src/shared/timeline/schema";
import type { Timeline } from "../src/shared/timeline/schema";
import type { TweenWindows } from "../src/shared/preview";
import { animationFeedback } from "../src/client/edit/feedback";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const original = parseComposition(
  `<main data-composition-id="main" data-duration="48" data-fps="30"><div id="title" data-start="6" data-duration="4"></div><div id="still" data-start="6" data-duration="4" data-track-index="1"></div></main>`,
  emptyTimelineSettings(),
).timeline;
const moved = {
  ...original,
  clips: original.clips.map((clip) =>
    clip.id === "title" ? { ...clip, start: 240 } : clip,
  ),
};
const windows: TweenWindows = { title: [["x", 6]], still: [["x", 6]] };
async function setup() {
  const path = await mkdtemp(join(tmpdir(), "cutroom-animation-"));
  directories.push(path);
  const project = {
    id: path,
    path,
    name: "Animation",
    createdAt: "",
    updatedAt: "",
  };
  const store = createAnimationBaselines();
  const sources = (sourceVersion: string, timeline: Timeline) =>
    new Map([
      [
        "index.html",
        {
          sourceVersion,
          animationClips: new Map(
            timeline.clips.map((clip) => [clip.id, JSON.stringify(clip)]),
          ),
        },
      ],
    ]);
  const observe = (revision: string, timeline = original, command = false) =>
    store.observe(project, sources(revision, timeline), command);
  const report = (timeline: Timeline, pairs = windows) =>
    store.report(project, "index.html", timeline, pairs);
  const warnings = (
    timeline: Timeline,
    pairs: TweenWindows,
    offsets: TweenWindows,
  ) =>
    animationFeedback(
      timeline,
      pairs,
      new Map(
        Object.entries(offsets).map(([id, values]) => [id, new Map(values)]),
      ),
    );
  return { project, store, sources, observe, report, warnings };
}

test("mixed unobserved source and command cannot replace known-good offsets, a later source fix can", async () => {
  const p = await setup();
  await p.observe("load");
  await p.report(original);
  await p.observe("source");
  await p.observe("move", moved, true);
  const changed: TweenWindows = { ...windows, title: [["x", 7]] };
  expect(await p.report(moved, changed)).not.toHaveProperty("title");
  const disk = JSON.parse(
    await readFile(
      join(p.project.path, ".cutroom/animation-baselines.json"),
      "utf8",
    ),
  );
  expect(disk.compositions["index.html"].title.baseline.offsets.x).toBe(0);
  await p.observe("source-fix", moved);
  const fixed: TweenWindows = { ...windows, title: [["x", 8]] };
  expect(p.warnings(moved, fixed, await p.report(moved, fixed))).toEqual([]);
  await p.observe("undo", original, true);
  expect(
    p
      .warnings(original, fixed, await p.report(original, fixed))
      .map(({ clip }) => clip.id),
  ).toEqual(["title"]);
});

test("late pairs on touched clips stay unknown; untouched clips adopt their offset", async () => {
  const p = await setup();
  await p.observe("load");
  await p.report(original, {});
  await p.observe("move", moved, true);
  const offsets = await p.report(moved);
  expect(offsets.title).toEqual([]);
  expect(offsets.still).toEqual([["x", 0]]);
  expect(p.warnings(moved, windows, offsets)).toEqual([]);
});

test("known-good offsets survive a server restart, broken reload and undo; deleted clips are pruned", async () => {
  const p = await setup();
  await p.observe("load");
  await p.report(original);
  await p.observe("move", moved, true);
  await p.report(moved);
  const reopened = createAnimationBaselines();
  await reopened.observe(p.project, p.sources("move", moved));
  const known = await reopened.report(p.project, "index.html", moved, windows);
  expect(p.warnings(moved, windows, known).map(({ clip }) => clip.id)).toEqual([
    "title",
  ]);
  await reopened.observe(p.project, p.sources("undo", original), true);
  expect(
    p.warnings(
      original,
      windows,
      await reopened.report(p.project, "index.html", original, windows),
    ),
  ).toEqual([]);
  const deleted = {
    ...original,
    clips: original.clips.filter((clip) => clip.id !== "title"),
  };
  await reopened.observe(p.project, p.sources("delete", deleted), true);
  await reopened.report(p.project, "index.html", deleted, {});
  const disk = JSON.parse(
    await readFile(
      join(p.project.path, ".cutroom/animation-baselines.json"),
      "utf8",
    ),
  );
  expect(disk.compositions["index.html"]).not.toHaveProperty("title");
});

test("a corrupt baseline file falls back to load-time baselining", async () => {
  const p = await setup();
  await p.observe("load");
  await p.report(original);
  await writeFile(
    join(p.project.path, ".cutroom/animation-baselines.json"),
    "{bad",
  );
  const reopened = createAnimationBaselines();
  await reopened.observe(p.project, p.sources("move", moved));
  expect(
    p.warnings(
      moved,
      windows,
      await reopened.report(p.project, "index.html", moved, windows),
    ),
  ).toEqual([]);
});

test("project shutdown drains pending baseline writes before the folder can close", async () => {
  const p = await setup();
  const projects = await createProjectStore({
    dataDir: join(p.project.path, "app"),
  });
  const baselines = createAnimationBaselines(projects.persistState);
  await baselines.observe(p.project, p.sources("load", original));
  await projects.close();
  const disk = JSON.parse(
    await readFile(
      join(p.project.path, ".cutroom/animation-baselines.json"),
      "utf8",
    ),
  );
  expect(disk.compositions["index.html"]).toHaveProperty("title");
});
