import { expect, test } from "bun:test";
import { parseComposition } from "../src/server/timeline/composition";
import { emptyTimelineSettings } from "../src/shared/timeline/schema";
import type { Clip } from "../src/shared/timeline/schema";
import { animationMessage, animationReview } from "../src/client/edit/feedback";
import {
  animationCheck,
  checkAnimationEdit,
  animationWarnings,
} from "../src/server/projects/animation";
import type { AnimationSnapshot } from "../src/server/projects/animation";

const timeline = parseComposition(
  `<main data-composition-id="main" data-duration="48" data-fps="30"><div id="title" data-label="Title" data-start="6" data-duration="4"></div><div id="still" data-start="6" data-duration="4" data-track-index="1"></div></main>`,
  emptyTimelineSettings(),
).timeline;
const before: AnimationSnapshot = {
  timeline,
  windows: { title: [["x", [6, 7]]], still: [["x", [6]]] },
};
const edit = (
  changes: Partial<Clip>,
  windows = before.windows,
): AnimationSnapshot => ({
  timeline: {
    ...timeline,
    clips: timeline.clips.map((clip) =>
      clip.id === "title" ? { ...clip, ...changes } : clip,
    ),
  },
  windows,
});
const checks = [animationCheck(before, "title", "title")!];

test("only an origin change whose starts stayed absolute creates a warning", () => {
  const result = checkAnimationEdit(edit({ start: 240 }), checks, []);
  expect(animationWarnings(result)).toEqual([{ clipId: "title", time: 6 }]);
  expect(checkAnimationEdit(edit({ duration: 20 }), checks, [])).toEqual([]);
  expect(
    checkAnimationEdit(edit({ start: 210, animationInPoint: 1 }), checks, []),
  ).toEqual([]);
  expect(
    checkAnimationEdit(
      edit({ start: 210, mediaStart: 2, playbackRate: 2 }),
      checks,
      [],
    ),
  ).toEqual([]);
  expect(
    animationWarnings(
      checkAnimationEdit(
        edit({ start: 240 }, { title: [["x", [8, 9]]] }),
        checks,
        [],
      ),
    ),
  ).toEqual([]);
  expect(
    animationWarnings(
      checkAnimationEdit(
        edit({ start: 240 }, { title: [["x", [6, 9]]] }),
        checks,
        [],
      ),
    ),
  ).toEqual([]);
  expect(
    animationWarnings(
      checkAnimationEdit(
        edit({ start: 240 }, { title: [["x", [7, 6]]] }),
        checks,
        [],
      ),
    ),
  ).toHaveLength(1);
});

test("source fixes and moving back resolve evidence from the original edit", () => {
  const previous = checkAnimationEdit(edit({ start: 240 }), checks, []);
  expect(
    animationWarnings(
      checkAnimationEdit(
        edit({ start: 240 }, { title: [["x", [8, 9]]] }),
        [],
        previous,
      ),
    ),
  ).toEqual([]);
  const moved = edit({ start: 240 });
  const back = [animationCheck(moved, "title", "title")!];
  expect(animationWarnings(checkAnimationEdit(before, back, previous))).toEqual(
    [],
  );
  const twice = checkAnimationEdit(edit({ start: 300 }), back, previous);
  expect(animationWarnings(twice)).toHaveLength(1);
  expect(
    animationWarnings(
      checkAnimationEdit(
        edit({ start: 300 }, { title: [["x", [10, 11]]] }),
        [],
        twice,
      ),
    ),
  ).toEqual([]);
});

test("new razor and clipboard ids use the source report from that edit", () => {
  const copy = edit({ id: "piece", start: 300 });
  copy.windows = { piece: [["x", [6, 7]]] };
  expect(
    animationWarnings(
      checkAnimationEdit(copy, [{ ...checks[0]!, clipId: "piece" }], []),
    ),
  ).toEqual([{ clipId: "piece", time: 6 }]);
  copy.timeline.clips[0]!.animationInPoint = 4;
  expect(
    checkAnimationEdit(copy, [{ ...checks[0]!, clipId: "piece" }], []),
  ).toEqual([]);
});

test("unknown groups and count changes stay silent; review note retains the moved clip", () => {
  expect(
    animationWarnings(
      checkAnimationEdit(
        edit({ start: 240 }, { title: [["y", [6]]] }),
        checks,
        [],
      ),
    ),
  ).toEqual([]);
  expect(
    animationWarnings(
      checkAnimationEdit(
        edit({ start: 240 }, { title: [["x", [6]]] }),
        checks,
        [],
      ),
    ),
  ).toEqual([]);
  const clip = edit({ start: 240 }).timeline.clips[0]!;
  expect(animationMessage([{ clip, time: 6 }], timeline.fps)).toBe(
    "Title's animation stayed at 00:00:06:00.",
  );
  expect(animationReview(clip, 6, timeline.fps).draft).toMatchObject({
    time: 8,
    elementIds: ["title"],
  });
});
