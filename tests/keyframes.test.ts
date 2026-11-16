import { expect, test } from "bun:test";
import { applyAll, canonicalTimeline } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import { valueAt } from "../src/shared/timeline/keyframes";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput, Timeline } from "../src/shared/timeline/schema";
import {
  parseComposition,
  patchComposition,
  settingsOf,
  timelineContent,
} from "../src/server/timeline/composition";
import { planPreviewPipeline } from "../src/server/hyperframes/pipelinePlan";
import { planDirectExport } from "../src/server/hyperframes/directPlan";
import { countingIds } from "./clip-ids";

const mediaLengths = new Map([["talk.mp4", 20]]);
const page = (body: string) =>
  `<!doctype html>\n<html><head></head>\n<body><main id="main" data-composition-id="main" data-duration="12" data-fps="30">\n${body}\n</main></body></html>\n`;
const shot = `<video id="a" src="talk.mp4" muted style="position:absolute;inset:0;width:100%;height:100%;opacity:0.5" data-start="1" data-duration="3" data-media-start="1" data-track-index="0"></video>`;

/** Applies commands, writes the HTML, and checks it reads back as the same timeline. */
function edit(html: string, commands: CommandInput[]) {
  const parsed = parseComposition(html, emptyTimelineSettings(), {
    mediaLengths,
  });
  const origins = new Map<string, ClipOrigin>();
  const timeline = canonicalTimeline(
    applyAll(
      parsed.timeline,
      commands.map((command) => CommandSchema.parse(command)),
      { onCreate: (id, origin) => origins.set(id, origin), newId: countingIds },
    ),
  );
  const output = patchComposition(parsed, timeline, origins);
  expect(
    timelineContent(
      parseComposition(output, settingsOf(timeline), { mediaLengths }).timeline,
    ),
  ).toEqual(timelineContent(timeline));
  return { html: output, timeline };
}
const clipOf = (timeline: Timeline, id: string) =>
  timeline.clips.find((clip) => clip.id === id)!;

const fadeUp: CommandInput[] = [
  { type: "setKeyframe", clipId: "a", property: "opacity", frame: 0, value: 0 },
  {
    type: "setKeyframe",
    clipId: "a",
    property: "opacity",
    frame: 30,
    value: 1,
  },
];

test("a keyframe turns the static value into keyframes and the HTML draws them in clip-local time", () => {
  const { html, timeline } = edit(page(shot), [
    ...fadeUp,
    {
      type: "setKeyframe",
      clipId: "a",
      property: "position",
      frame: 15,
      value: { x: 120 },
      ease: "ease-out",
    },
  ]);
  const a = clipOf(timeline, "a");
  expect(a.opacity).toBeNull();
  expect(a.keyframes).toEqual({
    opacity: [
      { frame: 0, value: 0, ease: "linear" },
      { frame: 30, value: 1, ease: "linear" },
    ],
    position: [{ frame: 15, value: { x: 120, y: 0 }, ease: "ease-out" }],
  });
  // Halfway between the opacity keyframes, the clip shows half.
  expect(valueAt(a, "opacity", 15)).toBe(0.5);
  // The static opacity is gone from the clip; the attribute holds the keyframes in seconds.
  expect(html).toContain(
    `style="position:absolute; inset:0; width:100%; height:100%" data-start`,
  );
  expect(html).toContain(
    `data-cutroom-keyframes="position 0.5 120 0 ease-out; opacity 0 0, 1 1"`,
  );
  // One rule per attribute value, the animation spanning the first keyframe to the last.
  expect(html).toMatch(
    /\[data-cutroom-keyframes="position 0\.5 120 0 ease-out; opacity 0 0, 1 1"\]\{--cutroom-keyframes:(cutroom-keyframes-\w+);--cutroom-keyframes-at:0;--cutroom-keyframes-span:1\}\n@keyframes \1\{0%\{translate:120px 0px\}50%\{translate:120px 0px;animation-timing-function:ease-out\}100%\{translate:120px 0px\}0%\{opacity:0;animation-timing-function:linear\}100%\{opacity:1;animation-timing-function:linear\}\}/,
  );
});

test("removing the last keyframe leaves its value static and drops the stylesheet", () => {
  const keyed = edit(page(shot), fadeUp).html;
  const { html, timeline } = edit(keyed, [
    { type: "removeKeyframe", clipId: "a", property: "opacity", frame: 0 },
    { type: "removeKeyframe", clipId: "a", property: "opacity", frame: 30 },
  ]);
  const a = clipOf(timeline, "a");
  expect(a.keyframes).toBeNull();
  expect(a.opacity).toBe(1);
  expect(html).not.toContain("data-cutroom-keyframe");
  expect(html).toContain("<head></head>");
  expect(html).toContain(
    `style="position:absolute; inset:0; width:100%; height:100%; opacity: 1"`,
  );
});

