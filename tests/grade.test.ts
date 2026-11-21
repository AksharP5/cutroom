import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeHfColorGradingCube } from "@hyperframes/core";
import { applyAll, canonicalTimeline } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { readGrade } from "../src/shared/timeline/grade";
import { editLabel } from "../src/shared/timeline/labels";
import type { Grade } from "../src/shared/timeline/grade";
import {
  parseComposition,
  patchComposition,
  settingsOf,
  timelineContent,
} from "../src/server/timeline/composition";
import { planDirectExport } from "../src/server/hyperframes/directPlan";
import { planPreviewPipeline } from "../src/server/hyperframes/pipelinePlan";
import { readCube, saveLut } from "../src/server/grade/luts";
import { countingIds } from "./clip-ids";
import { applyFilmGrade } from "../src/client/timeline/filmGradeLookup";

test("a filmstrip cube interpolates the eight corners and keeps alpha", () => {
  const cube = Uint8Array.from([
    0, 30, 5, 255, 0, 30, 5, 255, 0, 190, 5, 255, 0, 190, 5, 255, 0, 30, 245,
    255, 0, 30, 245, 255, 0, 190, 245, 255, 255, 190, 245, 255,
  ]);
  const pixels = new Uint8ClampedArray([
    51, 102, 153, 128, 255, 255, 255, 255, 0, 0, 0, 0,
  ]);
  applyFilmGrade(pixels, cube, 2);
  expect([...pixels]).toEqual([
    12, 94, 149, 128, 255, 190, 245, 255, 0, 0, 0, 0,
  ]);
});

const page = (body: string) =>
  `<!doctype html>\n<html><head></head>\n<body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="10" data-fps="30">\n${body}\n</main></body></html>\n`;
const shot = `<video id="shot" src="shot.mp4" muted style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" data-start="0" data-duration="10" data-track-index="0"></video>`;
const music = `<audio id="music" src="music.wav" data-start="0" data-duration="10" data-track-index="2"></audio>`;

const parse = (html: string) =>
  parseComposition(html, emptyTimelineSettings(), { scope: "document" });
const clip = (html: string, id: string) =>
  parse(html).timeline.clips.find((each) => each.id === id)!;

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
  const output = patchComposition(parsed, timeline, origins);
  expect(
    timelineContent(
      parseComposition(output, settingsOf(timeline), { scope: "document" })
        .timeline,
    ),
  ).toEqual(timelineContent(timeline));
  return output;
}

const look: Grade = {
  adjust: { temperature: 0.3, exposure: 0.25 },
  curves: {
    master: [
      [0, 0],
      [0.25, 0.2],
      [0.75, 0.82],
      [1, 1],
    ],
  },
  lut: { src: "luts/teal.cube", intensity: 0.7 },
};

test("a grade is written as HyperFrames' data-color-grading, edited field by field, and removed at neutral", () => {
  const graded = edit(page(shot), [
    { type: "setClip", clipId: "shot", grade: look },
  ]);
  expect(clip(graded, "shot").grade).toEqual(look);
  // The attribute is HyperFrames' own format, which its runtime draws.
  const attribute = /data-color-grading="([^"]*)"/.exec(graded)![1]!;
  expect(JSON.parse(attribute.replaceAll("&quot;", '"'))).toEqual(look);

  // Warmer keeps exposure, the curve and the LUT; a reset curve goes.
  const warmer = edit(graded, [
    {
      type: "setClip",
      clipId: "shot",
      grade: { adjust: { temperature: 0.5 }, curves: { master: null } },
    },
  ]);
  expect(clip(warmer, "shot").grade).toEqual({
    adjust: { temperature: 0.5, exposure: 0.25 },
    lut: look.lut,
  } satisfies Grade);
  // Back to neutral is ungraded, so the source carries no attribute at all.
  const neutral = edit(warmer, [
    {
      type: "setClip",
      clipId: "shot",
      grade: { adjust: { temperature: 0, exposure: 0 }, lut: null },
    },
  ]);
  expect(neutral).not.toContain("data-color-grading");
  expect(clip(neutral, "shot").grade).toBeNull();
});

test("a region-free adjustment layer keeps a grade without changing its source shots", () => {
  const graded = edit(page(shot), [
    { type: "setTrack", index: 1, kind: "video" },
    {
      type: "insert",
      at: 30,
      track: 1,
      clip: { kind: "adjustment", id: "look", duration: 90 },
    },
    { type: "setClip", clipId: "look", grade: look },
  ]);
  expect(clip(graded, "look")).toMatchObject({
    adjustment: true,
    grade: look,
    region: null,
    start: 30,
    duration: 90,
  });
  expect(clip(graded, "shot").grade).toBeNull();
  const cleared = edit(graded, [
    { type: "setClip", clipId: "look", grade: null },
  ]);
  expect(clip(cleared, "look")).toMatchObject({
    adjustment: true,
    grade: null,
    region: null,
  });
});

