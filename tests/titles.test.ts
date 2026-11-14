import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { applyAll, canonicalTimeline } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import { editLabel } from "../src/shared/timeline/labels";
import {
  CommandSchema,
  emptyTimelineSettings,
  TimelineViewSchema,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  parseComposition,
  patchComposition,
  settingsOf,
  timelineContent,
} from "../src/server/timeline/composition";
import type { CompositionScope } from "../src/server/timeline/composition";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { titleStyle } from "../src/server/timeline/titles";

const TITLE_STYLE = titleStyle([]);
import { countingIds } from "./clip-ids";
import { projectFixture } from "./project-fixture";

const shot = `<video id="shot" src="shot.mp4" muted data-start="0" data-duration="10" data-track-index="0"></video>`;
const page = (body: string, fps: number | string = 30) =>
  `<!doctype html>\n<html><head><style>.clip{position:absolute}</style></head>\n<body><main id="main" data-composition-id="main" data-duration="10" data-fps="${fps}">\n${body}\n</main></body></html>\n`;

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
  // What was written reads back as exactly the timeline the engine produced.
  expect(
    timelineContent(
      parseComposition(output, settingsOf(timeline), { scope }).timeline,
    ),
  ).toEqual(timelineContent(timeline));
  return output;
};
const clips = (html: string, scope: CompositionScope = "document") =>
  parseComposition(html, emptyTimelineSettings(), { scope }).timeline.clips;
const titleTag = (html: string, id: string) =>
  new RegExp(`<div id="${id}"[^>]*>.*?</div>`).exec(html)![0];
const withoutStacking = (html: string) =>
  html.replace(
    /<style data-cutroom-track-stacking[^>]*>[\s\S]*?<\/style>\n?/g,
    "",
  );

const lowerThird: CommandInput = {
  type: "insert",
  track: 1,
  at: 30,
  clip: {
    kind: "title",
    id: "lower",
    text: "Ada Lovelace\nFounder",
    duration: 120,
    title: { plate: "#000000B3", in: { preset: "slide" } },
  },
};
const lowerTag = `<div id="lower" class="clip" data-start="1" data-duration="4" data-track-index="1" data-cutroom-title="1" data-title-position="lower-left" data-title-size="64px" data-title-weight="600" data-title-color="#ffffff" data-title-align="left" data-title-plate="#000000b3" data-title-in="slide" data-title-in-duration="0.4" data-title-out="fade" data-title-out-duration="0.3">Ada Lovelace<br>Founder</div>`;

test("a new title is one element and one stylesheet, and later edits change only the attributes they name", () => {
  const inserted = edit(page(shot), [lowerThird]);
  expect(withoutStacking(inserted)).toBe(
    page(`${shot}\n${lowerTag}`).replace("<head>", `<head>${TITLE_STYLE}\n`),
  );
  expect(clips(inserted).find((clip) => clip.id === "lower")).toMatchObject({
    kind: "element",
    text: "Ada Lovelace\nFounder",
    title: {
      position: "lower-left",
      font: null,
      size: 64,
      plate: "#000000b3",
      in: { preset: "slide", frames: 12 },
      out: { preset: "fade", frames: 9 },
    },
  });

  const second = edit(inserted, [
    {
      type: "insert",
      track: 2,
      at: 0,
      clip: { kind: "title", id: "top", text: "Chapter one", duration: 60 },
    },
  ]);
  expect(second.split("data-cutroom-titles").length).toBe(2);

  const resized = edit(second, [
    {
      type: "setClip",
      clipId: "lower",
      title: { size: 72, plate: null, out: { frames: 15 } },
    },
  ]);
  expect(resized).toBe(
    second.replace(
      titleTag(second, "lower"),
      lowerTag
        .replace('data-title-size="64px"', 'data-title-size="72px"')
        .replace(' data-title-plate="#000000b3"', "")
        .replace(
          'data-title-out-duration="0.3"',
          'data-title-out-duration="0.5"',
        ),
    ),
  );
});

