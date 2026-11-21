import { expect, test } from "bun:test";
import { applyAll, canonicalTimeline } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  parseComposition,
  patchComposition,
} from "../src/server/timeline/composition";
import { planPreviewPipeline } from "../src/server/hyperframes/pipelinePlan";
import {
  appearances,
  frameLayersAt,
  shownAt,
  visibleAt,
} from "../src/client/pipeline/layers";
import { titleAttributes, titleStyle } from "../src/server/timeline/titles";
import { defaultTitle } from "../src/shared/timeline/title";
import { countingIds } from "./clip-ids";

const fps = { num: 30, den: 1 };
const fill = "position:absolute;inset:0;width:100%;height:100%";

/** Two cuts of one file on V1, b-roll on V2 and a title on V3, as Cutroom writes them. */
function page(extra = "", head = "") {
  const title = titleAttributes(defaultTitle(fps), fps)
    .map(([name, value]) => (value === null ? "" : ` ${name}="${value}"`))
    .join("");
  return `<!doctype html><html><head><style>html,body{margin:0;background:#111}</style>${titleStyle([])}${head}</head><body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="6" data-fps="30">
<video id="a" src="talk.mp4" muted data-start="0" data-duration="3" data-media-start="0" data-track-index="0" style="${fill}"></video>
<video id="b" src="talk.mp4" muted data-start="3" data-duration="3" data-media-start="10" data-track-index="0" style="${fill};object-fit:cover"></video>
<video id="broll" src="broll.mp4" muted data-start="1" data-duration="1" data-media-start="2" data-track-index="1" style="${fill}"></video>
<audio id="voice" src="talk.mp4" data-start="0" data-duration="6" data-track-index="2"></audio>
<div id="title" class="clip" data-start="0" data-duration="2" data-track-index="3"${title}>Name</div>
${extra}</main></body></html>`;
}

function edit(html: string, commands: CommandInput[]) {
  const parsed = parseComposition(html, emptyTimelineSettings());
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
  return patchComposition(parsed, timeline, origins);
}

const drawable = (html: string) => {
  const plan = planPreviewPipeline(html, fps);
  if ("reason" in plan) throw new Error(plan.reason);
  return plan;
};

test("plain footage under titles is drawable, with each video's fit and the page colour", () => {
  const plan = drawable(page());
  expect(plan.drawable).toEqual({ a: "fill", b: "cover", broll: "fill" });
  expect(plan.background).toBe("#111111");
  expect(plan.order).toEqual(["a", "b", "broll", "title"]);
});

test("the standard clip class and an empty timeline leave the footage drawable", () => {
  const library = "gsap.min.js";
  const html = page("", `<script src="${library}"></script>`)
    .replace('<video id="a"', '<video id="a" class="clip"')
    .replace(
      "</body>",
      "<script>window.__timelines=window.__timelines||{};window.__timelines.main=gsap.timeline({paused:true});</script></body>",
    );
  const libraries = new Set([library]);
  expect(planPreviewPipeline(html, fps, libraries)).toMatchObject({
    drawable: { a: "fill", b: "cover", broll: "fill" },
  });
  expect(planPreviewPipeline(html, fps)).toHaveProperty("reason");
  const scripted = html.replace(
    "paused:true});",
    "paused:true});document.querySelector('video').remove();",
  );
  expect(planPreviewPipeline(scripted, fps, libraries)).toHaveProperty(
    "reason",
  );
});

/** A HyperFrames clip above the footage holding `inner`. */
const card = (inner: string) =>
  `<div id="card" class="clip" data-start="0" data-duration="1" data-track-index="4">${inner}</div>`;

