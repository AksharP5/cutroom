import { expect, test } from "bun:test";
import { isClipOnScreenAt } from "@hyperframes/core/runtime/clip-window";
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
} from "../src/server/timeline/composition";

const talk = `<video id="talk" src="talk.mp4" muted data-link="lk-1" data-sync-origin="lk-1" data-start="0" data-duration="6" data-media-start="1" data-track-index="0"></video>`;
const voice = `<audio id="voice" src="talk.mp4" data-link="lk-1" data-sync-origin="lk-1" data-start="0" data-duration="6" data-media-start="1" data-track-index="2"></audio>`;
const title = `<DIV id='title' class=clip data-start=6 data-duration="4" data-track-index="1" data-hf-id="hf-9"><b data-hf-id="hf-10">Hi</b></DIV>`;
const after = `<div id="after" class="clip" data-start="title" data-duration="2" data-track-index="1">Next</div>`;
const track0Stacking = `<style data-cutroom-track-stacking>@layer cutroom-tracks{:where([data-track-index="0"]:not(audio),[data-layer="0"]:not([data-track-index]):not(audio)){z-index:0}}</style>`;
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

const edit = (html: string, commands: CommandInput[]) => {
  const parsed = parseComposition(html, emptyTimelineSettings());
  const origins = new Map<string, ClipOrigin>();
  const timeline = canonicalTimeline(
    applyAll(
      parsed.timeline,
      commands.map((command) => CommandSchema.parse(command)),
      { onCreate: (id, origin) => origins.set(id, origin) },
    ),
  );
  const output = patchComposition(parsed, timeline, origins);
  expect(parseComposition(output, settingsOf(timeline)).timeline).toEqual(
    timeline,
  );
  return output;
};

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
  expect(output).toBe(
    source
      .replace(`\n  ${talk}\n  ${voice}`, "")
      .replace(`data-duration="4"`, `data-duration="3"`)
      .replace(`data-duration="12"`, `data-duration="11"`)
      .replace(
        `data-fps="30">`,
        `data-fps="30">\n<style data-cutroom-track-stacking>@layer cutroom-tracks{:where([data-track-index="1"]:not(audio),[data-layer="1"]:not([data-track-index]):not(audio)){z-index:1}}</style>`,
      ),
  );
  const moved = edit(source, [{ type: "move", clipIds: ["after"], by: 15 }]);
  expect(moved).toBe(
    source
      .replace(`data-start="title"`, `data-start="10.5"`)
      .replace(`data-duration="12"`, `data-duration="12.5"`)
      .replace(
        `data-fps="30">`,
        `data-fps="30">\n<style data-cutroom-track-stacking>@layer cutroom-tracks{:where([data-track-index="0"]:not(audio),[data-layer="0"]:not([data-track-index]):not(audio)){z-index:0}:where([data-track-index="1"]:not(audio),[data-layer="1"]:not([data-track-index]):not(audio)){z-index:1}}</style>`,
      ),
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
  expect(output).toBe(
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
      .replace(`data-duration="12"`, `data-duration="10"`)
      .replace(
        `data-fps="30">`,
        `data-fps="30">\n<style data-cutroom-track-stacking>@layer cutroom-tracks{:where([data-track-index="0"]:not(audio),[data-layer="0"]:not([data-track-index]):not(audio)){z-index:0}:where([data-track-index="1"]:not(audio),[data-layer="1"]:not([data-track-index]):not(audio)){z-index:1}}</style>`,
      ),
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
    { type: "move", clipIds: ["title"], trackBy: 2 },
  ]);
  expect(moved).toContain(`data-track-index="3"`);
  expect(moved).toContain(`[data-track-index="3"]:not(audio)`);
  expect(moved).toContain(`{z-index:3}`);
  expect(moved).toContain(`style="color:red;z-index:50!important"`);
  expect(moved.match(/<style data-cutroom-track-stacking>/g)).toHaveLength(1);
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
  expect(edit(html, [{ type: "move", clipIds: ["bed"], trackBy: 1 }])).toBe(
    html.replace(`data-track-index="0"`, `data-track-index="1"`),
  );
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
  expect(edit(html, [{ type: "move", clipIds: ["title"], by: 30 }])).toBe(
    html
      .replace(`data-duration="10"`, `data-duration="11"`)
      .replace(`data-fps="30">`, `data-fps="30">\n${track0Stacking}`)
      .replace(
        `data-start="0" data-duration="2">Title`,
        `data-start="1" data-duration="2">Title`,
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
  expect(patchComposition(parsed, timeline, new Map())).toBe(
    `${first
      .replace(
        `data-start="0" data-duration="1" data-track-index="0">Helper`,
        `data-start="1" data-duration="1" data-track-index="0">Helper`,
      )
      .replace(
        `data-duration="4">`,
        `data-duration="5">\n${track0Stacking}`,
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
  expect(edit(html, [{ type: "move", clipIds: ["v"], by: 24 }])).toBe(
    html
      .replace(`data-duration="10"`, `data-duration="11"`)
      .replace(`data-fps="24">`, `data-fps="24">\n${track0Stacking}`)
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
