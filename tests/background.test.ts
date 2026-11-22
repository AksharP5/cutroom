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
import { planDirectExport } from "../src/server/hyperframes/directPlan";
import { planPreviewPipeline } from "../src/server/hyperframes/pipelinePlan";
import { clipMatte, matteNeeds } from "../src/shared/matte";
import type { MatteStatus } from "../src/shared/matte";
import { countingIds } from "./clip-ids";
import { frameLayersAt } from "../src/client/pipeline/layers";

const page = (body: string) =>
  `<!doctype html>\n<html><head></head>\n<body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="10" data-fps="30">\n${body}\n</main></body></html>\n`;
const shot = `<video id="shot" src="shot.mp4" muted style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" data-start="0" data-duration="4" data-media-start="2" data-track-index="0"></video>`;
const music = `<audio id="music" src="music.wav" data-start="0" data-duration="10" data-track-index="2"></audio>`;
const parse = (html: string) =>
  parseComposition(html, emptyTimelineSettings(), { scope: "document" });

function edit(html: string, commands: CommandInput[]) {
  const parsed = parse(html);
  const origins = new Map<string, ClipOrigin>();
  const timeline = canonicalTimeline(
    applyAll(
      parsed.timeline,
      commands.map((command) => CommandSchema.parse(command)),
      { onCreate: (id, origin) => origins.set(id, origin), newId: countingIds },
    ),
  );
  return patchComposition(parsed, timeline, origins);
}
const background = (html: string) =>
  parse(html).timeline.clips.find(({ id }) => id === "shot")!.background;

test("Remove, refine and Keep are one attribute stock HyperFrames ignores", () => {
  const removed = edit(page(shot), [
    { type: "setClip", clipId: "shot", background: { mode: "remove" } },
  ]);
  expect(removed).toContain('data-cutroom-matte="shrink:1;soften:1"');
  expect(background(removed)).toEqual({ shrink: 1, soften: 1 });
  const refined = edit(removed, [
    { type: "setClip", clipId: "shot", background: { shrink: 2, soften: 3 } },
  ]);
  expect(background(refined)).toEqual({ shrink: 2, soften: 3 });
  // The source keeps its own src: nothing points at a matte file.
  expect(refined).toContain('src="shot.mp4"');
  const kept = edit(refined, [
    { type: "setClip", clipId: "shot", background: null },
  ]);
  expect(kept).not.toContain("data-cutroom-matte");
  expect(background(kept)).toBeNull();
});

test("only video clips have a background, and refine needs Remove first", () => {
  const html = page(`${shot}\n${music}`);
  expect(() =>
    edit(html, [
      { type: "setClip", clipId: "music", background: { mode: "remove" } },
    ]),
  ).toThrow("Only video clips do");
  expect(() =>
    edit(html, [
      { type: "setClip", clipId: "shot", background: { shrink: 2 } },
    ]),
  ).toThrow('Set background.mode to "remove" first');
  expect(() =>
    CommandSchema.parse({
      type: "setClip",
      clipId: "shot",
      background: { soften: 9 },
    }),
  ).toThrow();
});

test("a removed clip stays drawable by the footage pipeline and goes to frame capture for export", () => {
  const removed = edit(page(shot), [
    { type: "setClip", clipId: "shot", background: { mode: "remove" } },
  ]);
  expect(planPreviewPipeline(removed, { num: 30, den: 1 })).toMatchObject({
    drawable: { shot: "cover" },
  });
  expect(planDirectExport(removed, { num: 30, den: 1 }, null)).toMatchObject({
    reason: "shot has data-cutroom-matte",
  });
});

