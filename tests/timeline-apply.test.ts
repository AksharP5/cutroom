import { expect, test } from "bun:test";
import {
  TimelineError,
  applyAll,
  copyClips,
  normalizeTimeline,
  slideRange,
  slipRange,
} from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import { CommandSchema } from "../src/shared/timeline/schema";
import { resolveClip } from "../src/shared/timeline/clipTiming";
import { encode, frames } from "../src/shared/timeline/piece";
import { editLabel } from "../src/shared/timeline/labels";
import { countingIds } from "./clip-ids";
import { syncOffsets } from "../src/shared/timeline/sync";
import { volumePoints } from "../src/shared/timeline/mix";
import { editKeys } from "../src/client/edit/keys";
import { pasteAttributes } from "../src/client/edit/pasteAttributes";
import { nearestEditPoint } from "../src/client/timeline/selection";
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
  scaleX: null,
  scaleY: null,
  rotation: null,
  crop: null,
  keyframes: null,
  text: null,
  title: null,
  region: null,
  adjustment: false,
  style: {},
  fadeIn: 0,
  fadeOut: 0,
  transitionIn: null,
  transitionOut: null,
  automation: null,
  fx: [],
  grade: null,
  background: null,
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
      volume: 1,
      fx: [],
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

for (const command of [
  { type: "remove", clipIds: ["shot"], ripple: true },
  { type: "trim", clipId: "shot", edge: "start", to: 90, ripple: true },
  { type: "trim", clipId: "shot", edge: "end", to: 90, ripple: true },
] satisfies CommandInput[]) {
  test(`${command.type}${"edge" in command ? ` ${command.edge}` : ""} shortens spanning text, stills and recipe compositions without copying them`, () => {
    const state = timeline([
      clip("shot", 0, 60, 60),
      clip("lower", 1, 15, 180, {
        kind: "element",
        src: null,
        mediaStart: null,
        text: "Grace Hopper",
        sourceRestrictions: { copy: "Animated by id." },
      }),
      clip("still", 2, 0, 240, {
        kind: "image",
        src: "still.png",
        mediaStart: null,
      }),
      clip("picture", 3, 0, 240),
      clip("music", 4, 0, 240, { kind: "audio" }),
      clip("recipe", 5, 15, 180, {
        kind: "composition",
        src: "compositions/lower.html",
        mediaStart: 0.5,
      }),
    ]);
    const result = run(state, command);
    const removed = command.type === "remove" ? 60 : 30;
    for (const id of ["lower", "still", "recipe"]) {
      const original = state.clips.find((clip) => clip.id === id)!;
      expect(result.clips.find((clip) => clip.id === id)).toEqual({
        ...original,
        duration: original.duration - removed,
      });
      expect(
        result.clips.filter((clip) => clip.track === original.track),
      ).toHaveLength(1);
    }
    for (const id of ["picture", "music"])
      expect(
        result.clips.filter(
          (clip) => clip.id === id || clip.id.startsWith(`${id}-`),
        ),
      ).toHaveLength(2);
    const optedOut = run(
      state,
      { type: "setTrack", index: 1, autoSelect: false },
      command,
    );
    expect(optedOut.clips.find((clip) => clip.id === "lower")).toEqual(
      state.clips.find((clip) => clip.id === "lower"),
    );
  });
}

for (const kind of ["element", "image", "composition"] as const) {
  for (const [start, duration] of [
    [60, 60],
    [30, 180],
  ]) {
    test(`a shortened ${kind} keeps both audio pieces linked after removing ${duration} frames`, () => {
      const state = timeline([
        clip("shot", 0, start, duration),
        clip("lower", 1, 0, 240, {
          kind,
          text: kind === "element" ? "Grace Hopper" : null,
          src:
            kind === "image"
              ? "still.png"
              : kind === "composition"
                ? "compositions/lower.html"
                : null,
          mediaStart: null,
          link: "pair",
        }),
        clip("sound", 2, 0, 240, { kind: "audio", link: "pair" }),
      ]);
      const cut = run(state, {
        type: "remove",
        clipIds: ["shot"],
        ripple: true,
      });
      expect(cut.clips.find((clip) => clip.id === "lower")?.duration).toBe(
        240 - duration,
      );
      const moved = run(cut, {
        type: "move",
        clipIds: ["lower"],
        by: 30,
        mode: "place",
      });
      expect(
        moved.clips
          .filter((clip) => clip.kind === "audio")
          .map((clip) => [clip.start, clip.duration]),
      ).toEqual([
        [30, start],
        [start + 30, 240 - start - duration],
      ]);
      expect(moved.clips.find((clip) => clip.id === "lower")?.start).toBe(30);
    });
  }
}

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

