import { expect, test } from "bun:test";
import {
  TimelineError,
  applyAll,
  normalizeTimeline,
} from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import { CommandSchema } from "../src/shared/timeline/schema";
import type {
  Clip,
  CommandInput,
  Timeline,
  Track,
} from "../src/shared/timeline/schema";

const clip = (
  id: string,
  track: number,
  start: number,
  duration: number,
  extra: Partial<Clip> = {},
): Clip => ({
  id,
  track,
  kind: "video",
  start,
  duration,
  mediaStart: 0,
  playbackRate: 1,
  src: "talk.mp4",
  sourceDuration: null,
  link: null,
  label: null,
  volume: null,
  startRef: null,
  ...extra,
});

const timeline = (clips: Clip[], tracks: Partial<Track>[] = []): Timeline =>
  normalizeTimeline({
    fps: { num: 30, den: 1 },
    duration: 300,
    tracks: tracks.map((track) => ({
      index: 0,
      kind: "video",
      name: null,
      locked: false,
      autoSelect: true,
      ...track,
    })),
    clips,
    markers: [],
    range: { in: null, out: null },
  });

const run = (state: Timeline, ...commands: CommandInput[]) =>
  applyAll(
    state,
    commands.map((command) => CommandSchema.parse(command)),
  );

const positions = (state: Timeline) =>
  Object.fromEntries(
    state.clips.map((item) => [
      item.id,
      [item.track, item.start, item.duration],
    ]),
  );

const failure = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    if (error instanceof TimelineError) return error.code;
    throw error;
  }
  throw new Error("Expected a timeline error.");
};

const edit = timeline([
  clip("a", 0, 0, 30),
  clip("b", 0, 30, 30),
  clip("c", 0, 60, 30),
  clip("music", 2, 0, 30, { kind: "audio" }),
  clip("sting", 2, 60, 30, { kind: "audio" }),
]);

test("lift leaves the gap and ripple delete closes it on auto-select tracks", () => {
  expect(positions(run(edit, { type: "remove", clipIds: ["b"] }))).toEqual({
    a: [0, 0, 30],
    c: [0, 60, 30],
    music: [2, 0, 30],
    sting: [2, 60, 30],
  });
  const rippled = run(edit, { type: "remove", clipIds: ["b"], ripple: true });
  expect(positions(rippled)).toEqual({
    a: [0, 0, 30],
    c: [0, 30, 30],
    music: [2, 0, 30],
    sting: [2, 30, 30],
  });
  expect(rippled.duration).toBe(270);
});

test("ripple edits skip locked and deselected tracks and locked clips refuse edits", () => {
  const locked = timeline(edit.clips, [{ index: 2, locked: true }]);
  expect(
    positions(run(locked, { type: "remove", clipIds: ["b"], ripple: true }))
      .sting,
  ).toEqual([2, 60, 30]);
  expect(
    failure(() => run(locked, { type: "remove", clipIds: ["sting"] })),
  ).toBe("locked");
  const deselected = timeline(edit.clips, [{ index: 2, autoSelect: false }]);
  expect(
    positions(
      run(deselected, {
        type: "trim",
        clipId: "a",
        edge: "end",
        to: 20,
        ripple: true,
      }),
    ),
  ).toEqual({
    a: [0, 0, 20],
    b: [0, 20, 30],
    c: [0, 50, 30],
    music: [2, 0, 30],
    sting: [2, 60, 30],
  });
});

test("Q and W trim to the playhead and ripple the rest of the edit", () => {
  const talk = timeline([
    clip("talk", 0, 0, 90, { mediaStart: 1 }),
    clip("next", 0, 90, 60),
    clip("title", 1, 45, 30, { kind: "element", mediaStart: null }),
  ]);
  const q = run(talk, {
    type: "trim",
    clipId: "talk",
    edge: "start",
    to: 30,
    ripple: true,
  });
  expect(positions(q)).toEqual({
    talk: [0, 0, 60],
    next: [0, 60, 60],
    title: [1, 15, 30],
  });
  expect(q.clips[0]!.mediaStart).toBe(2);
  const w = run(talk, {
    type: "trim",
    clipId: "talk",
    edge: "end",
    to: 45,
    ripple: true,
  });
  expect(positions(w)).toEqual({
    talk: [0, 0, 45],
    next: [0, 45, 60],
  });
  expect(
    positions(
      run(talk, { type: "trim", clipId: "talk", edge: "start", to: 30 }),
    ),
  ).toEqual({ talk: [0, 30, 60], next: [0, 90, 60], title: [1, 45, 30] });
});