test("a clip needs what it plays and a second each side, and is ready only once every frame is made", () => {
  const removed = edit(page(shot), [
    { type: "setClip", clipId: "shot", background: { mode: "remove" } },
  ]);
  const timeline = parse(removed).timeline;
  expect(matteNeeds(timeline, "index.html")).toEqual([
    { clip: "shot", src: "shot.mp4", from: 1, to: 7 },
  ]);
  const grid = { start: 0, rate: 30, count: 300 };
  const entry = (first: number, frames: number, subject = true) => ({
    file: subject ? `mattes/shot ${first}.mp4` : "",
    src: "shot.mp4",
    size: 1,
    mtimeMs: 1,
    ...grid,
    first,
    frames,
    variable: false,
    model: "u2net_human_seg",
    subject,
  });
  const status = (
    mattes: MatteStatus["mattes"],
    jobs: MatteStatus["jobs"] = [],
  ): MatteStatus => ({ model: { status: "ready" }, mattes, jobs });
  // The clip plays source frames 60 to 180.
  expect(clipMatte(status([entry(30, 100)]), "shot.mp4", 2, 6).state).toBe(
    "waiting",
  );
  const running = clipMatte(
    status(
      [entry(30, 100)],
      [
        {
          id: "j",
          src: "shot.mp4",
          ...grid,
          first: 130,
          frames: 80,
          done: 20,
          status: "running",
          elapsed: 4,
        },
      ],
    ),
    "shot.mp4",
    2,
    6,
  );
  expect(running).toMatchObject({ state: "running", elapsed: 4 });
  // Progress spans the clip and the job's handle: frames 60 to 210, of which 70 are in the
  // matte and 20 done by the job.
  expect(running.state === "running" && running.progress).toBe(90 / 150);
  expect(
    clipMatte(status([entry(30, 100), entry(130, 80)]), "shot.mp4", 2, 6).state,
  ).toBe("ready");
  expect(
    clipMatte(status([entry(0, 300, false)]), "shot.mp4", 2, 6).state,
  ).toBe("no-subject");
});

test("a cutout above a title draws over it, while uncut footage there still needs HyperFrames", () => {
  const fill = "position:absolute;inset:0;width:100%;height:100%";
  const title = `<div id="title" class="clip" data-start="0" data-duration="2" data-track-index="1" style="position:absolute;left:0;top:0">Behind</div>`;
  const presenter = (matte: string) =>
    `<video id="presenter" src="shot.mp4" muted ${matte} data-start="0" data-duration="2" data-media-start="0" data-track-index="2" style="${fill}"></video>`;
  const html = (matte: string) =>
    page(
      `<video id="plate" src="plate.mp4" muted data-start="0" data-duration="2" data-media-start="0" data-track-index="0" style="${fill}"></video>${title}${presenter(matte)}`,
    );
  const layers = (source: string) => {
    const plan = planPreviewPipeline(source, { num: 30, den: 1 });
    if ("reason" in plan) throw new Error(plan.reason);
    const frame = frameLayersAt(parse(source).timeline, plan, 30);
    return (
      frame && {
        below: frame.pictures.map(({ clip }) => clip.id),
        above: frame.above?.map(({ clip }) => clip.id),
      }
    );
  };
  expect(layers(html('data-cutroom-matte="shrink:1;soften:1"'))).toEqual({
    below: ["plate"],
    above: ["presenter"],
  });
  expect(layers(html(""))).toBeNull();
});

test("a clip playing to its source's last frame is ready once that frame is made, and a ramp asks for no matte", () => {
  const grid = { start: 0, rate: 30, count: 73 };
  const status: MatteStatus = {
    model: { status: "ready" },
    jobs: [],
    mattes: [
      {
        file: "mattes/shot.mp4",
        src: "shot.mp4",
        size: 1,
        mtimeMs: 1,
        ...grid,
        first: 0,
        frames: 73,
        variable: false,
        model: "u2net_human_seg",
        subject: true,
      },
    ],
  };
  // Played to the end at 29.97 fps rounding, a hair past frame 73.
  expect(clipMatte(status, "shot.mp4", 1, 73 / 30 + 0.0001).state).toBe(
    "ready",
  );
  const ramped = edit(page(shot), [
    { type: "setClip", clipId: "shot", background: { mode: "remove" } },
  ]).replace(
    "<video ",
    `<video data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":0.5},{"t":4,"v":2}]}]}' `,
  );
  expect(matteNeeds(parse(ramped).timeline, "index.html")).toEqual([]);
});
