import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sourceTimeAt } from "@hyperframes/core/speed-ramp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { ProjectSchema } from "../src/shared/project";
import { parseComposition } from "../src/server/timeline/composition";
import { planFormat } from "../src/server/timeline/format";
import {
  matchProjectRate,
  ProjectFormatSchema,
} from "../src/shared/projectFormat";
import { resolveClip } from "../src/shared/timeline/clipTiming";
import {
  frames,
  secondsOf,
  sourceAt,
  sourceSampleOffset,
} from "../src/shared/timeline/piece";
import type { Fps } from "../src/shared/timeline/schema";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { projectFixture } from "./project-fixture";

test("MCP creates exact rates and shares the format preview, write, and undo history", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "project-format-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const result = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      return z.object({ result: z.unknown() }).parse(response.structuredContent)
        .result;
    };
    const fps = { num: 30000, den: 1001 };
    const project = ProjectSchema.parse(
      await result("project_create", { name: "Exact project", fps }),
    );
    const index = join(project.path, "index.html");
    const endpoint = `/projects/${project.id}`;
    const read = async () =>
      TimelineViewSchema.parse(
        await (await fixture.request(`${endpoint}/timeline`)).json(),
      );
    expect(await readFile(index, "utf8")).toContain('data-fps="30000/1001"');
    expect((await read()).timeline.fps).toEqual(fps);
    expect(
      (
        await fixture.request("/projects", "POST", {
          name: "Decimal",
          fps: 29.97,
        })
      ).status,
    ).toBe(400);

    // The first clip starts off the old grid. Its follower shares its exact end.
    const html =
      '<main data-composition-id="main" data-fps="30000/1001" data-width="1920" data-height="1080" data-duration="2"><div id="one" data-start="0.018" data-duration="0.069"></div><div id="two" data-start="one" data-end="0.25"></div></main>';
    await writeFile(index, html);
    const before = await read();
    expect(before.timeline.clips[0]?.start).toBe(1);
    const format = { width: 1080, height: 1920, fps: { num: 24, den: 1 } };
    const args = { projectId: project.id, expectedRevision: before.revision };
    const preview = await result("timeline_format_preview", {
      ...args,
      format,
    });
    expect(preview).toMatchObject({ movedEdges: 3, maxShiftMs: 18 });
    expect(await readFile(index, "utf8")).toBe(html);
    const command = { type: "setFormat", ...format };
    const applied = await fixture.request(`${endpoint}/commands`, "POST", {
      expectedRevision: before.revision,
      commands: [command],
    });
    const data = await applied.json();
    expect(applied.status, JSON.stringify(data)).toBe(200);
    const after = TimelineViewSchema.parse(data);
    expect(after.size).toEqual({ width: 1080, height: 1920 });
    expect(after.timeline.fps).toEqual(format.fps);
    expect(
      after.timeline.clips.map(({ start, duration }) => [start, duration]),
    ).toEqual([
      [0, 2],
      [2, 4],
    ]);
    const written = await readFile(index, "utf8");
    expect(written).toContain('data-start="one"');

    expect(
      (await fixture.request(`${endpoint}/history/undo`, "POST")).status,
    ).toBe(200);
    expect(await readFile(index, "utf8")).toBe(html);
    expect((await read()).timeline).toEqual(before.timeline);
    expect(
      (await fixture.request(`${endpoint}/history/redo`, "POST")).status,
    ).toBe(200);
    expect(await readFile(index, "utf8")).toBe(written);
    expect((await read()).timeline).toEqual(after.timeline);
    await fixture.request(`${endpoint}/history/undo`, "POST");
    const mixed = await result("timeline_edit", {
      ...args,
      expectedRevision: (await read()).revision,
      commands: [command],
      replyFormat: "compact",
    });
    expect(TimelineViewSchema.parse(mixed).timeline).toEqual(after.timeline);
    expect(mixed).toMatchObject({
      size: after.size,
      changes: { fps: format.fps },
    });
    expect((await fixture.store.history(project)).list().at(-1)?.label).toBe(
      "Changed project format to 1080 × 1920, 24 fps",
    );
    expect(await readFile(index, "utf8")).toBe(written);
  } finally {
    await client.close();
    await server.stop(true);
    await fixture.close();
  }
});

