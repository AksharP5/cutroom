import { expect, test } from "bun:test";
import { parseComposition } from "../src/server/timeline/composition";
import { emptyTimelineSettings } from "../src/shared/timeline/schema";
import type { Timeline } from "../src/shared/timeline/schema";
import type { TweenWindows } from "../src/shared/preview";
import {
  animationFeedback,
  animationOffsets,
  animationMessage,
  animationReview,
} from "../src/client/edit/feedback";

const timeline = parseComposition(
  `<main data-composition-id="main" data-duration="48" data-fps="30"><div id="title" data-label="Title" data-start="6" data-duration="4"></div><div id="still" data-start="6" data-duration="4" data-track-index="1"></div></main>`,
  emptyTimelineSettings(),
).timeline;
const report: TweenWindows = { title: [[0, 6]], still: [[0, 6]] };
const baseline = animationOffsets(timeline, report);
const edit = (changes: Partial<Timeline["clips"][number]>): Timeline => ({
  ...timeline,
  clips: timeline.clips.map((clip) =>
    clip.id === "title" ? { ...clip, ...changes } : clip,
  ),
});

test("shared tween warns only the moved clip, undo clears, redo warns again", () => {
  const moved = edit({ start: 240 });
  const warnings = animationFeedback(moved, report, baseline);
  expect(warnings.map(({ clip }) => clip.id)).toEqual(["title"]);
  expect(animationFeedback(timeline, report, baseline)).toEqual([]);
  expect(animationFeedback(moved, report, baseline)).toEqual(warnings);
  expect(animationMessage(warnings, timeline.fps)).toBe(
    "Title's animation stayed at 00:00:06:00.",
  );
  expect(
    animationReview(warnings[0]!.clip, 6, timeline.fps).draft,
  ).toMatchObject({ time: 8, elementIds: ["title"] });
});

test("head and tail trims preserve origin, including nonzero in points and playback rate", () => {
  expect(
    animationFeedback(
      edit({ start: 210, duration: 90, animationInPoint: 1 }),
      report,
      baseline,
    ),
  ).toEqual([]);
  expect(animationFeedback(edit({ duration: 8 }), report, baseline)).toEqual(
    [],
  );
  expect(
    animationFeedback(
      edit({ start: 210, duration: 90, mediaStart: 2, playbackRate: 2 }),
      report,
      baseline,
    ),
  ).toEqual([]);
  // Repeat duration and end times never enter the report or the rule.
  expect(animationFeedback(timeline, report, baseline)).toEqual([]);
});

test("a following tween stays silent, a changed start warns beyond 2 ms", () => {
  const moved = edit({ start: 240 });
  expect(
    animationFeedback(moved, { ...report, title: [[0, 8.0019]] }, baseline),
  ).toEqual([]);
  expect(
    animationFeedback(moved, { ...report, title: [[0, 8.0021]] }, baseline),
  ).toHaveLength(1);
});

test("new pairs after a command cannot silently establish intent; source rebaseline clears", () => {
  const late: TweenWindows = {
    ...report,
    title: [
      [0, 6],
      [1, 7],
    ],
  };
  expect(animationFeedback(timeline, late, baseline)).toHaveLength(1);
  expect(
    animationFeedback(timeline, late, animationOffsets(timeline, late)),
  ).toEqual([]);
  expect(animationFeedback(timeline, {}, baseline)).toEqual([]);
});

test("razor pieces inherit intent, moved pieces and pasted copies warn", () => {
  const piece = {
    ...timeline.clips[0]!,
    id: "piece",
    animationSource: "title",
    start: 240,
    duration: 60,
    animationInPoint: 2,
  };
  const split = { ...timeline, clips: [...timeline.clips, piece] };
  const shared: TweenWindows = { ...report, piece: [[0, 6]] };
  expect(animationFeedback(split, shared, baseline)).toEqual([]);
  expect(
    animationFeedback(
      { ...split, clips: [...timeline.clips, { ...piece, start: 300 }] },
      shared,
      baseline,
    ).map(({ clip }) => clip.id),
  ).toEqual(["piece"]);
  expect(
    animationFeedback(
      { ...timeline, clips: [{ ...piece, start: 600, animationInPoint: 0 }] },
      { piece: [[0, 6]] },
      baseline,
    ),
  ).toHaveLength(1);
});

test("legal clip ids do not read inherited properties when the compact report omits them", () => {
  const clip = { ...timeline.clips[0]!, id: "constructor" };
  const source = { ...timeline, clips: [clip] };
  const windows: TweenWindows = {
    constructor: [[0, 6] satisfies [number, number]],
  };
  const known = animationOffsets(source, windows);
  expect(animationFeedback(source, {}, known)).toEqual([]);
  expect(animationOffsets(source, {}).get("constructor")?.size).toBe(0);
  expect(
    animationFeedback(
      { ...source, clips: [{ ...clip, start: 240 }] },
      windows,
      known,
    ),
  ).toHaveLength(1);
});