test("a linked group is one unit: trims move every partner's same edge", () => {
  // An interview cut: S2's sound leads its picture by 10 frames (a J-cut).
  const interview = timeline([
    clip("s1", 0, 0, 100, { link: "l1" }),
    clip("s1-sound", 1, 0, 90, { kind: "audio", link: "l1" }),
    clip("s2", 0, 100, 100, { link: "l2", mediaStart: 10 }),
    clip("s2-sound", 1, 90, 110, {
      kind: "audio",
      link: "l2",
      mediaStart: 9.666667,
    }),
  ]);
  const offFromMedia = (state: Timeline) =>
    state.clips
      .filter((item) => item.link === "l2")
      .map((item) => Math.round(item.mediaStart! * 30) - item.start);
  expect(offFromMedia(interview)).toEqual([200, 200]);
  const q = run(interview, {
    type: "trim",
    clipId: "s2",
    edge: "start",
    to: 110,
    ripple: true,
  });
  expect(offFromMedia(q)).toEqual([210, 210]);
  expect(positions(q)).toMatchObject({
    s2: [0, 100, 90],
    "s2-sound": [1, 90, 100],
  });
  const w = run(interview, {
    type: "trim",
    clipId: "s1",
    edge: "end",
    to: 80,
    ripple: true,
  });
  expect(positions(w)).toEqual({
    s1: [0, 0, 80],
    "s1-sound": [1, 0, 70],
    s2: [0, 80, 100],
    "s2-sound": [1, 70, 110],
  });
});

for (const [name, command, target] of [
  [
    "Q",
    { type: "trim", clipId: "edit", edge: "start", to: 60, ripple: true },
    clip("edit", 0, 30, 60),
  ],
  [
    "W",
    { type: "trim", clipId: "edit", edge: "end", to: 30, ripple: true },
    clip("edit", 0, 0, 60),
  ],
  [
    "delete",
    { type: "remove", clipIds: ["edit"], ripple: true },
    clip("edit", 0, 30, 30),
  ],
] satisfies [string, CommandInput, Clip][]) {
  test(`${name} removes exactly [30, 60), including partial overlaps on other tracks`, () => {
    const state = timeline([
      target,
      clip("next", 0, 90, 30),
      clip("span", 1, 0, 90, { mediaStart: 1, playbackRate: 2 }),
      clip("starts", 2, 45, 45, { mediaStart: 1 }),
      clip("ends", 3, 0, 45),
      clip("inside", 4, 40, 10),
      clip("before", 5, 0, 30),
      clip("after", 6, 60, 30),
      clip("exact", 7, 30, 30),
    ]);
    const result = run(state, command);
    expect(positions(result)).toEqual({
      ...(name === "Q"
        ? { edit: [0, 30, 30] }
        : name === "W"
          ? { edit: [0, 0, 30] }
          : {}),
      next: [0, 60, 30],
      span: [1, 0, 30],
      "span-2": [1, 30, 30],
      "starts-2": [2, 30, 30],
      ends: [3, 0, 30],
      before: [5, 0, 30],
      after: [6, 30, 30],
    });
    expect(result.clips.find((item) => item.id === "span-2")?.mediaStart).toBe(
      5,
    );
    expect(
      result.clips.find((item) => item.id === "starts-2")?.mediaStart,
    ).toBe(1.5);
    expect(positions(state).span).toEqual([1, 0, 90]);
  });

  for (const protection of [{ locked: true }, { autoSelect: false }]) {
    test(`${name} leaves ${Object.keys(protection)[0]} spanning clips alone and names linked blockers`, () => {
      const state = timeline(
        [
          target,
          clip("picture", 1, 0, 90),
          clip("bed", 2, 0, 90, { kind: "audio" }),
        ],
        [{ index: 2, kind: "audio", ...protection }],
      );
      const result = run(state, command);
      expect(result.clips.find((item) => item.id === "bed")).toEqual(
        state.clips.find((item) => item.id === "bed"),
      );
      const linked = {
        ...state,
        clips: state.clips.map((item) =>
          item.id === "edit" ? item : { ...item, link: "av" },
        ),
      };
      expect(() => run(linked, command)).toThrow("Clip bed");
      expect(failure(() => run(linked, command))).toBe("unsupported");
      // The selected clip's own partner cannot be edited through a protected track either.
      const selectedLink = {
        ...state,
        clips: state.clips.map((item) =>
          item.id === "picture" ? item : { ...item, link: "av" },
        ),
      };
      expect(() => run(selectedLink, command)).toThrow("Clip bed");
      expect(failure(() => run(selectedLink, command))).toBe("unsupported");
    });
  }
}

