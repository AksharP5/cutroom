import { expect, test } from "bun:test";
import { sourceTimeAt } from "@hyperframes/core/speed-ramp";
import {
  parseComposition,
  patchComposition,
} from "../src/server/timeline/composition";
import { applyAll } from "../src/shared/timeline/apply";
import { editReply } from "../src/server/mcp/timelineReply";
import { clipName } from "../src/shared/timeline/labels";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { versionStart } from "../src/shared/timeline/versions";

const lengths = new Map([
  ["music.wav", 20],
  ["cue-b.wav", 20],
  ["sting.wav", 1],
]);
const timelineOf = (body: string) =>
  parseComposition(
    `<main data-composition-id="main" data-fps="30" data-duration="20">${body}</main>`,
    emptyTimelineSettings(),
    { mediaLengths: lengths, mediaFiles: new Set(lengths.keys()) },
  ).timeline;
const run = (
  timeline: ReturnType<typeof timelineOf>,
  ...commands: CommandInput[]
) =>
  applyAll(
    timeline,
    commands.map((command) => CommandSchema.parse(command)),
    { mediaLengths: lengths, mediaFiles: new Set(lengths.keys()) },
  );
const takes = [
  { name: "Music", src: "music.wav" },
  { name: "Cue B", src: "cue-b.wav", sourceIn: 1 },
];

test("a kept take is named after its own file, not the one it replaced", () => {
  const music = timelineOf(
    '<audio id="music" src="music.wav" data-start="0" data-duration="4" data-track-index="1"></audio>',
  );
  const kept = run(
    music,
    { type: "setVersions", clipId: "music", versions: takes, active: 0 },
    { type: "setVersion", clipId: "music", version: 1 },
    { type: "keepVersion", clipId: "music" },
  ).clips[0]!;
  expect(kept.label).toBeNull();
  expect(clipName(kept)).toBe("cue-b.wav");
});

test("listing the clip's own file without an In keeps the clip's In", () => {
  const music = timelineOf(
    '<audio id="music" src="music.wav" data-start="0" data-duration="4" data-media-start="4.5" data-track-index="1"></audio>',
  );
  const [clip] = run(music, {
    type: "setVersions",
    clipId: "music",
    versions: takes,
    active: 0,
  }).clips;
  expect(clip!.mediaStart).toBe(4.5);
  expect(versionStart(clip!.versions![0]!, music.fps)).toBeCloseTo(4.5, 6);
  // The other take's In was given in seconds.
  expect(versionStart(clip!.versions![1]!, music.fps)).toBeCloseTo(1, 6);
});

test("a cut through a speed ramp moves every take by the same stretch of source", () => {
  const ramp = timelineOf(
    `<audio id="music" src="music.wav" data-start="0" data-duration="6" data-media-start="2" data-track-index="1" data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":0.5},{"t":6,"v":2}]}]}'></audio>`,
  );
  const cut = run(
    ramp,
    { type: "setVersions", clipId: "music", versions: takes, active: 0 },
    { type: "split", at: 90, clipIds: ["music"], ids: { music: ["tail"] } },
  );
  const head = cut.clips.find(({ id }) => id === "music")!;
  const tail = cut.clips.find(({ id }) => id === "tail")!;
  const seconds = (clip: typeof head, take: number) =>
    versionStart(clip.versions![take]!, cut.fps);
  // The ramp consumes the same source time before the cut whichever take plays.
  const consumed = seconds(tail, 0) - seconds(head, 0);
  // The cut lands where the runtime's own curve says, well short of 3 s at 1×.
  expect(consumed).toBeCloseTo(
    sourceTimeAt(
      {
        target: "rate",
        points: [
          { t: 0, v: 0.5 },
          { t: 6, v: 2 },
        ],
      },
      3,
    ),
    4,
  );
  expect(consumed).toBeLessThan(2.5);
  expect(tail.mediaStart! - head.mediaStart!).toBeCloseTo(consumed, 5);
  expect(seconds(tail, 1) - seconds(head, 1)).toBeCloseTo(consumed, 5);
  // Showing the other take on the tail starts it at that take's own In after the cut.
  const shown = run(cut, {
    type: "setVersion",
    clipId: "tail",
    version: 1,
  }).clips.find(({ id }) => id === "tail")!;
  expect(shown.mediaStart).toBeCloseTo(seconds(tail, 1), 5);
});

test("an agent hears once that a take is too short, not again on each later trim", () => {
  const music = timelineOf(
    '<audio id="music" src="music.wav" data-start="0" data-duration="4" data-track-index="1"></audio>',
  );
  const view = (timeline: typeof music, revision: string) => ({
    composition: "index.html",
    revision,
    timeline,
  });
  const listed = run(music, {
    type: "setVersions",
    clipId: "music",
    versions: [...takes, { name: "Sting", src: "sting.wav" }],
    active: 0,
  });
  const trimmed = run(listed, {
    type: "trim",
    clipId: "music",
    edge: "start",
    to: 10,
  });
  const warnings = (before: typeof music, after: typeof music) =>
    editReply(view(before, "a"), view(after, "b"), false).warnings ?? [];
  expect(warnings(music, listed)).toEqual([
    { clipId: "music", warning: expect.stringContaining("Sting") },
  ]);
  expect(warnings(listed, trimmed)).toEqual([]);
});

test("a slip keeps the slot of a clip whose length came from its file", () => {
  // Without a written length, the runtime plays to the file's end, so an earlier In would grow it.
  const html = `<main data-composition-id="main" data-fps="30" data-duration="20"><audio id="music" src="music.wav" data-start="0" data-media-start="1" data-track-index="1"></audio></main>`;
  const parsed = parseComposition(html, emptyTimelineSettings(), {
    mediaLengths: lengths,
  });
  expect(parsed.timeline.clips[0]!.duration).toBe(570);
  const slipped = run(parsed.timeline, {
    type: "slip",
    clipId: "music",
    by: -15,
  });
  const written = patchComposition(parsed, slipped, new Map());
  const reread = parseComposition(written, emptyTimelineSettings(), {
    mediaLengths: lengths,
  }).timeline.clips[0]!;
  expect(reread).toMatchObject({ start: 0, duration: 570, mediaStart: 0.5 });
});