test("a move to a missing track is refused unless the batch creates the track first", () => {
  const edit = timeline([clip("picture", 2, 0, 90)]);
  expect(() =>
    run(edit, { type: "move", clipIds: ["picture"], trackBy: 5 }),
  ).toThrow(
    'Command 1 (move): Track 7 does not exist, so picture cannot move onto it. To create it, add {"type":"setTrack","index":7,"kind":"video"} before the move in the same batch.',
  );
  const moved = run(
    edit,
    { type: "setTrack", index: 7, kind: "video" },
    { type: "move", clipIds: ["picture"], trackBy: 5 },
  );
  expect(moved.clips.map((clip) => [clip.id, clip.track])).toEqual([
    ["picture", 7],
  ]);
  // The sentence names the track the clip landed on, not only the index distance.
  const created = run(edit, { type: "setTrack", index: 7, kind: "video" });
  expect(
    editLabel(
      [CommandSchema.parse({ type: "move", clipIds: ["picture"], trackBy: 5 })],
      created,
      "Edit",
    ),
  ).toBe("Moved 5 tracks up to V2");
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
    4.333333,
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
    [
      { index: 1, kind: "video" },
      { index: 2, kind: "audio", locked: true },
    ],
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

test("a video's sound goes to the audio track the command names, edited as the picture's track is", () => {
  const state = timeline([
    clip("interview", 0, 0, 300, { link: "interview" }),
    clip("dialogue", 1, 0, 300, { kind: "audio", link: "interview" }),
    clip("music", 2, 0, 300, { kind: "audio" }),
    clip("spare", 3, 0, 1),
  ]);
  const place = (mode: "place" | "overwrite" | "insert", track: number) =>
    run(state, {
      type: "insert",
      mode,
      track: 3,
      at: 60,
      clip: { id: "b-roll", kind: "video", src: "b-roll.mp4", duration: 90 },
      linkedAudio: { id: "b-roll-sound", track },
    });
  const spans = (next: Timeline, track: number) =>
    next.clips
      .filter((item) => item.track === track)
      .map((item) => [item.start, item.duration]);
  // Overwrite replaces the music under the new sound and leaves the dialogue it was not sent to.
  const over = place("overwrite", 2);
  expect(over.clips.find((item) => item.id === "b-roll-sound")).toMatchObject({
    track: 2,
    start: 60,
    duration: 90,
    link: "b-roll",
  });
  expect(spans(over, 2)).toEqual([
    [0, 60],
    [60, 90],
    [150, 150],
  ]);
  expect(spans(over, 1)).toEqual([[0, 300]]);
  // Insert opens the named track with the others, so the sound has room there.
  const opened = place("insert", 2);
  expect(spans(opened, 2)).toEqual([
    [0, 60],
    [60, 90],
    [150, 240],
  ]);
  // Place never cuts, and picture cannot be sent to sound.
  expect(() => place("place", 2)).toThrow(TimelineError);
  expect(() => place("overwrite", 0)).toThrow(
    'Clip "b-roll.mp4" sound is audio and track 0 is a video track.',
  );
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

for (const destination of ["new", "free", "partner"] as const) {
  test(`paste overwrite routes linked sound to a ${destination} track without cutting another pair`, () => {
    const state = timeline(
      [
        clip("picture", 1, 0, 30, { link: "source" }),
        clip("sound", 2, 0, 30, { kind: "audio", link: "source" }),
        clip("other-picture", 0, 120, 60, { link: "other" }),
        clip("other-sound", 2, 120, 60, { kind: "audio", link: "other" }),
        ...(destination === "partner"
          ? [
              clip("destination", 1, 120, 60, { link: "destination" }),
              clip("destination-sound", 4, 120, 60, {
                kind: "audio",
                link: "destination",
              }),
            ]
          : []),
      ],
      destination === "new" ? [] : [{ index: 3, kind: "audio" }],
    );
    const next = applyAll(
      state,
      [CommandSchema.parse({ type: "paste", clipboardId: "copy", at: 135 })],
      {
        clipboards: new Map([["copy", copyClips(state, ["picture"])]]),
        newId: countingIds,
      },
    );
    expect(next.clips.filter((clip) => clip.link === "other")).toEqual(
      state.clips.filter((clip) => clip.link === "other"),
    );
    expect(next.clips.find((clip) => clip.id === "picture-2")).toMatchObject({
      track: 1,
      start: 135,
      duration: 30,
    });
    expect(next.clips.find((clip) => clip.id === "sound-2")).toMatchObject({
      track: destination === "partner" ? 4 : 3,
      start: 135,
      duration: 30,
    });
    if (destination === "partner")
      expect(
        next.clips
          .filter((clip) => clip.id.startsWith("destination"))
          .map((clip) => [clip.track, clip.start, clip.duration]),
      ).toEqual([
        [1, 120, 15],
        [1, 165, 15],
        [4, 120, 15],
        [4, 165, 15],
      ]);
    else
      expect(next.tracks).toHaveLength(
        destination === "new" ? 4 : state.tracks.length,
      );
  });
}

test("paste into an empty composition retains picture tracks and reserves standalone audio before routing sound", () => {
  const source = timeline([
    clip("picture", 0, 0, 30, { link: "source" }),
    clip("title", 1, 0, 30, { kind: "element", src: null, mediaStart: null }),
    clip("sound", 3, 0, 30, { kind: "audio", link: "source" }),
    clip("voice", 2, 0, 30, { kind: "audio" }),
  ]);
  for (const audioTrack of [3, 4]) {
    const pasted = applyAll(
      timeline([], audioTrack === 4 ? [{ index: 4, kind: "audio" }] : []),
      [CommandSchema.parse({ type: "paste", clipboardId: "copy", at: 135 })],
      { clipboards: new Map([["copy", source.clips]]), newId: countingIds },
    );
    expect(positions(pasted)).toEqual({
      "picture-2": [0, 135, 30],
      "title-2": [1, 135, 30],
      "voice-2": [2, 135, 30],
      "sound-2": [audioTrack, 135, 30],
    });
    expect(pasted.tracks.map((track) => [track.index, track.kind])).toEqual([
      [0, "video"],
      [1, "video"],
      [2, "audio"],
      [audioTrack, "audio"],
    ]);
  }
});

test("linked paste needs room for the whole J-cut sound span and skips locked or music tracks", () => {
  const state = timeline(
    [
      clip("picture", 1, 30, 30, { link: "source" }),
      clip("sound", 2, 0, 90, { kind: "audio", link: "source" }),
      clip("other-picture", 0, 120, 30, { link: "other" }),
      clip("other-sound", 2, 120, 30, { kind: "audio", link: "other" }),
      clip("music", 4, 0, 30, { kind: "audio" }),
    ],
    [{ index: 3, kind: "audio", locked: true }],
  );
  const pasted = applyAll(
    state,
    [CommandSchema.parse({ type: "paste", clipboardId: "copy", at: 135 })],
    {
      clipboards: new Map([["copy", copyClips(state, ["picture"])]]),
      newId: countingIds,
    },
  );
  expect(pasted.clips.find((clip) => clip.id === "sound-2")).toMatchObject({
    track: 5,
    start: 135,
    duration: 90,
  });
  expect(
    pasted.clips.filter((clip) => clip.link === "other" || clip.id === "music"),
  ).toEqual(
    state.clips.filter((clip) => clip.link === "other" || clip.id === "music"),
  );
});

test("standalone audio paste keeps the same overwrite semantics as an audio drop", () => {
  const state = timeline([
    clip("sound", 1, 0, 30, { kind: "audio", hasAudio: true }),
    clip("picture", 0, 120, 60, { link: "other" }),
    clip("other-sound", 1, 120, 60, { kind: "audio", link: "other" }),
  ]);
  const pasted = applyAll(
    state,
    [CommandSchema.parse({ type: "paste", clipboardId: "copy", at: 135 })],
    {
      clipboards: new Map([["copy", copyClips(state, ["sound"])]]),
      newId: countingIds,
    },
  );
  const dropped = run(state, {
    type: "insert",
    mode: "overwrite",
    track: 1,
    at: 135,
    clip: { kind: "audio", src: "talk.mp4", duration: 30 },
  });
  expect(
    pasted.clips
      .filter((clip) => clip.track === 1)
      .map((clip) => [clip.start, clip.duration]),
  ).toEqual([
    [0, 30],
    [120, 15],
    [135, 30],
    [165, 15],
  ]);
  expect(pasted.clips.filter((clip) => clip.link === "other")).toEqual(
    dropped.clips.filter((clip) => clip.link === "other"),
  );
});

test("paste keeps relative timing and J-cut partners on their tracks with fresh ids and links", () => {
  const state = timeline([
    clip("picture", 0, 30, 60, { link: "pair" }),
    clip("sound", 1, 15, 90, { kind: "audio", link: "pair", hasAudio: true }),
    clip("other", 2, 90, 30),
  ]);
  const copied = copyClips(state, ["picture", "other"]);
  expect(copied.map((clip) => clip.id)).toEqual(["picture", "sound", "other"]);
  const paste = CommandSchema.parse({
    type: "paste",
    clipboardId: "copy",
    at: 300,
  });
  const options = {
    clipboards: new Map([["copy", copied]]),
    newId: countingIds,
  };
  const after = applyAll(state, [paste], options);
  const added = after.clips.filter(
    (clip) => !state.clips.some((old) => old.id === clip.id),
  );
  expect(
    added.map((clip) => [
      clip.track,
      clip.start,
      clip.duration,
      clip.mediaStart,
    ]),
  ).toEqual([
    [0, 315, 60, 0],
    [1, 300, 90, 0],
    [2, 375, 30, 0],
  ]);
  expect(added[0]!.link).toBe(added[1]!.link);
  expect(added[0]!.link).not.toBe("pair");
  expect(added[2]!.link).toBeNull();
  const twice = applyAll(
    after,
    [CommandSchema.parse({ ...paste, at: 450 })],
    options,
  );
  expect(new Set(twice.clips.map((clip) => clip.id)).size).toBe(9);
  expect(new Set(twice.clips.flatMap((clip) => clip.link ?? [])).size).toBe(3);
  // A cut never empties the snapshot.
  const cut = run(state, { type: "remove", clipIds: ["picture", "other"] });
  expect(applyAll(cut, [paste], options).clips).toHaveLength(3);
});

test("paste overwrite clears each copied interval; insert opens the whole span once across auto-select tracks", () => {
  const source = [clip("a", 0, 20, 20), clip("b", 0, 60, 20)];
  const state = timeline([clip("bed", 0, 0, 180), clip("title", 1, 0, 180)]);
  const paste = (mode: "overwrite" | "insert") =>
    applyAll(
      state,
      [
        CommandSchema.parse({
          type: "paste",
          clipboardId: "copy",
          at: 60,
          mode,
        }),
      ],
      { clipboards: new Map([["copy", source]]), newId: countingIds },
    );
  expect(
    paste("overwrite").clips.map((clip) => [
      clip.track,
      clip.start,
      clip.duration,
    ]),
  ).toEqual([
    [0, 0, 60],
    [0, 60, 20],
    [0, 80, 20],
    [0, 100, 20],
    [0, 120, 60],
    [1, 0, 180],
  ]);
  expect(
    paste("insert").clips.map((clip) => [
      clip.track,
      clip.start,
      clip.duration,
    ]),
  ).toEqual([
    [0, 0, 60],
    [0, 60, 20],
    [0, 100, 20],
    [0, 120, 120],
    [1, 0, 60],
    [1, 120, 120],
  ]);
});

test("copy and paste refuse restricted clips by name, and insert keeps the existing auto-select hint", () => {
  const restricted = clip("lower", 1, 0, 180, {
    label: "Lower third",
    sourceRestrictions: { copy: "Styled by id." },
  });
  expect(() => copyClips(timeline([restricted]), ["lower"])).toThrow(
    "Lower third can't be copied",
  );
  const command = CommandSchema.parse({
    type: "paste",
    clipboardId: "copy",
    at: 60,
    mode: "insert",
  });
  expect(() =>
    applyAll(timeline([]), [command], {
      clipboards: new Map([["copy", [restricted]]]),
    }),
  ).toThrow("Lower third can't be copied");
  const state = timeline([clip("bed", 0, 0, 180), restricted]);
  const options = {
    clipboards: new Map([["copy", [clip("source", 0, 0, 30)]]]),
    newId: countingIds,
  };
  expect(() => applyAll(state, [command], options)).toThrow(
    "Lower third on V2 can't be cut here. Turn off auto-select on V2",
  );
  const off = run(state, { type: "setTrack", index: 1, autoSelect: false });
  expect(
    applyAll(off, [command], options).clips.find((clip) => clip.id === "lower"),
  ).toEqual(restricted);
  expect(() =>
    applyAll(
      state,
      [CommandSchema.parse({ ...command, ids: { source: ["spent"] } })],
      { ...options, retired: new Set(["spent"]) },
    ),
  ).toThrow("used earlier");
});

test("paste insert refuses a linked partner on an excluded track and a locked destination", () => {
  const state = timeline(
    [
      clip("picture", 0, 0, 180, { link: "pair" }),
      clip("sound", 1, 0, 180, { kind: "audio", link: "pair" }),
    ],
    [{ index: 1, kind: "audio", autoSelect: false }],
  );
  const command = CommandSchema.parse({
    type: "paste",
    clipboardId: "copy",
    at: 60,
    mode: "insert",
  });
  const options = {
    clipboards: new Map([["copy", [clip("source", 0, 0, 30)]]]),
    newId: countingIds,
  };
  expect(() => applyAll(state, [command], options)).toThrow(
    "cannot preserve sync",
  );
  const locked = run(state, { type: "setTrack", index: 0, locked: true });
  expect(() =>
    applyAll(
      locked,
      [CommandSchema.parse({ ...command, mode: "overwrite", at: 240 })],
      options,
    ),
  ).toThrow("locked");
});

// A talk recorded as one file, cut into picture and linked sound with five seconds of source.
const talk = (
  id: string,
  start: number,
  duration: number,
  mediaStart: number,
) => [
  clip(id, 0, start, duration, {
    link: `lk-${id}`,
    mediaStart,
    sourceDuration: 5,
  }),
  clip(`${id}-sound`, 1, start, duration, {
    kind: "audio",
    link: `lk-${id}`,
    mediaStart,
    sourceDuration: 5,
    hasAudio: true,
  }),
];
const avTracks: Partial<Track>[] = [
  { index: 0, kind: "video" },
  { index: 1, kind: "audio" },
];

test("closeGap closes a gap on every auto-select track and keeps sound in sync", () => {
  const state = timeline(
    [...talk("a", 0, 30, 0), ...talk("b", 60, 30, 2)],
    avTracks,
  );
  const closed = run(state, { type: "closeGap", track: 0, at: 45 });
  expect(positions(closed)).toEqual({
    a: [0, 0, 30],
    "a-sound": [1, 0, 30],
    b: [0, 30, 30],
    "b-sound": [1, 30, 30],
  });
  expect(
    editLabel(
      [CommandSchema.parse({ type: "closeGap", track: 0, at: 45 })],
      state,
      "",
      "pending",
    ),
  ).toBe("Close the 1 s gap on V1 at 00:00:01:00");
});

test("removeRange takes a range off the auto-select tracks, as In and Out with nothing selected", () => {
  const music = clip("music", 2, 0, 90, {
    kind: "audio",
    hasAudio: true,
    src: "music.wav",
    mediaStart: 0,
    sourceDuration: 10,
  });
  const lowerThird = clip("lower-third", 3, 0, 90, { mediaStart: null });
  const state = timeline(
    [...talk("a", 0, 90, 0), music, lowerThird],
    [...avTracks, { index: 2, kind: "audio" }, { index: 3, locked: true }],
  );
  // A pause from 1 s to 1.5 s.
  const rippled = run(state, {
    type: "removeRange",
    from: 30,
    to: 45,
    ripple: true,
  });
  expect(positions(rippled)).toEqual({
    a: [0, 0, 30],
    "a-2": [0, 30, 45],
    "a-sound": [1, 0, 30],
    "a-sound-2": [1, 30, 45],
    music: [2, 0, 30],
    "music-2": [2, 30, 45],
    "lower-third": [3, 0, 90],
  });
  // The words after the pause follow straight on, in sync with their sound.
  const after = rippled.clips.filter((item) => item.start === 30);
  expect(after.map((item) => item.mediaStart)).toEqual([1.5, 1.5, 1.5]);
  expect(new Set(after.map((item) => item.link)).size).toBe(2);

  const lifted = run(state, {
    type: "removeRange",
    from: 30,
    to: 45,
    ripple: false,
  });
  expect(positions(lifted)).toMatchObject({
    "a-2": [0, 45, 45],
    "music-2": [2, 45, 45],
    "lower-third": [3, 0, 90],
  });

  // Music with auto-select off stays whole, and agents cut it too, naming the track.
  const off = timeline(state.clips, [
    ...avTracks,
    { index: 2, kind: "audio", autoSelect: false, name: "Music" },
    { index: 3, locked: true },
  ]);
  const command = CommandSchema.parse({
    type: "removeRange",
    from: 30,
    to: 45,
    ripple: true,
  });
  expect(positions(run(off, command)).music).toEqual([2, 0, 90]);
  const cuts: [number, string, number][] = [];
  const agent = applyAll(off, [command], {
    newId: countingIds,
    onRippleCut: (track, name, frames) => cuts.push([track, name, frames]),
  });
  expect(positions(agent)["music-2"]).toEqual([2, 30, 45]);
  expect(cuts).toEqual([[2, "Music", 15]]);
  expect(editLabel([command], state, "", "pending")).toBe(
    "Ripple delete 00:00:01:00 to 00:00:01:15",
  );
  expect(() =>
    run(state, { type: "removeRange", from: 45, to: 45, ripple: true }),
  ).toThrow("The range must end after it starts.");
  // A clip the source animates by id cannot be cut, and a lift says so as a ripple does.
  const animated = timeline(
    [
      ...state.clips.filter((item) => item.track !== 3),
      clip("anim", 3, 0, 90, {
        kind: "element",
        src: null,
        mediaStart: null,
        sourceRestrictions: { copy: "Animated by id." },
      }),
    ],
    [...avTracks, { index: 2, kind: "audio", name: "Music" }, { index: 3 }],
  );
  for (const ripple of [false, true])
    expect(() =>
      run(animated, { type: "removeRange", from: 30, to: 45, ripple }),
    ).toThrow(
      `anim on V2 can't be cut here. Turn off auto-select on V2 to ${ripple ? "ripple" : "lift"} without it.`,
    );
});

test("a marked lift refuses if it would leave protected linked sound behind", () => {
  for (const locked of [false, true]) {
    const state = timeline(talk("a", 30, 30, 0), [
      { index: 0, kind: "video" },
      { index: 1, kind: "audio", autoSelect: false, locked },
    ]);
    expect(() =>
      run(state, { type: "removeRange", from: 20, to: 70, ripple: false }),
    ).toThrow(
      `Can't lift the range while linked clip a-sound is on ${locked ? "locked" : "auto-select-off"} track A1.`,
    );
  }
});

test("closeGap refuses what Resolve refuses: a clip in the gap, a locked track, and no gap", () => {
  const music = clip("music", 2, 20, 50, {
    kind: "audio",
    hasAudio: true,
    src: "music.wav",
  });
  const tracks: Partial<Track>[] = [...avTracks, { index: 2, kind: "audio" }];
  const state = timeline(
    [...talk("a", 0, 30, 0), ...talk("b", 60, 30, 2), music],
    tracks,
  );
  expect(() => run(state, { type: "closeGap", track: 0, at: 45 })).toThrow(
    "music.wav on A2 is in the gap. Turn off auto-select on A2 to close the gap without it.",
  );
  // Without auto-select, the music bed stays where it is.
  const off = timeline(state.clips, [
    ...avTracks,
    { index: 2, kind: "audio", autoSelect: false },
  ]);
  expect(
    positions(run(off, { type: "closeGap", track: 0, at: 45 })).music,
  ).toEqual([2, 20, 50]);
  // Sound on a track that does not ripple would fall out of sync with its picture.
  const stranded = timeline(
    state.clips.filter((item) => item !== music),
    [
      { index: 0, kind: "video" },
      { index: 1, kind: "audio", autoSelect: false },
    ],
  );
  expect(() => run(stranded, { type: "closeGap", track: 0, at: 45 })).toThrow(
    "Linked clips of talk.mp4 on A1 do not ripple, so closing the gap would put them out of sync. Turn on auto-select on A1, or unlink them.",
  );
  const locked = timeline(state.clips, [
    { index: 0, kind: "video", locked: true },
    ...tracks.slice(1),
  ]);
  expect(() => run(locked, { type: "closeGap", track: 0, at: 45 })).toThrow(
    "Track V1 is locked.",
  );
  expect(() => run(state, { type: "closeGap", track: 0, at: 95 })).toThrow(
    "Nothing follows frame 95 on V1, so there is no gap to close.",
  );
  expect(() => run(state, { type: "closeGap", track: 0, at: 10 })).toThrow(
    "Frame 10 on V1 is inside talk.mp4, not a gap.",
  );
});

test("slip changes the source of a clip and its sound, never its place, and stops at the source's ends", () => {
  const state = timeline(talk("a", 30, 60, 1), avTracks);
  const slipped = run(state, { type: "slip", clipId: "a", by: 15 });
  expect(positions(slipped)).toEqual(positions(state));
  expect(slipped.clips.map((item) => item.mediaStart)).toEqual([1.5, 1.5]);
  // One second before the in point and two after the out point.
  expect(() => run(state, { type: "slip", clipId: "a", by: -31 })).toThrow(
    "talk.mp4 can slip at most 30 frames earlier in its source: then clip a would start before its source media.",
  );
  expect(() => run(state, { type: "slip", clipId: "a", by: 61 })).toThrow(
    "talk.mp4 can slip at most 60 frames later in its source: then clip a would run past the end of its source media.",
  );
  expect(
    run(state, { type: "slip", clipId: "a", by: 60 }).clips[0]!.mediaStart,
  ).toBe(3);
  const still = timeline(
    [
      clip("logo", 0, 0, 30, {
        kind: "image",
        mediaStart: null,
        src: "logo.png",
      }),
    ],
    avTracks,
  );
  expect(() => run(still, { type: "slip", clipId: "logo", by: 1 })).toThrow(
    "logo.png has no source to slip.",
  );
});

test("slipping the sound alone puts it out of sync by that many frames", () => {
  const state = timeline(talk("a", 30, 60, 1), avTracks);
  const slipped = run(state, {
    type: "slip",
    clipId: "a-sound",
    by: -3,
    linked: false,
  });
  expect(slipped.clips.map((item) => item.mediaStart)).toEqual([1, 0.9]);
  expect(Object.fromEntries(syncOffsets(slipped))).toEqual({
    a: -3,
    "a-sound": 3,
  });
  const moved = run(state, {
    type: "move",
    clipIds: ["a-sound"],
    by: 5,
    linked: false,
  });
  expect(Object.fromEntries(syncOffsets(moved))).toEqual({
    a: -5,
    "a-sound": 5,
  });
  expect(syncOffsets(state).size).toBe(0);
});

test("slide moves a clip between its neighbours, which trim to follow with their sound", () => {
  const state = timeline(
    [...talk("a", 0, 30, 0), ...talk("b", 30, 30, 1), ...talk("c", 60, 30, 3)],
    avTracks,
  );
  const slid = run(state, { type: "slide", clipIds: ["b"], by: 10 });
  expect(positions(slid)).toEqual({
    a: [0, 0, 40],
    "a-sound": [1, 0, 40],
    b: [0, 40, 30],
    "b-sound": [1, 40, 30],
    c: [0, 70, 20],
    "c-sound": [1, 70, 20],
  });
  const source = Object.fromEntries(
    slid.clips.map((item) => [item.id, item.mediaStart]),
  );
  expect([source.a, source.b, source.c]).toEqual([0, 1, 3.333333]);
  expect(() => run(state, { type: "slide", clipIds: ["b"], by: 30 })).toThrow(
    "talk.mp4 can slide at most 29 frames later: then clip c would be shorter than one frame.",
  );
  // c starts three seconds in, but a has only five seconds of source in all.
  const tight = timeline(
    [...talk("a", 0, 30, 4), ...talk("b", 30, 30, 1), ...talk("c", 60, 30, 3)],
    avTracks,
  );
  expect(() => run(tight, { type: "slide", clipIds: ["b"], by: 1 })).toThrow(
    "talk.mp4 cannot slide later: clip a would run past the end of its source media.",
  );
});

test("slide into a gap shrinks it and stops at the next clip", () => {
  const state = timeline(
    [clip("a", 0, 0, 30), clip("b", 0, 30, 30), clip("c", 0, 70, 30)],
    avTracks,
  );
  expect(
    positions(run(state, { type: "slide", clipIds: ["b"], by: 10 })),
  ).toEqual({
    a: [0, 0, 40],
    b: [0, 40, 30],
    c: [0, 70, 30],
  });
  expect(() => run(state, { type: "slide", clipIds: ["b"], by: 11 })).toThrow(
    "talk.mp4 can slide at most 10 frames later: then clip c would overlap b on track 0.",
  );
});

test("unlink separates picture and sound, link joins them again with any partners", () => {
  const state = timeline(talk("a", 0, 30, 0), avTracks);
  const apart = run(state, { type: "unlink", clipIds: ["a"] });
  expect(apart.clips.map((item) => item.link)).toEqual([null, null]);
  expect(
    positions(run(apart, { type: "move", clipIds: ["a"], by: 5 }))["a-sound"],
  ).toEqual([1, 0, 30]);
  const together = run(apart, { type: "link", clipIds: ["a", "a-sound"] });
  const [link] = new Set(together.clips.map((item) => item.link));
  expect(link).toBeString();
  expect(
    positions(run(together, { type: "move", clipIds: ["a"], by: 5 }))[
      "a-sound"
    ],
  ).toEqual([1, 5, 30]);
  const music = clip("music", 2, 0, 30, { kind: "audio", hasAudio: true });
  const three = run(
    timeline(
      [...state.clips, music],
      [...avTracks, { index: 2, kind: "audio" }],
    ),
    { type: "link", clipIds: ["a", "music"] },
  );
  expect(new Set(three.clips.map((item) => item.link)).size).toBe(1);
  expect(run(state, { type: "link", clipIds: ["a", "a-sound"] })).toBe(state);
});

// B-roll without sound between two interview shots, each with linked sound on A1.
const interview = () =>
  timeline(
    [
      ...talk("a", 0, 60, 0),
      clip("b", 0, 60, 60, {
        src: "broll.mp4",
        mediaStart: 1,
        sourceDuration: 5,
      }),
      ...talk("c", 120, 60, 2),
    ],
    avTracks,
  );

test("slide trims each neighbour's linked sound with its picture, and the sound's source limits it", () => {
  const slid = run(interview(), { type: "slide", clipIds: ["b"], by: 10 });
  expect(positions(slid)).toMatchObject({
    a: [0, 0, 70],
    "a-sound": [1, 0, 70],
    b: [0, 70, 60],
    c: [0, 130, 50],
    "c-sound": [1, 130, 50],
  });
  const source = Object.fromEntries(
    slid.clips.map((item) => [item.id, item.mediaStart]),
  );
  expect([source.c, source["c-sound"]]).toEqual([2.333333, 2.333333]);
  // The sound has less source after its out point than the picture.
  const short = timeline(
    interview().clips.map((item) =>
      item.id === "a-sound" ? { ...item, sourceDuration: 65 / 30 } : item,
    ),
    avTracks,
  );
  expect(
    slideRange(short, [short.clips.find((item) => item.id === "b")!]),
  ).toMatchObject({
    max: 5,
  });
  expect(() => run(short, { type: "slide", clipIds: ["b"], by: 6 })).toThrow(
    "broll.mp4 can slide at most 5 frames later: then clip a-sound would run past the end of its source media.",
  );
});

test("clips next to each other slide as one block, and a clip between them refuses", () => {
  const state = timeline(
    [
      clip("a", 0, 0, 60, { mediaStart: 1 }),
      clip("b", 0, 60, 60, { mediaStart: 3 }),
      clip("c", 0, 120, 60, { mediaStart: 6 }),
    ],
    avTracks,
  );
  const target = {
    selection: new Set(["a", "b"]),
    frame: 0,
    trim: "slide" as const,
  };
  const slid = Array.from({ length: 5 }).reduce<Timeline>(
    (current) =>
      run(
        current,
        ...editKeys.editNudgeTrimStepNudgeForward.commands(current, target),
      ),
    state,
  );
  expect(positions(slid)).toEqual({
    a: [0, 5, 60],
    b: [0, 65, 60],
    c: [0, 125, 55],
  });
  const [a, b, c] = slid.clips.map((item) => item.mediaStart!);
  expect([a, b]).toEqual([1, 3]);
  expect(c).toBe(6.166667);
  expect(() =>
    run(state, { type: "slide", clipIds: ["a", "c"], by: 5 }),
  ).toThrow(
    "talk.mp4 is between clips that slide, so they cannot slide as one block.",
  );
});

test("slip and slide stop at a transition's media instead of shortening it", () => {
  const dissolve = (duration: number) => ({
    kind: "dissolve" as const,
    duration,
    alignment: "center" as const,
  });
  // b shows source from 10 s, and the 20-frame dissolve needs 10 frames of it before its in point.
  const state = timeline(
    [
      clip("a", 0, 0, 60, {
        mediaStart: 1,
        sourceDuration: 20,
        transitionOut: dissolve(20),
      }),
      clip("b", 0, 60, 60, {
        src: "b.mp4",
        mediaStart: 10,
        sourceDuration: 20,
        transitionIn: dissolve(20),
        transitionOut: dissolve(12),
      }),
      clip("c", 0, 120, 60, {
        src: "c.mp4",
        mediaStart: 12 / 30,
        sourceDuration: 20,
        transitionIn: dissolve(12),
      }),
    ],
    avTracks,
  );
  const b = state.clips.find((item) => item.id === "b")!;
  expect(slipRange(state, b)?.min).toBe(-290);
  expect(() => run(state, { type: "slip", clipId: "b", by: -295 })).toThrow(
    "b.mp4 can slip at most 290 frames earlier in its source: then the 20-frame transition between talk.mp4 and b.mp4 would not fit, since b.mp4 has 9 frames of media before its in point.",
  );
  // c has 12 frames before its in point, and the 12-frame dissolve on b|c needs 6.
  expect(slideRange(state, [b]).min).toBe(-6);
  expect(() => run(state, { type: "slide", clipIds: ["b"], by: -7 })).toThrow(
    "b.mp4 can slide at most 6 frames earlier: then the 12-frame transition between b.mp4 and c.mp4 would not fit",
  );
  expect(
    run(state, { type: "slide", clipIds: ["b"], by: -6 }).clips[2]!
      .transitionIn,
  ).toEqual(dissolve(12));
});

test("slip moves keyframes and volume points with the content, as a head trim does", () => {
  const keyed = run(
    timeline(
      [
        clip("a", 0, 30, 60, {
          mediaStart: 2,
          sourceDuration: 10,
          hasAudio: true,
        }),
      ],
      avTracks,
    ),
    {
      type: "setKeyframe",
      clipId: "a",
      property: "opacity",
      frame: 20,
      value: 0.5,
    },
    {
      type: "setKeyframe",
      clipId: "a",
      property: "opacity",
      frame: 40,
      value: 1,
    },
    {
      type: "setClip",
      clipId: "a",
      automation: {
        volume: [
          { frame: 20, gain: 1 },
          { frame: 40, gain: 0.5 },
        ],
      },
    },
  );
  const slipped = run(keyed, { type: "slip", clipId: "a", by: 10 }).clips[0]!;
  // Trimming the head 10 frames shows the same content from the same first frame.
  const trimmed = run(keyed, {
    type: "trim",
    clipId: "a",
    edge: "start",
    to: 40,
  }).clips[0]!;
  expect(slipped.keyframes).toEqual(trimmed.keyframes);
  expect(slipped.keyframes?.opacity?.map((keyframe) => keyframe.frame)).toEqual(
    [10, 30],
  );
  expect(slipped.automation).toEqual(trimmed.automation);
  expect(
    volumePoints(slipped.automation, keyed.fps)?.map((point) => point.frame),
  ).toEqual([0, 10, 30]);
});

test("link needs two different clips", () => {
  const state = timeline(talk("a", 0, 30, 0), avTracks);
  const apart = run(state, { type: "unlink", clipIds: ["a"] });
  expect(() => run(apart, { type: "link", clipIds: ["a", "a"] })).toThrow(
    "Linking takes two or more different clips.",
  );
});

test("setTiming keeps matching linked source maps across 636 in-points and 3,816 speed changes", () => {
  const map = (clip: Clip, fps: Timeline["fps"]) => {
    const { c, tau, zero } = resolveClip(clip, fps);
    return { c, tau, zero };
  };
  const rates = [24, 25, 30, 50, 60].map((num) => ({ num, den: 1 }));
  rates.push({ num: 30_000, den: 1001 });
  let inPoints = 0;
  let speedChanges = 0;
  for (const fps of rates) {
    const source = { c: -1000, tau: 0, zero: 0 };
    const inPoint = (start: number) =>
      encode(source, 1, frames(start, fps), fps).mediaStart / 1e6;
    const picture = clip("picture", 0, 120, 120, {
      link: "pair",
      mediaStart: inPoint(120),
    });
    for (let offset = -53; offset <= 53; offset++) {
      if (offset === 0) continue;
      const soundStart = picture.start + offset;
      const sound = clip("sound", 1, soundStart, 130, {
        kind: "audio",
        link: "pair",
        mediaStart: inPoint(soundStart),
      });
      const state = { ...timeline([picture, sound], avTracks), fps };
      const slip = run(state, {
        type: "setTiming",
        clipId: "picture",
        mediaStart: 4.25,
      });
      expect(map(slip.clips[1], fps)).toEqual(map(slip.clips[0], fps));
      inPoints++;
      for (const playbackRate of [0.5, 0.75, 1.03125, 1.5, 2, 3.333333]) {
        const speed = run(state, {
          type: "setTiming",
          clipId: "picture",
          playbackRate,
        });
        expect(map(speed.clips[1], fps)).toEqual(map(speed.clips[0], fps));
        speedChanges++;
      }
    }
  }
  expect({ inPoints, speedChanges }).toEqual({
    inPoints: 636,
    speedChanges: 3816,
  });
});

test("setTiming preserves the in-point offset of a separately aligned linked source", () => {
  const state = timeline(
    [
      clip("picture", 0, 0, 30, { link: "pair", mediaStart: 1 }),
      clip("sound", 1, 0, 30, {
        kind: "audio",
        link: "pair",
        src: "room.wav",
        mediaStart: 2,
      }),
    ],
    avTracks,
  );
  const edited = run(state, {
    type: "setTiming",
    clipId: "picture",
    mediaStart: 1.5,
  });
  expect(edited.clips.map(({ mediaStart }) => mediaStart)).toEqual([1.5, 2.5]);
});

test("constant speed resizes an exact half-frame tie and ripples the following cut", () => {
  const before = timeline([
    clip("shot", 0, 0, 1, { playbackRate: 2.4 }),
    clip("next", 0, 1, 30),
  ]);
  const after = run(before, {
    type: "setTiming",
    clipId: "shot",
    playbackRate: 1.6,
  });
  expect(positions(after)).toEqual({ shot: [0, 0, 2], next: [0, 2, 30] });
});

test("speeding up a J-cut clears the sound tail and keeps the next pair in sync", () => {
  const before = timeline([
    clip("shot", 0, 30, 120, { link: "first", mediaStart: 1 }),
    clip("sound", 1, 0, 120, { kind: "audio", link: "first" }),
    clip("next-shot", 0, 150, 60, { link: "second", mediaStart: 1 }),
    clip("next-sound", 1, 120, 60, { kind: "audio", link: "second" }),
  ]);
  const after = run(before, {
    type: "setTiming",
    clipId: "shot",
    playbackRate: 2,
  });
  expect(positions(after)).toEqual({
    shot: [0, 15, 60],
    sound: [1, 0, 60],
    "next-shot": [0, 90, 60],
    "next-sound": [1, 60, 60],
  });
});

test("slowing an L-cut at frame zero gives the same placement from either partner", () => {
  const before = timeline([
    clip("picture", 0, 10, 85, { link: "pair", mediaStart: 0.333333 }),
    clip("sound", 1, 0, 105, { kind: "audio", link: "pair" }),
  ]);
  const slow = (clipId: string) =>
    run(before, { type: "setTiming", clipId, playbackRate: 0.5 });
  expect(slow("picture")).toEqual(slow("sound"));
  expect(positions(slow("picture"))).toEqual({
    picture: [0, 20, 170],
    sound: [1, 0, 210],
  });
  const fast = run(before, {
    type: "setTiming",
    clipId: "picture",
    playbackRate: 3,
  });
  const restored = run(fast, {
    type: "setTiming",
    clipId: "sound",
    playbackRate: 1,
  });
  expect(positions(restored)).toEqual(positions(before));
  expect(restored.clips.map(({ mediaStart }) => mediaStart)).toEqual([
    0.333333, 0,
  ]);
});

test("speeding up a separately aligned partner compensates for rounding its head", () => {
  const before = timeline([
    clip("picture", 0, 0, 90, { link: "pair" }),
    clip("sound", 1, 10, 60, {
      kind: "audio",
      link: "pair",
      src: "room.wav",
      mediaStart: 2,
    }),
  ]);
  const after = run(before, {
    type: "setTiming",
    clipId: "picture",
    playbackRate: 3,
  });
  expect(positions(after).sound[1]).toBe(3);
  expect(after.clips[1].mediaStart).toBe(1.966667);
  const restored = run(after, {
    type: "setTiming",
    clipId: "sound",
    playbackRate: 1,
  });
  expect(restored.clips[1].mediaStart).toBe(2);
});

test("a full-source clip can return to 100% after rounding its faster duration", () => {
  const before = timeline([
    clip("picture", 0, 0, 121, { sourceDuration: 121 / 30 }),
    clip("next", 0, 121, 30),
  ]);
  for (const playbackRate of [2, 1.5, 0.3]) {
    const faster = run(before, {
      type: "setTiming",
      clipId: "picture",
      playbackRate,
    });
    const restored = run(faster, {
      type: "setTiming",
      clipId: "picture",
      playbackRate: 1,
    });
    expect(positions(restored)).toEqual(positions(before));
  }
  const withNewInPoint = run(before, {
    type: "setTiming",
    clipId: "picture",
    playbackRate: 1.5,
    mediaStart: 1 / 30,
  });
  expect(positions(withNewInPoint)).toEqual({
    picture: [0, 0, 80],
    next: [0, 80, 30],
  });
});

test("roll moves linked edges together and refuses missing handles or a locked partner", () => {
  const state = timeline([
    clip("left", 0, 0, 60, { link: "left-link", sourceDuration: 5 }),
    clip("right", 0, 60, 60, { link: "right-link", mediaStart: 1 }),
    clip("left-a", 1, 0, 60, { kind: "audio", link: "left-link" }),
    clip("right-a", 1, 60, 60, {
      kind: "audio",
      link: "right-link",
      mediaStart: 1,
    }),
  ]);
  const roll = { type: "roll", from: "left", to: "right", by: 6 } as const;
  const result = run(state, roll);
  expect(positions(result)).toEqual({
    left: [0, 0, 66],
    right: [0, 66, 54],
    "left-a": [1, 0, 66],
    "right-a": [1, 66, 54],
  });
  expect(result.clips.find(({ id }) => id === "right")?.mediaStart).toBeCloseTo(
    1.2,
    6,
  );
  expect(() => run(state, { ...roll, by: -31 })).toThrow(
    "before its source media",
  );
  expect(() =>
    run(run(state, { type: "setTrack", index: 1, locked: true }), roll),
  ).toThrow("locked");
});

test("swap preserves unlike clip lengths and refuses a transition on a neighbouring cut", () => {
  const state = timeline([
    clip("left", 0, 0, 60),
    clip("right", 0, 60, 30),
    clip("next", 0, 90, 30, { mediaStart: 1 }),
  ]);
  const swap = { type: "swap", from: "left", to: "right" } as const;
  expect(positions(run(state, swap))).toEqual({
    right: [0, 0, 30],
    left: [0, 30, 60],
    next: [0, 90, 30],
  });
  const faded = run(state, {
    type: "setTransition",
    from: "right",
    to: "next",
    transition: { duration: 30 },
  });
  expect(() => run(faded, swap)).toThrow("Remove the transitions");
});

test("trim linked false edits the named clip even when its partner is locked", () => {
  const state = timeline(
    [
      clip("picture", 0, 0, 60, { link: "talk" }),
      clip("sound", 1, 0, 60, { kind: "audio", link: "talk" }),
    ],
    [{ index: 1, kind: "audio", locked: true }],
  );
  const trim = {
    type: "trim",
    clipId: "picture",
    edge: "end",
    to: 42,
  } as const;
  expect(() => run(state, trim)).toThrow("locked");
  expect(positions(run(state, { ...trim, linked: false }))).toEqual({
    picture: [0, 0, 42],
    sound: [1, 0, 60],
  });
});

test("Shift brackets trim every eligible clip and close gaps only in Trim mode", () => {
  const state = timeline(
    [
      clip("low", 0, 0, 60),
      clip("low-next", 0, 60, 30),
      clip("high", 1, 10, 70),
      clip("high-next", 1, 80, 30),
      clip("disabled", 2, 0, 90),
      clip("title", 3, 100, 30, { kind: "element", mediaStart: null }),
    ],
    [{ index: 2, autoSelect: false }],
  );
  const keys = editKeys.editNudgeTrimStepTrimStart;
  const target = { frame: 30, selection: new Set(["disabled"]) };
  expect(positions(run(state, ...keys.commands(state, target)))).toEqual({
    low: [0, 30, 30],
    "low-next": [0, 60, 30],
    high: [1, 30, 50],
    "high-next": [1, 80, 30],
    disabled: [2, 0, 90],
    title: [3, 100, 30],
  });
  const ripple = keys.commands(state, { ...target, trim: "slip" });
  expect(() => run(state, ...ripple)).toThrow("different lengths");
  const isolated = run(state, {
    type: "setTrack",
    index: 3,
    autoSelect: false,
  });
  expect(positions(run(isolated, ...ripple))).toEqual({
    low: [0, 0, 30],
    "low-next": [0, 30, 30],
    high: [1, 10, 50],
    "high-next": [1, 60, 30],
    disabled: [2, 0, 90],
    title: [3, 100, 30],
  });
  const linked = run(isolated, {
    type: "link",
    clipIds: ["low-next", "high-next"],
  });
  expect(() => run(linked, ...ripple)).toThrow("would move linked clips");
});

test("Shift+] ripples later and overlapping clips on other auto-select tracks like W", () => {
  const state = timeline([
    clip("a", 0, 0, 60),
    clip("b", 0, 60, 60),
    clip("title", 1, 90, 30, { kind: "element", mediaStart: null }),
    clip("overlay", 2, 45, 30),
  ]);
  const target = {
    frame: 30,
    selection: new Set<string>(),
    trim: "slip",
  } as const;
  const bracket = run(
    state,
    ...editKeys.editNudgeTrimStepTrimEnd.commands(state, target),
  );
  expect(positions(bracket)).toEqual({
    a: [0, 0, 30],
    b: [0, 30, 60],
    title: [1, 60, 30],
    overlay: [2, 30, 15],
  });
  expect(bracket.clips.find(({ id }) => id === "overlay")?.mediaStart).toBe(
    0.5,
  );
  expect(bracket).toEqual(
    run(state, {
      type: "trim",
      clipId: "a",
      edge: "end",
      to: 30,
      ripple: true,
    }),
  );
});

test("V follows the enabled destination selector independently of auto-select", () => {
  const state = timeline(
    [
      clip("lowest", 1, 0, 70),
      clip("nearest", 2, 29, 50),
      clip("sound", 3, 30, 90, { kind: "audio" }),
    ],
    [{ index: 0 }, { index: 1, autoSelect: false }],
  );
  const destinations = { video: 1, audio: 3 };
  expect(nearestEditPoint(state, 30, destinations)).toEqual({
    mode: "start",
    to: "lowest",
    from: undefined,
  });
  expect(nearestEditPoint(state, 30, { ...destinations, video: 2 })?.to).toBe(
    "nearest",
  );
  expect(
    nearestEditPoint(state, 30, { ...destinations, videoEnabled: false })?.to,
  ).toBe("sound");
  expect(nearestEditPoint(state, 30, { ...destinations, video: 0 })?.to).toBe(
    "sound",
  );
  expect(
    nearestEditPoint(state, 30, {
      ...destinations,
      videoEnabled: false,
      audioEnabled: false,
    }),
  ).toBeNull();
});

test("one-sided nudges in Select refuse overlap and keep trimming their own edge", () => {
  const state = timeline([clip("a", 0, 0, 60), clip("b", 0, 60, 60)]);
  const target = {
    frame: 60,
    selection: new Set<string>(),
    editPoint: { from: "a", to: "b", mode: "end" },
  } as const;
  const grow = editKeys.editNudgeTrimStepNudgeForward.commands;
  const shorten = editKeys.editNudgeTrimStepNudgeReverse.commands;
  expect(() => run(state, ...grow(state, target))).toThrow("would overlap");
  const gap = run(state, ...shorten(state, target));
  expect(positions(run(gap, ...shorten(gap, target)))).toEqual({
    a: [0, 0, 58],
    b: [0, 60, 60],
  });
  expect(
    positions(run(state, ...grow(state, { ...target, trim: "slip" }))),
  ).toEqual({
    a: [0, 0, 61],
    b: [0, 61, 60],
  });
});

test("Paste Attributes replaces the animation tracks and skips speed ramps on either side", () => {
  const ramp = JSON.stringify({
    version: 1,
    lanes: [
      {
        target: "rate",
        points: [
          { t: 0, v: 1 },
          { t: 3, v: 1.5 },
        ],
      },
    ],
  });
  const source = clip("source", 0, 0, 90, {
    playbackRate: 0.75,
    keyframes: {
      position: [{ frame: 5, value: { x: 20, y: 10 }, ease: "linear" }],
    },
  });
  const destination = clip("destination", 0, 90, 90, {
    keyframes: { opacity: [{ frame: 0, value: 0.3, ease: "linear" }] },
  });
  for (const [from, to, skip] of [
    [source, destination, 0],
    [{ ...source, automation: ramp }, destination, 1],
    [source, { ...destination, automation: ramp }, 1],
  ] as const) {
    const state = timeline([to]);
    const { commands, skippedSpeed } = pasteAttributes(
      state,
      [from],
      from.id,
      new Set([to.id]),
    );
    expect(skippedSpeed).toBe(skip);
    expect(run(state, ...commands).clips[0]).toMatchObject({
      keyframes: source.keyframes,
      automation: to.automation,
      duration: skip ? 90 : 120,
      playbackRate: skip ? 1 : 0.75,
      x: null,
      y: null,
      opacity: null,
    });
  }
});

test("an agent ripple delete reports other tracks it cuts, not the target's linked sound", () => {
  const state = timeline(
    [
      clip("picture", 0, 0, 60, { link: "pair" }),
      clip("sound", 1, 0, 60, { kind: "audio", link: "pair" }),
      clip("music", 2, 0, 300, { kind: "audio" }),
    ],
    [
      { index: 0 },
      { index: 1, kind: "audio" },
      { index: 2, kind: "audio", name: "Music" },
    ],
  );
  const cuts: [number, string, number][] = [];
  const result = applyAll(
    state,
    [
      CommandSchema.parse({
        type: "remove",
        clipIds: ["picture"],
        ripple: true,
      }),
    ],
    {
      newId: countingIds,
      onRippleCut: (track, name, frames) => cuts.push([track, name, frames]),
    },
  );
  expect(cuts).toEqual([[2, "Music", 60]]);
  expect(positions(result)).toEqual({ music: [2, 0, 240] });
});
