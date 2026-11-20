import { expect, test } from "bun:test";
import { isClipOnScreenAt } from "@hyperframes/core/runtime/clip-window";
import {
  parseRateLane,
  rateAt,
  sourceTimeAt,
} from "@hyperframes/core/speed-ramp";
import { applyAll, canonicalTimeline } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  mediaSources,
  parseComposition,
  patchComposition,
  settingsOf,
  timelineContent,
} from "../src/server/timeline/composition";
import type { CompositionScope } from "../src/server/timeline/composition";
import { countingIds } from "./clip-ids";

const talk = `<video id="talk" src="talk.mp4" muted data-link="lk-1" data-sync-origin="lk-1" data-start="0" data-duration="6" data-media-start="1" data-track-index="0"></video>`;
const voice = `<audio id="voice" src="talk.mp4" data-link="lk-1" data-sync-origin="lk-1" data-start="0" data-duration="6" data-media-start="1" data-track-index="2"></audio>`;
const title = `<DIV id='title' class=clip data-start=6 data-duration="4" data-track-index="1" data-hf-id="hf-9"><b data-hf-id="hf-10">Hi</b></DIV>`;
const after = `<div id="after" class="clip" data-start="title" data-duration="2" data-track-index="1">Next</div>`;
const source = `<!doctype html>
<html><head><style>.clip{position:absolute}</style>
<script>const markup = "<div data-start='1'></div>";</script></head>
<body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="12" data-fps="30">
  <!-- <div id="ghost" data-start="9" data-duration="1"></div> -->
  ${talk}
  ${voice}
  ${title}
  ${after}
</main></body></html>
`;

const composition = (body: string, fps: number | string = 30) =>
  `<main data-composition-id="main" data-duration="10" data-fps="${fps}">\n${body}\n</main>\n`;

const edit = (
  html: string,
  commands: CommandInput[],
  scope: CompositionScope = "document",
) => {
  const parsed = parseComposition(html, emptyTimelineSettings(), { scope });
  const origins = new Map<string, ClipOrigin>();
  const timeline = canonicalTimeline(
    applyAll(
      parsed.timeline,
      commands.map((command) => CommandSchema.parse(command)),
      {
        onCreate: (id, origin) => origins.set(id, origin),
        newId: countingIds,
      },
    ),
  );
  const output = patchComposition(parsed, timeline, origins);
  expect(
    timelineContent(
      parseComposition(output, settingsOf(timeline), { scope }).timeline,
    ),
  ).toEqual(timelineContent(timeline));
  return output;
};

test.each([
  { type: "split", at: 60, clipIds: ["picture"] },
  { type: "trim", clipId: "picture", edge: "start", to: 60 },
] satisfies CommandInput[])(
  "saved linked $type keeps the picture and sound on the same ramp",
  (command) => {
    const automation = JSON.stringify({
      version: 1,
      lanes: [
        {
          target: "rate",
          points: [
            { t: 0, v: 0.25, curve: 1 },
            { t: 4, v: 4 },
          ],
        },
      ],
    });
    const timing = `src="talk.mp4" data-link="pair" data-start="0" data-duration="4" data-media-start="0.5" data-automation='${automation}'`;
    const html =
      composition(`<video id="picture" ${timing} muted data-track-index="0"></video>
    <audio id="sound" ${timing} data-track-index="1"></audio>`);
    const original = parseRateLane(automation)!;
    const output = edit(html, [command]);
    const saved = parseComposition(
      output,
      emptyTimelineSettings(),
    ).timeline.clips.filter((clip) => clip.start === 60);
    expect(saved.map((clip) => clip.kind).sort()).toEqual(["audio", "video"]);
    for (const clip of saved) {
      const retained = parseRateLane(clip.automation)!;
      expect(retained.audioWindow).toMatchObject({
        offset: 0,
        mediaStart: 0.5,
        duration: 4,
      });
      for (const time of [0, 0.37, 1.9375]) {
        expect(rateAt(retained, time)).toBeCloseTo(
          rateAt(original, 2 + time),
          6,
        );
        expect(clip.mediaStart! + sourceTimeAt(retained, time)).toBeCloseTo(
          0.5 + sourceTimeAt(original, 2 + time),
          6,
        );
      }
    }
  },
);

test("a linked ramp split keeps its physical cut and its original fractional outer edges", () => {
  const points = [
    { t: 0, v: 0.25, curve: 1 },
    { t: 0.25, v: 4 },
    { t: 0.8, v: 0.5, viaX: 0.25, viaY: 0.65 },
    { t: 1.5, v: 2 },
  ];
  const automation = (offset: number) =>
    JSON.stringify({ version: 1, lanes: [{ target: "rate", offset, points }] });
  const soundStart = 0.0125;
  const pictureStart = 0.1125;
  const soundOffset = 0.03;
  const pictureOffset = soundOffset + pictureStart - soundStart;
  const soundRate = parseRateLane(automation(soundOffset))!;
  const soundSource = 0.5;
  const pictureSource =
    soundSource + sourceTimeAt(soundRate, pictureStart - soundStart);
  const timing = `src="take.mp4" data-link="pair"`;
  const html = composition(
    `<video id="picture" ${timing} muted data-track-index="0" data-start="${pictureStart}" data-duration="1.64" data-media-start="${pictureSource}" data-automation='${automation(pictureOffset)}'></video>
     <audio id="sound" ${timing} data-track-index="1" data-start="${soundStart}" data-duration="2" data-media-start="${soundSource}" data-automation='${automation(soundOffset)}'></audio>`,
  );
  const saved = parseComposition(
    edit(html, [{ type: "split", at: 6, clipIds: ["picture"] }]),
    emptyTimelineSettings(),
  );
  const rows = saved.timeline.clips.map((clip) => {
    const attrs = saved.elements.get(clip.id)!.attrs;
    const start = Number(attrs["data-start"]);
    const end = start + Number(attrs["data-duration"]);
    const mediaStart = Number(attrs["data-media-start"]);
    const rate = parseRateLane(attrs["data-automation"])!;
    expect(rate.audioWindow).toBeDefined();
    for (const at of [start, (start + end) / 2, end])
      expect(mediaStart + sourceTimeAt(rate, at - start)).toBeCloseTo(
        soundSource + sourceTimeAt(soundRate, at - soundStart),
        6,
      );
    return { clip, start, end };
  });
  const [
    { clip: pictureHead, start: picIn, end: picCut },
    { clip: pictureTail, start: picJoin, end: picOut },
    { clip: soundHead, start: soundIn, end: soundCut },
    { clip: soundTail, start: soundJoin, end: soundOut },
  ] = rows as [
    (typeof rows)[number],
    (typeof rows)[number],
    (typeof rows)[number],
    (typeof rows)[number],
  ];
  expect([
    pictureHead.start,
    pictureTail.start,
    soundHead.start,
    soundTail.start,
  ]).toEqual([4, 6, 1, 6]);
  expect([picIn, picCut, picJoin, soundIn, soundCut, soundJoin]).toEqual([
    pictureStart,
    0.2,
    0.2,
    soundStart,
    0.2,
    0.2,
  ]);
  expect(picOut).toBeCloseTo(pictureStart + 1.64, 12);
  expect(soundOut).toBeCloseTo(soundStart + 2, 12);
});