test("Q on the first clip cuts a music bed at zero without pulling it before the timeline", () => {
  const state = timeline([
    clip("talk", 0, 0, 90, { mediaStart: 1 }),
    clip("next", 0, 90, 30),
    clip("bed", 1, 0, 150, { kind: "audio", mediaStart: 2 }),
  ]);
  const result = run(state, {
    type: "trim",
    clipId: "talk",
    edge: "start",
    to: 30,
    ripple: true,
  });
  expect(positions(result)).toEqual({
    talk: [0, 0, 60],
    next: [0, 60, 30],
    "bed-2": [1, 0, 120],
  });
  expect(result.clips.map((item) => item.mediaStart)).toEqual([2, 0, 3]);
});

test("ripple delete cuts a linked L-cut tail under B-roll and preserves the earlier shot", () => {
  const state = timeline([
    clip("shot", 0, 0, 100, { link: "av", mediaStart: 2 }),
    clip("broll", 0, 100, 50),
    clip("next", 0, 150, 50, { link: "next-av", mediaStart: 6 }),
    clip("tail", 1, 0, 120, { kind: "audio", link: "av", mediaStart: 2 }),
    clip("next-sound", 1, 150, 50, {
      kind: "audio",
      link: "next-av",
      mediaStart: 6,
    }),
  ]);
  const result = run(state, {
    type: "remove",
    clipIds: ["broll"],
    ripple: true,
  });
  expect(positions(result)).toEqual({
    shot: [0, 0, 100],
    next: [0, 100, 50],
    tail: [1, 0, 100],
    "next-sound": [1, 100, 50],
  });
  expect(
    result.clips
      .filter((item) => item.link === "av")
      .map((item) => [item.link, item.mediaStart]),
  ).toEqual([
    ["av", 2],
    ["av", 2],
  ]);
});

test("ripple delete trims a J-cut head under B-roll and keeps its surviving source in sync", () => {
  const state = timeline([
    clip("broll", 0, 100, 50),
    clip("shot", 0, 150, 50, { link: "av", mediaStart: 2 }),
    clip("head", 1, 120, 80, { kind: "audio", link: "av", mediaStart: 1 }),
  ]);
  const result = run(state, {
    type: "remove",
    clipIds: ["broll"],
    ripple: true,
  });
  expect(positions(result)).toEqual({
    shot: [0, 100, 50],
    "head-2": [1, 100, 50],
  });
  expect(result.clips.map((item) => [item.link, item.mediaStart])).toEqual([
    ["av", 2],
    ["av", 2],
  ]);
});

test("ripple cuts linked spanning clips into matching groups on either side", () => {
  const state = timeline([
    clip("edit", 0, 30, 30),
    clip("picture", 1, 0, 90, { link: "av", mediaStart: 2 }),
    clip("sound", 2, 0, 90, { kind: "audio", link: "av", mediaStart: 2 }),
  ]);
  const result = run(state, {
    type: "remove",
    clipIds: ["edit"],
    ripple: true,
  });
  expect(
    result.clips.map((item) => [
      item.id,
      item.start,
      item.duration,
      item.mediaStart,
    ]),
  ).toEqual([
    ["picture", 0, 30, 2],
    ["picture-2", 30, 30, 4],
    ["sound", 0, 30, 2],
    ["sound-2", 30, 30, 4],
  ]);
  expect(result.clips.map((item) => item.link)).toEqual([
    "av",
    "lk-1",
    "av",
    "lk-1",
  ]);
});