test("timeline edits leave a title's settings alone, and a stale or missing stylesheet is rewritten", () => {
  const inserted = edit(page(shot), [lowerThird]);
  // A tail trim, a head trim and a move write timing only: CSS reads the new length itself.
  const moved = edit(inserted, [
    { type: "trim", clipId: "lower", edge: "end", to: 120 },
    { type: "trim", clipId: "lower", edge: "start", to: 60 },
    { type: "move", clipIds: ["lower"], by: 90 },
  ]);
  expect(moved).toBe(
    inserted.replace(
      'data-start="1" data-duration="4"',
      'data-start="5" data-duration="2"',
    ),
  );

  const stale = inserted.replace(
    TITLE_STYLE,
    '<style data-cutroom-titles="0">[data-cutroom-title]{color:red}</style>',
  );
  expect(edit(stale, [{ type: "move", clipIds: ["lower"], by: 30 }])).toBe(
    edit(inserted, [{ type: "move", clipIds: ["lower"], by: 30 }]),
  );
  const missing = inserted.replace(`${TITLE_STYLE}\n`, "");
  expect(
    edit(missing, [{ type: "move", clipIds: ["lower"], by: 30 }]),
  ).toContain(TITLE_STYLE);
  // A composition without titles never gets the block.
  expect(
    edit(page(shot), [{ type: "trim", clipId: "shot", edge: "end", to: 90 }]),
  ).not.toContain("data-cutroom-titles");
});

test("a razor leaves the entrance on the first piece and the exit on the second; a ripple through the middle keeps both", () => {
  const inserted = edit(page(shot), [lowerThird]);
  const cut = clips(
    edit(inserted, [
      {
        type: "split",
        at: 90,
        clipIds: ["lower"],
        ids: { lower: ["lower-b"] },
      },
    ]),
  );
  const motion = (id: string) => {
    const title = cut.find((clip) => clip.id === id)!.title!;
    return [title.in, title.out];
  };
  expect(motion("lower")).toEqual([
    { preset: "slide", frames: 12 },
    { preset: "none", frames: 9 },
  ]);
  expect(motion("lower-b")).toEqual([
    { preset: "none", frames: 12 },
    { preset: "fade", frames: 9 },
  ]);
  // Everything else about the look travels to the new piece.
  expect(cut.find((clip) => clip.id === "lower-b")).toMatchObject({
    start: 90,
    duration: 60,
    text: "Ada Lovelace\nFounder",
    title: { plate: "#000000b3", size: 64 },
  });

  const rippled = clips(
    edit(inserted, [
      { type: "split", at: 60, clipIds: ["shot"], ids: { shot: ["shot-b"] } },
      {
        type: "split",
        at: 90,
        clipIds: ["shot-b"],
        ids: { "shot-b": ["shot-c"] },
      },
      { type: "remove", clipIds: ["shot-b"], ripple: true },
    ]),
  ).filter((clip) => clip.title);
  expect(rippled).toHaveLength(1);
  expect(rippled[0]).toMatchObject({
    id: "lower",
    start: 30,
    duration: 90,
    title: { in: { preset: "slide" }, out: { preset: "fade" } },
  });
});

for (const [fps, rate] of [
  ["30000/1001", { num: 30000, den: 1001 }],
  ["24000/1001", { num: 24000, den: 1001 }],
] as const)
  test(`a title's lengths stay on whole frames at ${fps}`, () => {
    const html = edit(page(shot, fps), [
      {
        ...lowerThird,
        clip: {
          ...lowerThird.clip,
          title: { in: { frames: 7 }, out: { preset: "wipe", frames: 11 } },
        },
      } as CommandInput,
    ]);
    const title = clips(html).find((clip) => clip.id === "lower")!;
    expect(title).toMatchObject({
      start: 30,
      duration: 120,
      title: {
        in: { preset: "fade", frames: 7 },
        out: { preset: "wipe", frames: 11 },
      },
    });
    const seconds = (frames: number) =>
      String(Math.round(((frames * rate.den) / rate.num) * 1e6) / 1e6);
    expect(titleTag(html, "lower")).toContain(
      `data-title-in-duration="${seconds(7)}" data-title-out="wipe" data-title-out-duration="${seconds(11)}"`,
    );
    // The defaults are 0.4 s and 0.3 s rounded to this rate's frames.
    const defaults = clips(edit(page(shot, fps), [lowerThird])).find(
      (clip) => clip.id === "lower",
    )!.title!;
    expect([defaults.in.frames, defaults.out.frames]).toEqual([
      Math.round((0.4 * rate.num) / rate.den),
      Math.round((0.3 * rate.num) / rate.den),
    ]);
    // Trimming, cutting and moving keep them exactly.
    const edited = clips(
      edit(html, [
        { type: "trim", clipId: "lower", edge: "end", to: 101 },
        { type: "move", clipIds: ["lower"], by: 13 },
      ]),
    ).find((clip) => clip.id === "lower")!;
    expect(edited).toMatchObject({ start: 43, duration: 71 });
    expect(edited.title).toEqual(title.title);
  });

