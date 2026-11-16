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
  settingsOf,
  timelineContent,
} from "../src/server/timeline/composition";
import { planDirectExport } from "../src/server/hyperframes/directPlan";
import { editLabel } from "../src/shared/timeline/labels";
import { countingIds } from "./clip-ids";

const page = (body: string) =>
  `<!doctype html>\n<html><head><style>@font-face{font-family:"Display";src:url(display.woff2)}#headline{font-size:96px;color:#fff}</style></head>\n<body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="10" data-fps="30">\n${body}\n</main></body></html>\n`;
const headline = `<h1 id="headline" class="clip" style="position: absolute; top: 80px" data-start="0" data-duration="5" data-track-index="1">Spring launch</h1>`;
const shape = `<div id="badge" class="clip" data-start="0" data-duration="5" data-track-index="2"></div>`;
const shot = `<video id="shot" src="shot.mp4" muted style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" data-start="0" data-duration="10" data-track-index="0"></video>`;

const parse = (html: string) =>
  parseComposition(html, emptyTimelineSettings(), { scope: "document" });
const clip = (html: string, id: string) =>
  parse(html).timeline.clips.find((clip) => clip.id === id)!;
const tag = (html: string, id: string) =>
  new RegExp(`<[a-z0-9]+ id="${id}"[^>]*>`).exec(html)![0];

/** Edits through the engine and the writer, and checks the file reads back as the engine's timeline. */
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

test("restyles an authored headline and shape as inline CSS, keeping authored declarations", () => {
  const html = page(`${headline}\n${shape}`);
  const output = edit(html, [
    {
      type: "setClip",
      clipId: "headline",
      style: {
        fontFamily: "Display",
        fontSize: 120,
        fontWeight: 800,
        letterSpacing: -0.02,
        lineHeight: 1.1,
        color: "#FFCC00",
        textAlign: "center",
        textTransform: "uppercase",
        shadow: { x: 0, y: 4, blur: 12, color: "#000000b3" },
      },
    },
    {
      type: "setClip",
      clipId: "badge",
      style: {
        fill: { from: "#ff0000", to: "#0000ff", angle: 90 },
        borderRadius: 24,
        width: 400,
        height: 120,
        blur: 2,
      },
    },
  ]);
  expect(tag(output, "headline")).toContain(
    `style="position: absolute; top: 80px; font-family: &quot;Display&quot;, sans-serif; font-size: 120px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; color: #ffcc00; text-align: center; text-transform: uppercase; filter: drop-shadow(0px 4px 12px #000000b3)"`,
  );
  expect(tag(output, "badge")).toContain(
    `style="background: linear-gradient(90deg, #ff0000, #0000ff); border-radius: 24px; filter: blur(2px); width: 400px; height: 120px"`,
  );
  expect(clip(output, "badge").style).toEqual({
    fill: { from: "#ff0000", to: "#0000ff", angle: 90 },
    borderRadius: 24,
    blur: 2,
    width: 400,
    height: 120,
  });
  // Text outside the clip's own element is untouched.
  expect(output.replace(/ style="[^"]*"/g, "")).toBe(
    html.replace(/ style="[^"]*"/g, ""),
  );

  const cleared = edit(output, [
    {
      type: "setClip",
      clipId: "headline",
      style: { fontSize: null, shadow: null, color: null },
    },
  ]);
  expect(clip(cleared, "headline").style).toEqual({
    fontFamily: "Display",
    fontWeight: 800,
    letterSpacing: -0.02,
    lineHeight: 1.1,
    textAlign: "center",
    textTransform: "uppercase",
  });
  expect(tag(cleared, "headline")).not.toMatch(/font-size|filter|color:/);
});

