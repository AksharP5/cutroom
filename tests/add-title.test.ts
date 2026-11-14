import { expect, test } from "bun:test";
import { addTitleCommands } from "../src/client/edit/addTitle";
import { applyAll, normalizeTimeline } from "../src/shared/timeline/apply";
import { CommandSchema } from "../src/shared/timeline/schema";
import type { Timeline } from "../src/shared/timeline/schema";
import { newTrack } from "../src/shared/timeline/tracks";

/** V1, V2 and V3 are tracks 0, 1 and 4; A1 is track 2. `titles` are [track, start, frames]. */
const layout = (
  video: number[],
  titles: [track: number, start: number, frames: number][] = [],
  locked: number[] = [],
): Timeline =>
  applyAll(
    normalizeTimeline({
      fps: { num: 30, den: 1 },
      duration: 600,
      tracks: [
        ...video.map((index) => ({
          ...newTrack(index, "video"),
          locked: locked.includes(index),
        })),
        newTrack(2, "audio"),
      ],
      clips: [],
      markers: [],
      range: { in: null, out: null },
    }),
    titles.map(([track, at, duration], index) =>
      CommandSchema.parse({
        type: "insert",
        track,
        at,
        clip: { kind: "title", id: `t${index}`, text: "Held", duration },
      }),
    ),
  );

/** Presses the key with V1 as the video destination and says where the new title went. */
const add = (timeline: Timeline, at = 90) => {
  const commands = addTitleCommands(timeline, timeline.tracks[0]!, at).map(
    (command) => CommandSchema.parse(command),
  );
  const after = applyAll(timeline, commands);
  const [title] = after.clips.filter((clip) => clip.text === "Title");
  return {
    title,
    madeTrack: after.tracks.length > timeline.tracks.length,
    others: after.clips.filter((clip) => clip !== title),
  };
};

test("a new title takes the free video track above the destination, for five seconds, lower left", () => {
  const { title, madeTrack } = add(layout([0, 1]));
  expect(title).toMatchObject({
    track: 1,
    start: 90,
    duration: 150,
    title: { position: "lower-left" },
  });
  expect(madeTrack).toBe(false);
});

test("a title never lands on a clip: an occupied track above is passed over", () => {
  // V2 holds a clip under the playhead, so the next free track up takes the title.
  const next = layout([0, 1, 4], [[1, 200, 60]]);
  expect(add(next)).toMatchObject({ title: { track: 4 }, madeTrack: false });
  // With every track above taken, a new one goes on top and the clips below are untouched.
  const full = layout([0, 1], [[1, 200, 60]]);
  const result = add(full);
  expect(result).toMatchObject({ title: { track: 3 }, madeTrack: true });
  expect(result.others).toEqual(full.clips);
  // A clip that ends where the title starts, or starts where it ends, leaves the track free.
  const beside = layout(
    [0, 1],
    [
      [1, 0, 90],
      [1, 240, 60],
    ],
  );
  expect(add(beside)).toMatchObject({ title: { track: 1 }, madeTrack: false });
});

test("with no video track above the destination, the title gets a new track at the top", () => {
  expect(add(layout([0]))).toMatchObject({
    title: { track: 3 },
    madeTrack: true,
  });
});

test("a locked track above is skipped", () => {
  expect(add(layout([0, 1, 4], [], [1]))).toMatchObject({
    title: { track: 4 },
    madeTrack: false,
  });
});

test("on an empty timeline the title goes above V1, which stays the destination", () => {
  const empty = normalizeTimeline({
    fps: { num: 30, den: 1 },
    duration: 0,
    tracks: [],
    clips: [],
    markers: [],
    range: { in: null, out: null },
  });
  const after = applyAll(
    empty,
    addTitleCommands(empty, newTrack(0, "video"), 0).map((command) =>
      CommandSchema.parse(command),
    ),
  );
  expect(after.tracks.map(({ index, kind }) => [index, kind])).toEqual([
    [0, "video"],
    [1, "video"],
  ]);
  expect(after.clips).toMatchObject([{ track: 1, text: "Title" }]);
});
