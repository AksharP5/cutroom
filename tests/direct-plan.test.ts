import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { planDirectExport } from "../src/server/hyperframes/directPlan";
import { ProjectSchema } from "../src/shared/project";
import { countingIds } from "./clip-ids";
import { projectFixture } from "./project-fixture";

const fps = { num: 30, den: 1 };

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

test("Cutroom's own cuts and b-roll export from the source, and frames under a title use the browser", async () => {
  const fixture = await projectFixture();
  try {
    const project = ProjectSchema.parse(
      await (
        await fixture.request("/projects", "POST", {
          name: "Direct",
          width: 1920,
          height: 1080,
          duration: 10,
        })
      ).json(),
    );
    const starter = await readFile(join(project.path, "index.html"), "utf8");
    const starterClips = parseComposition(
      starter,
      emptyTimelineSettings(),
    ).timeline.clips.map((clip) => clip.id);
    // The starter page, two linked cuts, b-roll over the first, a title over the second and a
    // track gain.
    const html = edit(starter, [
      { type: "remove", clipIds: starterClips },
      {
        type: "insert",
        track: 0,
        at: 0,
        clip: { kind: "video", src: "a.mp4", duration: 60, mediaStart: 2 },
      },
      {
        type: "insert",
        track: 0,
        at: 60,
        clip: { kind: "video", src: "b.mp4", duration: 60, mediaStart: 0.5 },
      },
      {
        type: "insert",
        track: 1,
        at: 20,
        clip: {
          kind: "video",
          src: "broll.mp4",
          duration: 20,
          mediaStart: 4,
          muted: true,
        },
      },
      {
        type: "insert",
        track: 2,
        at: 90,
        clip: { kind: "title", text: "Name", duration: 30 },
      },
      { type: "setTrack", index: 3, volume: 0.5 },
    ]);
    expect(planDirectExport(html, fps, null)).toEqual({
      width: 1920,
      height: 1080,
      durationFrames: 120,
      frames: { start: 0, end: 120 },
      segments: [
        { kind: "source", start: 0, end: 20, src: "a.mp4", mediaStart: 2 },
        { kind: "source", start: 20, end: 40, src: "broll.mp4", mediaStart: 4 },
        {
          kind: "source",
          start: 40,
          end: 60,
          src: "a.mp4",
          mediaStart: 2,
          clipStart: 0,
        },
        { kind: "source", start: 60, end: 90, src: "b.mp4", mediaStart: 0.5 },
        { kind: "capture", start: 90, end: 120 },
      ],
    });
  } finally {
    await fixture.close();
  }
});

const video = (attributes = "", style = "") =>
  `<video id="v" src="v.mp4" muted data-start="0" data-duration="2" data-media-start="1" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain${style}"${attributes}></video>`;