test("moving before trimming in the same batch keeps the exact authored audio in-point", () => {
  const html = composition(
    `<audio id="sound" src="sound.wav" data-start="0" data-media-start="0.500000701" data-duration="4"
      data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":0.5},{"t":4,"v":2}]}]}'></audio>`,
  );
  const saved = edit(html, [
    { type: "move", clipIds: ["sound"], by: 30, mode: "place" },
    { type: "trim", clipId: "sound", edge: "end", to: 90 },
  ]);
  const [clip] = parseComposition(saved, emptyTimelineSettings()).timeline
    .clips;
  expect(parseRateLane(clip!.automation)?.audioWindow).toMatchObject({
    offset: 0,
    mediaStart: 0.500000701,
    duration: 4,
  });
});

test("a ramp starting between frames at source zero still cuts from its authored in-point", () => {
  const start = 0.012515625;
  const html = composition(
    `<video id="take" src="take.mp4" data-start="${start}" data-duration="4"
      data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":0.5},{"t":4,"v":2}]}]}'></video>`,
  );
  const original = parseComposition(html, emptyTimelineSettings());
  const originalRate = parseRateLane(
    original.elements.get("take")!.attrs["data-automation"],
  )!;
  const split = parseComposition(
    edit(html, [{ type: "split", clipIds: ["take"], at: 61 }]),
    emptyTimelineSettings(),
  );
  const [left, right] = split.timeline.clips;
  const leftAttrs = split.elements.get(left!.id)!.attrs;
  const rightAttrs = split.elements.get(right!.id)!.attrs;
  expect(Number(leftAttrs["data-media-start"] ?? 0)).toBe(0);
  expect(Number(rightAttrs["data-media-start"])).toBeCloseTo(
    sourceTimeAt(originalRate, 61 / 30 - start),
    10,
  );
  expect(
    parseRateLane(rightAttrs["data-automation"])?.audioWindow?.mediaStart,
  ).toBe(0);
});

test("slipping and setting the source in-point keep dry ramp preparation valid", () => {
  const automation = JSON.stringify({
    version: 1,
    lanes: [
      {
        target: "rate",
        offset: 2,
        audioWindow: { offset: 0, mediaStart: 1, duration: 6 },
        points: [
          { t: 0, v: 1 },
          { t: 4, v: 1 },
        ],
      },
    ],
  });
  const html = composition(
    `<audio id="sound" src="sound.wav" data-start="0" data-media-start="3" data-duration="2" data-automation='${automation}'></audio>`,
  );
  const editedRate = (command: CommandInput) => {
    const [clip] = parseComposition(
      edit(html, [command]),
      emptyTimelineSettings(),
    ).timeline.clips;
    expect(clip?.start).toBe(0);
    return parseRateLane(clip!.automation)!;
  };

  expect(editedRate({ type: "slip", clipId: "sound", by: 30 })).toMatchObject({
    offset: 3,
    audioWindow: { offset: 0, mediaStart: 1, duration: 6 },
  });
  const extended = editedRate({ type: "slip", clipId: "sound", by: 90 });
  expect(extended.offset).toBe(5);
  expect(extended.audioWindow).toBeUndefined();
  const reassigned = editedRate({
    type: "setTiming",
    clipId: "sound",
    mediaStart: 3.5,
  });
  expect(reassigned.offset).toBe(2);
  expect(reassigned.audioWindow).toBeUndefined();
});

test.each([
  { rate: 4, last: 60 },
  { rate: 0.5, last: 480 },
])(
  "a $rate× rate lane bounds a trim at the last source frame",
  ({ rate, last }) => {
    const automation = JSON.stringify({
      version: 1,
      lanes: [{ target: "rate", points: [{ t: 0, v: rate }] }],
    });
    const { timeline } = parseComposition(
      composition(
        `<video id="shot" src="shot.mp4" data-start="0" data-duration="1" data-automation='${automation}'></video>`,
      ),
      emptyTimelineSettings(),
      { mediaLengths: new Map([["shot.mp4", 8]]) },
    );
    const trimTo = (to: number) =>
      applyAll(timeline, [
        CommandSchema.parse({ type: "trim", clipId: "shot", edge: "end", to }),
      ]);
    expect(trimTo(last).clips[0]?.duration).toBe(last);
    expect(() => trimTo(last + 1)).toThrow("past the end of its source media");
  },
);

test("an untrimmed ramp with measured media gets its natural length", () => {
  const { timeline } = parseComposition(
    composition(
      `<audio id="voice" src="voice.wav" data-start="0" data-media-start="1" data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":2}]}]}'></audio>`,
    ),
    emptyTimelineSettings(),
    { mediaLengths: new Map([["voice.wav", 9]]) },
  );
  expect(timeline.clips[0]?.duration).toBe(120);
});

const withoutStacking = (html: string) =>
  html
    .replace(
      /<head><style data-cutroom-track-stacking[^>]*>[\s\S]*?<\/style><\/head>\n/g,
      "",
    )
    .replace(
      /<style data-cutroom-track-stacking[^>]*>[\s\S]*?<\/style>\n?/g,
      "",
    );

for (const command of [{ type: "split", at: 90 }] satisfies CommandInput[]) {
  test(`${command.type}${"edge" in command ? ` ${command.edge}` : ""} leaves an auto-select id-animated title whole`, () => {
    const title = `<div id="lower" class="clip" data-label="Lower third" data-start="0" data-duration="10" data-track-index="1">Lower third</div>`;
    const html = composition(
      `<video id="shot" src="shot.mp4" muted data-start="2" data-duration="2" data-track-index="0"></video>\n${title}\n<script>gsap.to("#lower", {opacity: 1});</script>`,
    );
    const output = edit(html, [command]);
    expect(output).toContain(title);
    expect(output).not.toContain('id="lower-2"');
    expect(output).not.toBe(html);
  });
}

test("overwrite moves read back exactly at 30000/1001 with linked cuts and source offsets", () => {
  const html = composition(
    `
<video id="moving" src="take.mp4" muted data-link="move" data-start="0" data-duration="0.333667" data-media-start="1.234567" data-track-index="0"></video>
<audio id="sound" src="take.mp4" data-link="move" data-start="0" data-duration="0.333667" data-media-start="1.234567" data-track-index="1"></audio>
<video id="under" src="under.mp4" muted data-link="under-pair" data-start="1.001" data-duration="2.002" data-media-start="2.123456" data-playback-rate="2" data-track-index="0"></video>
<audio id="bed" src="under.mp4" data-link="under-pair" data-start="1.001" data-duration="2.002" data-media-start="2.123456" data-playback-rate="2" data-track-index="1"></audio>`,
    "30000/1001",
  );
  const output = edit(html, [
    {
      type: "move",
      clipIds: ["moving"],
      by: 40,
      ids: { under: ["under-tail"], bed: ["bed-tail"] },
    },
  ]);
  const result = parseComposition(output, emptyTimelineSettings()).timeline;
  expect(
    result.clips.map((clip) => [
      clip.id,
      clip.start,
      clip.duration,
      clip.mediaStart,
    ]),
  ).toEqual([
    ["under", 30, 10, 2.123456],
    ["moving", 40, 10, 1.234567],
    ["under-tail", 50, 40, 3.458123],
    ["bed", 30, 10, 2.123456],
    ["sound", 40, 10, 1.234567],
    ["bed-tail", 50, 40, 3.458123],
  ]);
});

