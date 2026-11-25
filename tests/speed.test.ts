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