test("format preview and commit refuse a clip that would collapse, without touching disk", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  try {
    const project = await fixture.store.create({ name: "One frame" });
    const index = join(project.path, "index.html");
    const html =
      '<main data-composition-id="main" data-fps="60"><div id="flash" data-start="0" data-duration="0.016667"></div></main>';
    await writeFile(index, html);
    const path = `/projects/${project.id}`;
    const view = TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
    const format = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
    const expectedRevision = view.revision;
    for (const [route, body] of [
      ["format-preview", { expectedRevision, format }],
      [
        "commands",
        { expectedRevision, commands: [{ type: "setFormat", ...format }] },
      ],
    ] as const) {
      const response = await fixture.request(`${path}/${route}`, "POST", body);
      expect(response.status).toBe(422);
      expect(await response.text()).toContain("shorter than one frame");
    }
    expect(await readFile(index, "utf8")).toBe(html);
    const history = await fixture.store.history(project);
    expect(history.list()).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("a rate change keeps cut, transition, marker and range times together", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  try {
    const project = await fixture.store.create({
      name: "Dissolve at two seconds",
    });
    const index = join(project.path, "index.html");
    await writeFile(
      index,
      '<main data-composition-id="main" data-fps="30"><img id="left" src="left.png" data-start="0" data-duration="2"><img id="right" src="right.png" data-start="2" data-duration="2"></main>',
    );
    const path = `/projects/${project.id}`;
    const view = TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
    const prepared = await fixture.request(`${path}/commands`, "POST", {
      expectedRevision: view.revision,
      commands: [
        {
          type: "setTransition",
          from: "left",
          to: "right",
          transition: { duration: 12 },
        },
        { type: "setMarker", id: "pace", frame: 31, duration: 6 },
        { type: "setRange", in: 30, out: 91 },
      ],
    });
    const before = await prepared.json();
    expect(prepared.status, JSON.stringify(before)).toBe(200);
    const format = await fixture.request(`${path}/commands`, "POST", {
      expectedRevision: TimelineViewSchema.parse(before).revision,
      commands: [
        {
          type: "setFormat",
          fps: { num: 60, den: 1 },
          width: 1920,
          height: 1080,
        },
      ],
    });
    const after = await format.json();
    expect(format.status, JSON.stringify(after)).toBe(200);
    const { timeline } = TimelineViewSchema.parse(after);
    expect(
      timeline.clips.map(({ start, duration }) => [start, duration]),
    ).toEqual([
      [0, 120],
      [120, 120],
    ]);
    expect(timeline.clips[0]?.transitionOut).toMatchObject({
      duration: 24,
      alignment: "center",
    });
    expect(timeline.clips[1]?.transitionIn).toEqual(
      timeline.clips[0]?.transitionOut,
    );
    expect(timeline.markers[0]).toMatchObject({ frame: 62, duration: 12 });
    expect(timeline.range).toEqual({ in: 60, out: 182 });
  } finally {
    await fixture.close();
  }
});

const size = { width: 1920, height: 1080 };
const rate = (num: number, den = 1): Fps => ({ num, den });

test.each([
  [rate(60), rate(24)],
  [rate(24), rate(30)],
  [rate(25), rate(30)],
  [rate(30), rate(60000, 1001)],
  [rate(30000, 1001), rate(60000, 1001)],
])(
  "regridding from %j to %j keeps each linked piece on its original source map",
  async (from, to) => {
    const fixture = await projectFixture();
    fixture.app.route(
      "/api/cutroom",
      createTimelineRoutes(fixture.store, fixture.review),
    );
    try {
      const project = await fixture.store.create({ name: "Two linked J cuts" });
      const index = join(project.path, "index.html");
      const videoFrame = Math.round(from.num / from.den) + 1;
      const audioFrame = videoFrame - 4;
      const piece = (tag: "video" | "audio", ramp: boolean) => {
        const time =
          ((tag === "video" ? videoFrame : audioFrame) * from.den) / from.num;
        // Both pieces share one curve with zero at timeline 0.
        const lane = {
          target: "rate",
          points: [
            { t: 0, v: 0.5 },
            { t: 4, v: 2 },
          ],
        };
        const source = ramp ? 0.5 + sourceTimeAt(lane, time) : time + 0.006345;
        const automation = ramp
          ? JSON.stringify({
              version: 1,
              lanes: [{ ...lane, offset: Number(time.toFixed(6)) }],
            })
          : "";
        const link = ramp ? "ramped" : "plain";
        return `<${tag} id="${link}-${tag}" src="take.mp4" data-link="${link}" data-track-index="${(ramp ? 2 : 0) + (tag === "audio" ? 1 : 0)}" data-start="${time.toFixed(6)}" data-duration="2" data-media-start="${source.toFixed(6)}" ${tag === "video" ? "muted" : ""} ${ramp ? `data-automation='${automation}'` : ""}></${tag}>`;
      };
      const html = `<main data-composition-id="main" data-fps="${from.num}/${from.den}">${piece("video", false)}${piece("audio", false)}${piece("video", true)}${piece("audio", true)}</main>
`;
      await writeFile(index, html);
      const path = `/projects/${project.id}`;
      const read = async () =>
        TimelineViewSchema.parse(
          await (await fixture.request(`${path}/timeline`)).json(),
        );
      const before = await read();
      const edit = await fixture.request(`${path}/commands`, "POST", {
        expectedRevision: before.revision,
        commands: [{ type: "setFormat", fps: to, ...size }],
      });
      const body = await edit.json();
      expect(edit.status, JSON.stringify(body)).toBe(200);
      const after = TimelineViewSchema.parse(body);
      for (const link of ["plain", "ramped"]) {
        const video = after.timeline.clips.find(
          ({ id }) => id === `${link}-video`,
        )!;
        const audio = after.timeline.clips.find(
          ({ id }) => id === `${link}-audio`,
        )!;
        expect(audio.start).toBeLessThan(video.start);
        for (const clip of [video, audio]) {
          const oldClip = before.timeline.clips.find(
            ({ id }) => id === clip.id,
          )!;
          expect(clip.start).toBe(
            Math.round(
              (oldClip.start * from.den * to.num) / (from.num * to.den),
            ),
          );
          const oldPiece = resolveClip(oldClip, from);
          const newPiece = resolveClip(clip, to);
          if (link === "plain") {
            expect(sourceSampleOffset(newPiece)).toBe(
              sourceSampleOffset(oldPiece),
            );
          }
          for (let frame = video.start; frame < video.start + 12; frame++) {
            const position = frames(frame, to);
            const oldValue = sourceAt(oldPiece, position);
            const newValue = sourceAt(newPiece, position);
            if (typeof oldValue === "number" && typeof newValue === "number") {
              expect(Math.abs(newValue - oldValue)).toBeLessThan(1e-6);
            } else if (
              typeof oldValue !== "number" &&
              typeof newValue !== "number"
            ) {
              expect(
                Math.abs(secondsOf(newValue) - secondsOf(oldValue)),
              ).toBeLessThan(2e-6);
            } else throw new Error("The clip changed source map type.");
          }
        }
        const videoPiece = resolveClip(video, to);
        const audioPiece = resolveClip(audio, to);
        expect(sourceAt(audioPiece, frames(video.start, to))).toEqual(
          sourceAt(videoPiece, frames(video.start, to)),
        );
      }
      expect(
        (await fixture.request(`${path}/history/undo`, "POST")).status,
      ).toBe(200);
      expect(await readFile(index, "utf8")).toBe(html);
      expect((await read()).timeline).toEqual(before.timeline);
    } finally {
      await fixture.close();
    }
  },
);

test("regridding keeps the original sample at a half-sample tie", () => {
  const from = rate(24);
  const to = rate(30);
  const lengths = new Map<string, number>();
  const settings = {
    tracks: [],
    markers: [],
    soloAudioGroups: [],
    range: { in: null, out: null },
  };
  const parsed = parseComposition(
    '<main data-composition-id="main" data-fps="24"><audio id="take" src="take.wav" data-start="0.083333" data-duration="1" data-media-start="0.041469"></audio></main>',
    settings,
  );
  const regridded = planFormat(parsed, settings, lengths, { ...size, fps: to });
  expect(sourceSampleOffset(resolveClip(parsed.timeline.clips[0]!, from))).toBe(
    -2010n,
  );
  expect(
    sourceSampleOffset(resolveClip(regridded.timeline.clips[0]!, to)),
  ).toBe(-2010n);
});

test.each([
  [62 / 60, 62 / 60],
  [63 / 60, 1.04],
])(
  "the end snaps inward from %f seconds with %f seconds of media",
  (end, length) => {
    const lengths = new Map([["take.mp4", length]]);
    const html = `<main data-composition-id="main" data-fps="60"><video id="take" src="take.mp4" data-start="0" data-duration="${end.toFixed(6)}"></video></main>`;
    const settings = {
      tracks: [],
      markers: [],
      soloAudioGroups: [],
      range: { in: null, out: null },
    };
    const parsed = parseComposition(html, settings, { mediaLengths: lengths });
    const { timeline, preview } = planFormat(parsed, settings, lengths, {
      ...size,
      fps: rate(24),
    });
    expect(timeline.clips[0]).toMatchObject({
      start: 0,
      duration: 24,
      mediaStart: 0,
    });
    expect(preview.maxShiftMs).toBeCloseTo((end - 1) * 1000);
  },
);

test("preview measures timing controls and keeps a one-frame fade", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  try {
    const project = await fixture.store.create({ name: "Fast fade" });
    await writeFile(
      join(project.path, "index.html"),
      '<main data-composition-id="main" data-fps="60"><audio id="tone" src="tone.wav" data-start="0" data-duration="2"></audio><div id="card" data-timeline-label="End card" data-start="0" data-duration="2"></div></main>',
    );
    const path = `/projects/${project.id}`;
    const read = async () =>
      TimelineViewSchema.parse(
        await (await fixture.request(`${path}/timeline`)).json(),
      );
    const edit = async (commands: unknown[]) =>
      fixture.request(`${path}/commands`, "POST", {
        expectedRevision: (await read()).revision,
        commands,
      });
    const format = { ...size, fps: rate(24) };
    const preview = async () =>
      fixture.request(`${path}/format-preview`, "POST", {
        expectedRevision: (await read()).revision,
        format,
      });
    const settings = await edit([
      { type: "setMarker", id: "beat", frame: 1, duration: 0 },
      { type: "setRange", in: 0, out: 60 },
    ]);
    expect(settings.status, await settings.text()).toBe(200);
    const marker = await (await preview()).json();
    expect(marker).toMatchObject({ movedEdges: 0 });
    expect(marker.maxShiftMs).toBeCloseTo(1000 / 60);
    const fade = await edit([{ type: "setClip", clipId: "tone", fadeIn: 1 }]);
    expect(fade.status, await fade.text()).toBe(200);
    const fading = await (await preview()).json();
    expect(fading).toMatchObject({ movedEdges: 0 });
    expect(fading.maxShiftMs).toBeCloseTo(25);
    const applied = await edit([{ type: "setFormat", ...format }]);
    const body = await applied.json();
    expect(applied.status, JSON.stringify(body)).toBe(200);
    expect(
      TimelineViewSchema.parse(body).timeline.clips.find(
        ({ id }) => id === "tone",
      )?.fadeIn,
    ).toBe(1);

    expect((await fixture.request(`${path}/history/undo`, "POST")).status).toBe(
      200,
    );
    const keyed = await edit([
      {
        type: "setClip",
        clipId: "card",
        keyframes: {
          opacity: [0, 1].map((frame) => ({
            frame,
            value: frame,
            ease: "linear",
          })),
        },
      },
    ]);
    expect(keyed.status, await keyed.text()).toBe(200);
    const refused = await preview();
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain(
      "End card has opacity keyframes at clip frames 0 and 1",
    );
  } finally {
    await fixture.close();
  }
});

