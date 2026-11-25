import { expect, test } from "bun:test";
import { applyAll, normalizeTimeline } from "../src/shared/timeline/apply";
import { CommandSchema } from "../src/shared/timeline/schema";
import type { Clip, Timeline } from "../src/shared/timeline/schema";
import {
  sourceOutFrame,
  speedAtFrame,
  speedCurve,
  speedLevel,
  speedPoints,
} from "../src/shared/timeline/speed";
import { countingIds } from "./clip-ids";
import { agentTimeline } from "../src/server/mcp/timelineReply";
import { resolveClip } from "../src/shared/timeline/clipTiming";
import { frames, secondsOf, sourceAt } from "../src/shared/timeline/piece";

const fps = { num: 30, den: 1 };
/** The agent's Hero ramp from the design spec: 100% to 160% to 25% and back, over 6 s. */
const HERO = JSON.stringify({
  version: 1,
  lanes: [
    {
      target: "rate",
      points: [
        { t: 0, v: 1 },
        { t: 1.5, v: 1.6 },
        { t: 3, v: 0.25 },
        { t: 4.5, v: 1.6 },
        { t: 6, v: 1 },
      ],
    },
  ],
});

const clip = (extra: Partial<Clip> = {}): Clip => ({
  id: "broll",
  track: 0,
  kind: "video",
  start: 180,
  duration: 180,
  mediaStart: 0,
  playbackRate: 1,
  src: "broll.mp4",
  sourceDuration: 20,
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

const timeline = (clips: Clip[]): Timeline =>
  normalizeTimeline({
    fps,
    duration: 600,
    tracks: [],
    clips,
    markers: [],
    range: { in: null, out: null },
  });

test("a ramp reads as its points in clip frames, and a constant clip has none", () => {
  const hero = clip({ automation: HERO });
  expect(speedPoints(hero, fps)).toEqual([
    { frame: 0, speed: 1, ease: "linear" },
    { frame: 45, speed: 1.6, ease: "linear" },
    { frame: 90, speed: 0.25, ease: "linear" },
    { frame: 135, speed: 1.6, ease: "linear" },
    { frame: 180, speed: 1, ease: "linear" },
  ]);
  expect(speedAtFrame(hero, fps, 90)).toBeCloseTo(0.25, 9);
  // Halfway from 160% to 25% on the log scale is 63.2%, not the arithmetic 92.5%.
  expect(speedAtFrame(hero, fps, 67.5)).toBeCloseTo(Math.sqrt(1.6 * 0.25), 9);
  expect(speedPoints(clip({ playbackRate: 2 }), fps)).toBeNull();
  expect(speedAtFrame(clip({ playbackRate: 2 }), fps, 10)).toBe(2);
});

test("both pieces of a cut ramp read the speed the whole clip had at each frame", () => {
  const whole = clip({ automation: HERO });
  const cut = applyAll(
    timeline([whole]),
    [CommandSchema.parse({ type: "split", clipIds: ["broll"], at: 250 })],
    { newId: countingIds },
  );
  const [head, tail] = cut.clips;
  expect(tail!.start).toBe(250);
  expect(speedPoints(tail!, fps)!.map(({ frame }) => frame)).toEqual([
    -70, -25, 20, 65, 110,
  ]);
  for (const at of [180, 225, 249, 250, 270, 359])
    expect(
      speedAtFrame(at < 250 ? head! : tail!, fps, at - (at < 250 ? 180 : 250)),
    ).toBeCloseTo(speedAtFrame(whole, fps, at - 180), 9);
  expect(sourceOutFrame(tail!, fps)).toBe(sourceOutFrame(whole, fps));
});

test("Source Out is the source frame on the clip's last frame", () => {
  expect(sourceOutFrame(clip(), fps)).toBe(179);
  expect(sourceOutFrame(clip({ playbackRate: 2, mediaStart: 1 }), fps)).toBe(
    30 + 179 * 2,
  );
  // 100% to 200% over 6 s on the log scale is 2^(t/6), whose integral to the last frame,
  // 179/30 s, is 6/ln 2 * (2^(179/180) - 1) = 8.5896 s of source.
  const doubling = JSON.stringify({
    version: 1,
    lanes: [
      {
        target: "rate",
        points: [
          { t: 0, v: 1 },
          { t: 6, v: 2 },
        ],
      },
    ],
  });
  expect(sourceOutFrame(clip({ automation: doubling }), fps)).toBe(257);
});

test("the drawn curve is the points, plus samples only through shaped segments", () => {
  expect(speedCurve(clip({ automation: HERO }), fps)).toHaveLength(5);
  const shaped = JSON.parse(HERO);
  shaped.lanes[0].points[1].curve = 0.5;
  const curve = speedCurve(clip({ automation: JSON.stringify(shaped) }), fps);
  expect(curve).toHaveLength(5 + 23);
  expect(curve.map(({ frame }) => frame)).toEqual(
    curve.map(({ frame }) => frame).sort((a, b) => a - b),
  );
});

test("the speed scale is logarithmic: 50% and 200% sit equally far from 100%", () => {
  expect(speedLevel(1)).toBe(0.5);
  expect(speedLevel(10)).toBe(0);
  expect(speedLevel(0.1)).toBe(1);
  expect(speedLevel(0.5) - 0.5).toBeCloseTo(0.5 - speedLevel(2), 12);
});

test("agents read a ramp as speed points and its source Out, and a constant clip as before", () => {
  const { clips } = agentTimeline(
    timeline([
      clip({ automation: HERO }),
      clip({ id: "talk", start: 0, playbackRate: 2 }),
    ]),
  );
  const ramped = clips.find(({ id }) => id === "broll");
  const plain = clips.find(({ id }) => id === "talk");
  expect(ramped).toMatchObject({
    speed: { points: speedPoints(clip({ automation: HERO }), fps) },
    sourceOut: 179,
    automation: { lanes: ["rate"] },
  });
  expect(plain).not.toHaveProperty("speed");
  expect(plain).not.toHaveProperty("sourceOut");
  expect(plain!.playbackRate).toBe(2);
});

const edit = (state: Timeline, command: object) =>
  applyAll(state, [CommandSchema.parse({ type: "setSpeed", ...command })], {
    newId: countingIds,
  });
const linked = () =>
  timeline([
    clip({ link: "kick", sourceDuration: 20 }),
    clip({
      id: "kick-a",
      kind: "audio",
      track: 1,
      link: "kick",
      hasAudio: true,
    }),
  ]);
const sourceSeconds = (state: Timeline, id: string, frame: number) => {
  const time = sourceAt(
    resolveClip(
      state.clips.find((item) => item.id === id)!,
      fps,
    ),
    frames(frame, fps),
  );
  return typeof time === "number" ? time : secondsOf(time);
};

test("speed points set picture and sound together, keeping length, first frame and eases", () => {
  const after = edit(linked(), {
    clipId: "broll",
    points: [
      { frame: 0, speed: 1, ease: "ease-in-out" },
      { frame: 60, speed: 0.25, ease: "hold" },
      { frame: 120, speed: 2 },
    ],
  });
  for (const id of ["broll", "kick-a"]) {
    const edited = after.clips.find((item) => item.id === id)!;
    expect(edited).toMatchObject({ start: 180, duration: 180, mediaStart: 0 });
    expect(speedPoints(edited, fps)).toEqual([
      { frame: 0, speed: 1, ease: "ease-in-out" },
      { frame: 60, speed: 0.25, ease: "hold" },
      { frame: 120, speed: 2, ease: "linear" },
    ]);
  }
  const broll = after.clips.find((item) => item.id === "broll")!;
  // Ease in and out is symmetric: halfway in time is halfway on the log scale.
  expect(speedAtFrame(broll, fps, 30)).toBeCloseTo(0.5, 6);
  // Hold keeps 25% up to the next point, then changes on that frame.
  expect(speedAtFrame(broll, fps, 119.9)).toBe(0.25);
  expect(speedAtFrame(broll, fps, 120)).toBe(2);
  // A held second at 25% plays exactly a quarter second of source, even across the step.
  expect(
    sourceSeconds(after, "broll", 300) - sourceSeconds(after, "broll", 240),
  ).toBeCloseTo(0.5, 6);
});

test("Hold draws a horizontal segment and steps at the next point", () => {
  const ramp = edit(timeline([clip()]), {
    clipId: "broll",
    points: [
      { frame: 0, speed: 1, ease: "hold" },
      { frame: 90, speed: 4 },
    ],
  }).clips[0]!;
  expect(speedCurve(ramp, fps)).toEqual([
    { frame: 0, speed: 1 },
    { frame: 90, speed: 1 },
    { frame: 90, speed: 4 },
    { frame: 180, speed: 4 },
  ]);
  expect(speedAtFrame(ramp, fps, 89)).toBe(1);
  expect(speedAtFrame(ramp, fps, 90)).toBe(4);
});

test.each([0.5, 2])(
  "a J-cut keeps the edited picture's first source frame at %s speed",
  (speed) => {
    const state = timeline([
      clip({ start: 60, mediaStart: 5, link: "take" }),
      clip({
        id: "kick-a",
        kind: "audio",
        track: 1,
        start: 0,
        duration: 240,
        mediaStart: 3,
        link: "take",
      }),
    ]);
    const after = edit(state, {
      clipId: "broll",
      points: [{ frame: 0, speed }],
    });
    expect(sourceSeconds(after, "broll", 60)).toBe(5);
    for (const frame of [60, 90, 239])
      expect(sourceSeconds(after, "kick-a", frame)).toBeCloseTo(
        sourceSeconds(after, "broll", frame),
        6,
      );
  },
);

test("a preset with overlapping points names the short clip", () => {
  expect(() =>
    edit(timeline([clip({ duration: 5 })]), {
      clipId: "broll",
      preset: "speed-through",
    }),
  ).toThrow("Clip broll is too short for the Speed through preset.");
});

test("setSpeed ignores the hit frame for explicit points and presets that do not use it", () => {
  const state = timeline([clip()]);
  const points = [{ frame: 0, speed: 1 }];
  expect(edit(state, { clipId: "broll", points, at: 500 })).toEqual(
    edit(state, { clipId: "broll", points }),
  );
  expect(
    edit(state, { clipId: "broll", preset: "speed-through", at: 500 }),
  ).toEqual(edit(state, { clipId: "broll", preset: "speed-through" }));
});

test("a ramp that would run past the source is refused with the frame and the most it can take", () => {
  const state = timeline([clip({ sourceDuration: 8 })]);
  const fast = (speed: number) => () =>
    edit(state, {
      clipId: "broll",
      points: [
        { frame: 0, speed: 1 },
        { frame: 90, speed },
        { frame: 180, speed: 1 },
      ],
    });
  expect(fast(4)).toThrow(
    /runs past the end of its source at frame 2\d\d; the most the point at frame 270 can take is \d+%\./,
  );
  const most = Number(/can take is (\d+)%/.exec(String(trial(fast(4))))![1]);
  // The bound it names fits, and a little more does not.
  expect(trial(fast(most / 100))).toBeUndefined();
  expect(trial(fast(most / 100 + 0.05))).toBeInstanceOf(Error);
});

const trial = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error;
  }
};