test("the projection reads clips, references, and fps from HTML", () => {
  const { timeline } = parseComposition(source, emptyTimelineSettings());
  expect(timeline.fps).toEqual({ num: 30, den: 1 });
  expect(timeline.duration).toBe(360);
  expect(
    timeline.clips.map((clip) => [
      clip.id,
      clip.kind,
      clip.track,
      clip.start,
      clip.duration,
      clip.startRef?.clipId ?? null,
    ]),
  ).toEqual([
    ["talk", "video", 0, 0, 180, null],
    ["title", "element", 1, 180, 120, null],
    ["after", "element", 1, 300, 60, "title"],
    ["voice", "audio", 2, 0, 180, null],
  ]);
  expect(timeline.tracks.map((track) => track.kind)).toEqual([
    "video",
    "video",
    "audio",
  ]);
});

test("edits change only the attributes they need and keep references", () => {
  const output = edit(source, [
    { type: "remove", clipIds: ["voice"] },
    { type: "trim", clipId: "title", edge: "end", to: 270, ripple: true },
  ]);
  expect(withoutStacking(output)).toBe(
    source
      .replace(`\n  ${talk}\n  ${voice}`, "")
      .replace(`data-duration="4"`, `data-duration="3"`)
      .replace(`data-duration="12"`, `data-duration="11"`),
  );
  const moved = edit(source, [{ type: "move", clipIds: ["after"], by: 15 }]);
  expect(withoutStacking(moved)).toBe(
    source
      .replace(`data-start="title"`, `data-start="10.5"`)
      .replace(`data-duration="12"`, `data-duration="12.5"`),
  );
});

test("a disabled clip is data-hidden, which HyperFrames leaves out of preview and render", () => {
  const off = edit(source, [
    { type: "setClip", clipId: "title", enabled: false },
  ]);
  expect(off).toBe(source.replace(`data-hf-id="hf-9"`, `$& data-hidden=""`));
  // Both halves of a cut stay off, and turning a clip back on removes only the attribute.
  const cut = edit(off, [{ type: "split", at: 200 }]);
  expect(
    parseComposition(cut, emptyTimelineSettings())
      .timeline.clips.filter((clip) => clip.track === 1 && clip.start < 300)
      .map((clip) => clip.enabled),
  ).toEqual([false, false]);
  expect(edit(off, [{ type: "setClip", clipId: "title", enabled: true }])).toBe(
    source,
  );
});

test("split, ripple delete, and insert round-trip without touching other markup", () => {
  const output = edit(source, [
    { type: "split", at: 60 },
    { type: "remove", clipIds: ["talk"], ripple: true },
    { type: "split", at: 135, clipIds: ["title"] },
    {
      type: "insert",
      track: 3,
      at: 0,
      clip: { kind: "audio", src: "music/bed & theme.wav", duration: 90 },
    },
  ]);
  expect(withoutStacking(output)).toBe(
    source
      .replace(
        `\n  ${talk}\n  ${voice}`,
        `\n  ${talk
          .replace(`id="talk"`, `id="talk-2"`)
          .replaceAll(`"lk-1"`, `"lk-2"`)
          .replace(`data-duration="6"`, `data-duration="4"`)
          .replace(`data-media-start="1"`, `data-media-start="3"`)}\n  ${voice
          .replace(`id="voice"`, `id="voice-2"`)
          .replaceAll(`"lk-1"`, `"lk-2"`)
          .replace(`data-duration="6"`, `data-duration="4"`)
          .replace(`data-media-start="1"`, `data-media-start="3"`)}`,
      )
      .replace(
        title,
        `${title
          .replace("data-start=6", "data-start=4")
          .replace(
            `data-duration="4"`,
            `data-duration="0.5"`,
          )}\n  <DIV id='title-2' class=clip data-start=4.5 data-duration="3.5" data-track-index="1"><b>Hi</b></DIV>`,
      )
      .replace(
        `${after}\n`,
        `${after.replace(`data-start="title"`, `data-start="8"`)}\n  <audio id="bed-theme" src="music/bed &amp; theme.wav" data-start="0" data-duration="3" data-track-index="3"></audio>\n`,
      )
      .replace(`data-duration="12"`, `data-duration="10"`),
  );
});

test("visual placements maintain track stacking without rewriting authored styles", () => {
  const html = composition(
    `<style>.title{z-index:40}</style><div id="title" class="clip title" style="color:red;z-index:50!important" data-start="0" data-duration="2" data-track-index="1">Title</div>`,
  );
  const inserted = edit(html, [
    {
      type: "insert",
      track: 0,
      at: 0,
      clip: { id: "picture", kind: "image", src: "picture.png", duration: 60 },
    },
  ]);
  expect(inserted).toContain(`<style>.title{z-index:40}</style>`);
  expect(inserted).toContain(`style="color:red;z-index:50!important"`);
  expect(inserted).toContain(`[data-track-index="0"]:not(audio)`);
  expect(inserted).toContain(`{z-index:0}`);
  const moved = edit(inserted, [
    { type: "setTrack", index: 3, kind: "video" },
    { type: "move", clipIds: ["title"], trackBy: 2 },
  ]);
  expect(moved).toContain(`data-track-index="3"`);
  expect(moved).toContain(`[data-track-index="3"]:not(audio)`);
  expect(moved).toContain(`{z-index:3}`);
  expect(moved).toContain(`style="color:red;z-index:50!important"`);
  expect(moved.match(/<style data-cutroom-track-stacking=/g)).toHaveLength(1);
  expect(edit(moved, [{ type: "move", clipIds: ["title"], by: 30 }])).toBe(
    moved
      .replace(`data-duration="10"`, `data-duration="11"`)
      .replace(
        `id="title" class="clip title" style="color:red;z-index:50!important" data-start="0"`,
        `id="title" class="clip title" style="color:red;z-index:50!important" data-start="1"`,
      ),
  );
});

test("audio placement leaves stacking and authored markup alone", () => {
  const html = composition(
    `<audio id="bed" src="bed.wav" style="z-index:90" data-start="0" data-duration="2" data-track-index="0"></audio>`,
  );
  expect(
    edit(html, [
      { type: "setTrack", index: 1, kind: "audio" },
      { type: "move", clipIds: ["bed"], trackBy: 1 },
    ]),
  ).toBe(html.replace(`data-track-index="0"`, `data-track-index="1"`));
  const inserted = edit(html, [
    {
      type: "insert",
      track: 1,
      at: 0,
      clip: { kind: "audio", src: "voice.wav", duration: 60 },
    },
  ]);
  expect(inserted).not.toContain("data-cutroom-track-stacking");
  expect(inserted).toContain(`style="z-index:90"`);
});