const page = ({
  head = "",
  body = video(),
}: { head?: string; body?: string } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"><style>html,body{margin:0;background:#111}</style>${head}</head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="2" class="stage">${body}</main></body></html>`;

test("a plain clip at 30000/1001 plans its source time from its own start", () => {
  const html = page({
    body: `<video id="v" src="v.mp4" muted data-start="0.033367" data-duration="1.001" data-media-start="1.25" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video>`,
  }).replace('data-duration="2"', 'data-duration="1.034367"');
  expect(
    planDirectExport(html, { num: 30000, den: 1001 }, { start: 1, end: 31 }),
  ).toMatchObject({
    durationFrames: 31,
    segments: [{ start: 1, end: 31, src: "v.mp4", mediaStart: 1.25 }],
  });
});

const second = (track: number) =>
  `<video id="w" src="w.mp4" muted data-start="0" data-duration="2" data-track-index="${track}" style="position:absolute;inset:0;width:100%;height:100%"></video>`;
const layer = `<style>@layer cutroom-tracks{${[0, 1]
  .map(
    (track) =>
      `:where([data-composition-id="main"] [data-start][data-track-index="${track}"]:not(audio)){z-index:${track}}`,
  )
  .join("")}}</style>`;
const sources = (html: string) => {
  const plan = planDirectExport(html, fps, null);
  return "segments" in plan
    ? plan.segments.map((segment) =>
        segment.kind === "source" ? segment.src : "capture",
      )
    : plan.reason;
};

test("of two full-frame videos, the one painted last exports from its source", () => {
  // Same level: document order decides.
  expect(sources(page({ body: video() + second(0) }))).toEqual(["w.mp4"]);
  // Cutroom's track layer puts the higher track on top wherever it is in the document.
  expect(sources(page({ head: layer, body: second(1) + video() }))).toEqual([
    "w.mp4",
  ]);
  // Any other z-index could reorder them.
  expect(
    sources(
      page({ head: "<style>.x{z-index:2}</style>", body: video() + second(0) }),
    ),
  ).toBe("frame 0 shows 2 clips in an authored order");
});

test("every run under a title is captured, however many, and the frames between draw from the source", () => {
  const title = (start: number) =>
    `<div id="t${start}" class="clip" data-start="${start}" data-duration="0.5" data-track-index="1">Hi</div>`;
  const long = (titles: number[]) =>
    page({
      body:
        video().replace('data-duration="2"', 'data-duration="5"') +
        titles.map(title).join(""),
    }).replace('data-duration="2" class', 'data-duration="5" class');
  expect(sources(long([1, 2, 3, 4]))).toEqual([
    "v.mp4",
    "capture",
    "v.mp4",
    "capture",
    "v.mp4",
    "capture",
    "v.mp4",
    "capture",
    "v.mp4",
  ]);
});

const placed = (html: string) => {
  const plan = planDirectExport(html, fps, null);
  if ("reason" in plan) return plan.reason;
  const [segment] = plan.segments;
  return segment?.kind === "source"
    ? { still: segment.still, placement: segment.placement }
    : "capture";
};

test("the inspector's Position, Scale, Rotation, Crop and Opacity draw from the source over the page colour", () => {
  expect(
    placed(
      page({
        body: video(
          ' data-x="40" data-y="-12.5" data-hf-edit-base-x="0" data-hf-edit-base-y="0"',
          ";scale:0.5 0.6;rotate:12deg;clip-path:inset(4px 8px 0px 2px);opacity:0.75",
        ),
      }),
    ),
  ).toEqual({
    still: undefined,
    placement: {
      x: 40,
      y: -12.5,
      scaleX: 0.5,
      scaleY: 0.6,
      rotation: 12,
      crop: { top: 4, right: 8, bottom: 0, left: 2 },
      opacity: 0.75,
      beneath: "#111111",
    },
  });
  // Cutroom's image clips plan as stills; the server reads their size before export.
  expect(
    placed(
      page({
        body: `<img id="i" class="clip" src="i.png" data-start="0" data-duration="2" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain">`,
      }),
    ),
  ).toMatchObject({ still: { fit: "contain" }, placement: { scaleX: 1 } });
});

test("a placed clip draws from the source over other clips only where it covers the frame", () => {
  const under = second(0).replace('id="w"', 'id="under"');
  // Something other than the page colour lies beneath, so a clip that shows it needs the browser.
  expect(placed(page({ body: under + video("", ";scale:0.5") }))).toBe(
    "v shows what lies beneath it",
  );
  expect(placed(page({ body: under + video("", ";opacity:0.5") }))).toBe(
    "v shows what lies beneath it",
  );
  // A punch-in covers the frame, whatever lies beneath.
  expect(
    placed(page({ body: under + video("", ";scale:1.2") })),
  ).toHaveProperty("placement.scaleX", 1.2);
  // A page without a known colour of its own shows the browser's default.
  expect(
    placed(
      page({ body: video("", ";scale:0.5") }).replace(
        "html,body{margin:0;background:#111}",
        "html,body{margin:0}",
      ),
    ),
  ).toBe("v shows what lies beneath it");
  // Two different colours could each show.
  expect(
    placed(
      page({
        head: "<style>.stage{background:#222}</style>",
        body: video("", ";scale:0.5"),
      }),
    ),
  ).toBe("v shows what lies beneath it");
});

test("the page the cases below change exports from the source", () => {
  expect(planDirectExport(page(), fps, null)).toHaveProperty("segments");
});

// Each of these draws something FFmpeg's plain copy of the source would not, so it must use the browser.
for (const [name, html] of [
  ["a speed change", page({ body: video(' data-playback-rate="2"') })],
  ["a translate of its own", page({ body: video("", ";translate:10px 0px") })],
  ["a transform", page({ body: video("", ";transform:scale(1.2)") })],
  [
    "a crop between pixels",
    page({ body: video("", ";clip-path:inset(10.5px 0px 0px 0px)") }),
  ],
  [
    "an opacity Cutroom cannot read",
    page({ body: video("", ";opacity:var(--fade)") }),
  ],
  ["a position without its baseline", page({ body: video(' data-x="40"') })],
  [
    "an image with a class of its own",
    page({
      body: `<img id="i" class="clip logo" src="i.png" data-start="0" data-duration="2" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%">`,
    }),
  ],
  ["a transition", page({ body: video(' data-transition-in="dissolve"') })],
  ["a class", page({ body: video(' class="clip"') })],
  ["its own sound", page({ body: video().replace(" muted", "") })],
  [
    "an authored script",
    page({ head: "<script>gsap.to('#v',{x:9})</script>" }),
  ],
  [
    "a stylesheet on video",
    page({ head: "<style>video{filter:blur(2px)}</style>" }),
  ],
  [
    "a pseudo-element on the stage",
    page({ head: '<style>.stage::after{content:"";background:red}</style>' }),
  ],
  [
    "!important",
    page({ head: "<style>.title{visibility:visible!important}</style>" }),
  ],
  ["a resized stage", page({ head: "<style>.stage{width:50%}</style>" })],
  ["an element without timing", page({ body: `${video()}<div>logo</div>` })],
  ["text outside a clip", page({ body: `${video()}hello` })],
  [
    "a start between frames",
    page({ body: video().replace('data-start="0"', 'data-start="0.01"') }),
  ],
  [
    "a linked stylesheet",
    page({ head: '<link rel="stylesheet" href="a.css">' }),
  ],
] as const)
  test(`a clip with ${name} uses the browser`, () => {
    expect(planDirectExport(html, fps, null)).toHaveProperty("reason");
  });

test("a script, stylesheet, frame or event handler anywhere in the composition sends the export to frame capture", () => {
  const plain = (extra: string) =>
    `<!doctype html><html><head><style>html,body{margin:0;background:#111}</style></head><body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="2">
${extra}
<video id="v" src="talk.mp4" muted data-start="0" data-duration="2" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video></main></body></html>`;
  // Beneath the video for its whole length, each would be ignored if only the top clip counted.
  const under = (inner: string, attributes = "") =>
    plain(
      `<div id="note" class="clip" data-start="0" data-duration="2" data-track-index="0"${attributes}>${inner}</div>`,
    );
  expect(planDirectExport(under("Name"), fps, null)).toMatchObject({
    segments: [{ kind: "source" }],
  });
  const cases: [string, string][] = [
    [
      under("<script>document.querySelector('video').style.scale = 2</script>"),
      "note has a <script>",
    ],
    [under("<style>video{filter:invert(1)}</style>"), "note has a <style>"],
    [
      under(`<img src="x.png" onerror="document.body.remove()">`),
      "note has an onerror handler",
    ],
    [
      under(`<svg onload="document.body.remove()"></svg>`),
      "note has an onload handler",
    ],
    [
      under(`<svg><script>document.body.remove()</script></svg>`),
      "note has a <script>",
    ],
    [
      under(
        `<iframe srcdoc="<script>parent.document.body.remove()</script>"></iframe>`,
      ),
      "note has a <iframe>",
    ],
    [under(`<object data="movie.swf"></object>`), "note has a <object>"],
    [
      under("Name", ` onclick="document.body.remove()"`),
      "note has an onclick handler",
    ],
    [
      plain(`<script>document.body.remove()</script>`),
      "the composition has a <script>",
    ],
  ];
  for (const [html, reason] of cases)
    expect(planDirectExport(html, fps, null)).toEqual({ reason });
});