test("constant speed resizes a constant clip, and flattens a ramp at its length", () => {
  const constant = edit(timeline([clip()]), { clipId: "broll", speed: 2 });
  expect(constant.clips[0]).toMatchObject({ playbackRate: 2, duration: 90 });
  const flat = edit(timeline([clip({ automation: HERO })]), {
    clipId: "broll",
    speed: 1,
  });
  expect(flat.clips[0]).toMatchObject({
    playbackRate: 1,
    duration: 180,
    automation: null,
  });
});

test("Slow-mo hit keeps the picture at the playhead and slows it to 25%", () => {
  const state = timeline([clip({ mediaStart: 2 })]);
  const before = sourceSeconds(state, "broll", 180 + 100);
  const after = edit(state, {
    clipId: "broll",
    preset: "slow-mo-hit",
    at: 100,
  });
  expect(sourceSeconds(after, "broll", 180 + 100)).toBeCloseTo(before, 4);
  expect(speedAtFrame(after.clips[0]!, fps, 100)).toBe(0.25);
  expect(after.clips[0]!.duration).toBe(180);
});

test("a ramp keeps staggered picture and sound on the same source time", () => {
  const state = timeline([
    clip({ start: 0, link: "take" }),
    clip({
      id: "kick-a",
      kind: "audio",
      track: 1,
      start: 60,
      duration: 120,
      mediaStart: 2,
      link: "take",
    }),
  ]);
  const after = edit(state, {
    clipId: "broll",
    points: [
      { frame: 0, speed: 0.5 },
      { frame: 179, speed: 0.5 },
    ],
  });
  expect(sourceSeconds(after, "broll", 0)).toBe(0);
  for (const frame of [60, 90, 179]) {
    expect(sourceSeconds(after, "broll", frame)).toBeCloseTo(frame / 60, 6);
    expect(sourceSeconds(after, "kick-a", frame)).toBeCloseTo(frame / 60, 6);
  }
  const flat = edit(after, { clipId: "broll", speed: 1 });
  expect(sourceSeconds(flat, "kick-a", 90)).toBeCloseTo(3, 6);
});

