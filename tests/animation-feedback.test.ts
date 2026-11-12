import { expect, test } from "bun:test";
import { parseComposition } from "../src/server/timeline/composition";
import { emptyTimelineSettings } from "../src/shared/timeline/schema";
import {
  animationFeedback,
  animationMessage,
  animationReview,
} from "../src/client/edit/feedback";

const before = parseComposition(
  `<main data-composition-id="main" data-duration="48" data-fps="30000/1001"><div id="title" data-label="Lower third" data-start="36" data-duration="4"></div><div id="still" data-start="6" data-duration="4" data-track-index="1"></div></main>`,
  emptyTimelineSettings(),
).timeline;
const after = {
  ...before,
  clips: before.clips.map((clip) =>
    clip.id === "title" ? { ...clip, start: clip.start - 300 } : clip,
  ),
};
const windows = {
  title: [{ start: 36, end: 36.5 }],
  still: [{ start: 6, end: 6.5 }],
};

test("moved clips must shift every tween by their frame delta; unmoved clips must keep theirs", () => {
  const clips = animationFeedback(before, after, windows, {
    ...windows,
    still: [{ start: 5, end: 5.5 }],
  });
  expect(clips.map(({ clip }) => clip.id)).toEqual(["title", "still"]);
  expect(animationMessage(clips, before.fps)).toBe(
    "2 clips left their animation behind.",
  );
  expect(animationMessage(clips.slice(0, 1), { num: 30, den: 1 })).toBe(
    "Lower third's animation stayed at 00:00:36:00.",
  );
  expect(animationReview(clips[0]!.clip, 36, before.fps).draft).toMatchObject({
    time: 25.992633,
    elementIds: ["title"],
  });
});

test("the 2 ms tolerance works at fractional fps; changed lengths and source-only edits do not warn", () => {
  const follows = { ...windows, title: [{ start: 25.991, end: 26.491 }] };
  expect(animationFeedback(before, after, windows, follows)).toEqual([]);
  expect(
    animationFeedback(before, after, windows, {
      ...follows,
      title: [{ start: 25.993, end: 26.493 }],
    }),
  ).toHaveLength(1);
  expect(animationFeedback(before, before, windows, follows)).toEqual([]);
  const resized = {
    ...after,
    clips: after.clips.map((clip) => ({
      ...clip,
      duration: clip.duration - 1,
    })),
  };
  expect(animationFeedback(before, resized, windows, windows)).toEqual([]);
  expect(
    animationFeedback(before, after, windows, { ...windows, title: [] }),
  ).toHaveLength(1);
});