test("track defaults precede authored cascade layers and leave first-child selectors intact", () => {
  const html = `<!doctype html><html><head><style>@layer utilities{.z-50{z-index:50}}.box:first-child{background:blue}</style></head><body><main data-composition-id="main" data-duration="2"><div id="box" class="clip box z-50" data-start="0" data-duration="1" data-track-index="1">Box</div></main></body></html>`;
  const output = edit(html, [{ type: "move", clipIds: ["box"], by: 1 }]);
  expect(output).toContain(`<head><style data-cutroom-track-stacking="main">`);
  expect(output.indexOf("@layer cutroom-tracks")).toBeLessThan(
    output.indexOf("@layer utilities"),
  );
  expect(output).toContain(
    `<main data-composition-id="main" data-duration="2.033333"><div id="box"`,
  );
  expect(output).toContain(`.box:first-child{background:blue}`);
});

test("a scene's defaults survive template loading without entering its clip children", () => {
  const html = `<template><style>@layer utilities{.z-50{z-index:50}}</style><div data-composition-id="scene" data-duration="2"><div id="box" class="clip box z-50" data-start="0" data-duration="1" data-track-index="1">Box</div></div></template>`;
  const output = edit(
    html,
    [{ type: "move", clipIds: ["box"], by: 1 }],
    "sub-composition",
  );
  expect(output).toContain(
    `<template><style data-cutroom-track-stacking="scene">`,
  );
  expect(output.indexOf("@layer cutroom-tracks")).toBeLessThan(
    output.indexOf("@layer utilities"),
  );
  expect(output).toContain(
    `<div data-composition-id="scene" data-duration="2.033333"><div id="box"`,
  );
  const second = edit(
    output,
    [{ type: "move", clipIds: ["box"], by: 1 }],
    "sub-composition",
  );
  expect(second.match(/<style data-cutroom-track-stacking=/g)).toHaveLength(1);
});

test("duration edits establish stacking, while label edits do not", () => {
  const html = composition(
    `<div id="box" class="clip" data-start="0" data-duration="1" data-track-index="1">Box</div>`,
  );
  expect(
    edit(html, [{ type: "setClip", clipId: "box", label: "Box" }]),
  ).not.toContain("data-cutroom-track-stacking");
  expect(
    edit(html, [{ type: "trim", clipId: "box", edge: "end", to: 60 }]),
  ).toContain(`data-cutroom-track-stacking="main"`);
});

test("a managed stylesheet moved by hand is relocated rather than duplicated", () => {
  const html = `<!doctype html><html><head></head><body>${composition(`<div id="box" class="clip" data-start="0" data-duration="1" data-track-index="1">Box</div>`)}</body></html>`;
  const first = edit(html, [{ type: "move", clipIds: ["box"], by: 1 }]);
  const block = first.match(
    /<style data-cutroom-track-stacking[^>]*>[\s\S]*?<\/style>/,
  )![0];
  const moved = first
    .replace(block, "")
    .replace("</body>", `<aside>${block}</aside></body>`);
  const output = edit(moved, [
    { type: "setTrack", index: 2, kind: "video" },
    { type: "move", clipIds: ["box"], trackBy: 1 },
  ]);
  expect(output.match(/<style data-cutroom-track-stacking/g)).toHaveLength(1);
  expect(output).toContain(`<head><style data-cutroom-track-stacking="main">`);
  expect(output).toContain(`<aside></aside>`);
});

test("noncanonical and legacy track values are normalized when defaults are written", () => {
  for (const attribute of [`data-track-index="02"`, `data-layer="02"`]) {
    const html = composition(
      `<div id="box" class="clip" data-start="0" data-duration="1" ${attribute}>Box</div>`,
    );
    const output = edit(html, [{ type: "move", clipIds: ["box"], by: 1 }]);
    expect(output).toContain(`data-track-index="2"`);
    expect(output).not.toContain(attribute);
    expect(
      parseComposition(output, emptyTimelineSettings()).timeline.clips[0]
        ?.track,
    ).toBe(2);
  }
});

test("managed CSS never makes a numeric clip id look like an authored reference", () => {
  const html = composition(
    `<div id="1" class="clip" data-start="0" data-duration="2" data-track-index="1">Box</div>`,
  );
  const moved = edit(html, [{ type: "move", clipIds: ["1"], by: 1 }]);
  const split = edit(moved, [{ type: "split", clipIds: ["1"], at: 30 }]);
  expect(
    parseComposition(split, emptyTimelineSettings()).timeline.clips.map(
      (clip) => clip.id,
    ),
  ).toEqual(["1", "1-2"]);
});

test("compositions that cannot be edited exactly are refused", () => {
  expect(() =>
    parseComposition(
      source.replace(` data-duration="2"`, ""),
      emptyTimelineSettings(),
    ),
  ).toThrow("after has no data-duration");
  const animated = source.replace(
    "</script>",
    `gsap.to("#title", { opacity: 0 });</script>`,
  );
  expect(() =>
    edit(animated, [{ type: "split", at: 200, clipIds: ["title"] }]),
  ).toThrow("animated by its id");
  const lookedUp = source.replace(
    "</script>",
    `document.getElementById("title");</script>`,
  );
  expect(() =>
    edit(lookedUp, [{ type: "split", at: 200, clipIds: ["title"] }]),
  ).toThrow("animated by its id");
});

test("frame rates HyperFrames ignores are refused instead of read as 30 fps", () => {
  const read = (fps: string) =>
    parseComposition(composition("", fps), emptyTimelineSettings()).timeline
      .fps;
  expect(
    parseComposition(
      `<main data-composition-id="main" data-duration="10"></main>`,
      emptyTimelineSettings(),
    ).timeline.fps,
  ).toEqual({ num: 30, den: 1 });
  expect(read("24000/1001")).toEqual({ num: 24000, den: 1001 });
  for (const [decimal, exact] of [
    ["23.976", "24000/1001"],
    ["23.98", "24000/1001"],
    ["29.97", "30000/1001"],
    ["47.952", "48000/1001"],
    ["59.94", "60000/1001"],
    ["119.88", "120000/1001"],
  ])
    expect(() => read(decimal)).toThrow(
      `HyperFrames ignores data-fps="${decimal}" and plays the composition at 30 fps. Write the exact rate, data-fps="${exact}".`,
    );
  for (const decimal of ["12.5", "-29.97"])
    expect(() => read(decimal)).toThrow(
      `HyperFrames ignores data-fps="${decimal}" and plays the composition at 30 fps. Write it as a whole number or a fraction.`,
    );
  for (const invalid of ["fast", "0", "300", "30/0"])
    expect(() => read(invalid)).toThrow(
      `HyperFrames ignores data-fps="${invalid}" and plays the composition at 30 fps. Use a whole number`,
    );
});

test("element boundaries follow the HTML spec tree, including implied end tags", () => {
  const first = `  <p id="a" data-start="0" data-duration="1">First\n`;
  const paragraphs = composition(
    `${first}  <p id="b" data-start="1" data-duration="1">Second</p>`,
  );
  expect(edit(paragraphs, [{ type: "remove", clipIds: ["a"] }])).toBe(
    paragraphs.replace(`\n${first.trimEnd()}`, ""),
  );
  const quoted = `  <div id="a" title="</div>" data-start="0" data-duration="1">A</div>`;
  const titled = composition(
    `${quoted}\n  <div id="b" data-start="1" data-duration="1">B</div>`,
  );
  expect(edit(titled, [{ type: "remove", clipIds: ["a"] }])).toBe(
    titled.replace(`\n${quoted}`, ""),
  );
});