test("Slow-mo hit keeps each linked file's own source time at the hit", () => {
  const state = timeline([
    clip({ link: "take", mediaStart: 2 }),
    clip({
      id: "kick-a",
      kind: "audio",
      track: 1,
      src: "external.wav",
      start: 210,
      duration: 150,
      mediaStart: 5,
      link: "take",
    }),
  ]);
  const hit = 280;
  const after = edit(state, {
    clipId: "broll",
    preset: "slow-mo-hit",
    at: 100,
  });
  for (const id of ["broll", "kick-a"])
    expect(sourceSeconds(after, id, hit)).toBeCloseTo(
      sourceSeconds(state, id, hit),
      5,
    );
  expect(
    sourceSeconds(after, "kick-a", 310) - sourceSeconds(after, "broll", 310),
  ).toBeCloseTo(2, 5);
});

test("Slow-mo hit still lands when the source has too little tail for its default shape", () => {
  const state = timeline([
    clip({ mediaStart: 4, playbackRate: 0.2, sourceDuration: 5.2 }),
  ]);
  const hit = 300;
  const notices: string[] = [];
  const after = applyAll(
    state,
    [
      CommandSchema.parse({
        type: "setSpeed",
        clipId: "broll",
        preset: "slow-mo-hit",
        at: 120,
      }),
    ],
    { onNotice: (notice: string) => notices.push(notice) },
  );
  expect(sourceSeconds(after, "broll", hit)).toBeCloseTo(4.8, 5);
  expect(sourceOutFrame(after.clips[0]!, fps)).toBeLessThan(156);
  expect(notices).toEqual(["Not enough source after the hit. Slowed to 20%."]);
});

