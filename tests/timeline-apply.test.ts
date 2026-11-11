import { expect, test } from "bun:test";
import {
  TimelineError,
  applyAll,
  normalizeTimeline,
} from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import { CommandSchema } from "../src/shared/timeline/schema";
import { countingIds } from "./clip-ids";
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
  hasAudio: false,
  link: null,
  label: null,
  volume: null,
  opacity: null,
  x: null,
  y: null,
  fadeIn: 0,
  fadeOut: 0,
  automation: null,
  enabled: true,
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
      enabled: true,
      muted: false,
      solo: false,
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
    { newId: countingIds },
  );

const positions = (state: Timeline) =>
  Object.fromEntries(
    state.clips.map((item) => [
      item.id,
      [item.track, item.start, item.duration],
    ]),
  );

test("auto-select razor cuts supported clips and reports the title it leaves whole", () => {
  const title = clip("lower", 1, 0, 180, {
    kind: "element",
    label: "Lower third",
    src: null,
    mediaStart: null,
    sourceRestrictions: {
      copy: "Clip lower is animated by its id. Edit it in the source instead.",
    },
  });
  const state = timeline([clip("picture", 0, 0, 180), title]);
  const skipped: string[] = [];
  const result = applyAll(
    state,
    [
      CommandSchema.parse({
        type: "split",
        at: 90,
        clipIds: ["picture", "lower"],
        autoSelect: true,
      }),
    ],
    {
      newId: countingIds,
      onSkip: (clip, reason) => {
        skipped.push(clip.id);
        expect(reason).toContain("animated by its id");
      },
    },
  );
  expect(positions(result)).toEqual({
    picture: [0, 0, 90],
    "picture-2": [0, 90, 90],
    lower: [1, 0, 180],
  });
  expect(result.clips.find((clip) => clip.id === "lower")).toEqual(title);
  expect(skipped).toEqual(["lower"]);
  for (const clipIds of [["lower"], ["picture", "lower"]])
    expect(() => run(state, { type: "split", at: 90, clipIds })).toThrow(
      "Edit it in the source instead.",
    );
  expect(run(timeline([title]), { type: "split", at: 90 }).clips).toEqual([
    title,
  ]);
});

test("auto-select leaves a restricted clip's linked group whole", () => {
  const state = timeline([
    clip("picture", 0, 0, 180, { link: "pair" }),
    clip("sound", 1, 0, 180, {
      kind: "audio",
      link: "pair",
      sourceRestrictions: { copy: "Cannot copy sound." },
    }),
    clip("other", 2, 0, 180),
  ]);
  const result = run(state, { type: "split", at: 90 });
  expect(positions(result)).toEqual({
    picture: [0, 0, 180],
    sound: [1, 0, 180],
    other: [2, 0, 90],
    "other-2": [2, 90, 90],
  });
});