test("ripple extensions cut overlapping clips and open exactly the added time", () => {
  const state = timeline([
    clip("edit", 0, 30, 30, { mediaStart: 1 }),
    clip("next", 0, 60, 30),
    clip("bed", 1, 0, 90, { kind: "audio", mediaStart: 2 }),
  ]);
  for (const [edge, to, boundary, mediaStart] of [
    ["start", 15, 30, 3],
    ["end", 75, 60, 4],
  ] as const) {
    const result = run(state, {
      type: "trim",
      clipId: "edit",
      edge,
      to,
      ripple: true,
    });
    expect(positions(result)).toEqual({
      edit: [0, 30, 45],
      next: [0, 75, 30],
      bed: [1, 0, boundary],
      "bed-2": [1, boundary + 15, 90 - boundary],
    });
    expect(result.clips.find((item) => item.id === "bed-2")?.mediaStart).toBe(
      mediaStart,
    );
  }
});

test("ripple delete removes the union of selected linked spans without a smallest-gap holdback", () => {
  const interview = timeline([
    clip("s1", 0, 0, 100, { link: "l1" }),
    clip("s1-sound", 1, 0, 90, { kind: "audio", link: "l1" }),
    clip("s2", 0, 100, 100, { link: "l2" }),
    clip("s2-sound", 1, 90, 110, { kind: "audio", link: "l2" }),
    clip("broll", 0, 200, 50),
    clip("title", 2, 150, 30, { kind: "element", mediaStart: null }),
  ]);
  expect(
    positions(
      run(interview, { type: "remove", clipIds: ["s1"], ripple: true }),
    ),
  ).toEqual({
    s2: [0, 0, 100],
    "s2-sound-2": [1, 0, 100],
    broll: [0, 100, 50],
    title: [2, 50, 30],
  });
  const take = timeline([
    clip("take", 0, 0, 200, { link: "l1" }),
    clip("take-sound", 1, 0, 200, { kind: "audio", link: "l1" }),
  ]);
  expect(
    positions(
      run(
        take,
        { type: "split", at: 100 },
        { type: "remove", clipIds: ["take"], ripple: true },
      ),
    ),
  ).toEqual({ "take-2": [0, 0, 100], "take-sound-2": [1, 0, 100] });
});

test("separate ripple deletions preserve the unselected interval between them", () => {
  const state = timeline([
    clip("first", 0, 30, 30),
    clip("second", 0, 90, 30),
    clip("bed", 1, 0, 150, { kind: "audio" }),
  ]);
  const result = run(state, {
    type: "remove",
    clipIds: ["first", "second"],
    ripple: true,
  });
  expect(
    result.clips.map((item) => [item.start, item.duration, item.mediaStart]),
  ).toEqual([
    [0, 30, 0],
    [30, 30, 2],
    [60, 30, 4],
  ]);
});

test("cuts keep a piece linked while it still overlaps its partner", () => {
  const lead = timeline([
    clip("s2", 0, 100, 100, { link: "l2" }),
    clip("s2-sound", 1, 90, 110, { kind: "audio", link: "l2" }),
  ]);
  const inserted = run(lead, {
    type: "insert",
    mode: "insert",
    track: 1,
    at: 95,
    clip: { kind: "audio", src: "sting.wav", duration: 10 },
  });
  expect(
    inserted.clips.map((item) => [
      item.id,
      item.start,
      item.duration,
      item.link,
    ]),
  ).toEqual([
    ["s2", 110, 100, "l2"],
    ["s2-sound", 90, 5, null],
    ["sting", 95, 10, null],
    ["s2-sound-2", 105, 105, "l2"],
  ]);
  const covered = run(lead, {
    type: "insert",
    mode: "overwrite",
    track: 0,
    at: 120,
    clip: { kind: "video", src: "broll.mp4", duration: 20 },
  });
  expect(covered.clips.map((item) => [item.id, item.link])).toEqual([
    ["s2", "l2"],
    ["broll", null],
    ["s2-2", "l2"],
    ["s2-sound", "l2"],
  ]);
});