test("whatever could change every clip keeps the composition on HyperFrames", () => {
  const cases: [string, string, string][] = [
    [
      `<div id="under" class="clip" data-start="0" data-duration="1" data-track-index="0" style="z-index:0"></div>`,
      "",
      "z-index",
    ],
    [`<script>window.x = 1</script>`, "", "the composition has a <script>"],
    ["", `<script src="app.js"></script>`, "the head has a <script>"],
    [
      "",
      "<style>video{filter:blur(4px)}</style>",
      "a stylesheet sets filter on <video>",
    ],
    // Inside a clip, where only a walk of every element finds them.
    [
      card("<script>document.body.remove()</script>"),
      "",
      "card has a <script>",
    ],
    [card("<style>video{filter:invert(1)}</style>"), "", "card has a <style>"],
    [
      card(`<img src="x.png" onerror="document.body.remove()">`),
      "",
      "card has an onerror handler",
    ],
    [
      card(`<svg onload="document.body.remove()"></svg>`),
      "",
      "card has an onload handler",
    ],
    [
      card(
        `<iframe srcdoc="<script>parent.postMessage(1, '*')</script>"></iframe>`,
      ),
      "",
      "card has a <iframe>",
    ],
    // Blending reads the pipeline's canvas beneath, which the preview cannot see.
    [
      card('<b style="mix-blend-mode:difference">Name</b>'),
      "",
      "b sets mix-blend-mode",
    ],
    [
      "",
      "<style>.clip{backdrop-filter:blur(8px)}</style>",
      "a stylesheet sets backdrop-filter",
    ],
  ];
  for (const [extra, head, reason] of cases)
    expect(planPreviewPipeline(page(extra, head), fps)).toEqual({
      reason: expect.stringContaining(reason),
    });
});

test("a native video only forces other footage back to HyperFrames while the layers overlap", () => {
  const video = (id: string, track: number, rest = "muted", style = fill) =>
    `<video id="${id}" src="talk.mp4" ${rest} data-start="0" data-duration="1" data-track-index="${track}" style="${style}"></video>`;
  const cases: [string, string][] = [
    [video("loud", 5, ""), "loud plays its own sound"],
    [
      video("framed", 5, "muted", "position:absolute;left:10px;width:50%"),
      "framed is not placed in a box filling the frame",
    ],
    // A video between frames is one the pipeline would draw a frame early or late.
    [
      video("early", 5).replace('data-start="0"', 'data-start="0.01"'),
      "early starts or ends between frames",
    ],
  ];
  for (const [extra, reason] of cases) {
    const plan = drawable(page(extra));
    expect(plan.drawable).toEqual({ a: "fill", b: "cover", broll: "fill" });
    expect(Object.values(plan.hyperframes)).toEqual([reason]);
  }
  // Native footage stays native. Conflicting stacking sends only the overlap to HyperFrames.
  const at = (html: string, start: number, duration: number) =>
    html.replace(
      'data-start="0" data-duration="1"',
      `data-start="${start}" data-duration="${duration}"`,
    );
  const stacked = drawable(
    page(
      at(video("loud", 5, ""), 3, 1) +
        at(video("over", 6), 3.5, 1) +
        at(video("top", 7), 4.2, 0.8),
    ),
  );
  expect(stacked.hyperframes).toEqual({ loud: "loud plays its own sound" });
  // Use the pipeline again as soon as the native clip ends, even mid-clip.
  const overlap = page(
    at(video("loud", 5, ""), 3, 1) + at(video("over", 6), 3.5, 1),
  );
  const { timeline } = parseComposition(overlap, emptyTimelineSettings());
  expect(shownAt(timeline, stacked, 110)).toBeNull();
  expect(visibleAt(timeline, stacked, 120)?.map(({ clip }) => clip.id)).toEqual(
    ["over"],
  );
  // Moving footage above an HTML title affects only the title's interval.
  const under = edit(page(), [
    { type: "setTrack", index: 4, kind: "video" },
    { type: "move", clipIds: ["broll"], by: 15, trackBy: 3, mode: "overwrite" },
  ]);
  const moved = parseComposition(under, emptyTimelineSettings()).timeline;
  expect(shownAt(moved, drawable(under), 59)).toBeNull();
  expect(
    visibleAt(moved, drawable(under), 60)?.map(({ clip }) => clip.id),
  ).toEqual(["broll"]);
  // With nothing left to draw the composition stays on HyperFrames.
  expect(planPreviewPipeline(page().replaceAll(" muted ", " "), fps)).toEqual({
    reason: "no video clips passed the footage classifier",
    hyperframes: expect.objectContaining({ a: "a plays its own sound" }),
  });
});

