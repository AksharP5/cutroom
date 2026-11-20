import { expect, test } from "bun:test";
import { applyAll } from "../src/shared/timeline/apply";
import { CommandSchema, TimelineSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { newTrack } from "../src/shared/timeline/tracks";
import {
  escapeXml,
  fcpTime,
  framesAt,
  timecodeFrames,
} from "../src/server/resolve/fcpxml";
import { planResolveTimeline, simplify } from "../src/server/resolve/plan";
import type { ClipMedia } from "../src/server/resolve/plan";
import type { MediaFacts } from "../src/server/resolve/probe";

const NTSC = { num: 30000, den: 1001 };

test("frame times stay exact at NTSC rates", () => {
  // 120 frames at 29.97 is 4.004 s, written as a reduced fraction.
  expect(fcpTime(framesAt(120, NTSC))).toBe("1001/250s");
  expect(fcpTime(framesAt(1, { num: 60000, den: 1001 }))).toBe("1001/60000s");
  expect(fcpTime(framesAt(0, NTSC))).toBe("0s");
  expect(fcpTime(framesAt(48, { num: 24, den: 1 }))).toBe("2s");
  // An hour of 29.97 frames does not drift from the rational.
  expect(fcpTime(framesAt(107892, NTSC))).toBe("8999991/2500s");
});

test("drop-frame timecode skips the dropped labels, non-drop counts every frame", () => {
  expect(timecodeFrames("01:00:00;00", NTSC)).toBe(107892);
  expect(timecodeFrames("00:01:00;02", NTSC)).toBe(1800);
  expect(timecodeFrames("00:10:00;00", NTSC)).toBe(17982);
  expect(timecodeFrames("01:00:00;00", { num: 60000, den: 1001 })).toBe(215784);
  expect(timecodeFrames("01:00:00:00", NTSC)).toBe(108000);
  expect(timecodeFrames("01:00:00:00", { num: 24000, den: 1001 })).toBe(86400);
  expect(timecodeFrames("00:00:01:30", NTSC)).toBeNull();
  expect(timecodeFrames("garbage", NTSC)).toBeNull();
});

test("text written into the timeline cannot break out of its attribute", () => {
  expect(escapeXml(`a"b'<c>&d\u0000\u0007`)).toBe(
    "a&quot;b&apos;&lt;c&gt;&amp;d",
  );
});

test("simplified keys redraw every frame of a curve exactly", () => {
  const values = Array.from({ length: 31 }, (_, frame) =>
    frame < 10 ? 0 : frame < 20 ? (frame - 10) ** 2 : 100,
  );
  const keys = simplify(values, (value) => [value]);
  const at = (frame: number) => {
    const next = keys.findIndex((key) => key.frame >= frame);
    const key = keys[next]!;
    if (key.frame === frame) return key.value;
    const before = keys[next - 1]!;
    return (
      before.value +
      ((key.value - before.value) * (frame - before.frame)) /
        (key.frame - before.frame)
    );
  };
  values.forEach((value, frame) => expect(at(frame)).toBeCloseTo(value, 6));
  // The straight runs need no keys inside them.
  expect(keys.length).toBeLessThan(values.length - 10);
});

const facts = (
  path: string,
  options: { timecode?: number; audio?: boolean } = {},
): MediaFacts => ({
  path,
  video: {
    rate: NTSC,
    width: 1920,
    height: 1080,
    start: 0,
    timecode: options.timecode ?? 0,
  },
  audio:
    options.audio === false
      ? null
      : { channels: 2, sampleRate: 48000, codec: "pcm_s16le" },
  duration: 20,
});

/** A 29.97 edit: two shots and their sound with a dissolve, an animated inset, music, a title. */
function edit(extra: readonly CommandInput[] = [], timecode = 107892) {
  const empty = TimelineSchema.parse({
    fps: NTSC,
    duration: 390,
    tracks: [
      newTrack(0, "video"),
      newTrack(1, "video"),
      newTrack(2, "video"),
      newTrack(3, "audio"),
      newTrack(4, "audio"),
    ],
    clips: [],
    markers: [],
    range: { in: null, out: null },
  });
  const commands: CommandInput[] = [
    {
      type: "insert",
      track: 0,
      at: 0,
      clip: {
        id: "a",
        kind: "video",
        src: "a.mp4",
        duration: 120,
        mediaStart: 2.002,
        label: 'Shot "A" & <B>',
      },
      linkedAudio: { id: "a-sound", track: 3 },
    },
    {
      type: "insert",
      track: 0,
      at: 120,
      clip: {
        id: "b",
        kind: "video",
        src: "b.mp4",
        duration: 150,
        mediaStart: 3.003,
      },
      linkedAudio: { id: "b-sound", track: 3 },
    },
    {
      type: "insert",
      track: 0,
      at: 270,
      clip: { id: "still", kind: "image", src: "still.png", duration: 60 },
    },
    {
      type: "insert",
      track: 1,
      at: 30,
      clip: {
        id: "inset",
        kind: "video",
        src: "a.mp4",
        duration: 120,
        mediaStart: 10.01,
        muted: true,
      },
    },
    {
      type: "insert",
      track: 4,
      at: 0,
      clip: { id: "music", kind: "audio", src: "music.wav", duration: 300 },
    },
    {
      type: "insert",
      track: 2,
      at: 300,
      clip: { id: "title", kind: "title", text: "Hello", duration: 60 },
    },
    { type: "setTransition", from: "a", to: "b", transition: { duration: 30 } },
    {
      type: "setClip",
      clipId: "inset",
      x: 200,
      y: -100,
      rotation: 15,
      crop: { left: 108 },
    },
    {
      type: "setKeyframe",
      clipId: "inset",
      property: "opacity",
      frame: 0,
      value: 1,
    },
    {
      type: "setKeyframe",
      clipId: "inset",
      property: "opacity",
      frame: 90,
      value: 0.4,
    },
    {
      type: "setKeyframe",
      clipId: "inset",
      property: "scale",
      frame: 0,
      value: { x: 0.5, y: 0.5 },
      ease: "ease-in-out",
    },
    {
      type: "setKeyframe",
      clipId: "inset",
      property: "scale",
      frame: 60,
      value: { x: 0.8, y: 0.8 },
    },
    { type: "setClip", clipId: "a-sound", volume: 0.5 },
    {
      type: "setMarker",
      frame: 45,
      name: "Hook | beat",
      note: "a note",
      color: "red",
    },
    ...extra,
  ];
  const lengths = new Map([
    ["a.mp4", 20],
    ["b.mp4", 20],
    ["music.wav", 20],
  ]);
  const timeline = applyAll(
    empty,
    commands.map((command) => CommandSchema.parse(command)),
    { mediaLengths: lengths },
  );
  const files: Record<string, ClipMedia> = {
    "a.mp4": {
      kind: "file",
      facts: facts("/media/a.mp4", { timecode }),
    },
    "b.mp4": { kind: "file", facts: facts("/media/b b#.mp4") },
    "music.wav": {
      kind: "file",
      facts: { ...facts("/media/music.wav"), video: null },
    },
    "still.png": { kind: "still", path: "/media/still.png" },
  };
  const media = new Map(
    timeline.clips.flatMap((clip) =>
      clip.src && files[clip.src] ? [[clip.id, files[clip.src]!] as const] : [],
    ),
  );
  return planResolveTimeline({
    name: "Cut <1>",
    timeline,
    size: { width: 1920, height: 1080 },
    media,
  });
}

test("a 200% NTSC camera clip keeps its opacity keys at hour-long timecode", () => {
  const { fcpxml } = edit(
    [
      { type: "setTiming", clipId: "a", mediaStart: 1, playbackRate: 2 },
      {
        type: "setKeyframe",
        clipId: "a",
        property: "opacity",
        frame: 0,
        value: 0.5,
      },
      {
        type: "setKeyframe",
        clipId: "a",
        property: "opacity",
        frame: 60,
        value: 1,
      },
    ],
    108000,
  );
  expect(fcpxml).toContain('<keyframe time="2703063113/750000s" value="0.5"/>');
  expect(fcpxml).toContain('<keyframe time="2704564613/750000s" value="1"/>');
});

test("V1 is the storyline, upper tracks are lanes and each audio track keeps its place", () => {
  const { fcpxml } = edit();
  const spine = fcpxml.slice(
    fcpxml.indexOf("<spine>"),
    fcpxml.indexOf("</spine>"),
  );
  const top = spine
    .split("\n")
    .filter((line) => /^ {12}<(video|asset-clip|transition|gap)\b/.test(line))
    .map((line) => line.trim().split(/[ >]/)[0]);
  expect(top).toEqual(["<video", "<transition", "<video", "<video", "<gap"]);
  // A cut at frame 120, a centred 30-frame dissolve: it starts at 105.
  expect(spine).toContain(
    `<transition name="Cross Dissolve" offset="${fcpTime(framesAt(105, NTSC))}" duration="1001/1000s">`,
  );
  // Shot A's source starts at its 01:00:00;00 timecode plus 2.002 s, frame 60.
  expect(spine).toContain(`start="${fcpTime(framesAt(107952, NTSC))}"`);
  // Sound with a transition stays on the deeper lane, at its cut and original level.
  expect(spine).toMatch(
    /<asset-clip ref="r\d+" lane="-2" name="[^"]+" offset="2251249\/625s" start="2251249\/625s" duration="1001\/250s" audioRole="dialogue">\s*<adjust-volume amount="-6.0206dB"\/>/,
  );
  // Music on A2 is its own clip, never linked.
  expect(spine).toMatch(/<asset-clip ref="r\d+" lane="-1" name="music.wav"/);
  // The inset hangs off shot A on V2, offset in shot A's source time.
  expect(spine).toMatch(
    /<asset-clip ref="r\d+" lane="1" name="a.mp4" offset="18014997\/5000s"/,
  );
});

