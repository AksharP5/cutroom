import { expect, test } from "bun:test";
import { applyAll, normalizeTimeline } from "../src/shared/timeline/apply";
import { CommandSchema } from "../src/shared/timeline/schema";
import type { Clip, Timeline, Track } from "../src/shared/timeline/schema";
import { editKeys } from "../src/client/edit/keys";
import { countingIds } from "./clip-ids";

const clip = (
  id: string,
  track: number,
  start: number,
  duration: number,
  extra: Partial<Clip> = {},
): Clip => ({
  id,
  track,
  kind: track >= 2 ? "audio" : "video",
  start,
  duration,
  mediaStart: 0,
  playbackRate: 1,
  src: null,
  sourceDuration: null,
  link: null,
  label: null,
  volume: null,
  enabled: true,
  hasAudio: false,
  startRef: null,
  ...extra,
});

/** V1 is track 0 and V2 track 1; A1 is track 2 and A2, the music, track 3. */
const sequence = (tracks: Partial<Track>[] = []): Timeline =>
  normalizeTimeline({
    fps: { num: 30, den: 1 },
    duration: 300,
    tracks: [0, 1, 2, 3].map((index) => ({
      index,
      kind: index >= 2 ? "audio" : "video",
      name: null,
      locked: false,
      autoSelect: true,
      enabled: true,
      muted: false,
      solo: false,
      ...tracks.find((track) => track.index === index),
    })),
    clips: [
      clip("a", 0, 0, 100, { link: "lk" }),
      clip("a-sound", 2, 0, 100, { link: "lk" }),
      clip("b", 0, 100, 100),
      clip("title", 1, 200, 50),
      clip("music", 3, 0, 300),
    ],
    markers: [],
    range: { in: null, out: null },
  });
const musicOff = [{ index: 3, autoSelect: false }];

const press = (
  key: keyof typeof editKeys,
  timeline: Timeline,
  frame: number,
  selected: string[] = [],
) => editKeys[key].commands(timeline, { selection: new Set(selected), frame });

const apply = (timeline: Timeline, commands: ReturnType<typeof press>) =>
  applyAll(
    timeline,
    commands.map((command) => CommandSchema.parse(command)),
    { newId: countingIds },
  );
const starts = (timeline: Timeline) =>
  Object.fromEntries(timeline.clips.map((item) => [item.id, item.start]));

test("Q and W ripple trim the first clip under the playhead, skipping tracks with auto-select off", () => {
  const timeline = sequence(musicOff);
  const q = press("trimRippleStartToPlayhead", timeline, 60);
  expect(q).toEqual([
    { type: "trim", clipId: "a", edge: "start", to: 60, ripple: true },
  ]);
  // The linked sound trims with it and V2 keeps sync; the music's track takes no part.
  expect(starts(apply(timeline, q))).toEqual({
    a: 0,
    "a-sound": 0,
    b: 40,
    title: 140,
    music: 0,
  });
  expect(press("trimRippleEndToPlayhead", timeline, 60)).toEqual([
    { type: "trim", clipId: "a", edge: "end", to: 60, ripple: true },
  ]);
  // With auto-select on, the music bed under the cut loses the same 60 frames.
  const all = sequence();
  const music = apply(
    all,
    press("trimRippleStartToPlayhead", all, 60),
  ).clips.find((item) => item.id === "music");
  expect([music?.start, music?.duration]).toEqual([0, 240]);
  // With every track locked or off, nothing is under the playhead to trim.
  const idle = sequence([
    { index: 0, locked: true },
    { index: 1, autoSelect: false },
    { index: 2, locked: true },
    ...musicOff,
  ]);
  expect(press("trimRippleStartToPlayhead", idle, 60)).toEqual([]);
});

test("a selected clip under the playhead is trimmed even on a track with auto-select off", () => {
  const timeline = sequence(musicOff);
  expect(press("trimRippleEndToPlayhead", timeline, 60, ["music"])).toEqual([
    { type: "trim", clipId: "music", edge: "end", to: 60, ripple: true },
  ]);
  // A selection away from the playhead leaves the keys to auto-select.
  expect(press("trimRippleStartToPlayhead", timeline, 60, ["b"])).toEqual([
    { type: "trim", clipId: "a", edge: "start", to: 60, ripple: true },
  ]);
});

test("E and Ctrl+\\ razor the selected clips under the playhead, or every unlocked auto-select track", () => {
  const timeline = sequence(musicOff);
  const all = apply(timeline, press("editBladeRazor", timeline, 140));
  // V1 is cut; the music with auto-select off stays whole.
  expect(all.clips.map((item) => item.id)).toEqual([
    "a",
    "b",
    "b-2",
    "title",
    "a-sound",
    "music",
  ]);
  // The title on locked V2 stays whole while the music is cut.
  const locked = sequence([{ index: 1, locked: true }]);
  const ids = apply(locked, press("editBladeRazor", locked, 220)).clips.map(
    (item) => item.id,
  );
  expect(ids).toEqual(["a", "b", "title", "a-sound", "music", "music-2"]);
  expect(press("editM2SplitClip", timeline, 140, ["music", "a"])).toEqual([
    { type: "split", at: 140, clipIds: ["music"] },
  ]);
});

test("X lifts and Shift+X ripple deletes the selection, and do nothing without one", () => {
  const timeline = sequence(musicOff);
  const lifted = apply(timeline, press("editBackspace", timeline, 0, ["b"]));
  expect(starts(lifted)).toEqual({ a: 0, "a-sound": 0, title: 200, music: 0 });
  const closed = apply(timeline, press("editDelete", timeline, 0, ["b"]));
  expect(starts(closed)).toEqual({ a: 0, "a-sound": 0, title: 100, music: 0 });
  expect(press("editBackspace", timeline, 0)).toEqual([]);
  expect(press("editDelete", timeline, 0)).toEqual([]);
  // A second quick X, or an agent's delete, leaves selected clips that are gone; they are skipped.
  expect(press("editBackspace", lifted, 0, ["b"])).toEqual([]);
  expect(press("editClipEnabled", lifted, 0, ["a", "b"])).toEqual([
    { type: "setClip", clipId: "a", enabled: false },
  ]);
});

test("D turns each selected clip on or off, and M adds one marker at the playhead", () => {
  const timeline = sequence();
  const off = apply(timeline, press("editClipEnabled", timeline, 0, ["b"]));
  const toggled = apply(
    off,
    press("editClipEnabled", off, 0, ["a", "a-sound", "b"]),
  );
  expect(
    Object.fromEntries(toggled.clips.map((item) => [item.id, item.enabled])),
  ).toEqual({
    a: false,
    "a-sound": false,
    b: true,
    title: true,
    music: true,
  });
  const marked = apply(timeline, press("markMarkerAdd", timeline, 45));
  expect(marked.markers.map((marker) => marker.frame)).toEqual([45]);
  expect(press("markMarkerAdd", marked, 45)).toEqual([]);
});