for (const [name, command, expected] of [
  [
    "Q",
    { type: "trim", clipId: "shot", edge: "start", to: 90, ripple: true },
    { shot: [0, 60, 30], later: [0, 90, 360] },
  ],
  [
    "W",
    { type: "trim", clipId: "shot", edge: "end", to: 90, ripple: true },
    { shot: [0, 60, 30], later: [0, 90, 360] },
  ],
  [
    "Shift+X",
    { type: "remove", clipIds: ["shot"], ripple: true },
    { later: [0, 60, 360] },
  ],
  [
    "ripple extension",
    { type: "trim", clipId: "shot", edge: "start", to: 30, ripple: true },
    { shot: [0, 60, 90], later: [0, 150, 360] },
  ],
  [
    "insert ripple",
    {
      type: "insert",
      track: 0,
      at: 120,
      mode: "insert",
      clip: { id: "inserted", kind: "image", src: "still.png", duration: 30 },
    },
    { shot: [0, 60, 60], inserted: [0, 120, 30], later: [0, 150, 360] },
  ],
] satisfies [string, CommandInput, Record<string, number[]>][]) {
  for (const kind of ["element", "audio"] as const) {
    test(`${name} refuses a spanning restricted ${kind} atomically until its track opts out`, () => {
      const state = timeline(
        [
          clip("shot", 0, 60, 60, { mediaStart: 2 }),
          clip("later", 0, 120, 360),
          clip("restricted", 1, 0, 300, {
            kind,
            label: kind === "audio" ? "Voiceover" : "Lower third",
            sourceRestrictions: { copy: "Cannot copy restricted." },
          }),
          clip("later-cue", 1, 420, 60, { kind }),
        ],
        [{ index: 1, kind: kind === "audio" ? "audio" : "video" }],
      );
      const before = structuredClone(state);
      const onSkip = () => {
        throw new Error("A ripple must never skip a clip.");
      };
      const track = kind === "audio" ? "A1" : "V2";
      const label = kind === "audio" ? "Voiceover" : "Lower third";
      expect(() =>
        applyAll(state, [CommandSchema.parse(command)], { onSkip }),
      ).toThrow(
        `Command 1 (${command.type}): ${label} on ${track} can't be cut here. Turn off auto-select on ${track} to ripple without it.`,
      );
      expect(state).toEqual(before);
      const result = run(
        state,
        { type: "setTrack", index: 1, autoSelect: false },
        command,
      );
      expect(positions(result)).toEqual({
        ...expected,
        restricted: [1, 0, 300],
        "later-cue": [1, 420, 60],
      });
      expect(result.clips.filter((clip) => clip.track === 1)).toEqual(
        state.clips.filter((clip) => clip.track === 1),
      );
    });
  }
}

test("a ripple refuses a fully covered clip whose source cannot be removed", () => {
  const state = timeline([
    clip("shot", 0, 60, 60, { mediaStart: 2 }),
    clip("later", 0, 120, 360),
    clip("restricted", 1, 60, 60, {
      label: "Lower third",
      sourceRestrictions: { remove: "Cannot remove restricted." },
    }),
  ]);
  expect(() =>
    run(state, { type: "remove", clipIds: ["shot"], ripple: true }),
  ).toThrow(
    "Lower third on V2 can't be cut here. Turn off auto-select on V2 to ripple without it.",
  );
});

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

test("a trim past an overwritten sound partner names the sound, not the picture", () => {
  const overwritten = run(
    timeline([
      clip("picture", 0, 0, 90, { link: "pair" }),
      clip("sound", 2, 0, 90, { kind: "audio", link: "pair" }),
    ]),
    {
      type: "insert",
      track: 2,
      at: 30,
      mode: "overwrite",
      clip: { src: "tone.wav", kind: "audio", duration: 60 },
    },
  );
  expect(() =>
    run(overwritten, {
      type: "trim",
      clipId: "picture",
      edge: "start",
      to: 60,
      ripple: true,
    }),
  ).toThrow("Command 1 (trim): Clip sound would be shorter than one frame.");
});

test("a refused move names the locked destination track", () => {
  const locked = timeline(
    [clip("picture", 0, 0, 90)],
    [{ index: 1, locked: true }],
  );
  expect(() =>
    run(locked, { type: "move", clipIds: ["picture"], trackBy: 1 }),
  ).toThrow("Command 1 (move): Track 1 is locked.");
});

test("a picture refused on an audio track uses the right article", () => {
  const edit = timeline(
    [clip("picture", 0, 0, 90)],
    [{ index: 1, kind: "audio" }],
  );
  expect(() =>
    run(edit, { type: "move", clipIds: ["picture"], trackBy: 1 }),
  ).toThrow(
    "Command 1 (move): Clip picture is picture and track 1 is an audio track.",
  );
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
      starts: [2, 30, 30],
      ends: [3, 0, 30],
      before: [5, 0, 30],
      after: [6, 30, 30],
    });
    expect(result.clips.find((item) => item.id === "span-2")?.mediaStart).toBe(
      5,
    );
    expect(result.clips.find((item) => item.id === "starts")?.mediaStart).toBe(
      1.5,
    );
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
      // Selecting a clip cannot edit its locked partner either.
      if (!protection.locked) return;
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