test("a scene file gets its own stylesheet inside its template", () => {
  const scene = `<template>\n<div id="root" data-composition-id="scene" data-width="1920" data-height="1080" data-duration="6" data-fps="30">\n<div id="card" class="clip" data-start="0" data-duration="6" data-track-index="0"></div>\n</div>\n</template>\n`;
  const html = edit(
    scene,
    [{ ...lowerThird, at: 0 } as CommandInput],
    "sub-composition",
  );
  expect(withoutStacking(html).startsWith(`<template>${TITLE_STYLE}\n`)).toBe(
    true,
  );
  expect(
    clips(html, "sub-composition").map((clip) => clip.title?.position),
  ).toEqual([undefined, "lower-left"]);
});

test("title values cannot carry markup or CSS into the source", () => {
  const refused = (title: unknown, text = "Words") =>
    CommandSchema.safeParse({
      type: "insert",
      track: 1,
      at: 0,
      clip: { kind: "title", text, duration: 30, title },
    }).success;
  expect(refused({})).toBe(true);
  for (const title of [
    { color: "red" },
    { color: "#fff" },
    { color: "#ffffff;background:url(https://example.com/x)" },
    { color: '#ffffff"><script>alert(1)</script>' },
    { plate: "#000000" },
    { plate: "rgba(0,0,0,.5)" },
    { font: 'Inter"; } body { display: none' },
    { font: "Inter, url(x)" },
    { font: "</style><script>alert(1)</script>" },
    { font: "" },
    { position: "lower-left; top: 0" },
    { align: "justify" },
    { weight: 650 },
    { weight: "600" },
    { size: 4 },
    { size: 64.5 },
    { size: "64px" },
    { in: { preset: "spin" } },
    { in: { frames: -1 } },
    { out: { frames: 1.5 } },
  ])
    expect([title, refused(title)]).toEqual([title, false]);
  expect(refused({}, "")).toBe(false);

  // Words are text, never markup, and attribute values are quoted and escaped.
  const html = edit(page(shot), [
    {
      type: "insert",
      track: 1,
      at: 0,
      clip: {
        kind: "title",
        id: "x",
        text: `</div><script>alert("x")</script> & <b>bold</b>`,
        label: `"><img src=x onerror=alert(1)>`,
        duration: 30,
      },
    },
  ]);
  const tag = titleTag(html, "x");
  expect(tag).toContain(
    `>&lt;/div&gt;&lt;script&gt;alert("x")&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;</div>`,
  );
  expect(tag).toContain(
    `data-timeline-label="&quot;><img src=x onerror=alert(1)>"`,
  );
  expect(html).not.toContain("<script>");
  expect(clips(html).map((clip) => clip.id)).toEqual(["shot", "x"]);
  expect(clips(html)[1]!.text).toBe(
    `</div><script>alert("x")</script> & <b>bold</b>`,
  );
});