test("a linked group that cannot move together is refused by name", () => {
  // Pushing B pulls its sound on a deselected track into the outro there.
  const blocked = timeline(
    [
      clip("a", 0, 0, 100),
      clip("b", 0, 100, 100, { link: "lb" }),
      clip("b-sound", 1, 50, 150, { kind: "audio", link: "lb" }),
      clip("outro", 1, 200, 30, { kind: "audio" }),
    ],
    [{ index: 1, kind: "audio", autoSelect: false }],
  );
  const error = (() => {
    try {
      run(blocked, {
        type: "insert",
        mode: "insert",
        track: 0,
        at: 100,
        clip: { kind: "video", src: "x.mp4", duration: 10 },
      });
    } catch (caught) {
      return caught;
    }
  })();
  expect(error).toBeInstanceOf(TimelineError);
  expect(error).toMatchObject({ code: "unsupported" });
  expect(String(error)).toContain("b-sound");
});

test("razor cuts auto-select tracks and linked partners, which stay linked", () => {
  const linked = timeline(
    [
      clip("video", 0, 0, 90, { link: "lk-1", mediaStart: 2 }),
      clip("title", 1, 0, 90, { kind: "element", mediaStart: null, src: null }),
      clip("voice", 3, 0, 90, { kind: "audio", link: "lk-1", mediaStart: 2 }),
    ],
    [
      { index: 1, autoSelect: false },
      { index: 3, kind: "audio", autoSelect: false },
    ],
  );
  const cut = run(linked, { type: "split", at: 30 });
  expect(positions(cut)).toEqual({
    video: [0, 0, 30],
    "video-2": [0, 30, 60],
    title: [1, 0, 90],
    voice: [3, 0, 30],
    "voice-2": [3, 30, 60],
  });
  const right = cut.clips.filter((item) => item.id.endsWith("-2"));
  expect(right.map((item) => [item.link, item.mediaStart])).toEqual([
    ["lk-2", 3],
    ["lk-2", 3],
  ]);
  const moved = run(cut, { type: "move", clipIds: ["video-2"], by: 30 });
  expect(positions(moved)["voice-2"]).toEqual([3, 60, 60]);
  const trimmed = run(cut, {
    type: "trim",
    clipId: "voice",
    edge: "end",
    to: 20,
  });
  expect([positions(trimmed).video, positions(trimmed).voice]).toEqual([
    [0, 0, 20],
    [3, 0, 20],
  ]);
});

test("insert edits place, overwrite, or push the timeline", () => {
  const media = {
    type: "insert",
    track: 0,
    at: 15,
    clip: { kind: "video", src: "media/B Roll.mp4", duration: 10 },
  } as const;
  expect(failure(() => run(edit, media))).toBe("overlap");
  expect(positions(run(edit, { ...media, mode: "overwrite" }))).toMatchObject({
    a: [0, 0, 15],
    "b-roll": [0, 15, 10],
    "a-2": [0, 25, 5],
    b: [0, 30, 30],
  });
  const interview = timeline([
    clip("talk", 0, 0, 60, { link: "lk-1" }),
    clip("dialogue", 1, 0, 60, { kind: "audio", link: "lk-1" }),
  ]);
  expect(positions(run(interview, { ...media, mode: "overwrite" }))).toEqual({
    talk: [0, 0, 15],
    "b-roll": [0, 15, 10],
    "talk-2": [0, 25, 35],
    dialogue: [1, 0, 60],
  });
  expect(positions(run(edit, { ...media, mode: "insert" }))).toEqual({
    a: [0, 0, 15],
    "b-roll": [0, 15, 10],
    "a-2": [0, 25, 15],
    b: [0, 40, 30],
    c: [0, 70, 30],
    music: [2, 0, 15],
    "music-2": [2, 25, 15],
    sting: [2, 70, 30],
  });
});