test("trims and razors keep keyframes on the frames they animate", () => {
  const keyed = edit(page(shot), fadeUp).html;
  // Trimming 10 frames off the head moves the clip's first frame onto the keyframes' frame 10.
  const trimmed = clipOf(
    edit(keyed, [{ type: "trim", clipId: "a", edge: "start", to: 40 }])
      .timeline,
    "a",
  );
  expect(trimmed.keyframes?.opacity?.map((keyframe) => keyframe.frame)).toEqual(
    [-10, 20],
  );
  expect(valueAt(trimmed, "opacity", 5)).toBe(0.5);

  // A razor halfway through the fade: each piece shows what the whole clip showed there.
  const { timeline } = edit(keyed, [{ type: "split", at: 45 }]);
  const [left, right] = timeline.clips;
  expect(valueAt(left!, "opacity", 14)).toBeCloseTo(14 / 30);
  expect(valueAt(right!, "opacity", 0)).toBe(0.5);
  expect(right!.keyframes?.opacity?.map((keyframe) => keyframe.frame)).toEqual([
    -15, 15,
  ]);
});

test("under a transition the attribute counts from the element's earlier start", () => {
  const html = page(
    [
      `<video id="a" src="talk.mp4" muted data-start="1" data-duration="3" data-media-start="1" data-track-index="0"></video>`,
      `<video id="b" src="talk.mp4" muted data-start="4" data-duration="3" data-media-start="5" data-track-index="0"></video>`,
    ].join("\n"),
  );
  const { html: output, timeline } = edit(html, [
    {
      type: "setKeyframe",
      clipId: "b",
      property: "rotation",
      frame: 0,
      value: 0,
    },
    {
      type: "setKeyframe",
      clipId: "b",
      property: "rotation",
      frame: 30,
      value: 90,
    },
    {
      type: "setTransition",
      from: "a",
      to: "b",
      transition: { duration: 30 },
    },
  ]);
  // The clip's frames stay where they were; its element starts half a second earlier.
  expect(
    clipOf(timeline, "b").keyframes?.rotation?.map(
      (keyframe) => keyframe.frame,
    ),
  ).toEqual([0, 30]);
  expect(output).toContain(`data-cutroom-keyframes="rotation 0.5 0, 1.5 90"`);
});

test("scale keyframes on a moved clip keyframe its position, and setClip leaves keyframed properties alone", () => {
  const moved = edit(page(shot), [{ type: "setClip", clipId: "a", x: 40 }]);
  const { timeline } = edit(moved.html, [
    {
      type: "setKeyframe",
      clipId: "a",
      property: "scale",
      frame: 10,
      value: { x: 2, y: 2 },
    },
  ]);
  const a = clipOf(timeline, "a");
  expect(a.x).toBeNull();
  expect(a.keyframes?.position).toEqual([
    { frame: 10, value: { x: 40, y: 0 }, ease: "linear" },
  ]);
  const refused = () =>
    applyAll(timeline, [
      CommandSchema.parse({ type: "setClip", clipId: "a", scale: 1 }),
    ]);
  expect(refused).toThrow("animates its scale with keyframes");
  expect(() =>
    applyAll(timeline, [
      CommandSchema.parse({ type: "setClip", clipId: "a", x: 0 }),
    ]),
  ).toThrow("animates its position with keyframes");
});

test("keyframe commands refuse frames outside the clip and values of another property", () => {
  const { timeline } = edit(page(shot), fadeUp);
  const run = (command: CommandInput) => () =>
    applyAll(timeline, [CommandSchema.parse(command)]);
  expect(
    run({ type: "setKeyframe", clipId: "a", property: "opacity", frame: 90 }),
  ).toThrow("outside");
  expect(
    run({
      type: "setKeyframe",
      clipId: "a",
      property: "opacity",
      frame: 5,
      value: { x: 1 },
    }),
  ).toThrow("not a opacity value");
  expect(
    run({
      type: "moveKeyframe",
      clipId: "a",
      property: "opacity",
      frame: 0,
      to: 30,
    }),
  ).toThrow("already has");
});

test("keyframed eases follow CSS: hold keeps the value, ease-in starts slow", () => {
  const { timeline } = edit(page(shot), [
    ...fadeUp,
    {
      type: "setKeyframe",
      clipId: "a",
      property: "opacity",
      frame: 0,
      ease: "hold",
    },
  ]);
  const a = clipOf(timeline, "a");
  expect(valueAt(a, "opacity", 29)).toBe(0);
  expect(valueAt(a, "opacity", 30)).toBe(1);
  const eased = clipOf(
    edit(page(shot), [
      ...fadeUp,
      {
        type: "setKeyframe",
        clipId: "a",
        property: "opacity",
        frame: 0,
        ease: "ease-in",
      },
    ]).timeline,
    "a",
  );
  // Chromium's ease-in at half way, as getComputedStyle reports it.
  expect(valueAt(eased, "opacity", 15)).toBeCloseTo(0.315357, 5);
});

test("a keyframed video keeps the footage pipeline and the direct export on HyperFrames, which draws the keyframes", () => {
  const fps = { num: 30, den: 1 };
  // An opaque shot filling the frame, which both draw from its source.
  const sized = page(shot.replace(";opacity:0.5", "")).replace(
    'data-fps="30"',
    'data-fps="30" data-width="1920" data-height="1080"',
  );
  const { html } = edit(sized, fadeUp);
  for (const [document, keyed] of [
    [sized, false],
    [html, true],
  ] as const) {
    expect("reason" in planPreviewPipeline(document, fps)).toBe(keyed);
    expect(
      "reason" in planDirectExport(document, fps, { start: 30, end: 120 }),
    ).toBe(keyed);
  }
});