test("transforms carry in Resolve's units and eased keyframes are drawn frame by frame", () => {
  const { fcpxml } = edit();
  const inset = fcpxml.slice(fcpxml.indexOf('lane="1"'));
  // 200 px right and 100 px up of a 1080-line frame, CSS's clockwise 15 degrees counter-clockwise.
  expect(inset).toContain(
    'position="18.518519 9.259259" scale="0.5 0.5" rotation="-15"',
  );
  expect(inset).toContain(
    '<trim-rect left="10" right="0" top="0" bottom="0"/>',
  );
  const param = (name: string) =>
    inset.slice(
      inset.indexOf(`<param name="${name}"`),
      inset.indexOf("</param>", inset.indexOf(`<param name="${name}"`)),
    );
  // Linear opacity keeps its two keys, a hundredth of a frame late so Resolve never rounds them back.
  expect(param("amount").match(/<keyframe /g)).toHaveLength(2);
  expect(param("amount")).toContain('value="0.4"');
  // The ease-in-out scale is keyed on the frames it bends on, then holds.
  const scale = param("scale").match(/<keyframe /g)!.length;
  expect(scale).toBeGreaterThan(20);
  expect(scale).toBeLessThan(62);
});

test("the marker EDL remains available and the importer retains the full marker", () => {
  const { fcpxml, markers, timelineMarkers, notes } = edit();
  expect(fcpxml).toContain('name="Shot &quot;A&quot; &amp; &lt;B&gt;"');
  expect(fcpxml).toContain('src="file:///media/b%20b%23.mp4"');
  expect(fcpxml).toContain('<event name="Cut &lt;1&gt;">');
  expect(fcpxml).not.toContain("<1>");
  expect(markers).toBe(
    "TITLE: Cut <1>\nFCM: NON-DROP FRAME\n\n001  001      V     C        00:00:01:15 00:00:01:16 00:00:01:15 00:00:01:16  \n |C:ResolveColorRed |M:Hook beat |D:1\n",
  );
  expect(notes).toEqual([
    '"Hello" at 00:00:10:00 on V3 is not carried: Resolve can\'t open it as media.',
    "Resolve uses its own equal-power fade curve on A1 at 00:00:04:00. For Cutroom’s curve, overlap the clips on separate Fairlight tracks and use clip volume keyframes to match the original fade.",
    "Resolve may trim the empty tail after 00:00:11:00. Extend a black generator to 00:00:21:00 to restore that time.",
  ]);
  expect(timelineMarkers).toMatchObject([
    { frame: 45, name: "Hook | beat", note: "a note", color: "red" },
  ]);
});