test("project formats require exportable dimensions and supported exact rates", () => {
  const valid = (width: number, height: number, fps: Fps) =>
    ProjectFormatSchema.safeParse({ width, height, fps }).success;
  expect(valid(7680, 4320, rate(96000, 1001))).toBe(true);
  expect(valid(4320, 7680, rate(120))).toBe(true);
  expect(valid(1921, 1080, rate(60))).toBe(false);
  expect(valid(7680, 4322, rate(60))).toBe(false);
  expect(valid(1920, 1080, rate(7, 3))).toBe(false);
  expect(valid(1920, 1080, rate(9007199254740991, 9007199254740990))).toBe(
    false,
  );
  expect(matchProjectRate(59.84)).toEqual(rate(60000, 1001));
  expect(matchProjectRate(59.62)).toBeUndefined();
});

test("a frame rate change keeps every take's In with the clip's edge", () => {
  const settings = {
    tracks: [],
    markers: [],
    soloAudioGroups: [],
    range: { in: null, out: null },
  };
  // Audio takes have no picture rate, so their In counts frames of the project.
  const versions = JSON.stringify([
    { name: "Take 1", src: "a.wav", sourceIn: 24 },
    { name: "Take 2", src: "b.wav", sourceIn: 48 },
  ]);
  const parsed = parseComposition(
    `<main data-composition-id="main" data-fps="24"><audio id="vo" src="a.wav" data-start="0.541667" data-duration="1" data-media-start="1" data-cutroom-versions='${versions}' data-cutroom-version-index="0"></audio></main>`,
    settings,
  );
  const { timeline } = planFormat(parsed, settings, new Map(), {
    ...size,
    fps: rate(30),
  });
  const [clip] = timeline.clips;
  // 13 frames at 24 fps lands on frame 16 at 30 fps, 1/120 s earlier in every take.
  expect(clip).toMatchObject({ start: 16, mediaStart: 0.991667 });
  // In points are stored to the microsecond, so a take's frame count is exact to 1e-4.
  const [first, second] = clip!.versions!;
  expect(first!.sourceIn).toBeCloseTo(29.75, 4);
  expect(second!.sourceIn).toBeCloseTo(59.75, 4);
});