test("a grade on an adjustment layer follows its span on either export path", () => {
  const html = edit(page(shot), [
    { type: "setTrack", index: 1, kind: "video" },
    {
      type: "insert",
      at: 60,
      track: 1,
      clip: { kind: "adjustment", id: "look", duration: 30 },
    },
    { type: "setClip", clipId: "look", grade: look },
  ]);
  const plan = planDirectExport(html, { num: 30, den: 1 }, null);
  if ("reason" in plan) throw new Error(plan.reason);
  expect(
    plan.segments.map(({ kind, start, end }) => [kind, start, end]),
  ).toEqual([
    ["source", 0, 60],
    ["source", 60, 90],
    ["source", 90, 300],
  ]);
  expect(plan.segments[1]).toMatchObject({ adjustments: [look] });
  const title =
    '<div id="title" data-start="2" data-duration="1" data-track-index="0">Title</div>';
  const mixed = planDirectExport(
    html.replace("</main>", title + "</main>"),
    { num: 30, den: 1 },
    null,
  );
  if ("reason" in mixed) throw new Error(mixed.reason);
  expect(
    mixed.segments.map(({ kind, start, end }) => [kind, start, end]),
  ).toEqual([
    ["source", 0, 60],
    ["capture", 60, 90],
    ["source", 90, 300],
  ]);
  const neutral = edit(html, [
    { type: "setClip", clipId: "look", grade: null },
  ]);
  const plain = planDirectExport(neutral, { num: 30, den: 1 }, null);
  if ("reason" in plain) throw new Error(plain.reason);
  expect(
    plain.segments.map(({ kind, start, end }) => [kind, start, end]),
  ).toEqual([["source", 0, 300]]);
});

test("a razor cut and a freeze frame keep the grade", () => {
  const graded = edit(page(shot), [
    { type: "setClip", clipId: "shot", grade: { adjust: { saturation: -1 } } },
  ]);
  const cut = edit(graded, [{ type: "split", at: 120 }]);
  const grades = parse(cut).timeline.clips.map((each) => each.grade);
  expect(grades).toEqual([
    { adjust: { saturation: -1 } },
    { adjust: { saturation: -1 } },
  ]);
  // The still is the source's frame, so it carries the grade the clip showed.
  const frozen = applyAll(
    parse(graded).timeline,
    [
      CommandSchema.parse({
        type: "freeze",
        clipId: "shot",
        at: 60,
        id: "still",
      }),
    ],
    { onCreate: () => {}, newId: countingIds },
  );
  expect(frozen.clips.find((each) => each.id === "still")?.grade).toEqual({
    adjust: { saturation: -1 },
  });
});

test("grades are refused on sound, out of range, and on authored grades Cutroom cannot edit", () => {
  const html = page(`${shot}\n${music}`);
  expect(() =>
    edit(html, [
      { type: "setClip", clipId: "music", grade: { adjust: { tint: 0.2 } } },
    ]),
  ).toThrow("has no colour grade");
  expect(() =>
    CommandSchema.parse({
      type: "setClip",
      clipId: "shot",
      grade: { adjust: { exposure: 3 } },
    }),
  ).toThrow();
  // HyperFrames' contract refuses a curve with two points at one input.
  expect(() =>
    edit(html, [
      {
        type: "setClip",
        clipId: "shot",
        grade: {
          curves: {
            red: [
              [0.5, 0.2],
              [0.5, 0.8],
            ],
          },
        },
      },
    ]),
  ).toThrow("duplicate input");
  // A LUT is a project file, never a URL.
  for (const src of ["https://example.com/a.cube", "../a.cube", "/a.cube"])
    expect(() =>
      CommandSchema.parse({
        type: "setClip",
        clipId: "shot",
        grade: { lut: { src } },
      }),
    ).toThrow();

  const authored = page(
    shot.replace(
      "<video",
      `<video data-color-grading='{"preset":"vhs-playback","effects":{"tapeNoise":1}}'`,
    ),
  );
  const read = clip(authored, "shot");
  expect(read.grade).toBeNull();
  expect(read.sourceRestrictions?.grade).toContain("Edit it in the source");
  expect(() =>
    edit(authored, [
      { type: "setClip", clipId: "shot", grade: { adjust: { tint: 0.2 } } },
    ]),
  ).toThrow("Edit it in the source");
  expect(readGrade("{nope")).toEqual({
    restriction:
      "Its data-color-grading is not JSON. Repair it in the source first.",
  });
});