test("refuses values that could carry markup, a url or an expression", () => {
  for (const style of [
    { color: "red; background: url(https://example.com/x.png)" },
    { color: '#fff" onload="alert(1)' },
    { fontFamily: 'Inter", sans-serif; background: url(x)' },
    { fontFamily: "Inter</style><script>alert(1)</script>" },
    { fill: "url(javascript:alert(1))" },
    { fill: "expression(alert(1))" },
    { fill: { from: "#000000", to: "var(--x)", angle: 0 } },
    { fontSize: "12px; position: fixed" },
    { textAlign: "center; color: red" },
    { shadow: { x: 0, y: 0, blur: 4, color: "#000;x:y" } },
    { width: Number.POSITIVE_INFINITY },
    { fontWeight: 450 },
  ])
    expect(() =>
      CommandSchema.parse({ type: "setClip", clipId: "headline", style }),
    ).toThrow();
});

test("keeps an authored inline value Cutroom cannot read until that field is set", () => {
  const html = page(
    `<h1 id="headline" class="clip" style="color: var(--accent); font-size: 4rem" data-start="0" data-duration="5" data-track-index="1">Hi</h1>`,
  );
  expect(clip(html, "headline").style).toEqual({});
  const weighted = edit(html, [
    { type: "setClip", clipId: "headline", style: { fontWeight: 700 } },
  ]);
  expect(tag(weighted, "headline")).toContain(
    `style="color: var(--accent); font-size: 4rem; font-weight: 700"`,
  );
  const sized = edit(weighted, [
    { type: "setClip", clipId: "headline", style: { fontSize: 72 } },
  ]);
  expect(tag(sized, "headline")).toContain(
    `style="color: var(--accent); font-weight: 700; font-size: 72px"`,
  );
});

test("refuses style a clip cannot take", () => {
  const html = page(
    `${headline}\n${shot}\n<audio id="music" src="music.mp3" data-start="0" data-duration="5" data-track-index="3"></audio>\n<div id="lower" class="clip" data-cutroom-title="1" data-start="0" data-duration="5" data-track-index="4">Name</div>`,
  );
  const refusal = (command: CommandInput) => {
    try {
      edit(html, [command]);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return null;
  };
  expect(
    refusal({ type: "setClip", clipId: "shot", style: { fontSize: 40 } }),
  ).toContain("no words to style");
  expect(
    refusal({
      type: "setClip",
      clipId: "headline",
      style: { objectFit: "cover" },
    }),
  ).toContain("not a video or image");
  expect(
    refusal({ type: "setClip", clipId: "music", style: { blur: 2 } }),
  ).toContain("Audio clips have no style.");
  expect(
    refusal({ type: "setClip", clipId: "lower", style: { blur: 2 } }),
  ).toContain("is a Cutroom title. Change its look with setClip.title.");
});

test("a video's fit keeps the direct export; other looks send it to the browser", () => {
  const html = page(shot).replace(/<style>[^<]*<\/style>/, "");
  const fps = { num: 30, den: 1 };
  const covered = edit(html, [
    { type: "setClip", clipId: "shot", style: { objectFit: "cover" } },
  ]);
  expect(tag(covered, "shot")).toContain(
    `style="position:absolute; inset:0; width:100%; height:100%; object-fit: cover"`,
  );
  expect(planDirectExport(covered, fps, null)).toMatchObject({
    segments: [{ kind: "source", src: "shot.mp4" }],
  });
  const rounded = edit(covered, [
    { type: "setClip", clipId: "shot", style: { borderRadius: 40 } },
  ]);
  expect(planDirectExport(rounded, fps, null)).toEqual({
    reason: "shot is not placed in a box filling the frame",
  });
});

test("history names each style change in the inspector's words", () => {
  const { timeline } = parse(page(`${headline}\n${shape}`));
  const label = (style: Record<string, unknown>) =>
    editLabel(
      [CommandSchema.parse({ type: "setClip", clipId: "headline", style })],
      timeline,
      "Edit",
    );
  expect(label({ fontSize: 140, color: "#FFCC00", letterSpacing: 0.08 })).toBe(
    "Set font size to 140px; Set tracking to 0.08em; Set text colour to #ffcc00",
  );
  expect(label({ shadow: null })).toBe("Reset shadow");
  expect(
    label({ fill: null, borderRadius: null, blur: null, width: null }),
  ).toBe("Reset style");
});
