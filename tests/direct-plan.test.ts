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

test("Cutroom's own cuts export from the source, and frames under a title use the browser", async () => {
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
    // The starter page, two linked cuts, a title over the second and a track gain.
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
        at: 90,
        clip: { kind: "title", text: "Name", duration: 30 },
      },
      { type: "setTrack", index: 2, volume: 0.5 },
    ]);
    const plan = planDirectExport(html, fps, { start: 30, end: 90 });
    expect(plan).toEqual({
      width: 1920,
      height: 1080,
      durationFrames: 120,
      frames: { start: 30, end: 90 },
      segments: [
        { start: 30, end: 60, src: "a.mp4", mediaStart: 3 },
        { start: 60, end: 90, src: "b.mp4", mediaStart: 0.5 },
      ],
    });
    expect(planDirectExport(html, fps, null)).toEqual({
      reason: "frame 90 shows 2 clips",
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

test("the page the cases below change exports from the source", () => {
  expect(planDirectExport(page(), fps, null)).toHaveProperty("segments");
});

// Each of these draws something FFmpeg's plain copy of the source would not, so it must use the browser.
for (const [name, html] of [
  ["a speed change", page({ body: video(' data-playback-rate="2"') })],
  ["opacity", page({ body: video("", ";opacity:0.5") })],
  ["a scale", page({ body: video("", ";scale:1.2") })],
  ["a crop", page({ body: video("", ";clip-path:inset(10px 0px 0px 0px)") })],
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