test("markup the browser moves out of a table is never removed with the table", () => {
  const card = `<div id="card" class="clip" data-start="1" data-duration="1">Card</div>`;
  const html = composition(
    `  <table id="grid" class="clip" data-start="0" data-duration="1">${card}</table>`,
  );
  expect(
    parseComposition(html, emptyTimelineSettings()).timeline.clips.map(
      (clip) => clip.id,
    ),
  ).toEqual(["grid", "card"]);
  expect(() => edit(html, [{ type: "remove", clipIds: ["grid"] }])).toThrow(
    "places outside it",
  );
  expect(edit(html, [{ type: "remove", clipIds: ["card"] }])).toBe(
    html.replace(card, "").replace(`data-duration="10"`, `data-duration="9"`),
  );
});

test("inert template content never becomes the root or answers an id", () => {
  // A scene prototype written before the live root: the browser renders main.
  const prototype = `<template><div id="scene" data-composition-id="scene" data-fps="24" data-duration="4"><div id="hidden" class="clip" data-start="0" data-duration="1">Hidden</div></div></template>`;
  const live = `<main id="main" data-composition-id="main" data-duration="10" data-fps="30">\n  <div id="title" class="clip" data-start="0" data-duration="2">Title</div>\n</main>`;
  const html = `${prototype}\n${live}\n`;
  const { timeline } = parseComposition(html, emptyTimelineSettings());
  expect(timeline.fps).toEqual({ num: 30, den: 1 });
  expect(timeline.clips.map((clip) => clip.id)).toEqual(["title"]);
  expect(
    withoutStacking(edit(html, [{ type: "move", clipIds: ["title"], by: 30 }])),
  ).toBe(
    html
      .replace(`data-duration="10"`, `data-duration="11"`)
      .replace(
        `data-start="0" data-duration="2">Title`,
        `data-start="1" data-duration="2" data-track-index="0">Title`,
      ),
  );
  // A template's lead must not shadow the live lead that a reference names.
  const shadowed = `<template><div id="lead" data-start="0" data-duration="5"></div></template>
<main data-root="true" data-composition-id="main" data-duration="10" data-fps="30">
  <div id="lead" class="clip" data-start="0" data-duration="2">Lead</div>
  <div id="next" class="clip" data-start="lead" data-duration="1">Next</div>
</main>
`;
  const next = parseComposition(
    shadowed,
    emptyTimelineSettings(),
  ).timeline.clips.find((clip) => clip.id === "next");
  expect(next).toMatchObject({ start: 60, startRef: { clipId: "lead" } });
});

test("an entry document uses its live tree and a sub-composition its template", () => {
  // The entry document renders only its live tree, so a root hidden in a template is not one.
  const hidden = `<body><template><main data-root="true" data-composition-id="main" data-duration="4"><div id="card" class="clip" data-start="0" data-duration="1">Card</div></main></template></body>\n`;
  expect(() => parseComposition(hidden, emptyTimelineSettings())).toThrow(
    "no live element with data-composition-id",
  );
  // HyperFrames loads a sub-composition from its first template, media included.
  const scene = `<template id="scene-template"><div data-composition-id="scene" data-duration="4"><video id="v" src="v.mp4" data-start="0" data-track-index="0"></video></div></template>\n`;
  expect(mediaSources(scene, "sub-composition")).toEqual(["v.mp4"]);
  expect(mediaSources(scene, "document")).toEqual([]);
  expect(
    parseComposition(scene, emptyTimelineSettings(), {
      scope: "sub-composition",
      mediaLengths: new Map([["v.mp4", 2]]),
    }).timeline.clips.map((clip) => [clip.id, clip.duration]),
  ).toEqual([["v", 60]]);
});

test("a sub-composition edits its first template even when a later one is named for it", () => {
  // Preview and render inline the first template here, so that is the one an edit must change.
  const first = `<template id="helper"><div data-composition-id="helper" data-duration="4"><p id="helper-text" class="clip" data-start="0" data-duration="1" data-track-index="0">Helper</p><video id="h" src="h.mp4" data-start="0" data-duration="1"></video></div></template>`;
  const named = `<template id="intro-template"><div data-composition-id="intro" data-duration="4"><p id="title" class="clip" data-start="0" data-duration="1" data-track-index="0">Intro</p><video id="i" src="i.mp4" data-start="0" data-duration="1"></video></div></template>`;
  const html = `${first}\n${named}\n`;
  expect(mediaSources(html, "sub-composition")).toEqual(["h.mp4"]);
  const parsed = parseComposition(html, emptyTimelineSettings(), {
    scope: "sub-composition",
  });
  const timeline = canonicalTimeline(
    applyAll(parsed.timeline, [
      CommandSchema.parse({ type: "move", clipIds: ["helper-text"], by: 30 }),
    ]),
  );
  expect(withoutStacking(patchComposition(parsed, timeline, new Map()))).toBe(
    `${first
      .replace(
        `data-start="0" data-duration="1" data-track-index="0">Helper`,
        `data-start="1" data-duration="1" data-track-index="0">Helper`,
      )
      .replace(`data-duration="4">`, `data-duration="5">`)
      .replace(
        `id="h" src="h.mp4" data-start="0" data-duration="1"`,
        `id="h" src="h.mp4" data-start="0" data-duration="1" data-track-index="0"`,
      )}\n${named}\n`,
  );
});

test("text the browser fosters out of a table row is never cut with the row", () => {
  for (const html of [
    composition(
      `  outside<table><tbody><tr id="c" class="clip" data-start="0" data-duration="1">bar<td>cell</td></tr></tbody></table>`,
    ),
    composition(
      `  prefix<table><tr id="c" class="clip" data-start="0" data-duration="1">LOST<td>A</td></tr>outside</table>`,
    ),
  ]) {
    expect(() => edit(html, [{ type: "remove", clipIds: ["c"] }])).toThrow(
      "places outside it",
    );
    expect(() =>
      edit(html, [{ type: "split", at: 15, clipIds: ["c"] }]),
    ).toThrow("places outside it");
  }
});

test("a clip is removed or copied only when its bytes hold its text and end tags too", () => {
  // The browser merges "outside" into the text before the table.
  const merged = composition(
    `  prefix<table id="grid" class="clip" data-start="0" data-duration="1">outside</table>`,
  );
  expect(() => edit(merged, [{ type: "remove", clipIds: ["grid"] }])).toThrow(
    "places outside it",
  );
  // The </b> inside the div closes the bold that began before it.
  const misnested = composition(
    `  <b>1<div id="card" class="clip" data-start="0" data-duration="1">2</b>3</div>`,
  );
  expect(() =>
    edit(misnested, [{ type: "remove", clipIds: ["card"] }]),
  ).toThrow("places outside it");
  expect(() =>
    edit(misnested, [{ type: "split", at: 15, clipIds: ["card"] }]),
  ).toThrow("places outside it");
});

