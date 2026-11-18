import { expect, test } from "bun:test";
import { applyAll, canonicalTimeline } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
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
import { readRegion } from "../src/server/timeline/regions";
import { planPreviewPipeline } from "../src/server/hyperframes/pipelinePlan";
import { planDirectExport } from "../src/server/hyperframes/directPlan";
import { countingIds } from "./clip-ids";

const fps = { num: 30, den: 1 };
const mediaLengths = new Map([["talk.mp4", 20]]);
const page = (body: string) =>
  `<!doctype html>\n<html><head></head>\n<body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="12" data-fps="30">\n${body}\n</main></body></html>\n`;
const video = (id: string, start: number, duration: number, track = 0) =>
  `<video id="${id}" src="talk.mp4" muted style="position:absolute;inset:0;width:100%;height:100%" data-start="${start}" data-duration="${duration}" data-track-index="${track}"></video>`;

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
/** The custom properties the region stylesheet gives one clip. */
const zoomOf = (html: string, id: string) =>
  new RegExp(`\\[id="${id}"\\]\\{(--cutroom-zoom:[^}]*)\\}`).exec(html)?.[1];

test("a zoom aimed at a wide button fills the frame with a box of the frame's shape around it", () => {
  const { html, timeline } = edit(page(video("rec", 0, 6)), [
    {
      type: "setClip",
      clipId: "rec",
      region: {
        effect: "zoom",
        box: { x: 0.6, y: 0.1, width: 0.2, height: 0.05 },
        in: 15,
        out: 15,
      },
    },
  ]);
  const region = clipOf(timeline, "rec").region!;
  // 5x around the button's centre, kept inside the frame.
  expect(region.box).toEqual({ x: 0.6, y: 0.025, width: 0.2, height: 0.2 });
  expect(region.ease).toBe("ease-in-out");
  // At full zoom the picture moves toward a 1000 px perspective; projecting the box's corners
  // through it must land them on the frame's corners.
  const full = /translate:(-?[\d.]+)px (-?[\d.]+)px ([\d.]+)px/
    .exec(html.slice(html.indexOf("@keyframes cutroom-zoom")).split("%{")[2]!)!
    .slice(1)
    .map(Number);
  const [tx, ty, tz] = full as [number, number, number];
  const project = (x: number, y: number) => [
    960 + (x + tx - 960) * (1000 / (1000 - tz)),
    540 + (y + ty - 540) * (1000 / (1000 - tz)),
  ];
  const corner = (value: number[]) =>
    value.map((n) => Math.round(n * 1000) / 1000);
  expect(corner(project(0.6 * 1920, 0.025 * 1080))).toEqual([0, 0]);
  expect(corner(project(0.8 * 1920, 0.225 * 1080))).toEqual([1920, 1080]);
  expect(zoomOf(html, "rec")).toContain("--cutroom-zoom-duration:6s");
  expect(html).toContain("perspective:1000px");
});

test("an adjustment layer zooms every picture below it from where each one starts, and none above", () => {
  const { html, timeline } = edit(
    page(
      [video("a", 0, 3), video("b", 3, 3), video("logo", 0, 6, 2)].join("\n"),
    ),
    [
      {
        type: "insert",
        track: 1,
        at: 60,
        clip: {
          kind: "adjustment",
          duration: 60,
          region: {
            effect: "zoom",
            box: { x: 0, y: 0, width: 0.5, height: 0.5 },
          },
        },
      },
    ],
  );
  const layer = clipOf(timeline, "adjustment");
  expect(layer).toMatchObject({
    kind: "element",
    adjustment: true,
    text: null,
  });
  expect(layer.region).toMatchObject({ effect: "zoom", in: 15, out: 15 });
  // The zoom starts 2 s into a and a second before b; the clip on V3 stays put.
  expect(zoomOf(html, "a")).toContain("--cutroom-zoom-delay:2s");
  expect(zoomOf(html, "b")).toContain("--cutroom-zoom-delay:-1s");
  expect(zoomOf(html, "logo")).toBeUndefined();
  expect(html).toContain('data-cutroom-adjustment=""');

  // Moving the layer off the clips takes its zoom away from them.
  const moved = edit(html, [
    { type: "move", clipIds: ["adjustment"], by: 240, mode: "place" },
  ]);
  expect(zoomOf(moved.html, "a")).toBeUndefined();
  expect(moved.html).not.toContain("--cutroom-zoom:");
});