test("a transition the pipeline would draw differently is HyperFrames' to draw", () => {
  const dissolve: CommandInput = {
    type: "setTransition",
    from: "a",
    to: "b",
    transition: { kind: "dissolve", duration: 10, alignment: "center" },
  };
  expect(drawable(edit(page(), [dissolve])).drawable.b).toBe("cover");
  // A dissolve animates opacity from the clip's own, which the pipeline draws only at 1.
  // b fades over a, which holds beneath it, so a stays with the pipeline.
  expect(
    drawable(
      edit(page(), [dissolve, { type: "setClip", clipId: "b", opacity: 0.5 }]),
    ).hyperframes,
  ).toEqual({ b: "b has a transition the pipeline cannot draw" });
  // Without Cutroom's transitions sheet the attributes animate nothing.
  const bare = edit(page(), [dissolve]).replace(
    /<style data-cutroom-transitions[^>]*>[\s\S]*?<\/style>/,
    "",
  );
  expect(drawable(bare).hyperframes).toEqual({
    a: "a has a transition the pipeline cannot draw",
    b: "b has a transition the pipeline cannot draw",
  });
  expect(
    shownAt(
      parseComposition(bare, emptyTimelineSettings()).timeline,
      drawable(bare),
      45,
    ),
  ).toBeNull();
});

test("frames show the right media time, stacking and transition opacity", () => {
  const html = edit(page(), [
    {
      type: "setTransition",
      from: "a",
      to: "b",
      transition: { kind: "dissolve", duration: 10, alignment: "center" },
    },
    {
      type: "setClip",
      clipId: "broll",
      x: 100,
      scale: 0.5,
      crop: { left: 8 },
      opacity: 0.5,
    },
  ]);
  const plan = drawable(html);
  const { timeline } = parseComposition(html, emptyTimelineSettings());
  const at = (frame: number) =>
    shownAt(timeline, plan, frame)!.map(({ clip, time, opacity }) => ({
      id: clip.id,
      time: Math.round(time * 1000) / 1000,
      opacity: Math.round(opacity * 100) / 100,
    }));
  // b-roll over a, at its own media offset and opacity.
  expect(at(45)).toEqual([
    { id: "a", time: 1.5, opacity: 1 },
    { id: "broll", time: 2.5, opacity: 0.5 },
  ]);
  // The dissolve straddles the cut at 90, frames 85 to 94: b, later in the document, fades in
  // over a, which holds.
  expect(at(84).map(({ id }) => id)).toEqual(["a"]);
  expect(at(87)).toEqual([
    { id: "a", time: 2.9, opacity: 1 },
    { id: "b", time: 9.9, opacity: 0.2 },
  ]);
  expect(at(94)).toEqual([
    { id: "a", time: 3.133, opacity: 1 },
    { id: "b", time: 10.133, opacity: 0.9 },
  ]);
  expect(at(95)).toEqual([{ id: "b", time: 10.167, opacity: 1 }]);
  // A razor piece the plan has not named yet draws as the clip it came from.
  const b = timeline.clips.find((clip) => clip.id === "b")!;
  const cut = {
    ...timeline,
    clips: [
      ...timeline.clips.filter((clip) => clip.id !== "b"),
      { ...b, duration: 30, transitionOut: null },
      { ...b, id: "b-2", start: b.start + 30, duration: b.duration - 30 },
    ],
  };
  expect(shownAt(cut, plan, 150)?.map(({ fit }) => fit)).toEqual(["cover"]);
  // An unknown video from another file is not drawable.
  const other = {
    ...timeline,
    clips: [
      ...timeline.clips,
      {
        ...timeline.clips.find((clip) => clip.id === "b")!,
        id: "new",
        src: "other.mp4",
        track: 9,
      },
    ],
  };
  expect(shownAt(other, plan, 120)).toBeNull();
});

test("the adjustment is drawn after the lower footage and only across its interval", () => {
  const html = page(
    '<div id="look" class="clip" data-start="1" data-duration="1.5" data-track-index="2" data-cutroom-adjustment data-color-grading=\'{"adjust":{"saturation":-1}}\'></div>',
  )
    .replace('data-track-index="2"></audio>', 'data-track-index="6"></audio>')
    .replace(
      'id="broll" src="broll.mp4" muted data-start="1" data-duration="1" data-media-start="2" data-track-index="1" style="',
      'id="broll" src="broll.mp4" muted data-start="1" data-duration="1" data-media-start="2" data-track-index="1" style="opacity:.5;',
    );
  const plan = drawable(html);
  const { timeline } = parseComposition(html, emptyTimelineSettings());
  const frame = frameLayersAt(timeline, plan, 45)!;
  expect(frame.pictures.map(({ clip }) => clip.id)).toEqual(["a", "broll"]);
  expect(frame.adjustments?.map(({ clip, after }) => [clip.id, after])).toEqual(
    [["look", 2]],
  );
  expect(frameLayersAt(timeline, plan, 29)?.adjustments).toBeUndefined();
  expect(frameLayersAt(timeline, plan, 75)?.adjustments).toBeUndefined();
});