test("Slow-mo hit names a surrounding speed cap when the hit itself stays at 25%", () => {
  const state = timeline([
    clip({ mediaStart: 4, playbackRate: 0.2, sourceDuration: 5.8 }),
  ]);
  const notices: string[] = [];
  const after = applyAll(
    state,
    [{ type: "setSpeed", clipId: "broll", preset: "slow-mo-hit", at: 120 }],
    { onNotice: (notice) => notices.push(notice) },
  );
  const ramp = after.clips[0]!;
  const cap = Math.round(speedAtFrame(ramp, fps, 0) * 100);
  expect(cap).toBeGreaterThan(25);
  expect(cap).toBeLessThan(100);
  expect(speedAtFrame(ramp, fps, 120)).toBe(0.25);
  expect(notices).toEqual([
    `Not enough source after the hit. Surrounding speeds capped at ${cap}%.`,
  ]);
});

test("constant speed with linked false leaves even a following linked partner in place", () => {
  const base = linked();
  const partner = { ...base.clips[1]!, start: 360 };
  const state = timeline([base.clips[0]!, partner]);
  const after = edit(state, { clipId: "broll", speed: 2, linked: false });
  expect(after.clips[0]).toMatchObject({ playbackRate: 2, duration: 90 });
  expect(after.clips[1]).toEqual(partner);
});

test("a ramp edit refuses a background-removed linked picture", () => {
  const base = linked();
  const state = timeline([
    { ...base.clips[0]!, background: { shrink: 1, soften: 1 } },
    base.clips[1]!,
  ]);
  expect(() =>
    edit(state, {
      clipId: "kick-a",
      points: [{ frame: 0, speed: 0.5 }],
    }),
  ).toThrow(/background is removed/);
  expect(
    edit(state, {
      clipId: "kick-a",
      points: [{ frame: 0, speed: 0.5 }],
      linked: false,
    }).clips[0]!.background,
  ).toEqual({ shrink: 1, soften: 1 });
});

test("Slow-mo hit must aim at an actual clip frame", () => {
  const state = timeline([clip()]);
  for (const at of [-1, 180, 10_000])
    expect(() =>
      edit(state, { clipId: "broll", preset: "slow-mo-hit", at }),
    ).toThrow(/hit frame .* outside .* 0 to 179/);
  expect(
    edit(state, { clipId: "broll", preset: "slow-mo-hit", at: 179 }).clips[0]!
      .duration,
  ).toBe(180);
});

test("two points on one frame are refused, and an omitted ease keeps a custom shape", () => {
  expect(() =>
    edit(timeline([clip()]), {
      clipId: "broll",
      points: [
        { frame: 30, speed: 1 },
        { frame: 30, speed: 2 },
      ],
    }),
  ).toThrow("Two speed points share frame 30. Use Hold");
  const shaped = JSON.parse(HERO);
  shaped.lanes[0].points[1].curve = 0.5;
  const after = edit(timeline([clip({ automation: JSON.stringify(shaped) })]), {
    clipId: "broll",
    points: speedPoints(clip({ automation: JSON.stringify(shaped) }), fps)!.map(
      ({ frame, speed, ease }) =>
        ease === "custom"
          ? { frame, speed: speed * 2 }
          : { frame, speed, ease },
    ),
  });
  expect(speedPoints(after.clips[0]!, fps)![1]).toEqual({
    frame: 45,
    speed: 3.2,
    ease: "custom",
  });
});