test("a razor keeps the effect running through the cut", () => {
  const { html } = edit(page(video("a", 0, 6)), [
    {
      type: "insert",
      track: 1,
      at: 0,
      clip: {
        kind: "adjustment",
        duration: 120,
        region: { effect: "highlight", in: 10, out: 10 },
      },
    },
  ]);
  const { timeline } = edit(html, [
    { type: "split", clipIds: ["adjustment"], at: 60 },
  ]);
  const [left, right] = timeline.clips
    .filter((clip) => clip.adjustment)
    .toSorted((a, b) => a.start - b.start);
  expect([left!.region!.in, left!.region!.out]).toEqual([10, 0]);
  expect([right!.region!.in, right!.region!.out]).toEqual([0, 10]);
});

test("blur and highlight draw over the picture below, so they need an adjustment layer", () => {
  expect(() =>
    edit(page(video("a", 0, 6)), [
      { type: "setClip", clipId: "a", region: { effect: "blur" } },
    ]),
  ).toThrow(/adjustment layer/);
  const { html } = edit(page(video("a", 0, 6)), [
    {
      type: "insert",
      track: 1,
      at: 0,
      clip: {
        kind: "adjustment",
        duration: 60,
        region: {
          effect: "highlight",
          dim: 0.75,
          blur: 4,
          radius: 0,
          feather: 0,
        },
      },
    },
  ]);
  expect(html).toContain("backdrop-filter:blur(4px) brightness(0.25)");
  // Everything outside the box: the frame with the box cut out of it.
  expect(html).toContain(
    'clip-path:path(evenodd,"M0 0H1920V1080H0ZM672 378H1248V702H672Z")',
  );
  expect(html).not.toContain("--cutroom-fade:");
});

test("only validated numbers and names reach the stylesheet", () => {
  expect(
    CommandSchema.safeParse({
      type: "setClip",
      clipId: "a",
      region: {
        effect: "zoom",
        box: { x: 0.9, y: 0, width: 0.5, height: 0.5 },
      },
    }).success,
  ).toBe(false);
  expect(
    CommandSchema.safeParse({
      type: "setClip",
      clipId: "a",
      region: { ease: "x;}body{display:none" },
    }).success,
  ).toBe(false);
  // An attribute edited by hand that does not pass the schema reads as no region.
  expect(
    readRegion(
      JSON.stringify({
        effect: "blur",
        box: { x: "0}</style>", y: 0, width: 0.5, height: 0.5 },
      }),
      fps,
    ),
  ).toBeNull();
  // An id that would close the style element is escaped in its selector.
  const id = "a</style><script>alert(1)</script>";
  const { html } = edit(
    page(video("a&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;", 0, 6)),
    [{ type: "setClip", clipId: id, region: { effect: "zoom" } }],
  );
  const style = html.slice(
    html.indexOf("<style data-cutroom-region-style"),
    html.indexOf("</style>", html.indexOf("<style data-cutroom-region-style")),
  );
  expect(style).toContain('[id="a\\3c /style>\\3c script>');
  expect(style).not.toContain("<script>");
});

test("a zoomed video leaves the footage pipeline and the direct export for HyperFrames, which draws it", () => {
  const plain = page(video("a", 0, 6));
  const { html } = edit(plain, [
    { type: "setClip", clipId: "a", region: { effect: "zoom" } },
  ]);
  for (const [document, zoomed] of [
    [plain, false],
    [html, true],
  ] as const) {
    expect("reason" in planPreviewPipeline(document, fps)).toBe(zoomed);
    expect(
      "reason" in planDirectExport(document, fps, { start: 0, end: 120 }),
    ).toBe(zoomed);
  }
});
