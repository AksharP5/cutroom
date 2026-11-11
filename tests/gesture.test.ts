import { expect, test } from "bun:test";
import { applyAll, normalizeTimeline } from "../src/shared/timeline/apply";
import { clipFades } from "../src/shared/timeline/mix";
import { CommandSchema } from "../src/shared/timeline/schema";
import type { Clip, Timeline, Track } from "../src/shared/timeline/schema";
import {
  beginDrag,
  bladePreview,
  dragPreview,
  dropPreview,
  idle,
  intentAt,
  snap,
  snapTargets,
  step,
} from "../src/client/timeline/gesture";
import type { Drag, Gesture, Preview } from "../src/client/timeline/gesture";
import { anchorsChanged, editAnchors } from "../src/client/edit/anchors";

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
  opacity: null,
  fadeIn: 0,
  fadeOut: 0,
  automation: null,
  enabled: true,
  hasAudio: false,
  startRef: null,
  ...extra,
});

/**
 * V1 is track 0 and V2 track 1; A1 is track 2. Shots a and b butt at 100 with a gap before c;
 * a has linked sound, and b is 200 frames of source showing its middle 100.
 */
const sequence = (tracks: Partial<Track>[] = []): Timeline =>
  normalizeTimeline({
    fps: { num: 30, den: 1 },
    duration: 600,
    tracks: [0, 1, 2].map((index) => ({
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
      clip("b", 0, 100, 100, {
        src: "b.mp4",
        mediaStart: 50 / 30,
        sourceDuration: 200 / 30,
      }),
      clip("c", 0, 300, 100),
    ],
    markers: [
      { id: "m", frame: 250, duration: 0, name: "", note: "", color: "blue" },
    ],
    range: { in: null, out: null },
  });

const places = (timeline: Timeline) =>
  Object.fromEntries(
    timeline.clips.map((item) => [
      item.id,
      [item.track, item.start, item.duration],
    ]),
  );
/** The timeline a preview's commands make, which is what the release sends. */
const committed = (timeline: Timeline, preview: Preview) =>
  places(
    applyAll(
      timeline,
      preview.commands.map((command) => CommandSchema.parse(command)),
    ),
  );

const drag = (
  intent: Drag["intent"],
  selection: string[],
  origin: number,
  timeline = sequence(),
  playhead = 0,
) => beginDrag(timeline, intent, new Set(selection), origin, playhead);

test("a horizontal envelope press hands off to a move once, while a vertical drag keeps gain", () => {
  const press = step(idle, {
    type: "press",
    intent: { kind: "gain", clipId: "a", alone: true },
    point: { x: 0, y: 0 },
  }).gesture;
  const horizontal = step(press, {
    type: "move",
    point: { x: 4, y: 1 },
  }).gesture;
  expect(horizontal).toMatchObject({
    phase: "dragging",
    intent: { kind: "move", clipId: "a", alone: true },
  });
  expect(
    step(horizontal, { type: "move", point: { x: 4, y: 20 } }).gesture,
  ).toMatchObject({ intent: { kind: "move" } });
  expect(
    step(press, { type: "move", point: { x: 1, y: 4 } }).gesture,
  ).toMatchObject({ phase: "dragging", intent: { kind: "gain" } });
});

test("a fade drag leaves a clip's authored volume automation alone", () => {
  const timeline = sequence();
  // Hand-drawn points look like an edge ramp, but nothing marks them as Cutroom's.
  const automation = JSON.stringify({
    version: 1,
    lanes: [
      {
        target: "volume",
        points: [
          { t: 0, v: 1 },
          { t: 8, v: 0.5 },
        ],
      },
    ],
  });
  timeline.clips = [clip("music", 2, 0, 240, { automation })];
  const preview = dragPreview(
    drag({ kind: "fade", clipId: "music", edge: "fadeOut" }, [], 240, timeline),
    { frame: 210, track: 2, reach: 0 },
  );
  expect(preview.commands).toEqual([
    { type: "setClip", clipId: "music", fadeOut: 30 },
  ]);
  expect(preview.shown.clips[0]?.automation).toBe(automation);
});

test("fade drags on a clip shorter than its fades keep both handles where they are drawn", () => {
  const timeline = sequence();
  // 60/180 authored on 61 frames: the runtime scales them to 15.25 and 45.75.
  timeline.clips = [clip("music", 2, 0, 61, { fadeIn: 60, fadeOut: 180 })];
  const fadeOut = drag(
    { kind: "fade", clipId: "music", edge: "fadeOut" },
    [],
    15,
    timeline,
  );
  const preview = dragPreview(fadeOut, { frame: 20, track: 2, reach: 0 });
  expect(preview.valid).toBe(true);
  expect(clipFades(preview.shown.clips[0]!)).toEqual({
    fadeIn: 15,
    fadeOut: 41,
  });
  // Dragging back to where the handle started writes nothing, so authored lengths survive.
  expect(
    dragPreview(fadeOut, { frame: 15, track: 2, reach: 0 }).commands,
  ).toEqual([]);
  const fadeIn = drag(
    { kind: "fade", clipId: "music", edge: "fadeIn" },
    [],
    15,
    timeline,
  );
  expect(
    clipFades(
      dragPreview(fadeIn, { frame: 10, track: 2, reach: 0 }).shown.clips[0]!,
    ),
  ).toEqual({ fadeIn: 10, fadeOut: 46 });
  // The handles already meet, and they never cross.
  expect(
    dragPreview(fadeIn, { frame: 40, track: 2, reach: 0 }).commands,
  ).toEqual([]);
});

test("frozen edit anchors include linked partners and ripple followers but ignore unrelated clips", () => {
  const before = sequence();
  const commands = [
    CommandSchema.parse({
      type: "trim",
      clipId: "a",
      edge: "end",
      to: 90,
      ripple: true,
    }),
  ];
  const anchors = editAnchors(before, applyAll(before, commands), commands);
  expect(anchors.clips.map(({ id }) => id).sort()).toEqual([
    "a",
    "a-sound",
    "b",
    "c",
  ]);
  expect(anchorsChanged(anchors, { ...before, markers: [] })).toBe(false);
  for (const id of ["a-sound", "c"]) {
    expect(
      anchorsChanged(anchors, {
        ...before,
        clips: before.clips.map((clip) =>
          clip.id === id ? { ...clip, start: clip.start + 15 } : clip,
        ),
      }),
    ).toBe(true);
  }
  const move = [CommandSchema.parse({ type: "move", clipIds: ["c"], by: 30 })];
  const moved = editAnchors(before, applyAll(before, move), move);
  expect(moved.clips.map(({ id }) => id)).toEqual(["c"]);
  expect(
    anchorsChanged(moved, {
      ...before,
      clips: before.clips.map((clip) =>
        clip.id === "a" ? { ...clip, label: "An agent's name" } : clip,
      ),
    }),
  ).toBe(false);
  expect(
    anchorsChanged(moved, {
      ...before,
      clips: before.clips.filter(({ id }) => id !== "c"),
    }),
  ).toBe(true);
});

test("an overwrite freezes empty destination occupancy against both moved and inserted clips", () => {
  const before = sequence();
  const commands = [
    CommandSchema.parse({ type: "move", clipIds: ["c"], by: 100 }),
  ];
  const anchors = editAnchors(before, applyAll(before, commands), commands);
  expect(anchorsChanged(anchors, before)).toBe(false);
  for (const incoming of [
    { type: "move", clipIds: ["b"], by: 300 },
    {
      type: "insert",
      track: 0,
      at: 450,
      clip: { id: "incoming", kind: "image", src: "new.png", duration: 10 },
    },
  ]) {
    const current = applyAll(before, [CommandSchema.parse(incoming)]);
    expect(anchorsChanged(anchors, current)).toBe(true);
  }
});

test("destination snapshots include linked tracks, preserve selection gaps, and use exclusive ends", () => {
  const before = sequence();
  const commands = [
    CommandSchema.parse({ type: "move", clipIds: ["a", "c"], by: 500 }),
  ];
  const anchors = editAnchors(before, applyAll(before, commands), commands);
  const arriving = (track: number, at: number, duration: number) =>
    normalizeTimeline({
      ...before,
      clips: [...before.clips, clip("incoming", track, at, duration)],
    });
  expect(anchorsChanged(anchors, arriving(2, 550, 10))).toBe(true);
  expect(anchorsChanged(anchors, arriving(0, 600, 200))).toBe(false);
  expect(anchorsChanged(anchors, arriving(0, 599, 1))).toBe(true);
  expect(anchorsChanged(anchors, arriving(0, 800, 1))).toBe(true);
  const alone = [
    CommandSchema.parse({
      type: "move",
      clipIds: ["a"],
      by: 500,
      linked: false,
    }),
  ];
  expect(
    anchorsChanged(
      editAnchors(before, applyAll(before, alone), alone),
      arriving(2, 550, 10),
    ),
  ).toBe(false);
});

test("a press arms, three pixels of travel start the drag, and a release commits it", () => {
  const intent = { kind: "move", clipId: "a", alone: false } as const;
  const press = step(idle, { type: "press", intent, point: { x: 10, y: 10 } });
  expect(press).toEqual({
    gesture: { phase: "armed", intent, origin: { x: 10, y: 10 } },
    outcome: null,
  });

  const near = step(press.gesture, { type: "move", point: { x: 12, y: 11 } });
  expect(near.gesture.phase).toBe("armed");
  // A press that never travelled is a click: it selects, and the blade cuts.
  expect(step(near.gesture, { type: "release" })).toEqual({
    gesture: idle,
    outcome: "click",
  });

  const far = step(near.gesture, { type: "move", point: { x: 13, y: 10 } });
  expect(far.gesture.phase).toBe("dragging");
  // Once dragging, coming back inside the threshold does not disarm it.
  const back = step(far.gesture, { type: "move", point: { x: 10, y: 10 } });
  expect(back.gesture).toEqual({
    phase: "dragging",
    intent,
    origin: { x: 10, y: 10 },
    point: { x: 10, y: 10 },
  });
  expect(step(back.gesture, { type: "release" })).toEqual({
    gesture: idle,
    outcome: "commit",
  });
});

test("Esc cancels an armed press or a drag, and a second press never replaces the first", () => {
  const first = { kind: "move", clipId: "a", alone: false } as const;
  const armed = step(idle, {
    type: "press",
    intent: first,
    point: { x: 0, y: 0 },
  }).gesture;
  const dragging = step(armed, {
    type: "move",
    point: { x: 9, y: 0 },
  }).gesture;
  for (const gesture of [armed, dragging] satisfies Gesture[]) {
    expect(step(gesture, { type: "cancel" })).toEqual({
      gesture: idle,
      outcome: "cancel",
    });
    expect(
      step(gesture, {
        type: "press",
        intent: { kind: "marquee" },
        point: { x: 50, y: 50 },
      }).gesture,
    ).toBe(gesture);
  }
  // Nothing is under way, so there is nothing to end.
  expect(step(idle, { type: "release" }).outcome).toBeNull();
  expect(step(idle, { type: "cancel" }).outcome).toBeNull();
});

test("a press means move, resize, ripple, roll, or razor by tool and by where it lands", () => {
  const timeline = sequence();
  const [a, b, c] = timeline.clips as [Clip, Clip, Clip];
  const hit = (target: Clip, x: number) => ({ clip: target, x, width: 200 });

  expect(intentAt("pointer", timeline, hit(b, 100))).toEqual({
    kind: "move",
    clipId: "b",
    alone: false,
  });
  expect(intentAt("pointer", timeline, hit(b, 100), true)).toMatchObject({
    alone: true,
  });
  expect(intentAt("pointer", timeline, hit(b, 3))).toEqual({
    kind: "trim",
    clipId: "b",
    edge: "start",
    ripple: false,
  });
  expect(intentAt("pointer", timeline, hit(b, 195))).toMatchObject({
    edge: "end",
    ripple: false,
  });

  // Trim on the cut where a meets b rolls it; further inside either clip, that edge ripples.
  expect(intentAt("trim", timeline, hit(b, 2))).toEqual({
    kind: "roll",
    left: "a",
    right: "b",
  });
  expect(intentAt("trim", timeline, hit(a, 198))).toEqual({
    kind: "roll",
    left: "a",
    right: "b",
  });
  expect(intentAt("trim", timeline, hit(b, 6))).toEqual({
    kind: "trim",
    clipId: "b",
    edge: "start",
    ripple: true,
  });
  // b's end and c's start face a gap: nothing to roll against.
  expect(intentAt("trim", timeline, hit(c, 1))).toMatchObject({
    kind: "trim",
    edge: "start",
    ripple: true,
  });
  expect(intentAt("trim", timeline, hit(b, 100))).toBeNull();

  expect(intentAt("blade", timeline, hit(b, 3))).toEqual({
    kind: "blade",
    clipId: "b",
  });
  expect(intentAt("blade", timeline, null)).toBeNull();
  expect(intentAt("pointer", timeline, null)).toEqual({ kind: "marquee" });

  // A narrow clip keeps a body to grab: each edge takes a third at most.
  expect(
    intentAt("pointer", timeline, { clip: b, x: 6, width: 12 }),
  ).toMatchObject({ kind: "move" });
  // Clips on a locked track start nothing.
  expect(
    intentAt("pointer", sequence([{ index: 0, locked: true }]), hit(b, 100)),
  ).toBeNull();
});

test("edges snap to the nearest target in reach and to nothing beyond it", () => {
  const targets = [0, 100, 250, 400];
  expect(snap([96], targets, 5)).toEqual({ by: 4, at: 100 });
  expect(snap([94], targets, 5)).toBeNull();
  // The closest pair wins across every dragged edge: an end 2 away beats a start 4 away.
  expect(snap([104, 252], targets, 5)).toEqual({ by: -2, at: 250 });
  expect(snap([500], targets, 5)).toBeNull();
  expect(snap([96], targets, 0)).toBeNull();
});

test("snap targets are the playhead, markers, in and out, and edges of clips that stay put", () => {
  const timeline = { ...sequence(), range: { in: 20, out: 380 } };
  expect(snapTargets(timeline, 150)).toEqual([
    0, 20, 100, 150, 200, 250, 300, 380, 400,
  ]);
  // A moving clip is no target for itself, and a ripple leaves out what it is about to move.
  expect(snapTargets(timeline, 150, new Set(["b"]))).toEqual([
    0, 20, 100, 150, 250, 300, 380, 400,
  ]);
  expect(snapTargets(timeline, 150, new Set(), 200)).toEqual([
    0, 20, 100, 150, 200, 250, 380,
  ]);
});

test("dragging a clip moves it and its linked partner; Alt moves it alone", () => {
  const timeline = sequence();
  const together = dragPreview(
    drag({ kind: "move", clipId: "c", alone: false }, ["c"], 320),
    { frame: 370, track: 0, reach: 0 },
  );
  expect(together).toMatchObject({ label: "Move", valid: true, delta: 50 });
  expect(together.commands).toEqual([
    { type: "move", clipIds: ["c"], by: 50, trackBy: 0, mode: "overwrite" },
  ]);

  // Held over b, c replaces it in the preview as well as on release.
  const over = dragPreview(
    drag({ kind: "move", clipId: "c", alone: false }, ["c"], 320),
    { frame: 120, track: 0, reach: 0 },
  );
  expect(over.valid).toBe(true);
  expect(places(over.shown).b).toBeUndefined();
  expect(places(over.shown).c).toEqual([0, 100, 100]);

  const alone = dragPreview(
    drag({ kind: "move", clipId: "a-sound", alone: true }, ["a-sound"], 10),
    { frame: 410, track: 2, reach: 0 },
  );
  expect(alone.commands).toEqual([
    {
      type: "move",
      clipIds: ["a-sound"],
      by: 400,
      trackBy: 0,
      mode: "overwrite",
      linked: false,
    },
  ]);
  expect(committed(timeline, alone)).toMatchObject({
    a: [0, 0, 100],
    "a-sound": [2, 400, 100],
  });
});

test("a move snaps, stops at the timeline's start, and carries only its own kind across tracks", () => {
  const timeline = sequence();
  // c's start lands 3 frames from b's end at 200 and takes it.
  const snapped = dragPreview(
    drag({ kind: "move", clipId: "c", alone: false }, ["c"], 320),
    { frame: 223, track: 0, reach: 5 },
  );
  expect(snapped).toMatchObject({ snap: 200, delta: -100, valid: true });
  // With snapping off the same drop lands where the pointer left it.
  expect(
    dragPreview(drag({ kind: "move", clipId: "c", alone: false }, ["c"], 320), {
      frame: 223,
      track: 0,
      reach: 0,
    }),
  ).toMatchObject({ snap: null, delta: -97 });

  const pinned = dragPreview(
    drag({ kind: "move", clipId: "a", alone: false }, ["a", "a-sound"], 50),
    { frame: -40, track: 0, reach: 0 },
  );
  expect(pinned.commands).toEqual([]);

  // Dragged up a track, the picture goes to V2 and its linked sound follows in time on A1.
  const lifted = dragPreview(
    drag({ kind: "move", clipId: "a", alone: false }, ["a", "a-sound"], 50),
    { frame: 550, track: 1, reach: 0 },
  );
  expect(lifted.commands).toEqual([
    {
      type: "move",
      clipIds: ["a", "a-sound"],
      by: 500,
      trackBy: 1,
      trackClipIds: ["a"],
      mode: "overwrite",
    },
  ]);
  expect(committed(timeline, lifted)).toMatchObject({
    a: [1, 500, 100],
    "a-sound": [2, 500, 100],
  });
  expect(places(lifted.shown)).toEqual(committed(timeline, lifted));

  // Picture held over an audio track is refused and still drawn where it is held.
  const wrong = dragPreview(
    drag({ kind: "move", clipId: "c", alone: false }, ["c"], 320),
    { frame: 320, track: 2, reach: 0 },
  );
  expect(wrong.valid).toBe(false);
  expect(places(wrong.shown).c).toEqual([2, 300, 100]);
});

test("an overwrite drag previews both surviving pieces and anchors the covered clip", () => {
  const timeline = sequence();
  const preview = dragPreview(
    drag({ kind: "move", clipId: "b", alone: false }, ["b"], 150),
    { frame: 400, track: 0, reach: 0 },
  );
  // b lands [350,450), trimming c to [300,350).
  expect(places(preview.shown)).toMatchObject({
    b: [0, 350, 100],
    c: [0, 300, 50],
  });
  expect(
    editAnchors(timeline, preview.shown, preview.commands).clips.map(
      (clip) => clip.id,
    ),
  ).toEqual(["b", "c"]);

  const shorter = {
    ...timeline,
    clips: timeline.clips.map((clip) =>
      clip.id === "b" ? { ...clip, duration: 30 } : clip,
    ),
  };
  const split = dragPreview(
    drag({ kind: "move", clipId: "b", alone: false }, ["b"], 110, shorter),
    { frame: 330, track: 0, reach: 0 },
  );
  const tailId = [...split.pieces!.keys()][0]!;
  expect(split.pieces?.get(tailId)).toBe("c");
  expect(places(split.shown)).toMatchObject({
    b: [0, 320, 30],
    c: [0, 300, 20],
    [tailId]: [0, 350, 50],
  });
});

test("Select resizes an edge up to its neighbour and its source; Trim ripples it", () => {
  const timeline = sequence();
  const resize = (edge: "start" | "end", origin: number, frame: number) =>
    dragPreview(
      drag({ kind: "trim", clipId: "b", edge, ripple: false }, ["b"], origin),
      { frame, track: 0, reach: 0 },
    );
  expect(resize("end", 200, 170).commands).toEqual([
    { type: "trim", clipId: "b", edge: "end", to: 170, ripple: false },
  ]);
  expect(resize("end", 200, 170)).toMatchObject({
    label: "Resize",
    delta: -30,
  });
  // 50 frames of source remain after b's end: the edge stops there, short of c at 300.
  expect(resize("end", 200, 290)).toMatchObject({ delta: 50, valid: true });
  // The start cannot cross a, which ends where b begins.
  expect(resize("start", 100, 40).commands).toEqual([]);
  // Nor can a clip be dragged shut: one frame stays.
  expect(resize("end", 200, 20)).toMatchObject({ delta: -99 });

  const ripple = dragPreview(
    drag({ kind: "trim", clipId: "b", edge: "end", ripple: true }, ["b"], 200),
    { frame: 150, track: 0, reach: 0 },
  );
  expect(ripple.label).toBe("Ripple trim");
  expect(committed(timeline, ripple)).toMatchObject({
    b: [0, 100, 50],
    c: [0, 250, 100],
  });
  expect(places(ripple.shown)).toEqual(committed(timeline, ripple));

  // The marker at 250 pulls a resized edge the last three frames.
  expect(
    dragPreview(
      drag(
        { kind: "trim", clipId: "b", edge: "end", ripple: false },
        ["b"],
        200,
      ),
      { frame: 247, track: 0, reach: 5 },
    ),
  ).toMatchObject({ snap: 250, delta: 50 });
});

test("a roll moves the cut and leaves both clips' far edges where they were", () => {
  const timeline = sequence();
  const roll = (frame: number) =>
    dragPreview(
      drag({ kind: "roll", left: "a", right: "b" }, ["a", "b"], 100),
      {
        frame,
        track: 0,
        reach: 0,
      },
    );
  // Either way, the clip that gives way is trimmed first, so the batch never overlaps.
  expect(
    roll(80).commands.map(
      (command) => command.type === "trim" && command.clipId,
    ),
  ).toEqual(["a", "b"]);
  expect(
    roll(120).commands.map(
      (command) => command.type === "trim" && command.clipId,
    ),
  ).toEqual(["b", "a"]);
  expect(committed(timeline, roll(80))).toMatchObject({
    a: [0, 0, 80],
    "a-sound": [2, 0, 80],
    b: [0, 80, 120],
    c: [0, 300, 100],
  });
  // b has 50 frames of source before its start: the cut rolls back that far and stops.
  expect(roll(10)).toMatchObject({ label: "Roll", delta: -50 });
});

test("the blade cuts the clip under it at that frame, snapped only inside the clip", () => {
  const timeline = sequence();
  const b = timeline.clips.find((item) => item.id === "b")!;
  const cut = dragPreview(drag({ kind: "blade", clipId: "b" }, [], 130), {
    frame: 130,
    track: 0,
    reach: 0,
  });
  expect(cut.commands).toEqual([{ type: "split", at: 130, clipIds: ["b"] }]);
  expect(cut.label).toBe("Razor");
  expect(bladePreview(timeline, b, 147, [150], 5)).toMatchObject({
    at: 150,
    snap: 150,
  });
  // The clip's own edge is in reach, but a cut there cuts nothing: the frame under the pointer stands.
  expect(bladePreview(timeline, b, 103, [100], 5)).toMatchObject({
    at: 103,
    snap: null,
    valid: true,
  });
  expect(bladePreview(timeline, b, 100, [], 0)).toMatchObject({
    commands: [],
    valid: false,
  });
});

test("dropped media is placed in free space, inserted over a clip, and refused on the wrong kind of track", () => {
  const timeline = sequence();
  const [video, , audio] = timeline.tracks as [Track, Track, Track];
  const media = { kind: "video", src: "assets/new.mp4", frames: 60 } as const;
  const insert = (preview: Preview) => {
    const [command] = preview.commands;
    return command?.type === "insert" ? [command.mode, command.at] : null;
  };

  const free = dropPreview(timeline, media, video, 420, 0, 0);
  expect(insert(free)).toEqual(["place", 420]);
  expect(free.valid).toBe(true);
  // Its end takes c's start when dropped a little short of it.
  expect(dropPreview(timeline, media, video, 238, 0, 5)).toMatchObject({
    at: 240,
    snap: 300,
  });

  // On the cut between a and b it is inserted, and every track opens 60 frames there.
  const over = dropPreview(timeline, media, video, 102, 0, 5);
  expect(insert(over)).toEqual(["insert", 100]);
  expect(places(over.shown)).toMatchObject({
    a: [0, 0, 100],
    b: [0, 160, 100],
    c: [0, 360, 100],
  });

  const wrong = dropPreview(timeline, media, audio, 420, 0, 0);
  expect(wrong.valid).toBe(false);
  expect(wrong.shown).toBe(timeline);
  // An empty placeholder row has no persisted track yet; its kind still constrains the drop.
  const placeholder = dropPreview(
    timeline,
    media,
    { index: 3, kind: "audio" },
    420,
    0,
    0,
  );
  expect(() => committed(timeline, placeholder)).toThrow("an audio track");
  expect(
    dropPreview(
      timeline,
      { kind: "audio", src: "bed.wav", frames: 60 },
      audio,
      420,
      0,
      0,
    ).valid,
  ).toBe(true);
});