test("commands that cannot apply exactly fail with typed errors", () => {
  expect(
    failure(() => run(edit, { type: "move", clipIds: ["a"], by: 10 })),
  ).toBe("overlap");
  expect(
    failure(() =>
      run(edit, { type: "trim", clipId: "b", edge: "start", to: 0 }),
    ),
  ).toBe("out_of_bounds");
  expect(
    failure(() => run(edit, { type: "split", at: 30, clipIds: ["b"] })),
  ).toBe("out_of_bounds");
  expect(failure(() => run(edit, { type: "setRange", in: 60, out: 30 }))).toBe(
    "out_of_bounds",
  );
  expect(
    failure(() => run(edit, { type: "remove", clipIds: ["missing"] })),
  ).toBe("not_found");
  const source = timeline([
    clip("talk", 0, 0, 90, { mediaStart: 0.5, sourceDuration: 4 }),
  ]);
  const extend = (to: number) =>
    run(source, { type: "trim", clipId: "talk", edge: "end", to });
  expect(positions(extend(105)).talk).toEqual([0, 0, 105]);
  expect(failure(() => extend(106))).toBe("out_of_bounds");
  const tooLong = () =>
    applyAll(
      timeline([]),
      [
        CommandSchema.parse({
          type: "insert",
          track: 0,
          at: 0,
          clip: { kind: "video", src: "short.mp4", duration: 91 },
        }),
      ],
      { mediaLengths: new Map([["short.mp4", 3]]) },
    );
  expect(failure(tooLong)).toBe("out_of_bounds");
  const batch = () =>
    run(
      edit,
      { type: "remove", clipIds: ["a"] },
      { type: "move", clipIds: ["b"], by: -40 },
    );
  expect(batch).toThrow("Command 2 (move)");
  expect(edit.clips).toHaveLength(5);
});

test("a batch never reuses an id, so every copy comes from original markup", () => {
  const origins = new Map<string, ClipOrigin>();
  const state = applyAll(
    timeline([clip("a", 0, 0, 240)]),
    [
      { type: "split", at: 60 },
      { type: "remove", clipIds: ["a"] },
      { type: "split", at: 120, clipIds: ["a-2"] },
      { type: "remove", clipIds: ["a-2"] },
      { type: "split", at: 180, clipIds: ["a-3"] },
    ].map((command) => CommandSchema.parse(command)),
    { onCreate: (id, origin) => origins.set(id, origin) },
  );
  expect(state.clips.map((item) => item.id)).toEqual(["a-3", "a-4"]);
  expect([...origins.values()]).toEqual([
    { copyOf: "a" },
    { copyOf: "a" },
    { copyOf: "a" },
  ]);
});

test("placing the first clip in an empty composition keeps its length", () => {
  const empty = timeline([]);
  expect(empty.duration).toBe(300);
  expect(
    run(empty, {
      type: "insert",
      track: 0,
      at: 0,
      clip: { kind: "video", src: "intro.mp4", duration: 30 },
    }).duration,
  ).toBe(300);
});

test("a root kept shorter than its content does not grow after a ripple delete", () => {
  const cutOff = timeline([clip("a", 0, 0, 30), clip("b", 0, 30, 330)]);
  expect(cutOff.duration).toBe(300);
  expect(
    run(cutOff, { type: "remove", clipIds: ["a"], ripple: true }).duration,
  ).toBe(300);
});

test("track kinds are stored, so an empty locked audio track stays audio", () => {
  const state = run(timeline([clip("v", 0, 0, 30)]), {
    type: "setTrack",
    index: 1,
    kind: "audio",
    locked: true,
  });
  expect(state.tracks.map((track) => [track.index, track.kind])).toEqual([
    [0, "video"],
    [1, "audio"],
  ]);
  expect(
    failure(() =>
      run(
        state,
        { type: "setTrack", index: 1, locked: false },
        {
          type: "move",
          clipIds: ["v"],
          trackBy: 1,
        },
      ),
    ),
  ).toBe("track_kind");
  expect(
    failure(() => run(state, { type: "setTrack", index: 0, kind: "audio" })),
  ).toBe("track_kind");
});