test("upper video and linked audio transitions are restored at their cuts", () => {
  const { transitions } = edit([
    {
      type: "insert",
      track: 1,
      at: 150,
      clip: {
        id: "next",
        kind: "video",
        src: "b.mp4",
        duration: 90,
        mediaStart: 3.003,
        muted: true,
      },
    },
    {
      type: "setTransition",
      from: "inset",
      to: "next",
      transition: { kind: "dip", duration: 24, alignment: "end" },
    },
  ]);
  expect(transitions).toEqual([
    {
      kind: "video",
      track: 2,
      start: 30,
      end: 150,
      label: "a.mp4",
      transition: { kind: "dip", duration: 24, alignment: "end" },
    },
    {
      kind: "audio",
      track: 1,
      start: 0,
      end: 120,
      label: 'Shot "A" & <B>',
      transition: { kind: "dissolve", duration: 30, alignment: "center" },
      linear: false,
    },
  ]);
});

test("standalone audio keeps a 24-frame crossfade and reports a mixed fade curve", () => {
  const commands: CommandInput[] = [
    { type: "setTrack", index: 5, kind: "audio" },
    {
      type: "insert",
      track: 5,
      at: 0,
      clip: {
        id: "music-left",
        kind: "audio",
        src: "music.wav",
        duration: 60,
        mediaStart: 2,
      },
    },
    {
      type: "insert",
      track: 5,
      at: 60,
      clip: {
        id: "music-right",
        kind: "audio",
        src: "music.wav",
        duration: 60,
        mediaStart: 4,
      },
    },
    {
      type: "setTransition",
      from: "music-left",
      to: "music-right",
      transition: { duration: 24 },
    },
  ];
  expect(edit(commands).transitions).toContainEqual({
    kind: "audio",
    track: 3,
    start: 0,
    end: 60,
    label: "music.wav",
    transition: { kind: "dissolve", duration: 24, alignment: "center" },
    linear: false,
  });
  const { transitions, notes } = edit([
    ...commands,
    {
      type: "setClip",
      clipId: "music-left",
      automation: { volume: [{ frame: 0, gain: 0.5 }] },
    },
  ]);
  expect(
    transitions.some(({ kind, track }) => kind === "audio" && track === 3),
  ).toBe(false);
  expect(notes).toContainEqual(
    expect.stringContaining("24-frame audio fade at A3 at 00:00:02:00"),
  );
});