test("frames are the ones the runtime shows, and moves keep the source in sync", () => {
  const video = `<video id="v" src="v.mp4" data-start="0.1" data-duration="1" data-media-start="2" data-track-index="0"></video>`;
  const html = composition(video, 24);
  const [clip] = parseComposition(html, emptyTimelineSettings()).timeline.clips;
  const shown = Array.from({ length: 48 }, (_, frame) => frame).filter(
    (frame) => isClipOnScreenAt(frame / 24, 0.1, 1.1, 24, 10),
  );
  expect([clip!.start, clip!.start + clip!.duration]).toEqual([
    shown[0]!,
    shown.at(-1)! + 1,
  ]);
  expect(
    withoutStacking(edit(html, [{ type: "move", clipIds: ["v"], by: 24 }])),
  ).toBe(
    html
      .replace(`data-duration="10"`, `data-duration="11"`)
      .replace(
        `data-start="0.1" data-duration="1" data-media-start="2"`,
        `data-start="1.125" data-duration="1" data-media-start="2.025"`,
      ),
  );
});

test("a start a hair past a frame never yields a negative source offset", () => {
  for (const [fps, rate] of [
    ["24", 24],
    ["30000/1001", 30000 / 1001],
    ["30", 30],
  ] as const) {
    // Within a thousandth of frame 30, so the runtime shows the clip from frame 30.
    const start = (30 + 0.0005) / rate;
    const html = `<main data-composition-id="main" data-duration="10" data-fps="${fps}">\n<video id="v" src="v.mp4" data-start="${start}" data-duration="1" data-media-start="0" data-track-index="0"></video>\n</main>\n`;
    const [clip] = parseComposition(html, emptyTimelineSettings()).timeline
      .clips;
    expect(clip).toMatchObject({ start: 30, mediaStart: 0 });
    const commands: CommandInput[] = [
      { type: "move", clipIds: ["v"], by: 1 },
      { type: "trim", clipId: "v", edge: "end", to: 40 },
    ];
    for (const command of commands) {
      const output = edit(html, [command]);
      const written = /data-media-start="([^"]+)"/.exec(output)![1]!;
      expect(Number(written)).toBeGreaterThanOrEqual(0);
    }
  }
});

test("source offsets stay exact through retimes, repeated trims, and inserts", () => {
  // NTSC with a double-speed clip: a one-frame move writes a rounded start, which must not
  // shift the projected source offset.
  const ntsc = `<main data-composition-id="main" data-duration="10" data-fps="30000/1001">\n<video id="v" src="v.mp4" data-start="0" data-duration="1" data-media-start="1" data-playback-rate="2" data-track-index="0"></video>\n</main>\n`;
  expect(edit(ntsc, [{ type: "move", clipIds: ["v"], by: 1 }])).toContain(
    `data-start="0.033367" data-duration="1.001" data-media-start="1"`,
  );
  const long = composition(
    `<video id="v" src="v.mp4" data-start="0" data-duration="20" data-media-start="1" data-track-index="0"></video>`,
  );
  const offsetAfter = (commands: CommandInput[]) =>
    Number(/data-media-start="([^"]+)"/.exec(edit(long, commands))![1]);
  const oneTrim = offsetAfter([
    { type: "trim", clipId: "v", edge: "start", to: 300 },
  ]);
  const manyTrims = offsetAfter(
    Array.from({ length: 300 }, (_, frame) => ({
      type: "trim" as const,
      clipId: "v",
      edge: "start" as const,
      to: frame + 1,
    })),
  );
  expect(oneTrim).toBe(11);
  expect(Math.abs(manyTrims - oneTrim)).toBeLessThanOrEqual(1e-6);
  expect(
    edit(composition(""), [
      {
        type: "insert",
        track: 0,
        at: 0,
        clip: {
          kind: "audio",
          src: "bed.wav",
          duration: 30,
          mediaStart: 1.23456789,
        },
      },
    ]),
  ).toContain(`data-media-start="1.234568"`);
});

for (const [name, target, command, kept] of [
  [
    "Q",
    `  <video id="edit" src="edit.mp4" data-start="1.001" data-duration="2.002" data-media-start="1" data-track-index="0"></video>`,
    { type: "trim", clipId: "edit", edge: "start", to: 60, ripple: true },
    `  <video id="edit" src="edit.mp4" data-start="1.001" data-duration="1.001" data-media-start="2.001" data-track-index="0"></video>\n`,
  ],
  [
    "W",
    `  <video id="edit" src="edit.mp4" data-start="0" data-duration="2.002" data-media-start="1" data-track-index="0"></video>`,
    { type: "trim", clipId: "edit", edge: "end", to: 30, ripple: true },
    `  <video id="edit" src="edit.mp4" data-start="0" data-duration="1.001" data-media-start="1" data-track-index="0"></video>\n`,
  ],
  [
    "delete",
    `  <video id="edit" src="edit.mp4" data-start="1.001" data-duration="1.001" data-media-start="1" data-track-index="0"></video>`,
    { type: "remove", clipIds: ["edit"], ripple: true },
    "",
  ],
] satisfies [string, string, CommandInput, string][]) {
  test(`${name} writes exact NTSC cuts, links and retimed source offsets and reads them back`, () => {
    const html = `<main data-composition-id="main" data-duration="10.01" data-fps="30000/1001">
${target}
  <video id="next" src="next.mp4" data-start="3.003" data-duration="1.001" data-track-index="0"></video>
  <video id="span" src="span.mp4" data-link="av" data-start="0" data-duration="3.003" data-media-start="1" data-track-index="1"></video>
  <audio id="sound" src="span.mp4" data-link="av" data-start="0" data-duration="3.003" data-media-start="1" data-track-index="2"></audio>
  <video id="starts" src="starts.mp4" data-start="1.5015" data-duration="1.5015" data-media-start="2" data-playback-rate="2" data-track-index="3"></video>
  <video id="ends" src="ends.mp4" data-start="0" data-duration="1.5015" data-track-index="4"></video>
</main>
`;
    expect(withoutStacking(edit(html, [command])))
      .toBe(`<main data-composition-id="main" data-duration="9.009" data-fps="30000/1001">
${kept}  <video id="next" src="next.mp4" data-start="2.002" data-duration="1.001" data-track-index="0"></video>
  <video id="span" src="span.mp4" data-link="av" data-start="0" data-duration="1.001" data-media-start="1" data-track-index="1"></video>
  <video id="span-2" src="span.mp4" data-link="lk-1" data-start="1.001" data-duration="1.001" data-media-start="3.002" data-track-index="1"></video>
  <audio id="sound" src="span.mp4" data-link="av" data-start="0" data-duration="1.001" data-media-start="1" data-track-index="2"></audio>
  <audio id="sound-2" src="span.mp4" data-link="lk-1" data-start="1.001" data-duration="1.001" data-media-start="3.002" data-track-index="2"></audio>
  <video id="starts" src="starts.mp4" data-start="1.001" data-duration="1.001" data-media-start="3.001" data-playback-rate="2" data-track-index="3"></video>
  <video id="ends" src="ends.mp4" data-start="0" data-duration="1.001" data-track-index="4"></video>
</main>
`);
  });
}