test("playback prepares clips that come back into view, not only clips that start", () => {
  const html = page();
  const plan = drawable(html);
  const { timeline } = parseComposition(html, emptyTimelineSettings());
  // The b-roll fills the frame opaquely from 30 to 60, so nothing beneath it is decoded.
  expect(visibleAt(timeline, plan, 45)!.map(({ clip }) => clip.id)).toEqual([
    "broll",
  ]);
  expect(
    appearances(timeline, plan, 0, 100).map(({ frame, layer }) => ({
      frame,
      id: layer.clip.id,
      time: Math.round(layer.time * 1000) / 1000,
    })),
  ).toEqual([
    { frame: 30, id: "broll", time: 2 },
    // a never starts here: the b-roll above it ends, and its picture resumes two seconds in.
    { frame: 60, id: "a", time: 2 },
    { frame: 90, id: "b", time: 10 },
  ]);
});

test("lookahead includes transition handles and keeps ownership outside its window", () => {
  const html = edit(page(), [
    {
      type: "setTransition",
      from: "a",
      to: "b",
      transition: { kind: "dissolve", duration: 10, alignment: "center" },
    },
  ]);
  const plan = drawable(html);
  const { timeline } = parseComposition(html, emptyTimelineSettings());
  // b starts at 90, but its opening at 85 still needs preparing by this window's end.
  expect(
    appearances(timeline, plan, 80, 85).map(({ frame, layer }) => ({
      frame,
      id: layer.clip.id,
    })),
  ).toEqual([{ frame: 85, id: "b" }]);

  const b = timeline.clips.find((clip) => clip.id === "b")!;
  const cut = {
    ...timeline,
    clips: [
      ...timeline.clips
        .filter((clip) => clip.id !== "b")
        .map((clip) =>
          clip.id === "broll" ? { ...clip, start: 135, duration: 10 } : clip,
        ),
      { ...b, duration: 30, transitionOut: null },
      {
        ...b,
        id: "b-rest",
        start: 120,
        duration: 60,
        mediaStart: 11,
        transitionIn: null,
      },
    ],
  };
  // The surviving named neighbour ends at 120, outside this window. It still establishes
  // that the new piece is cover, even though another named clip of the file uses fill.
  expect(
    appearances(cut, { ...plan, trackZ: { "0": 0, "1": 1 } }, 135, 145).map(
      ({ frame, layer }) => ({
        frame,
        id: layer.clip.id,
        fit: layer.fit,
      }),
    ),
  ).toEqual([{ frame: 145, id: "b-rest", fit: "cover" }]);
});

test("lookahead prepares the pipeline’s return after an unclassified clip", () => {
  const html = page();
  const plan = drawable(html);
  const { timeline } = parseComposition(html, emptyTimelineSettings());
  const b = timeline.clips.find((clip) => clip.id === "b")!;
  const changed = {
    ...timeline,
    clips: [
      ...timeline.clips,
      { ...b, id: "new", src: "new.mp4", start: 50, duration: 5, track: 9 },
    ],
  };
  expect(appearances(changed, plan, 45, 100).map(({ frame }) => frame)).toEqual(
    [55, 60, 90],
  );
});

test("a frame showing one of HyperFrames' videos still draws the pipeline's beneath it", () => {
  const html = page(
    `<video id="loud" src="talk.mp4" data-start="0" data-duration="1" data-track-index="5" style="${fill}"></video>`,
  );
  const plan = drawable(html);
  const { timeline } = parseComposition(html, emptyTimelineSettings());
  expect(shownAt(timeline, plan, 10)!.map(({ clip }) => clip.id)).toEqual([
    "a",
  ]);
  // A razor piece of it, before the next plan names it, is HyperFrames' too.
  const loud = timeline.clips.find((clip) => clip.id === "loud")!;
  const cut = {
    ...timeline,
    clips: [
      ...timeline.clips.filter((clip) => clip.id !== "loud"),
      { ...loud, duration: 15 },
      { ...loud, id: "loud-2", start: loud.start + 15, duration: 15 },
    ],
  };
  expect(shownAt(cut, plan, 20)!.map(({ clip }) => clip.id)).toEqual(["a"]);
});