for (const [name, command, expected] of [
  [
    "Q",
    { type: "trim", clipId: "shot", edge: "start", to: 30, ripple: true },
    {
      shot: [0, 0, 60],
      sound: [1, 0, 60],
      next: [0, 60, 30],
      "next-sound": [1, 60, 30],
    },
  ],
  [
    "W",
    { type: "trim", clipId: "shot", edge: "end", to: 60, ripple: true },
    {
      shot: [0, 0, 60],
      sound: [1, 0, 60],
      next: [0, 60, 30],
      "next-sound": [1, 60, 30],
    },
  ],
  [
    "Shift+X",
    { type: "remove", clipIds: ["shot"], ripple: true },
    { next: [0, 0, 30], "next-sound": [1, 0, 30] },
  ],
] satisfies [string, CommandInput, Record<string, number[]>][]) {
  test(`${name} ripples explicitly edited auto-select-off tracks and their partners`, () => {
    const state = timeline(
      [
        clip("shot", 0, 0, 90, { link: "av" }),
        clip("sound", 1, 0, 90, { kind: "audio", link: "av" }),
        clip("next", 0, 90, 30, { link: "next-av" }),
        clip("next-sound", 1, 90, 30, { kind: "audio", link: "next-av" }),
        clip("excluded", 2, 0, 150),
      ],
      [
        { index: 0, autoSelect: false },
        { index: 1, kind: "audio", autoSelect: false },
        { index: 2, autoSelect: false },
      ],
    );
    expect(positions(run(state, command))).toEqual({
      ...expected,
      excluded: [2, 0, 150],
    });
  });
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
    bed: [1, 0, 120],
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
    head: [1, 100, 50],
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
    "s2-sound": [1, 0, 100],
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

test("deleting a J-cut pair trims the preceding picture inside the selected union", () => {
  const state = timeline([
    clip("previous", 0, 0, 100, { link: "previous-av", mediaStart: 2 }),
    clip("previous-sound", 1, 0, 90, {
      kind: "audio",
      link: "previous-av",
      mediaStart: 2,
    }),
    clip("shot", 0, 100, 100, { link: "av", mediaStart: 10 }),
    clip("head", 1, 90, 110, {
      kind: "audio",
      link: "av",
      mediaStart: 9.666667,
    }),
  ]);
  const result = run(state, {
    type: "remove",
    clipIds: ["shot"],
    ripple: true,
  });
  expect(positions(result)).toEqual({
    previous: [0, 0, 90],
    "previous-sound": [1, 0, 90],
  });
  expect(result.clips.map((item) => [item.link, item.mediaStart])).toEqual([
    ["previous-av", 2],
    ["previous-av", 2],
  ]);
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

test("range trims unlink survivors when their only overlap was removed", () => {
  const state = timeline([
    clip("v", 0, 0, 40, { link: "av" }),
    clip("a", 1, 30, 40, { kind: "audio", link: "av", mediaStart: 1 }),
    clip("edit", 2, 30, 30),
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
      item.link,
      item.mediaStart,
    ]),
  ).toEqual([
    ["v", 0, 30, null, 0],
    ["a", 30, 10, null, 2],
  ]);
  expect(positions(run(result, { type: "remove", clipIds: ["v"] }))).toEqual({
    a: [1, 30, 10],
  });
});

test("linked interval sweep lifts only surviving overlapping partners after Q, W, and delete", () => {
  const intervals: [number, number][] = [];
  for (let start = 0; start < 100; start += 10)
    for (let end = start + 10; end <= 100; end += 10)
      intervals.push([start, end]);
  const edits: [Clip, CommandInput][] = [
    [
      clip("edit", 2, 30, 60),
      { type: "trim", clipId: "edit", edge: "start", to: 60, ripple: true },
    ],
    [
      clip("edit", 2, 0, 60),
      { type: "trim", clipId: "edit", edge: "end", to: 30, ripple: true },
    ],
    [
      clip("edit", 2, 30, 30),
      { type: "remove", clipIds: ["edit"], ripple: true },
    ],
  ];
  let cases = 0;
  for (const [vStart, vEnd] of intervals)
    for (const [aStart, aEnd] of intervals) {
      if (Math.max(vStart, aStart) >= Math.min(vEnd, aEnd)) continue;
      for (const [target, command] of edits) {
        const result = run(
          timeline([
            clip("v", 0, vStart, vEnd - vStart, { link: "av" }),
            clip("a", 1, aStart, aEnd - aStart, { kind: "audio", link: "av" }),
            target,
          ]),
          command,
        );
        const survivors = result.clips.filter((item) => item.track !== 2);
        for (const item of survivors) {
          const partners = survivors.filter(
            (other) =>
              other !== item &&
              Math.max(item.start, other.start) <
                Math.min(
                  item.start + item.duration,
                  other.start + other.duration,
                ),
          );
          expect(item.link === null).toBe(partners.length === 0);
          const lifted = run(result, { type: "remove", clipIds: [item.id] });
          expect(lifted.clips.map((other) => other.id).toSorted()).toEqual(
            result.clips
              .filter((other) => other !== item && !partners.includes(other))
              .map((other) => other.id)
              .toSorted(),
          );
        }
        cases++;
      }
    }
  expect(cases).toBe(6_105);
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
    clip: { kind: "video", src: "broll.mp4", duration: 20, muted: true },
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
    clip: { kind: "video", src: "media/B Roll.mp4", duration: 10, muted: true },
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
    failure(() =>
      run(edit, { type: "move", clipIds: ["a"], by: 10, mode: "place" }),
    ),
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

test("moves overwrite partial and full clips without rippling or changing the moved source", () => {
  const state = timeline([
    clip("moving", 0, 0, 60, { mediaStart: 2, playbackRate: 2 }),
    clip("head", 0, 90, 30),
    clip("covered", 0, 120, 20),
    clip("tail", 0, 140, 60, { mediaStart: 3, playbackRate: 2 }),
    clip("later", 0, 210, 30),
  ]);
  const result = run(state, { type: "move", clipIds: ["moving"], by: 100 });
  expect(positions(result)).toEqual({
    moving: [0, 100, 60],
    head: [0, 90, 10],
    tail: [0, 160, 40],
    later: [0, 210, 30],
  });
  expect(result.clips.find((item) => item.id === "tail")?.mediaStart).toBe(
    4 + 1 / 3,
  );
  expect(result.clips.find((item) => item.id === "moving")).toMatchObject({
    mediaStart: 2,
    playbackRate: 2,
    duration: 60,
  });
  expect(state.clips).toHaveLength(5);
});

test("an overwrite move splits a spanning clip with a fresh stable id", () => {
  const state = timeline([
    clip("moving", 0, 0, 30),
    clip("under", 0, 60, 120, { mediaStart: 1, playbackRate: 2 }),
  ]);
  const input = {
    type: "move",
    clipIds: ["moving"],
    by: 90,
    ids: { under: ["under-tail"] },
  } satisfies CommandInput;
  const command = CommandSchema.parse(input);
  const origins = new Map<string, ClipOrigin>();
  const result = applyAll(state, [command], {
    onCreate: (id, origin) => origins.set(id, origin),
  });
  expect(positions(result)).toEqual({
    moving: [0, 90, 30],
    under: [0, 60, 30],
    "under-tail": [0, 120, 60],
  });
  expect(
    result.clips.find((item) => item.id === "under-tail")?.mediaStart,
  ).toBe(5);
  expect(origins.get("under-tail")).toEqual({ copyOf: "under" });
  expect(
    failure(() =>
      applyAll(state, [command], { retired: new Set(["under-tail"]) }),
    ),
  ).toBe("duplicate_id");
  expect(
    failure(() => run(state, { ...input, ids: { under: ["moving"] } })),
  ).toBe("duplicate_id");
});

test("linked moves overwrite each partner's own range, including on a deselected track", () => {
  const state = timeline(
    [
      clip("picture", 0, 0, 30, { link: "pair" }),
      clip("sound", 2, 0, 45, { kind: "audio", link: "pair" }),
      clip("under", 1, 60, 120),
      clip("bed", 2, 60, 120, { kind: "audio" }),
      clip("other", 0, 90, 30),
    ],
    [{ index: 2, kind: "audio", autoSelect: false }],
  );
  const command = {
    type: "move",
    clipIds: ["picture"],
    by: 90,
    trackBy: 1,
  } satisfies CommandInput;
  expect(positions(run(state, command))).toEqual({
    picture: [1, 90, 30],
    sound: [2, 90, 45],
    other: [0, 90, 30],
    under: [1, 60, 30],
    "under-2": [1, 120, 60],
    bed: [2, 60, 30],
    "bed-2": [2, 135, 45],
  });
  const alone = run(state, { ...command, linked: false });
  expect(alone.clips.find((item) => item.id === "sound")?.start).toBe(0);
  expect(alone.clips.find((item) => item.id === "bed")?.duration).toBe(120);
  for (const index of [0, 1, 2]) {
    const locked = {
      ...state,
      tracks: state.tracks.map((track) =>
        track.index === index ? { ...track, locked: true } : track,
      ),
    };
    expect(failure(() => run(locked, command))).toBe("locked");
  }
  // Moving only the picture vertically leaves its stationary partner's track alone,
  // including any authored overlaps on that locked track.
  const vertical = timeline(
    [
      clip("picture", 0, 0, 30, { link: "pair" }),
      clip("sound", 2, 0, 30, { kind: "audio", link: "pair" }),
      clip("bed", 2, 0, 120, { kind: "audio" }),
    ],
    [{ index: 2, kind: "audio", locked: true }],
  );
  expect(positions(run(vertical, { ...command, by: 0 }))).toEqual({
    picture: [1, 0, 30],
    sound: [2, 0, 30],
    bed: [2, 0, 120],
  });
});

test("a moving selection never overwrites itself, including mixed kinds changing tracks", () => {
  const state = timeline([
    clip("a", 0, 0, 30),
    clip("b", 0, 30, 30),
    clip("sound", 2, 30, 30, { kind: "audio" }),
    clip("under", 1, 0, 150),
  ]);
  expect(
    positions(
      run(state, {
        type: "move",
        clipIds: ["a", "b", "sound"],
        by: 30,
        trackBy: 1,
        trackClipIds: ["a", "b"],
      }),
    ),
  ).toEqual({
    a: [1, 30, 30],
    b: [1, 60, 30],
    sound: [2, 60, 30],
    under: [1, 0, 30],
    "under-2": [1, 90, 60],
  });
  expect(
    positions(run(state, { type: "move", clipIds: ["a", "b"], by: 30 })),
  ).toMatchObject({
    a: [0, 30, 30],
    b: [0, 60, 30],
  });
  expect(
    failure(() =>
      run(state, { type: "move", clipIds: ["a"], by: 30, trackClipIds: ["b"] }),
    ),
  ).toBe("unsupported");
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
    {
      onCreate: (id, origin) => origins.set(id, origin),
      newId: countingIds,
    },
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

test("every piece a command cuts takes the caller's ids in order, and spent ids are refused", () => {
  // Shots 2 and 4 ripple delete under a title spanning all four: the title is cut twice.
  const state = timeline([
    clip("s1", 0, 0, 60),
    clip("s2", 0, 60, 60),
    clip("s3", 0, 120, 60),
    clip("s4", 0, 180, 60),
    clip("title", 1, 30, 240, { kind: "element", src: null, mediaStart: null }),
  ]);
  const remove = (ids?: Record<string, string[]>) =>
    CommandSchema.parse({
      type: "remove",
      clipIds: ["s2", "s4"],
      ripple: true,
      ids,
    });
  const cut = applyAll(state, [
    remove({ title: ["title-after-s4", "title-after-s2"] }),
  ]);
  expect(positions(cut)).toEqual({
    s1: [0, 0, 60],
    s3: [0, 60, 60],
    title: [1, 30, 30],
    "title-after-s2": [1, 60, 60],
    "title-after-s4": [1, 120, 30],
  });
  // A short list names the first pieces; the rest get new random ids.
  const short = applyAll(state, [remove({ title: ["title-tail"] })]);
  expect(short.clips.map((item) => item.id)).toEqual([
    "s1",
    "s3",
    "title",
    expect.stringMatching(/^title-[a-z0-9]{6}$/),
    "title-tail",
  ]);
  // An id in the timeline, or one the project used before, is refused.
  expect(() => applyAll(state, [remove({ title: ["s1"] })])).toThrow(
    "A clip already has id s1.",
  );
  expect(() =>
    applyAll(state, [remove({ title: ["old"] })], {
      retired: new Set(["old"]),
    }),
  ).toThrow("Id old was used earlier in this project.");
});

test("video overwrite clears matching picture-sound ranges, including fully covered picture, without rippling music", () => {
  for (const duration of [60, 180]) {
    const state = timeline([
      clip("interview", 0, 30, 120, { link: "interview" }),
      clip("dialogue", 1, 0, 180, { kind: "audio", link: "interview" }),
      clip("music", 2, 0, 300, { kind: "audio" }),
      clip("later", 0, 240, 30),
    ]);
    const next = run(state, {
      type: "insert",
      mode: "overwrite",
      track: 0,
      at: 0,
      clip: { id: "b-roll", kind: "video", src: "b-roll.mp4", duration },
      linkedAudio: { id: "b-roll-audio" },
    });
    expect(next.clips.find((clip) => clip.id === "b-roll-audio")).toMatchObject(
      {
        track: 1,
        start: 0,
        duration,
        link: "b-roll",
      },
    );
    expect(next.clips.find((clip) => clip.id === "music")).toEqual(
      state.clips.find((clip) => clip.id === "music"),
    );
    expect(next.clips.find((clip) => clip.id === "later")).toEqual(
      state.clips.find((clip) => clip.id === "later"),
    );
    if (duration === 180) {
      expect(
        next.clips.some(
          (clip) => clip.id === "interview" || clip.id === "dialogue",
        ),
      ).toBe(false);
    } else {
      expect(next.clips.find((clip) => clip.id === "interview")).toMatchObject({
        start: 60,
        duration: 90,
        mediaStart: 1,
      });
      expect(next.clips.find((clip) => clip.id === "dialogue")).toMatchObject({
        start: 60,
        duration: 120,
        mediaStart: 2,
      });
    }
  }
});

test("video overwrite routes sound to the overwritten picture's partner instead of another pair", () => {
  for (const duration of [60, 180]) {
    const state = timeline([
      clip("background", 0, 0, 300, { link: "background" }),
      clip("background-sound", 2, 0, 300, {
        kind: "audio",
        link: "background",
      }),
      clip("interview", 1, 30, 120, { link: "interview" }),
      clip("dialogue", 3, 0, 180, { kind: "audio", link: "interview" }),
    ]);
    const command: CommandInput = {
      type: "insert",
      mode: "overwrite",
      track: 1,
      at: 0,
      clip: { id: "b-roll", kind: "video", src: "b-roll.mp4", duration },
      linkedAudio: { id: "b-roll-audio" },
    };
    const next = run(state, command);
    expect(
      next.clips.filter((clip) => clip.track === 0 || clip.track === 2),
    ).toEqual(
      state.clips.filter((clip) => clip.track === 0 || clip.track === 2),
    );
    expect(next.clips.find((clip) => clip.id === "b-roll-audio")).toMatchObject(
      {
        track: 3,
        start: 0,
        duration,
        link: "b-roll",
      },
    );
    expect(
      next.clips
        .filter((clip) => clip.src === "talk.mp4" && clip.track === 3)
        .map((clip) => [clip.start, clip.duration]),
    ).toEqual(duration === 180 ? [] : [[60, 120]]);
    expect(
      failure(() =>
        run(state, { type: "setTrack", index: 3, locked: true }, command),
      ),
    ).toBe("locked");
  }
});

test("overwriting a silent picture never cuts another picture's sound on the fallback track", () => {
  const state = timeline([
    clip("talk", 0, 0, 180, { link: "talk" }),
    clip("talk-sound", 2, 0, 180, { kind: "audio", link: "talk" }),
    clip("title", 1, 100, 100),
  ]);
  const next = run(state, {
    type: "insert",
    mode: "overwrite",
    track: 1,
    at: 120,
    clip: { id: "b-roll", kind: "video", src: "b-roll.mp4", duration: 60 },
    linkedAudio: { id: "b-roll-sound" },
  });
  // The dialogue under the drop is another pair's sound: it stays whole.
  expect(next.clips.find((clip) => clip.id === "talk-sound")).toEqual(
    state.clips.find((clip) => clip.id === "talk-sound"),
  );
  const sound = next.clips.find((clip) => clip.id === "b-roll-sound")!;
  expect(sound.track).not.toBe(2);
  expect(
    next.clips.some(
      (clip) =>
        clip.id !== sound.id &&
        clip.track === sound.track &&
        clip.start < sound.start + sound.duration &&
        clip.start + clip.duration > sound.start,
    ),
  ).toBe(false);
});

test("overwrite keeps the existing audio fallback without a partner and refuses multiple partner destinations", () => {
  const state = timeline([
    clip("first", 0, 0, 30, { link: "first" }),
    clip("first-sound", 2, 0, 30, { kind: "audio", link: "first" }),
    clip("second", 0, 30, 30, { link: "second" }),
    clip("second-sound", 3, 30, 30, { kind: "audio", link: "second" }),
    clip("music", 4, 0, 300, { kind: "audio" }),
  ]);
  const command: CommandInput = {
    type: "insert",
    mode: "overwrite",
    track: 0,
    at: 90,
    clip: { id: "b-roll", kind: "video", src: "b-roll.mp4", duration: 60 },
    linkedAudio: { id: "b-roll-sound" },
  };
  const fallback = run(state, command);
  expect(
    fallback.clips.find((clip) => clip.id === "b-roll-sound"),
  ).toMatchObject({ track: 2 });
  expect(fallback.clips.filter((clip) => clip.src === "talk.mp4")).toEqual(
    state.clips,
  );
  expect(failure(() => run(state, { ...command, at: 0 }))).toBe("unsupported");
});

test("setMarker on an existing marker changes only the fields it names", () => {
  const added = run(timeline([]), {
    type: "setMarker",
    id: "beat",
    frame: 60,
    duration: 15,
    name: "Downbeat",
    note: "Keep this cue",
    color: "green",
  });
  // An agent moves the marker; a rename made against the older view must not revert that.
  const moved = run(added, {
    type: "setMarker",
    id: "beat",
    frame: 90,
    note: "Agent moved this",
  });
  expect(
    run(moved, { type: "setMarker", id: "beat", name: "Drop" }).markers,
  ).toEqual([
    {
      id: "beat",
      frame: 90,
      duration: 15,
      name: "Drop",
      note: "Agent moved this",
      color: "green",
    },
  ]);
  expect(
    failure(() => run(timeline([]), { type: "setMarker", name: "No frame" })),
  ).toBe("unsupported");
});