test("Q at NTSC frame one writes source offsets rounded once to the microsecond", () => {
  const html = `<main data-composition-id="main" data-duration="10.01" data-fps="30000/1001">
  <video id="talk" src="talk.mp4" data-start="0" data-duration="3.003" data-media-start="1" data-track-index="0"></video>
  <audio id="bed" src="bed.wav" data-start="0" data-duration="6.006" data-media-start="2" data-playback-rate="2" data-track-index="1"></audio>
</main>
`;
  expect(
    edit(html, [
      { type: "trim", clipId: "talk", edge: "start", to: 1, ripple: true },
    ]),
  )
    .toBe(`<head><style data-cutroom-track-stacking="main">@layer cutroom-tracks{:where([data-composition-id="main"] [data-start][data-track-index="0"]:not(audio):not([data-composition-id="main"] :is([data-start],[data-composition-id],[data-composition-src]) *)){z-index:0}}</style></head>
<main data-composition-id="main" data-duration="9.976633" data-fps="30000/1001">
  <video id="talk" src="talk.mp4" data-start="0" data-duration="2.969633" data-media-start="1.033367" data-track-index="0"></video>
  <audio id="bed" src="bed.wav" data-start="0" data-duration="5.972633" data-media-start="2.066733" data-playback-rate="2" data-track-index="1"></audio>
</main>
`);
});

test("Q trims a referenced music bed in place without copying its script target", () => {
  const script = `<script>gsap.to("#bed", { opacity: 0.5 });</script>`;
  const html =
    composition(`<video id="shot" src="shot.mp4" data-start="0" data-duration="3" data-track-index="0"></video>
<audio id="bed" src="bed.wav" data-start="0" data-duration="5" data-media-start="2" data-track-index="1"></audio>
${script}`);
  const output = edit(html, [
    { type: "trim", clipId: "shot", edge: "start", to: 30, ripple: true },
  ]);
  expect(output).toContain(
    `<audio id="bed" src="bed.wav" data-start="0" data-duration="4" data-media-start="3" data-track-index="1"></audio>`,
  );
  expect(output).toContain(script);
  expect(output).not.toContain("bed-2");
});

test("a range cut removes stale links in HTML so lifting the picture keeps the surviving audio", () => {
  const html =
    composition(`<video id="v" src="v.mp4" data-start="0" data-duration="1.333333" data-link="av" data-track-index="0"></video>
<audio id="a" src="a.wav" data-start="1" data-duration="1.333333" data-media-start="1" data-link="av" data-track-index="1"></audio>
<video id="edit" src="edit.mp4" data-start="1" data-duration="1" data-track-index="2"></video>`);
  expect(
    edit(html, [
      { type: "remove", clipIds: ["edit"], ripple: true },
      { type: "remove", clipIds: ["v"] },
    ]),
  ).toBe(
    composition(
      `<audio id="a" src="a.wav" data-start="1" data-duration="0.333333" data-media-start="2" data-track-index="1"></audio>`,
    ).replace(`data-duration="10"`, `data-duration="9"`),
  );
});

test("removing an anonymous clip writes ids on the clips it would renumber", () => {
  const clips = ["A", "B", "C"].map(
    (text, index) =>
      `  <div class="clip" data-start="${index}" data-duration="1">${text}</div>`,
  );
  const html = composition(clips.join("\n"));
  expect(edit(html, [{ type: "remove", clipIds: ["clip-1"] }])).toBe(
    html
      .replace(`${clips[0]}\n`, "")
      .replace(`">B`, `" id="clip-2">B`)
      .replace(`">C`, `" id="clip-3">C`),
  );
});

test("media without data-duration takes its length from the measured source", () => {
  const html = composition(
    `<audio id="bed" src="bed.wav" data-start="1" data-media-start="2" data-track-index="0"></audio>`,
  );
  expect(() => parseComposition(html, emptyTimelineSettings())).toThrow(
    "could not be measured",
  );
  const { timeline } = parseComposition(html, emptyTimelineSettings(), {
    mediaLengths: new Map([["bed.wav", 10]]),
  });
  expect(timeline.clips[0]).toMatchObject({
    start: 30,
    duration: 240,
    sourceDuration: 10,
  });
  expect(() =>
    applyAll(timeline, [
      CommandSchema.parse({
        type: "trim",
        clipId: "bed",
        edge: "end",
        to: 271,
      }),
    ]),
  ).toThrow("past the end of its source");
});

test("position captures both native baselines and clearing one axis keeps the other offset exact", () => {
  const html = composition(
    '<div id="title" data-start="0" data-duration="2" data-x="12.25" data-y="-7.5">Title</div>',
  );
  const horizontal = edit(html, [{ type: "setClip", clipId: "title", x: 40 }]);
  expect(horizontal).toContain('data-x="52.25"');
  expect(horizontal).toContain('data-y="-7.5"');
  expect(horizontal).toContain('data-hf-edit-base-x="12.25"');
  expect(horizontal).toContain('data-hf-edit-base-y="-7.5"');
  const both = edit(horizontal, [{ type: "setClip", clipId: "title", y: -10 }]);
  const vertical = edit(both, [{ type: "setClip", clipId: "title", x: null }]);
  expect(vertical).toContain('data-x="12.25"');
  expect(vertical).toContain('data-y="-17.5"');
  expect(vertical).toContain('data-hf-edit-base-x="12.25"');
  expect(
    parseComposition(vertical, emptyTimelineSettings()).timeline.clips[0],
  ).toMatchObject({ x: null, y: -10 });
  expect(edit(vertical, [{ type: "setClip", clipId: "title", y: 0 }])).toBe(
    html,
  );
  // Upstream documents may carry just one marker; the runtime still applies data-x on the other axis.
  expect(
    parseComposition(
      composition(
        '<div id="title" data-start="0" data-duration="2" data-x="12.25" data-y="-17.5" data-hf-edit-base-y="-7.5"></div>',
      ),
      emptyTimelineSettings(),
    ).timeline.clips[0],
  ).toMatchObject({ x: 12.25, y: -10 });
});

test("scale, rotation and crop are inline longhands beside authored styles, and the identity removes them", () => {
  const html = composition(
    '<video id="shot" src="shot.mp4" style="object-fit: cover; transform: translateX(4px)" data-start="0" data-duration="2" data-x="10" data-hf-edit-base-x="0" data-y="0" data-hf-edit-base-y="0"></video>',
  );
  const punched = edit(html, [
    { type: "setClip", clipId: "shot", scale: 1.1, rotation: -2.5 },
    { type: "setClip", clipId: "shot", crop: { left: 120, top: 8 } },
  ]);
  // Position stays in its native attributes and the authored transform composes after the longhands.
  expect(punched).toContain(
    'style="object-fit: cover; transform: translateX(4px); scale: 1.1; rotate: -2.5deg; clip-path: inset(8px 0px 0px 120px)" data-start="0" data-duration="2" data-x="10"',
  );
  const shot = () =>
    parseComposition(punched, emptyTimelineSettings()).timeline.clips[0];
  expect(shot()).toMatchObject({
    x: 10,
    scaleX: 1.1,
    scaleY: 1.1,
    rotation: -2.5,
    crop: { top: 8, right: 0, bottom: 0, left: 120 },
  });
  // One axis keeps the other; a partial crop keeps the other edges.
  const stretched = edit(punched, [
    { type: "setClip", clipId: "shot", scaleY: 0.9, crop: { left: 0 } },
  ]);
  expect(stretched).toContain("scale: 1.1 0.9;");
  expect(stretched).toContain("clip-path: inset(8px 0px 0px 0px)");
  expect(
    edit(stretched, [
      {
        type: "setClip",
        clipId: "shot",
        scale: null,
        rotation: 0,
        crop: { top: 0 },
      },
    ]),
  ).toBe(html);
});