test("the direct export draws a graded clip from its source with the grade; the footage pipeline can draw it", () => {
  const graded = edit(page(shot), [
    { type: "setClip", clipId: "shot", grade: look },
  ]);
  const plan = planDirectExport(graded, { num: 30, den: 1 }, null);
  expect(plan).toMatchObject({
    segments: [{ kind: "source", src: "shot.mp4", grade: look }],
  });
  expect(planPreviewPipeline(graded, { num: 30, den: 1 })).toMatchObject({
    drawable: { shot: "contain" },
  });
  // A grade with a stage no LUT holds goes to frame capture.
  const grained = page(
    shot.replace(
      "<video",
      `<video data-color-grading='{"details":{"grain":0.3}}'`,
    ),
  );
  expect(planDirectExport(grained, { num: 30, den: 1 }, null)).toEqual({
    reason: "shot has a grade Cutroom cannot bake",
  });
  expect(planPreviewPipeline(grained, { num: 30, den: 1 })).toEqual({
    reason: "no video clips passed the footage classifier",
    hyperframes: { shot: "shot has a grade Cutroom cannot bake" },
  });
});

const cube = (size: number, row = "0 0.5 1") =>
  `LUT_3D_SIZE ${size}\n${Array.from({ length: size ** 3 }, () => row).join("\n")}\n`;
const bytes = (text: string) => new TextEncoder().encode(text);

test(".cube files are read strictly, and saved in one canonical form", async () => {
  expect(readCube(bytes(cube(2))).size).toBe(2);
  const refusals: [string | Uint8Array, string][] = [
    [cube(66), "LUT_3D_SIZE 66 exceeds max 65"],
    [cube(2, "0 NaN 1"), "line 2"],
    [cube(2, "0 0.5 9"), "beyond ±4"],
    [`LUT_1D_SIZE 4\n0 0 0\n`, "1D cube LUTs"],
    [cube(2).replace(/\n0 0.5 1\n$/, "\n"), "Expected 8 LUT rows"],
    [new Uint8Array([0xff, 0xfe, 0x00]), "not text"],
  ];
  for (const [input, message] of refusals)
    expect(() =>
      readCube(typeof input === "string" ? bytes(input) : input),
    ).toThrow(message);
  // A bad value is named by its line, never echoed back.
  expect(() => readCube(bytes(cube(2, "0 secret 1")))).toThrow(
    /^That \.cube file cannot be read \(line 2\): Invalid number a value\.$/,
  );

  const root = await mkdtemp(join(tmpdir(), "cutroom-luts-"));
  try {
    const first = await saveLut(
      { path: root },
      "Teal & Orange.cube",
      readCube(bytes(`# comment\nTITLE "x"\n${cube(2)}`)),
    );
    const second = await saveLut(
      { path: root },
      "teal orange",
      readCube(bytes(cube(2))),
    );
    expect(first).toEqual({
      path: "luts/teal-orange.cube",
      title: "Teal Orange",
      size: 2,
    });
    expect(second.path).toBe("luts/teal-orange-2.cube");
    const saved = await readFile(join(root, first.path), "utf8");
    expect(saved.split("\n").slice(0, 5)).toEqual([
      'TITLE "Teal Orange"',
      "LUT_3D_SIZE 2",
      "DOMAIN_MIN 0.000000 0.000000 0.000000",
      "DOMAIN_MAX 1.000000 1.000000 1.000000",
      "0.000000 0.500000 1.000000",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a baked grade saved as a LUT bakes back to the same cube", () => {
  const grade = {
    adjust: {
      exposure: 0.3,
      contrast: 0.2,
      temperature: 0.4,
      saturation: 0.25,
    },
    wheels: { shadows: { hue: 190, amount: 0.4 } },
    curves: {
      master: [
        [0, 0.05],
        [0.5, 0.55],
        [1, 0.95],
      ] as [number, number][],
    },
  };
  const baked = bakeHfColorGradingCube(grade, { size: 33 });
  const again = bakeHfColorGradingCube(
    { lut: { src: "luts/grade.cube" } },
    { size: 33, lut: readCube(bytes(baked)) },
  );
  const values = (text: string) =>
    text
      .split("\n")
      .filter((line) => /^[\d.]+ [\d.]+ [\d.]+$/.test(line))
      .flatMap((line) => line.split(" ").map(Number));
  const [a, b] = [values(baked), values(again)];
  expect(a.length).toBe(33 ** 3 * 3);
  // The runtime holds a LUT at 8 bits, so each point moves by half a level at most, plus the
  // file's six decimals.
  const error = Math.max(
    ...a.map((value, index) => Math.abs(value - b[index]!)),
  );
  expect(error * 255).toBeLessThanOrEqual(0.501);
  // And the grade is far from neutral, so the check means something.
  const neutral = values(bakeHfColorGradingCube({}, { size: 33 }));
  expect(
    Math.max(...a.map((value, index) => Math.abs(value - neutral[index]!))),
  ).toBeGreaterThan(0.1);
});

test("history and approvals name a grade edit in plain words", () => {
  const { timeline } = parse(page(shot));
  const label = (grade: unknown) =>
    editLabel(
      [CommandSchema.parse({ type: "setClip", clipId: "shot", grade })],
      timeline,
      "Edit",
    );
  expect(
    label({ adjust: { temperature: 0.3 }, lut: { src: "luts/teal.cube" } }),
  ).toBe("Set temperature to 0.3; Set look LUT to teal.cube");
  expect(label(null)).toBe("Removed grade");
});