test("a hand-edited title that no longer reads is a plain text clip with the reason", () => {
  const inserted = edit(page(shot), [lowerThird]);
  for (const [from, to, attribute, problem] of [
    [
      'data-title-size="64px"',
      'data-title-size="4em"',
      "data-title-size",
      "not a value Cutroom writes",
    ],
    [
      'data-title-color="#ffffff"',
      'data-title-color="red; background: url(x)"',
      "data-title-color",
      "not a value Cutroom writes",
    ],
    [' data-title-out="fade"', "", "data-title-out", "missing"],
    [
      'data-title-in-duration="0.4"',
      'data-title-in-duration="calc(1s)"',
      "data-title-in-duration",
      "not a value Cutroom writes",
    ],
  ] as const) {
    const html = inserted.replace(from, to);
    expect(html).not.toBe(inserted);
    const clip = clips(html).find((item) => item.id === "lower")!;
    const reason = `This title's ${attribute} is ${problem}. Edit it in the source.`;
    expect(clip.title).toBeNull();
    expect(clip.text).toBe("Ada Lovelace\nFounder");
    expect(clip.sourceRestrictions?.title).toBe(reason);
    expect(() =>
      edit(html, [{ type: "setClip", clipId: "lower", title: { size: 72 } }]),
    ).toThrow(reason);
    // Its words and timing stay editable, and nothing rewrites the attributes it cannot read.
    expect(
      edit(html, [{ type: "setClip", clipId: "lower", text: "Grace Hopper" }]),
    ).toBe(html.replace("Ada Lovelace<br>Founder", "Grace Hopper"));
  }
  expect(() =>
    edit(inserted, [{ type: "setClip", clipId: "shot", title: { size: 72 } }]),
  ).toThrow("shot is not a Cutroom title.");
});

test("approvals describe title edits in plain words", () => {
  const timeline = parseComposition(
    edit(page(shot), [lowerThird]),
    emptyTimelineSettings(),
  ).timeline;
  const label = (command: CommandInput) =>
    editLabel([CommandSchema.parse(command)], timeline, "Edit", "pending");
  expect(
    label({
      ...lowerThird,
      clip: { ...lowerThird.clip, id: "next" },
    } as CommandInput),
  ).toBe('Add title "Ada Lovelace" at 00:00:01:00');
  expect(
    label({
      type: "setClip",
      clipId: "lower",
      title: { size: 72, plate: null, in: { preset: "wipe", frames: 15 } },
    }),
  ).toBe(
    "Set title size to 72 px; Remove title plate; Set title entrance to wipe, 00:00:00:15 for a text clip",
  );
});

test("an MCP agent adds a title in one call, an undeclared font is refused, and undo restores the files", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Titles" });
  const files = () =>
    Promise.all(
      ["index.html", "cutroom.json"].map((file) =>
        readFile(join(project.path, file), "utf8"),
      ),
    );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "cutroom-title-test", version: "1.0.0" });
  const result = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  try {
    const original = await files();
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const read = async () =>
      result.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: project.id },
        }),
      ).structuredContent.result;
    const call = async (commands: CommandInput[]) =>
      client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: (await read()).revision,
          commands,
        },
      });
    const insert = (font: string): CommandInput => ({
      type: "insert",
      track: 3,
      at: 30,
      clip: {
        kind: "title",
        id: "lower",
        text: "Ada Lovelace",
        duration: 120,
        title: { font },
      },
    });

    const refused = await call([insert("Comic Sans")]);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      "Declared fonts: Instrument Sans.",
    );
    expect(await files()).toEqual(original);

    const added = result.parse(await call([insert("Instrument Sans")]))
      .structuredContent.result;
    expect(
      added.timeline.clips.find((clip) => clip.id === "lower"),
    ).toMatchObject({
      start: 30,
      duration: 120,
      text: "Ada Lovelace",
      title: { font: "Instrument Sans", in: { preset: "fade", frames: 12 } },
    });
    const [html] = await files();
    expect(html).toContain(titleStyle(["Instrument Sans"]));
    expect(html).toContain('data-title-font="Instrument Sans"');

    const history = z
      .object({ entries: z.array(z.object({ label: z.string() })) })
      .parse(
        await (await fixture.request(`/projects/${project.id}/history`)).json(),
      ).entries;
    expect(history.map((entry) => entry.label)).toEqual([
      "Added title at 00:00:01:00",
    ]);
    const undo = await fixture.request(
      `/projects/${project.id}/history/undo`,
      "POST",
    );
    expect(undo.status).toBe(200);
    expect(await files()).toEqual(original);
  } finally {
    await client.close();
    await server.stop(true);
    await fixture.close();
  }
});