test("an inline transform Cutroom cannot read is kept through other edits and refuses its own", () => {
  const html = composition(
    '<div id="spun" style="rotate: var(--spin); opacity: 0.5" data-start="0" data-duration="2">Hi</div>',
  );
  const { clips } = parseComposition(html, emptyTimelineSettings()).timeline;
  expect(clips[0]).toMatchObject({ rotation: null, opacity: 0.5 });
  expect(clips[0]!.sourceRestrictions?.transform).toContain("rotation");
  expect(
    edit(html, [{ type: "setClip", clipId: "spun", opacity: 1 }]),
  ).toContain('style="rotate: var(--spin); opacity: 1"');
  expect(() =>
    edit(html, [{ type: "setClip", clipId: "spun", scale: 2 }]),
  ).toThrow("Cutroom can't edit this clip's inline rotation");
});

test("a text edit replaces only the words, escaping them and writing line breaks as <br>", () => {
  const html = composition(
    `<h1 id="title" class="clip" data-start="0" data-duration="2">\n    Ada &amp; Park,\n    Editor\n  </h1>\n<video id="shot" src="shot.mp4" data-start="0" data-duration="2"></video>`,
  );
  const { clips } = parseComposition(html, emptyTimelineSettings()).timeline;
  const title = clips.find((clip) => clip.id === "title");
  const shot = clips.find((clip) => clip.id === "shot");
  expect(title).toMatchObject({ text: "Ada & Park, Editor" });
  expect(title!.sourceRestrictions).toBeUndefined();
  expect(shot!.text).toBeNull();
  const output = edit(html, [
    { type: "setClip", clipId: "title", text: "  Cut <one>\r\n & two  " },
  ]);
  expect(output).toBe(
    html.replace("Ada &amp; Park,\n    Editor", "Cut &lt;one&gt;<br>&amp; two"),
  );
  expect(
    parseComposition(output, emptyTimelineSettings()).timeline.clips.find(
      (clip) => clip.id === "title",
    )!.text,
  ).toBe("Cut <one>\n& two");
  expect(
    edit(output, [
      { type: "setClip", clipId: "title", text: "Ada & Park, Editor" },
    ]),
  ).toBe(html.replace("Ada &amp; Park,\n    Editor", "Ada &amp; Park, Editor"));
  expect(() =>
    edit(html, [{ type: "setClip", clipId: "shot", text: "Words" }]),
  ).toThrow("has no text to edit");
  expect(
    CommandSchema.safeParse({ type: "setClip", clipId: "title", text: " \n " })
      .success,
  ).toBe(false);
});

test("text with markup inside or a script that writes it is shown but never rewritten", () => {
  const html = composition(
    [
      `<div id="lower" data-start="0" data-duration="2"><b>Ada Park</b><span>Editor</span></div>`,
      `<div id="count" data-start="0" data-duration="2">0</div>`,
      `<div id="typed" data-start="0" data-duration="2">Hello</div>`,
      `<div id="faded" data-start="0" data-duration="2">Fades in</div>`,
      `<p id="open" data-start="0" data-duration="2">No closing tag`,
      `<div id="shape" data-start="0" data-duration="2"> </div>`,
      `<script>
        const counter = document.querySelector("#count");
        tl.to(state, { value: 90, onUpdate: () => { counter.textContent = Math.round(state.value); } });
        tl.to("#typed", { duration: 1, text: "Goodbye" });
        gsap.from("#faded", { opacity: 0 });
      </script>`,
    ].join("\n"),
  );
  const clips = new Map(
    parseComposition(html, emptyTimelineSettings()).timeline.clips.map(
      (clip) => [clip.id, clip],
    ),
  );
  expect(clips.get("lower")).toMatchObject({
    text: "Ada Park Editor",
    sourceRestrictions: {
      text: "This text has markup inside it. Edit it in the source.",
    },
  });
  expect(clips.get("count")!.sourceRestrictions?.text).toBe(
    "A script sets this text. Edit it in the source.",
  );
  expect(clips.get("typed")!.sourceRestrictions?.text).toBe(
    "A script sets this text. Edit it in the source.",
  );
  expect(clips.get("faded")).toMatchObject({ text: "Fades in" });
  expect(clips.get("faded")!.sourceRestrictions?.text).toBeUndefined();
  expect(clips.get("shape")!.text).toBeNull();
  expect(clips.get("open")!.sourceRestrictions?.text).toBe(
    "This element has no closing tag. Edit it in the source.",
  );
  for (const clipId of ["lower", "count", "typed", "open"])
    expect(() =>
      edit(html, [{ type: "setClip", clipId, text: "New" }]),
    ).toThrow("Edit it in the source.");
  expect(edit(html, [{ type: "setClip", clipId: "faded", text: "New" }])).toBe(
    html.replace("Fades in", "New"),
  );
});

test("inline pre-line keeps source newlines in the field and in a text edit", () => {
  const html = composition(
    '<div id="title" data-start="0" data-duration="2" style="white-space:pre-line">First\nSecond</div>',
  );
  const clip = parseComposition(html, emptyTimelineSettings()).timeline
    .clips[0]!;
  expect(clip.text).toBe("First\nSecond");
  expect(clip.sourceRestrictions?.text).toBeUndefined();
  const written = edit(html, [
    { type: "setClip", clipId: "title", text: "Updated\nSecond" },
  ]);
  expect(written).toContain(">Updated<br>Second</div>");
  expect(
    parseComposition(written, emptyTimelineSettings()).timeline.clips[0]!.text,
  ).toBe("Updated\nSecond");
});

test("uncertain stylesheet whitespace preserves source newlines and refuses a lossy edit", () => {
  for (const sheet of [
    "<style>.title{white-space:pre-line}</style>",
    '<link rel="stylesheet" href="type.css">',
  ]) {
    const html = composition(
      `${sheet}<div id="title" class="title" data-start="0" data-duration="2">First\nSecond</div>`,
    );
    const clip = parseComposition(html, emptyTimelineSettings()).timeline
      .clips[0]!;
    expect(clip.text).toBe("First\nSecond");
    expect(clip.sourceRestrictions?.text).toContain("source line breaks");
    expect(() =>
      edit(html, [
        { type: "setClip", clipId: "title", text: "Updated\nSecond" },
      ]),
    ).toThrow("source line breaks");
  }
  for (const whiteSpace of ["pre", "pre-wrap", "break-spaces"]) {
    const html = composition(
      `<div id="title" data-start="0" data-duration="2" style="white-space:${whiteSpace}">First\nSecond</div>`,
    );
    const clip = parseComposition(html, emptyTimelineSettings()).timeline
      .clips[0]!;
    expect(clip.text).toBe("First\nSecond");
    expect(() =>
      edit(html, [
        { type: "setClip", clipId: "title", text: "Updated\nSecond" },
      ]),
    ).toThrow("exact spacing");
  }
});
