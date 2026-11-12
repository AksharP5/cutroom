import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSummarySchema } from "../src/shared/project";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  ClipboardSchema,
  TimelineViewSchema,
} from "../src/shared/timeline/schema";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { readTrackMix } from "../src/server/timeline/mix";
import { projectFixture } from "./project-fixture";

const timelineFixture = async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Timeline" });
  const files = () =>
    Promise.all(
      ["index.html", "cutroom.json"].map((file) =>
        readFile(join(project.path, file), "utf8"),
      ),
    );
  return { ...fixture, project, files };
};

test("a project summary reports the picture size and length the editor would show", async () => {
  const fixture = await timelineFixture();
  try {
    const summary = async (id: string) =>
      ProjectSummarySchema.parse(
        await (await fixture.request(`/projects/${id}/summary`)).json(),
      );
    const portrait = await fixture.store.create({
      name: "Portrait",
      width: 1080,
      height: 1920,
      duration: 20,
    });
    expect(await summary(portrait.id)).toEqual({
      width: 1080,
      height: 1920,
      duration: 20,
    });
    // No authored size or length: the size the preview renders at, and the end of the last clip.
    await writeFile(
      join(fixture.project.path, "index.html"),
      `<!doctype html><html><body><main id="main" data-composition-id="main" data-fps="30"><div id="card" class="clip" data-start="1" data-duration="2.5" data-track-index="0"></div></main></body></html>`,
    );
    expect(await summary(fixture.project.id)).toEqual({
      width: 1920,
      height: 1080,
      duration: 3.5,
    });
    await writeFile(join(fixture.project.path, "index.html"), "<p>notes</p>");
    expect(
      (await fixture.request(`/projects/${fixture.project.id}/summary`)).status,
    ).toBe(422);
  } finally {
    await fixture.close();
  }
});

test("outside HTML uses persisted mute and solo on read without a history write or undo loop", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  const endpoint = `/projects/${project.id}/timeline`;
  const read = async () =>
    TimelineViewSchema.parse(await (await fixture.request(endpoint)).json());
  try {
    const view = await read();
    const response = await fixture.request(
      `/projects/${project.id}/commands`,
      "POST",
      {
        expectedRevision: view.revision,
        commands: [
          {
            type: "setTrack",
            index: 3,
            kind: "audio",
            name: "Voice",
            solo: true,
          },
          {
            type: "setTrack",
            index: 4,
            kind: "audio",
            name: "Music",
            muted: true,
          },
        ],
      },
    );
    expect(response.status).toBe(200);
    const index = join(project.path, "index.html");
    await writeFile(
      index,
      (await readFile(index, "utf8")).replace(
        "</main>",
        `
      <audio id="music" src="music.wav" data-start="0" data-duration="2" data-track-index="4"></audio>
      <audio id="new-track" src="music.wav" data-start="0" data-duration="2" data-track-index="5"></audio>
      <video id="embedded" src="picture.mp4" data-start="0" data-duration="2" data-track-index="6"></video>
    </main>`,
      ),
    );
    const mixed = await read();
    expect(
      mixed.timeline.clips
        .filter((clip) => ["music", "new-track", "embedded"].includes(clip.id))
        .every((clip) => clip.enabled),
    ).toBe(true);
    const raw = await readFile(index, "utf8");
    const [prepared] = await readTrackMix(fixture.store, project);
    const written = prepared!.html;
    expect(written).toMatch(
      /id="music"[^>]*data-hidden="" data-cutroom-track-hidden=""/,
    );
    expect(written).toMatch(
      /id="new-track"[^>]*data-hidden="" data-cutroom-track-hidden=""/,
    );
    expect(written).toMatch(/id="embedded"[^>]*muted="" data-cutroom-muted=""/);
    expect(await read()).toEqual(mixed);
    expect(await readFile(index, "utf8")).toBe(raw);
    expect((await readTrackMix(fixture.store, project))[0]!.html).toBe(written);
    await fixture.request(`/projects/${project.id}/history/undo`, "POST", {});
    expect(
      (await read()).timeline.clips.some((clip) => clip.id === "music"),
    ).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("a command batch is atomic, one undo step, and refuses stale revisions", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  try {
    const original = await fixture.files();
    const history = async () =>
      z
        .object({ entries: z.array(z.object({ label: z.string() })) })
        .parse(
          await (
            await fixture.request(`/projects/${project.id}/history`)
          ).json(),
        ).entries;
    const read = TimelineViewSchema.parse(
      await (await fixture.request(`/projects/${project.id}/timeline`)).json(),
    );
    expect(read.timeline.clips.map((clip) => clip.id)).toEqual([
      "rule",
      "headline",
      "caption",
    ]);
    const post = (body: unknown) =>
      fixture.request(`/projects/${project.id}/commands`, "POST", body);

    const failed = await post({
      expectedRevision: read.revision,
      commands: [
        { type: "split", at: 180 },
        { type: "remove", clipIds: ["missing"] },
      ],
    });
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({
      code: "not_found",
      command: 1,
    });
    expect(await fixture.files()).toEqual(original);
    expect(await history()).toHaveLength(0);

    const edited = await post({
      expectedRevision: read.revision,
      label: "Tighten intro",
      commands: [
        // The caller names the right halves, so it can remove them in the same batch.
        {
          type: "split",
          at: 180,
          ids: {
            rule: ["rule-b"],
            headline: ["headline-b"],
            caption: ["caption-b"],
          },
        },
        {
          type: "remove",
          clipIds: ["rule-b", "headline-b", "caption-b"],
          ripple: true,
        },
        { type: "setTrack", index: 2, locked: true },
        { type: "setMarker", frame: 90, name: "Beat", color: "green" },
      ],
    });
    expect(edited.status).toBe(200);
    const view = TimelineViewSchema.parse(await edited.json());
    expect(view.timeline.duration).toBe(180);
    expect(view.timeline.clips.map((clip) => clip.duration)).toEqual([
      180, 180, 180,
    ]);
    expect(view.timeline.markers.map((marker) => marker.name)).toEqual([
      "Beat",
    ]);
    expect(view.timeline.markers[0]?.color).toBe("green");
    expect(
      TimelineViewSchema.parse(
        await (
          await fixture.request(`/projects/${project.id}/timeline`)
        ).json(),
      ),
    ).toEqual(view);
    expect((await history()).map((entry) => entry.label)).toEqual([
      "Tighten intro",
    ]);

    const stale = await post({
      expectedRevision: read.revision,
      commands: [{ type: "setRange", in: 0 }],
    });
    expect(stale.status).toBe(409);

    const undo = await fixture.request(
      `/projects/${project.id}/history/undo`,
      "POST",
    );
    expect(undo.status).toBe(200);
    expect(await fixture.files()).toEqual(original);
  } finally {
    await fixture.close();
  }
});

test("Q through a spanning music bed persists exact NTSC HTML and undo restores it", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  const source = `<main data-composition-id="main" data-duration="10.01" data-fps="30000/1001">
  <video id="talk" src="talk.mp4" data-start="0" data-duration="3.003" data-media-start="1" data-track-index="0"></video>
  <audio id="bed" src="bed.wav" data-start="0" data-duration="6.006" data-media-start="2" data-playback-rate="2" data-track-index="1"></audio>
</main>
`;
  try {
    await writeFile(join(project.path, "index.html"), source);
    const read = async () =>
      TimelineViewSchema.parse(
        await (
          await fixture.request(`/projects/${project.id}/timeline`)
        ).json(),
      );
    const before = await read();
    const response = await fixture.request(
      `/projects/${project.id}/commands`,
      "POST",
      {
        expectedRevision: before.revision,
        label: "Ripple start to frame one",
        commands: [
          { type: "trim", clipId: "talk", edge: "start", to: 1, ripple: true },
        ],
      },
    );
    expect(response.status).toBe(200);
    const after = TimelineViewSchema.parse(await response.json());
    expect(await read()).toEqual(after);
    expect(
      after.timeline.clips.map((clip) => [
        clip.id,
        clip.start,
        clip.duration,
        clip.mediaStart,
      ]),
    ).toEqual([
      ["talk", 0, 89, 1.033367],
      ["bed", 0, 179, 2.066733],
    ]);
    expect(await readFile(join(project.path, "index.html"), "utf8"))
      .toBe(`<head><style data-cutroom-track-stacking="main">@layer cutroom-tracks{:where([data-composition-id="main"] [data-start][data-track-index="0"]:not(audio):not([data-composition-id="main"] :is([data-start],[data-composition-id],[data-composition-src]) *)){z-index:0}}</style></head>
<main data-composition-id="main" data-duration="9.976633" data-fps="30000/1001">
  <video id="talk" src="talk.mp4" data-start="0" data-duration="2.969633" data-media-start="1.033367" data-track-index="0"></video>
  <audio id="bed" src="bed.wav" data-start="0" data-duration="5.972633" data-media-start="2.066733" data-playback-rate="2" data-track-index="1"></audio>
</main>
`);
    expect(
      (await fixture.request(`/projects/${project.id}/history/undo`, "POST"))
        .status,
    ).toBe(200);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      source,
    );
    const restored = await read();
    expect(restored.timeline).toEqual(before.timeline);
    expect(restored.revision).toBe(before.revision);
    expect(restored.agentChanges).toEqual(before.agentChanges);
  } finally {
    await fixture.close();
  }
});

test("an id is spent for good: a piece named after an undone clip is refused, and redo still works", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  try {
    const edit = async (commands: unknown[]) => {
      const { revision } = TimelineViewSchema.parse(
        await (
          await fixture.request(`/projects/${project.id}/timeline`)
        ).json(),
      );
      return fixture.request(`/projects/${project.id}/commands`, "POST", {
        expectedRevision: revision,
        commands,
      });
    };
    const ids = async () =>
      TimelineViewSchema.parse(
        await (
          await fixture.request(`/projects/${project.id}/timeline`)
        ).json(),
      ).timeline.clips.map((clip) => clip.id);

    // Cut the rule and name its right half, then undo the cut.
    const named = await edit([
      { type: "split", at: 90, clipIds: ["rule"], ids: { rule: ["retired"] } },
    ]);
    expect(named.status).toBe(200);
    expect(await ids()).toContain("retired");
    await fixture.request(`/projects/${project.id}/history/undo`, "POST");
    expect(await ids()).not.toContain("retired");

    // The undone clip's id cannot name a piece of another clip.
    const reused = await edit([
      {
        type: "split",
        at: 200,
        clipIds: ["headline"],
        ids: { headline: ["retired"] },
      },
    ]);
    expect(reused.status).toBe(422);
    expect(await reused.json()).toMatchObject({
      code: "duplicate_id",
      error:
        "Command 1 (split): Id retired was used earlier in this project. Name the clip with an id never used before.",
    });
    const current = await edit([
      {
        type: "split",
        at: 200,
        clipIds: ["headline"],
        ids: { headline: ["rule"] },
      },
    ]);
    expect(await current.json()).toMatchObject({
      code: "duplicate_id",
      error: "Command 1 (split): A clip already has id rule.",
    });

    // Redo swaps the file back, so the original clip returns under its own id.
    const redo = await fixture.request(
      `/projects/${project.id}/history/redo`,
      "POST",
    );
    expect(redo.status).toBe(200);
    expect(await ids()).toContain("retired");
  } finally {
    await fixture.close();
  }
});

for (const protection of [{ locked: true }, { autoSelect: false }]) {
  test(`ripple delete can shorten an L-cut tail linked to an unchanged ${Object.keys(protection)[0]} picture`, async () => {
    const fixture = await timelineFixture();
    const { project } = fixture;
    const shot = `<video id="shot" src="shot.mp4" data-start="0" data-duration="3.333333" data-media-start="2" data-link="av" data-track-index="0"></video>`;
    try {
      await writeFile(
        join(project.path, "index.html"),
        `<main data-composition-id="main" data-duration="10" data-fps="30">
  ${shot}
  <audio id="tail" src="shot.mp4" data-start="0" data-duration="4" data-media-start="2" data-link="av" data-track-index="1"></audio>
  <video id="broll" src="broll.mp4" data-start="3.333333" data-duration="1.666667" data-track-index="2"></video>
</main>`,
      );
      const read = async () =>
        TimelineViewSchema.parse(
          await (
            await fixture.request(`/projects/${project.id}/timeline`)
          ).json(),
        );
      const initial = await read();
      const protectedTrack = await fixture.request(
        `/projects/${project.id}/commands`,
        "POST",
        {
          expectedRevision: initial.revision,
          commands: [{ type: "setTrack", index: 0, ...protection }],
        },
      );
      expect(protectedTrack.status).toBe(200);
      const before = await read();
      const originalFiles = await fixture.files();
      const response = await fixture.request(
        `/projects/${project.id}/commands`,
        "POST",
        {
          expectedRevision: before.revision,
          commands: [{ type: "remove", clipIds: ["broll"], ripple: true }],
        },
      );
      expect(response.status).toBe(200);
      const after = TimelineViewSchema.parse(await response.json());
      expect(after.timeline.clips).toEqual([
        before.timeline.clips[0],
        { ...before.timeline.clips[1], duration: 100 },
      ]);
      expect(await read()).toEqual(after);
      expect(
        await readFile(join(project.path, "index.html"), "utf8"),
      ).toContain(shot);
      expect(
        (await fixture.request(`/projects/${project.id}/history/undo`, "POST"))
          .status,
      ).toBe(200);
      expect(await fixture.files()).toEqual(originalFiles);
    } finally {
      await fixture.close();
    }
  });
}

test("an MCP agent reads and edits the timeline through the batch endpoint", async () => {
  const fixture = await timelineFixture();
  const seeks: string[] = [];
  const handler = createMcpHttpHandler({
    fetch: (url, init) => {
      // Frame capture needs Chromium; the seek it is asked for is what matters here.
      if (!url.includes("/thumbnail/")) return fixture.app.request(url, init);
      seeks.push(new URL(url).searchParams.get("t") ?? "");
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({
    name: "cutroom-timeline-test",
    version: "1.0.0",
  });
  const result = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    // The server measures inserted media, so agents are never asked for its length.
    const edit = (await client.listTools()).tools.find(
      (tool) => tool.name === "timeline_edit",
    );
    expect(JSON.stringify(edit?.inputSchema)).toContain("insert");
    expect(JSON.stringify(edit?.inputSchema)).toContain("linkedAudio");
    expect(JSON.stringify(edit?.inputSchema)).toContain("solo");
    expect(JSON.stringify(edit?.inputSchema)).not.toContain("sourceDuration");
    const read = result.parse(
      await client.callTool({
        name: "timeline_read",
        arguments: { projectId: fixture.project.id },
      }),
    ).structuredContent.result;
    const editCall = {
      name: "timeline_edit",
      arguments: {
        projectId: fixture.project.id,
        expectedRevision: read.revision,
        label: "Delay caption",
        commands: [{ type: "trim", clipId: "caption", edge: "start", to: 60 }],
      },
    };
    const edited = result.parse(await client.callTool(editCall))
      .structuredContent.result;
    expect(
      edited.timeline.clips.find((clip) => clip.id === "caption"),
    ).toMatchObject({ start: 60, duration: 300 });
    const [html] = await fixture.files();
    expect(html).toContain(
      `id="caption" class="clip caption" data-start="2" data-duration="10"`,
    );
    const stale = await client.callTool(editCall);
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain("409");
    const mixed = result.parse(
      await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: fixture.project.id,
          expectedRevision: edited.revision,
          label: "Set up the mix",
          commands: [
            {
              type: "setTrack",
              index: 3,
              kind: "audio",
              name: "Music",
              muted: true,
              solo: true,
            },
            { type: "setTrack", index: 0, enabled: false },
          ],
        },
      }),
    ).structuredContent.result;
    expect(mixed.timeline.tracks.at(-1)).toMatchObject({
      index: 3,
      kind: "audio",
      name: "Music",
      muted: true,
      solo: true,
    });
    expect(
      result.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: fixture.project.id },
        }),
      ).structuredContent.result,
    ).toEqual(mixed);
    await fixture.request(
      `/projects/${fixture.project.id}/history/undo`,
      "POST",
    );
    expect(
      result.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: fixture.project.id },
        }),
      ).structuredContent.result.timeline,
    ).toEqual(edited.timeline);
    const view = await client.callTool({
      name: "timeline_view",
      arguments: { projectId: fixture.project.id, frame: 1 },
    });
    expect(view.isError).not.toBe(true);
    expect(seeks).toEqual([String(1 / 30)]);
    const overwritten = result.parse(
      await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: fixture.project.id,
          expectedRevision: edited.revision,
          commands: [
            {
              type: "move",
              clipIds: ["caption"],
              by: -30,
              trackBy: -2,
              mode: "overwrite",
              ids: { rule: ["rule-tail"] },
            },
          ],
        },
      }),
    ).structuredContent.result;
    expect(
      overwritten.timeline.clips.map((clip) => [
        clip.id,
        clip.track,
        clip.start,
        clip.duration,
      ]),
    ).toEqual([
      ["rule", 0, 0, 30],
      ["caption", 0, 30, 300],
      ["rule-tail", 0, 330, 30],
      ["headline", 1, 0, 360],
    ]);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});

test("the entry document reads its live tree and a scene file its template", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  try {
    await writeFile(
      join(project.path, "index.html"),
      `<body><template><main data-root="true" data-composition-id="main" data-duration="4"><div id="card" class="clip" data-start="0" data-duration="1">Card</div></main></template></body>`,
    );
    const entry = await fixture.request(`/projects/${project.id}/timeline`);
    expect(entry.status).toBe(422);
    expect(await entry.json()).toMatchObject({ code: "unsupported" });
    await mkdir(join(project.path, "scenes"));
    const scene = `<template id="intro-template"><div data-composition-id="intro" data-duration="4"><div id="card" class="clip" data-start="0" data-duration="1">Card</div></div></template>`;
    await writeFile(join(project.path, "scenes", "intro.html"), scene);
    const read = TimelineViewSchema.parse(
      await (
        await fixture.request(
          `/projects/${project.id}/timeline?composition=scenes/intro.html`,
        )
      ).json(),
    );
    expect(read.timeline.clips.map((clip) => clip.id)).toEqual(["card"]);
    const moved = await fixture.request(
      `/projects/${project.id}/commands`,
      "POST",
      {
        composition: "scenes/intro.html",
        expectedRevision: read.revision,
        commands: [{ type: "move", clipIds: ["card"], by: 30 }],
      },
    );
    expect(moved.status).toBe(200);
    const written = await readFile(
      join(project.path, "scenes", "intro.html"),
      "utf8",
    );
    expect(written).toContain(
      `<template id="intro-template"><style data-cutroom-track-stacking="intro">`,
    );
    expect(
      written.replace(
        /<style data-cutroom-track-stacking[^>]*>[\s\S]*?<\/style>\n/g,
        "",
      ),
    ).toBe(
      scene
        .replace(`data-start="0"`, `data-start="1"`)
        .replace(
          `data-duration="1">Card`,
          `data-duration="1" data-track-index="0">Card`,
        )
        .replace(`data-duration="4">`, `data-duration="5">`),
    );
  } finally {
    await fixture.close();
  }
});

test("./index.html, /index.html, and index.html are one composition with one revision", async () => {
  const fixture = await timelineFixture();
  try {
    const read = async (path: string) => {
      const response = await fixture.request(
        `/projects/${fixture.project.id}/timeline?composition=${encodeURIComponent(path)}`,
      );
      return TimelineViewSchema.parse(await response.json());
    };
    const dotted = await read("./index.html");
    expect(dotted.composition).toBe("index.html");
    const edited = await fixture.request(
      `/projects/${fixture.project.id}/commands`,
      "POST",
      {
        composition: "./index.html",
        expectedRevision: dotted.revision,
        commands: [{ type: "setTrack", index: 0, name: "Rule" }],
      },
    );
    expect(edited.status).toBe(200);
    const plain = await read("index.html");
    expect(plain.revision).toBe(
      TimelineViewSchema.parse(await edited.json()).revision,
    );
    expect((await read("/index.html")).revision).toBe(plain.revision);
    expect(plain.timeline.tracks[0]?.name).toBe("Rule");
  } finally {
    await fixture.close();
  }
});

test.skipIf(!Bun.which("ffprobe"))(
  "a file ffprobe cannot read is probed once per version, not on every read",
  async () => {
    const fixture = await timelineFixture();
    const configured = process.env.HYPERFRAMES_FFPROBE_PATH;
    try {
      const { path } = fixture.project;
      const calls = join(path, "probe-calls.txt");
      const counting = join(path, "counting-ffprobe");
      await writeFile(
        counting,
        `#!/bin/sh\necho call >> "${calls}"\nexec "${Bun.which("ffprobe")}" "$@"\n`,
        { mode: 0o755 },
      );
      await writeFile(join(path, "broken.wav"), "not audio");
      await writeFile(
        join(path, "index.html"),
        `<main data-composition-id="main" data-duration="4"><audio id="bed" src="broken.wav" data-start="0" data-duration="1" data-track-index="0"></audio></main>`,
      );
      process.env.HYPERFRAMES_FFPROBE_PATH = counting;
      for (let read = 0; read < 3; read++)
        expect(
          (await fixture.request(`/projects/${fixture.project.id}/timeline`))
            .status,
        ).toBe(200);
      expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(
        1,
      );
    } finally {
      if (configured === undefined) delete process.env.HYPERFRAMES_FFPROBE_PATH;
      else process.env.HYPERFRAMES_FFPROBE_PATH = configured;
      await fixture.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "media without data-duration is measured with ffprobe",
  async () => {
    const fixture = await timelineFixture();
    try {
      const { path } = fixture.project;
      const made = Bun.spawnSync(
        [
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=8000:cl=mono",
          "-t",
          "2",
          join(path, "bed.wav"),
        ],
        { stderr: "pipe" },
      );
      expect(made.exitCode).toBe(0);
      await writeFile(
        join(path, "index.html"),
        `<main data-composition-id="main" data-duration="4"><audio id="bed" src="bed.wav" data-start="1" data-track-index="0"></audio></main>`,
      );
      const read = () =>
        fixture.request(`/projects/${fixture.project.id}/timeline`);
      // Measuring while ffprobe is unavailable must not be remembered once it is back.
      const configured = process.env.HYPERFRAMES_FFPROBE_PATH;
      process.env.HYPERFRAMES_FFPROBE_PATH = join(path, "missing-ffprobe");
      try {
        const unmeasured = await read();
        expect(unmeasured.status).toBe(422);
        expect(await unmeasured.text()).toContain("could not be measured");
      } finally {
        if (configured === undefined)
          delete process.env.HYPERFRAMES_FFPROBE_PATH;
        else process.env.HYPERFRAMES_FFPROBE_PATH = configured;
      }
      const { timeline } = TimelineViewSchema.parse(
        await (await read()).json(),
      );
      expect(timeline.clips[0]).toMatchObject({
        id: "bed",
        start: 30,
        duration: 60,
        sourceDuration: 2,
      });
    } finally {
      await fixture.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "timeline reads refuse HLS playlists that reference outside files or network media",
  async () => {
    const fixture = await timelineFixture();
    let networkReads = 0;
    const outside = join(fixture.directory, "outside.ts");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        networkReads++;
        return new Response(Bun.file(outside));
      },
    });
    try {
      const made = Bun.spawnSync(
        [
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=44100",
          "-t",
          "1",
          "-c:a",
          "aac",
          "-f",
          "mpegts",
          outside,
        ],
        { stderr: "pipe" },
      );
      expect(made.exitCode).toBe(0);
      for (const [name, segment] of [
        ["escape.m3u8", outside],
        ["disguised.mp4", outside],
        ["network.m3u8", `http://127.0.0.1:${server.port}/outside.ts`],
      ]) {
        await writeFile(
          join(fixture.project.path, name),
          `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\n${segment}\n#EXT-X-ENDLIST\n`,
        );
        await writeFile(
          join(fixture.project.path, "index.html"),
          `<main data-composition-id="main" data-duration="4"><audio id="bed" src="${name}" data-start="0" data-track-index="0"></audio></main>`,
        );
        const response = await fixture.request(
          `/projects/${fixture.project.id}/timeline`,
        );
        expect(response.status, name).toBe(422);
        expect(await response.text()).toContain("could not be measured");
      }
      expect(networkReads).toBe(0);
    } finally {
      server.stop(true);
      await fixture.close();
    }
  },
);

test("a scene edit declares the entry layer in the same undo step", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  try {
    const entry = await readFile(join(project.path, "index.html"), "utf8");
    const scene = `<template><div data-composition-id="scene" data-duration="2"><div id="box" class="clip" data-start="0" data-duration="1" data-track-index="1">Box</div></div></template>`;
    await writeFile(join(project.path, "scene.html"), scene);
    const read = TimelineViewSchema.parse(
      await (
        await fixture.request(
          `/projects/${project.id}/timeline?composition=scene.html`,
        )
      ).json(),
    );
    const edited = await fixture.request(
      `/projects/${project.id}/commands`,
      "POST",
      {
        composition: "scene.html",
        expectedRevision: read.revision,
        commands: [{ type: "trim", clipId: "box", edge: "end", to: 60 }],
      },
    );
    expect(edited.status).toBe(200);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toContain(
      `<head><style data-cutroom-track-layer>@layer cutroom-tracks;</style>`,
    );
    expect(await readFile(join(project.path, "scene.html"), "utf8")).toContain(
      `<template><style data-cutroom-track-stacking="scene">`,
    );
    expect(
      (await fixture.request(`/projects/${project.id}/history/undo`, "POST"))
        .status,
    ).toBe(200);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      entry,
    );
    expect(await readFile(join(project.path, "scene.html"), "utf8")).toBe(
      scene,
    );
  } finally {
    await fixture.close();
  }
});

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "ordinary MCP video inserts create linked audio by default, with exact readback and one undo step",
  async () => {
    const fixture = await timelineFixture();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createMcpHttpHandler({
        fetch: (url, init) => fixture.app.request(url, init),
      }),
    });
    const client = new Client({
      name: "cutroom-insert-test",
      version: "1.0.0",
    });
    const result = z.object({
      structuredContent: z.object({ result: TimelineViewSchema }),
    });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${server.port}/mcp`),
        ),
      );
      const original = await fixture.files();
      const { path, id } = fixture.project;
      const picture = ["-f", "lavfi", "-i", "color=c=gray:s=64x36:r=10:d=1"];
      const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"];
      for (const [name, inputs] of [
        ["silent.mp4", picture],
        ["sound.mp4", [...picture, ...tone]],
      ] as const) {
        const made = Bun.spawnSync(
          ["ffmpeg", "-v", "error", ...inputs, "-shortest", join(path, name)],
          { stderr: "pipe" },
        );
        expect(made.stderr.toString()).toBe("");
      }
      const voice = Bun.spawnSync(
        ["ffmpeg", "-v", "error", ...tone, join(path, "voice.wav")],
        { stderr: "pipe" },
      );
      expect(voice.exitCode).toBe(0);
      const { revision } = result.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: id },
        }),
      ).structuredContent.result;
      const insert = (src: string, at: number) => ({
        type: "insert",
        track: 5,
        at,
        clip: { id: src.replace(".mp4", ""), kind: "video", src, duration: 10 },
      });
      const edited = result.parse(
        await client.callTool({
          name: "timeline_edit",
          arguments: {
            projectId: id,
            expectedRevision: revision,
            commands: [
              {
                type: "setTrack",
                index: 4,
                kind: "audio",
                name: "Voice",
                solo: true,
              },
              {
                type: "insert",
                track: 4,
                at: 0,
                clip: {
                  id: "voice",
                  kind: "audio",
                  src: "voice.wav",
                  duration: 30,
                },
              },
              insert("silent.mp4", 0),
              insert("sound.mp4", 10),
            ],
          },
        }),
      ).structuredContent.result;
      const { timeline } = edited;
      const sounding = (clipId: string) =>
        timeline.clips.find((clip) => clip.id === clipId)?.hasAudio;
      expect(sounding("silent")).toBe(false);
      expect(sounding("sound")).toBe(false);
      expect(
        timeline.clips.find((clip) => clip.id === "silent")?.link,
      ).toBeNull();
      const pair = timeline.clips.filter((clip) => clip.src === "sound.mp4");
      expect(pair).toHaveLength(2);
      expect(pair.map((clip) => [clip.kind, clip.hasAudio, clip.link])).toEqual(
        [
          ["video", false, "sound"],
          ["audio", true, "sound"],
        ],
      );
      expect(pair[1]).toMatchObject({
        start: 10,
        duration: 10,
        sourceDuration: 1,
      });
      expect(
        result.parse(
          await client.callTool({
            name: "timeline_read",
            arguments: { projectId: id },
          }),
        ).structuredContent.result,
      ).toEqual(edited);
      const [html] = await fixture.files();
      expect(html).toMatch(/<video id="silent"[^>]*data-has-audio="false"/);
      expect(html).toMatch(/<video id="sound"[^>]*muted/);
      expect(pair[1]?.track).not.toBe(4);
      expect(html).toMatch(/<audio[^>]*src="sound.mp4"[^>]*data-hidden/);
      await fixture.request(`/projects/${id}/history/undo`, "POST");
      expect(await fixture.files()).toEqual(original);
    } finally {
      await client.close();
      server.stop(true);
      await fixture.close();
    }
  },
);

test("MCP gain, authored fades and cleared automation read back exactly and undo in one step", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  await writeFile(
    join(project.path, "index.html"),
    `<main data-composition-id="main" data-duration="10" data-fps="30"><audio id="music" src="music.wav" data-start="0" data-duration="10" data-automation='{"version":1,"lanes":[{"target":"volume","points":[{"t":0,"v":1},{"t":10,"v":0}]}]}'></audio></main>`,
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "mix-test", version: "1" });
  const result = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  try {
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
    const initial = await read();
    const originalFiles = await fixture.files();
    expect(initial.timeline.clips[0]?.automation).toBeString();
    const gain = 10 ** (-12 / 20);
    const changed = result.parse(
      await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: initial.revision,
          commands: [
            {
              type: "setClip",
              clipId: "music",
              volume: gain,
              automation: null,
              fadeIn: 1,
              fadeOut: 120,
            },
            { type: "trim", clipId: "music", edge: "end", to: 60 },
          ],
        },
      }),
    ).structuredContent.result;
    expect(changed.timeline.clips[0]).toMatchObject({
      volume: gain,
      automation: null,
      duration: 60,
      fadeIn: 1,
      fadeOut: 120,
    });
    expect(await read()).toEqual(changed);
    await fixture.request(`/projects/${project.id}/history/undo`, "POST");
    expect((await read()).timeline).toEqual(initial.timeline);
    expect(await fixture.files()).toEqual(originalFiles);
    await fixture.request(`/projects/${project.id}/history/redo`, "POST");
    expect((await read()).timeline).toEqual(changed.timeline);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "MCP keeps place as the default and routes explicit V2 overwrite to A2, preserving V1/A1",
  async () => {
    const fixture = await timelineFixture();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createMcpHttpHandler({
        fetch: (url, init) => fixture.app.request(url, init),
      }),
    });
    const client = new Client({ name: "two-pair-overwrite", version: "1.0.0" });
    const result = z.object({
      structuredContent: z.object({ result: TimelineViewSchema }),
    });
    const { id, path } = fixture.project;
    const read = async () =>
      result.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: id },
        }),
      ).structuredContent.result;
    try {
      const media = Bun.spawnSync(
        [
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=64x36:r=30:d=1",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-shortest",
          join(path, "sound.mp4"),
        ],
        { stderr: "pipe" },
      );
      expect(media.exitCode).toBe(0);
      const index = join(path, "index.html");
      await writeFile(
        index,
        (await readFile(index, "utf8")).replace(
          /<main[^>]*>[\s\S]*<\/main>/,
          `<main id="main" data-composition-id="main" data-fps="30" data-duration="1">
<video id="background" src="sound.mp4" data-start="0" data-duration="1" data-track-index="0" data-link="background" muted></video>
<video id="interview" src="sound.mp4" data-start="0" data-duration="1" data-track-index="1" data-link="interview" muted></video>
<audio id="background-sound" src="sound.mp4" data-start="0" data-duration="1" data-track-index="2" data-link="background"></audio>
<audio id="dialogue" src="sound.mp4" data-start="0" data-duration="1" data-track-index="3" data-link="interview"></audio></main>`,
        ),
      );
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${server.port}/mcp`),
        ),
      );
      const before = await fixture.files();
      const initial = await read();
      const insert = {
        type: "insert",
        track: 1,
        at: 10,
        clip: { id: "b-roll", kind: "video", src: "sound.mp4", duration: 10 },
        linkedAudio: { id: "b-roll-sound" },
      };
      const refused = await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: id,
          expectedRevision: initial.revision,
          commands: [insert],
        },
      });
      expect(refused.isError).toBe(true);
      expect(await read()).toEqual(initial);
      expect(await fixture.files()).toEqual(before);
      const edited = result.parse(
        await client.callTool({
          name: "timeline_edit",
          arguments: {
            projectId: id,
            expectedRevision: initial.revision,
            commands: [{ ...insert, mode: "overwrite" }],
          },
        }),
      ).structuredContent.result;
      expect(edited.timeline.tracks).toEqual(initial.timeline.tracks);
      expect(
        edited.timeline.clips.filter((c) => c.track === 0 || c.track === 2),
      ).toEqual(
        initial.timeline.clips.filter((c) => c.track === 0 || c.track === 2),
      );
      expect(
        edited.timeline.clips
          .filter((c) => [1, 3].includes(c.track))
          .map((c) => [c.track, c.start, c.duration]),
      ).toEqual([
        [1, 0, 10],
        [1, 10, 10],
        [1, 20, 10],
        [3, 0, 10],
        [3, 10, 10],
        [3, 20, 10],
      ]);
      expect(
        edited.timeline.clips.find((c) => c.id === "b-roll-sound"),
      ).toMatchObject({ track: 3, link: "b-roll" });
      expect(await read()).toEqual(edited);
      await fixture.request(`/projects/${id}/history/undo`, "POST");
      expect(await fixture.files()).toEqual(before);
    } finally {
      await client.close();
      server.stop(true);
      await fixture.close();
    }
  },
);

test("MCP reports clips left whole by auto-select razor and refuses an explicit razor", async () => {
  const fixture = await timelineFixture();
  const handler = createMcpHttpHandler({
    fetch: (url, init) => fixture.app.request(url, init),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({ name: "partial-auto-select", version: "1.0.0" });
  const result = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  const title = `<div id="lower" class="clip" data-label="Lower third" data-start="0" data-duration="10" data-track-index="1">Lower third</div>`;
  const html = `<main data-composition-id="main" data-duration="10" data-fps="30"><video id="shot" src="shot.mp4" muted data-start="2" data-duration="2" data-track-index="0"></video>${title}<script>gsap.to("#lower", {opacity:1});</script></main>`;
  const index = join(fixture.project.path, "index.html");
  try {
    await writeFile(index, html);
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const read = async () =>
      result.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: fixture.project.id },
        }),
      ).structuredContent.result;
    for (const command of [{ type: "split", at: 90 }]) {
      const before = await read();
      const edited = result.parse(
        await client.callTool({
          name: "timeline_edit",
          arguments: {
            projectId: fixture.project.id,
            expectedRevision: before.revision,
            commands: [command],
          },
        }),
      ).structuredContent.result;
      expect(edited.skippedClips).toEqual([
        {
          clipId: "lower",
          label: "Lower third",
          reason: expect.stringContaining("animated by its id"),
        },
      ]);
      expect(edited.timeline).not.toEqual(before.timeline);
      expect(edited.timeline.clips.find((clip) => clip.id === "lower")).toEqual(
        before.timeline.clips.find((clip) => clip.id === "lower"),
      );
      expect(await readFile(index, "utf8")).toContain(title);
      await fixture.request(
        `/projects/${fixture.project.id}/history/undo`,
        "POST",
        {},
      );
      expect((await read()).timeline).toEqual(before.timeline);
      expect(await readFile(index, "utf8")).toBe(html);
    }
    const before = await read();
    const refused = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: fixture.project.id,
        expectedRevision: before.revision,
        commands: [{ type: "split", clipIds: ["lower"], at: 90 }],
      },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      "Edit it in the source instead.",
    );
    expect((await read()).timeline).toEqual(before.timeline);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});

for (const [name, command, expectedPicture] of [
  [
    "Q",
    { type: "trim", clipId: "shot", edge: "start", to: 90, ripple: true },
    [
      ["shot", 60, 30],
      ["later", 90, 360],
    ],
  ],
  [
    "W",
    { type: "trim", clipId: "shot", edge: "end", to: 90, ripple: true },
    [
      ["shot", 60, 30],
      ["later", 90, 360],
    ],
  ],
  [
    "Shift+X",
    { type: "remove", clipIds: ["shot"], ripple: true },
    [["later", 60, 360]],
  ],
  [
    "ripple extension",
    { type: "trim", clipId: "shot", edge: "start", to: 30, ripple: true },
    [
      ["shot", 60, 90],
      ["later", 150, 360],
    ],
  ],
  [
    "insert ripple",
    {
      type: "insert",
      track: 0,
      at: 120,
      mode: "insert",
      clip: { id: "inserted", kind: "image", src: "still.png", duration: 30 },
    },
    [
      ["shot", 60, 60],
      ["inserted", 120, 30],
      ["later", 150, 360],
    ],
  ],
] satisfies [string, CommandInput, (string | number)[][]][]) {
  test(`${name} returns the same atomic refusal over HTTP and MCP, then ripples only opted-in tracks`, async () => {
    const fixture = await timelineFixture();
    const { project } = fixture;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createMcpHttpHandler({
        fetch: (url, init) => fixture.app.request(url, init),
      }),
    });
    const client = new Client({ name: "ripple-sync", version: "1" });
    const api = `/projects/${project.id}`;
    const index = join(project.path, "index.html");
    const html = `<main data-composition-id="main" data-duration="16" data-fps="30"><video id="shot" src="shot.mp4" muted data-start="2" data-duration="2" data-media-start="2" data-track-index="0"></video><video id="later" src="shot.mp4" muted data-start="4" data-duration="12" data-track-index="0"></video><div id="lower" class="clip" data-label="Lower third" data-start="0" data-duration="10" data-track-index="1">Lower third</div><div id="later-title" class="clip" data-start="14" data-duration="2" data-track-index="1">Later cue</div><script>gsap.to("#lower", {opacity:1});</script></main>`;
    const read = async () =>
      TimelineViewSchema.parse(
        await (await fixture.request(`${api}/timeline`)).json(),
      );
    const result = z.object({
      structuredContent: z.object({ result: TimelineViewSchema }),
    });
    try {
      await writeFile(index, html);
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${server.port}/mcp`),
        ),
      );
      const before = await read();
      const files = await fixture.files();
      const reason = `Command 1 (${command.type}): Lower third on V2 can't be cut here. Turn off auto-select on V2 to ripple without it.`;
      const response = await fixture.request(`${api}/commands`, "POST", {
        expectedRevision: before.revision,
        commands: [command],
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: reason,
        code: "unsupported",
        command: 0,
      });
      const refused = await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: before.revision,
          commands: [command],
        },
      });
      expect(refused.isError).toBe(true);
      expect(refused.content).toEqual([
        { type: "text", text: expect.stringContaining(reason) },
      ]);
      expect(await read()).toEqual(before);
      expect(await fixture.files()).toEqual(files);
      const optOut = await fixture.request(`${api}/commands`, "POST", {
        expectedRevision: before.revision,
        commands: [{ type: "setTrack", index: 1, autoSelect: false }],
      });
      expect(optOut.status).toBe(200);
      const optedOut = await read();
      const edited = result.parse(
        await client.callTool({
          name: "timeline_edit",
          arguments: {
            projectId: project.id,
            expectedRevision: optedOut.revision,
            commands: [command],
          },
        }),
      ).structuredContent.result;
      expect(edited.skippedClips ?? []).toEqual([]);
      expect(
        edited.timeline.clips
          .filter((clip) => clip.track === 0)
          .map((clip) => [clip.id, clip.start, clip.duration]),
      ).toEqual(expectedPicture);
      expect(edited.timeline.clips.filter((clip) => clip.track === 1)).toEqual(
        before.timeline.clips.filter((clip) => clip.track === 1),
      );
      expect((await read()).timeline).toEqual(edited.timeline);
      await fixture.request(`${api}/history/undo`, "POST", {});
      expect((await read()).timeline).toEqual(optedOut.timeline);
      await fixture.request(`${api}/history/undo`, "POST", {});
      expect((await read()).timeline).toEqual(before.timeline);
      expect(await readFile(index, "utf8")).toBe(html);
    } finally {
      await client.close();
      await server.stop(true);
      await fixture.close();
    }
  });
}

for (const destination of ["new", "free", "partner"] as const) {
  test(`HTTP and MCP paste route linked sound to a ${destination} track and preserve another pair`, async () => {
    const fixture = await timelineFixture();
    const { project } = fixture;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createMcpHttpHandler({
        fetch: (url, init) => fixture.app.request(url, init),
      }),
    });
    const client = new Client({ name: "paste-sound-routing", version: "1" });
    const result = z.object({
      structuredContent: z.object({ result: TimelineViewSchema }),
    });
    const copied = z.object({
      structuredContent: z.object({ result: ClipboardSchema }),
    });
    try {
      const media = Bun.spawnSync(
        [
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=64x36:r=30:d=6",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=6",
          "-shortest",
          join(project.path, "source.mp4"),
        ],
        { stderr: "pipe" },
      );
      expect(media.exitCode, media.stderr.toString()).toBe(0);
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><body><main data-composition-id="main" data-fps="30" data-duration="8">
        <video id="picture" src="source.mp4" muted data-start="0" data-duration="1" data-track-index="1" data-link="source"></video>
        <audio id="sound" src="source.mp4" data-start="0" data-duration="1" data-track-index="2" data-link="source"></audio>
        <video id="other-picture" src="source.mp4" muted data-start="4" data-duration="2" data-track-index="0" data-link="other"></video>
        <audio id="other-sound" src="source.mp4" data-start="4" data-duration="2" data-track-index="2" data-link="other"></audio>
        ${
          destination === "partner"
            ? `
          <video id="destination" src="source.mp4" muted data-start="4" data-duration="2" data-track-index="1" data-link="destination"></video>
          <audio id="destination-sound" src="source.mp4" data-start="4" data-duration="2" data-track-index="4" data-link="destination"></audio>`
            : ""
        }
        </main></body></html>`,
      );
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
      const api = `/projects/${project.id}`;
      if (destination !== "new") {
        const response = await fixture.request(`${api}/commands`, "POST", {
          expectedRevision: (await read()).revision,
          commands: [{ type: "setTrack", index: 3, kind: "audio" }],
        });
        expect(response.status).toBe(200);
      }
      const before = await read();
      const copy = copied.parse(
        await client.callTool({
          name: "timeline_copy",
          arguments: {
            projectId: project.id,
            expectedRevision: before.revision,
            clipIds: ["picture"],
          },
        }),
      ).structuredContent.result;
      const commands = [{ type: "paste", clipboardId: copy.id, at: 135 }];
      for (const route of ["http", "mcp"]) {
        const edited =
          route === "http"
            ? TimelineViewSchema.parse(
                await (
                  await fixture.request(`${api}/commands`, "POST", {
                    expectedRevision: (await read()).revision,
                    commands,
                  })
                ).json(),
              )
            : result.parse(
                await client.callTool({
                  name: "timeline_edit",
                  arguments: {
                    projectId: project.id,
                    expectedRevision: (await read()).revision,
                    commands,
                  },
                }),
              ).structuredContent.result;
        expect(
          edited.timeline.clips.filter((clip) => clip.link === "other"),
        ).toEqual(
          before.timeline.clips.filter((clip) => clip.link === "other"),
        );
        const picture = edited.timeline.clips.find(
          (clip) => clip.kind === "video" && clip.start === 135,
        )!;
        expect(picture).toMatchObject({ track: 1, duration: 30 });
        const sound = edited.timeline.clips.find(
          (clip) => clip.kind === "audio" && clip.link === picture.link,
        )!;
        expect(sound).toMatchObject({
          track: destination === "partner" ? 4 : 3,
          start: 135,
          duration: 30,
        });
        if (destination === "partner")
          expect(
            edited.timeline.clips
              .filter((clip) => clip.id.startsWith("destination"))
              .map((clip) => [clip.track, clip.start, clip.duration]),
          ).toEqual([
            [1, 120, 15],
            [1, 165, 15],
            [4, 120, 15],
            [4, 165, 15],
          ]);
        expect((await read()).timeline).toEqual(edited.timeline);
        await fixture.request(`${api}/history/undo`, "POST");
        expect((await read()).timeline).toEqual(before.timeline);
      }
    } finally {
      await client.close();
      await server.stop(true);
      await fixture.close();
    }
  });
}

test("MCP clipboard snapshots survive cuts and timeline switches, paste once, and refuse other projects", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "clipboard-test", version: "1" });
  const viewResult = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  const copyResult = z.object({
    structuredContent: z.object({ result: ClipboardSchema }),
  });
  try {
    await mkdir(join(project.path, "scenes"));
    const tone = Bun.spawnSync(
      [
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=6",
        join(project.path, "tone.wav"),
      ],
      { stderr: "pipe" },
    );
    expect(tone.exitCode, tone.stderr.toString()).toBe(0);
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><body><main data-composition-id="main" data-duration="12" data-fps="30">
      <div id="picture" data-start="1" data-duration="2" data-track-index="0" data-link="pair" data-label="Picture"><span>Copied content</span></div>
      <audio src="tone.wav" id="sound" data-start="0.5" data-duration="3" data-track-index="1" data-link="pair"></audio>
    </main></body></html>`,
    );
    await writeFile(
      join(project.path, "scenes/other.html"),
      `<template><main data-composition-id="other" data-duration="12" data-fps="30"></main></template>`,
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const read = async (composition = "index.html") =>
      viewResult.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: project.id, composition },
        }),
      ).structuredContent.result;
    const before = await read();
    const api = `/projects/${project.id}`;
    const historyBefore = await (
      await fixture.request(`${api}/history`)
    ).json();
    const copy = copyResult.parse(
      await client.callTool({
        name: "timeline_copy",
        arguments: {
          projectId: project.id,
          expectedRevision: before.revision,
          clipIds: ["picture"],
        },
      }),
    ).structuredContent.result;
    expect(copy.clips.map((clip) => clip.id)).toEqual(["picture", "sound"]);
    expect(await (await fixture.request(`${api}/history`)).json()).toEqual(
      historyBefore,
    );
    const edit = async (composition: string, commands: CommandInput[]) =>
      viewResult.parse(
        await client.callTool({
          name: "timeline_edit",
          arguments: {
            projectId: project.id,
            composition,
            expectedRevision: (await read(composition)).revision,
            commands,
          },
        }),
      ).structuredContent.result;
    await edit("index.html", [{ type: "remove", clipIds: ["picture"] }]);
    expect((await read()).timeline.clips).toHaveLength(0);
    const paste: CommandInput = {
      type: "paste",
      clipboardId: copy.id,
      at: 120,
    };
    const otherBefore = await read("scenes/other.html");
    const other = await edit("scenes/other.html", [paste]);
    expect(
      other.timeline.clips.map((clip) => [
        clip.track,
        clip.start,
        clip.duration,
      ]),
    ).toEqual([
      [0, 135, 60],
      [1, 120, 90],
    ]);
    expect(other.timeline.clips[1]).toMatchObject({
      src: "../tone.wav",
      sourceDuration: 6,
    });
    expect(other.timeline.clips[0]!.link).toBe(other.timeline.clips[1]!.link);
    expect(other.timeline.clips[0]!.link).not.toBe("pair");
    expect(
      await readFile(join(project.path, "scenes/other.html"), "utf8"),
    ).toContain("<span>Copied content</span>");
    await fixture.request(`${api}/history/undo`, "POST");
    expect((await read("scenes/other.html")).timeline).toEqual(
      otherBefore.timeline,
    );
    await fixture.request(`${api}/history/redo`, "POST");
    expect((await read("scenes/other.html")).timeline).toEqual(other.timeline);
    await fixture.request(`${api}/history/undo`, "POST");
    const repasted = await edit("scenes/other.html", [paste]);
    expect(
      repasted.timeline.clips.every(
        (clip) => !other.timeline.clips.some((old) => old.id === clip.id),
      ),
    ).toBe(true);
    const restored = await edit("index.html", [paste]);
    expect(restored.timeline.clips).toHaveLength(2);
    const another = await fixture.store.create({ name: "Other project" });
    const anotherView = TimelineViewSchema.parse(
      await (await fixture.request(`/projects/${another.id}/timeline`)).json(),
    );
    const refused = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: another.id,
        expectedRevision: anotherView.revision,
        commands: [paste],
      },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain(
      "clipboard is unavailable in this project",
    );
  } finally {
    await client.close();
    await server.stop(true);
    await fixture.close();
  }
});

test("clipboard copy refuses id-styled clips and stale revisions without changing files", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  try {
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><head><style>#lower{color:white}</style></head><body><main data-composition-id="main" data-duration="12"><div id="lower" data-label="Lower third" data-start="0" data-duration="12"></div></main></body></html>`,
    );
    const api = `/projects/${project.id}`;
    const view = TimelineViewSchema.parse(
      await (await fixture.request(`${api}/timeline`)).json(),
    );
    const files = await fixture.files();
    const restricted = await fixture.request(`${api}/timeline/copy`, "POST", {
      expectedRevision: view.revision,
      clipIds: ["lower"],
    });
    expect(restricted.status).toBe(422);
    expect((await restricted.json()).error).toContain(
      "Lower third can't be copied",
    );
    const stale = await fixture.request(`${api}/timeline/copy`, "POST", {
      expectedRevision: "old",
      clipIds: ["lower"],
    });
    expect(stale.status).toBe(409);
    expect(await fixture.files()).toEqual(files);
  } finally {
    await fixture.close();
  }
});

test("track view settings stay outside history and survive real-edit undo and redo", async () => {
  const fixture = await timelineFixture();
  const { project, store } = fixture;
  const ledger = await store.history(project);
  const endpoint = `/projects/${project.id}`;
  const settings = {
    density: "compact",
    heights: { "0": 120 },
    destinations: {},
  };
  const save = (view: unknown, composition = "index.html") =>
    fixture.request(
      `${endpoint}/timeline-view?composition=${composition}`,
      "PUT",
      view,
    );
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.request(`${endpoint}/timeline`)).json(),
    );
  try {
    const original = await fixture.files();
    await ledger.checkpoint();
    const initial = ledger.list().length;
    expect((await save(settings)).status).toBe(200);
    await ledger.checkpoint();
    expect(ledger.list()).toHaveLength(initial);
    expect(await fixture.files()).toEqual(original);
    const before = await read();
    expect(
      (
        await fixture.request(`${endpoint}/commands`, "POST", {
          expectedRevision: before.revision,
          commands: [{ type: "setTrack", index: 0, name: "Picture" }],
        })
      ).status,
    ).toBe(200);
    expect(ledger.list()).toHaveLength(initial + 1);
    const tall = { density: "tall", heights: {}, destinations: {} };
    expect((await save(tall)).status).toBe(200);
    await ledger.checkpoint();
    expect(ledger.list()).toHaveLength(initial + 1);
    expect(
      (await fixture.request(`${endpoint}/history/undo`, "POST", {})).status,
    ).toBe(200);
    expect((await read()).timeline.tracks[0]?.name).not.toBe("Picture");
    expect(
      await (await fixture.request(`${endpoint}/timeline-view`)).json(),
    ).toEqual(tall);
    expect(
      (await fixture.request(`${endpoint}/history/redo`, "POST", {})).status,
    ).toBe(200);
    expect((await read()).timeline.tracks[0]?.name).toBe("Picture");
    expect(
      await (await fixture.request(`${endpoint}/timeline-view`)).json(),
    ).toEqual(tall);
    // A second composition has its own preferences; concurrent saves retain both entries.
    await writeFile(join(project.path, "second.html"), original[0]!);
    const responses = await Promise.all([
      save(settings, "./index.html"),
      save({ density: "normal", heights: { "1": 80 } }, "second.html"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      JSON.parse(
        await readFile(join(project.path, ".cutroom/view.json"), "utf8"),
      ),
    ).toEqual({
      timelines: {
        "index.html": settings,
        "second.html": {
          density: "normal",
          heights: { "1": 80 },
          destinations: {},
        },
      },
    });
  } finally {
    await fixture.close();
  }
});

test("destination tracks are read and set by themselves, outside history and other view preferences", async () => {
  const fixture = await timelineFixture();
  const { project, store } = fixture;
  const ledger = await store.history(project);
  const endpoint = `/projects/${project.id}`;
  const destinations = async (method = "GET", body?: unknown) => {
    const response = await fixture.request(
      `${endpoint}/timeline-destinations`,
      method,
      body,
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    const { timeline, revision } = TimelineViewSchema.parse(
      await (await fixture.request(`${endpoint}/timeline`)).json(),
    );
    // Nothing chosen: the first video track, and the empty audio row the headers show as A1.
    expect(timeline.tracks.map(({ index, kind }) => [index, kind])).toEqual([
      [0, "video"],
      [1, "video"],
      [2, "video"],
    ]);
    const initial = { video: 0, audio: 3 };
    expect((await destinations()).body).toEqual(initial);
    const spare = 4;
    expect(
      (
        await fixture.request(`${endpoint}/commands`, "POST", {
          expectedRevision: revision,
          commands: [{ type: "setTrack", index: spare, kind: "video" }],
        })
      ).status,
    ).toBe(200);
    await fixture.request(`${endpoint}/timeline-view`, "PUT", {
      density: "compact",
      heights: { "0": 120 },
    });
    await ledger.checkpoint();
    const entries = ledger.list().length;
    const files = await fixture.files();
    expect(await destinations("PUT", { video: spare })).toEqual({
      status: 200,
      body: { video: spare, audio: initial.audio },
    });
    await ledger.checkpoint();
    expect(ledger.list()).toHaveLength(entries);
    expect(await fixture.files()).toEqual(files);
    expect(
      await (await fixture.request(`${endpoint}/timeline-view`)).json(),
    ).toEqual({
      density: "compact",
      heights: { "0": 120 },
      destinations: { video: spare },
    });
    // A track of the other kind, or one the timeline lacks, is refused and nothing changes.
    for (const wrong of [{ audio: spare }, { video: spare + 5 }])
      expect((await destinations("PUT", wrong)).status).toBe(422);
    expect((await destinations()).body.video).toBe(spare);
    // Undo removes the chosen track, so placement falls back to the first one.
    expect(
      (await fixture.request(`${endpoint}/history/undo`, "POST", {})).status,
    ).toBe(200);
    expect((await destinations()).body).toEqual(initial);
  } finally {
    await fixture.close();
  }
});

test("missing or malformed view preferences use defaults and do not block timeline edits", async () => {
  const fixture = await timelineFixture();
  const { project } = fixture;
  const endpoint = `/projects/${project.id}`;
  const defaults = { density: "normal", heights: {}, destinations: {} };
  try {
    expect(
      await (await fixture.request(`${endpoint}/timeline-view`)).json(),
    ).toEqual(defaults);
    await mkdir(join(project.path, ".cutroom"), { recursive: true });
    for (const corrupt of [
      "{broken",
      JSON.stringify({
        timelines: {
          "index.html": { density: "giant", heights: { "0": 500 } },
        },
      }),
    ]) {
      await writeFile(join(project.path, ".cutroom/view.json"), corrupt);
      expect(
        await (await fixture.request(`${endpoint}/timeline-view`)).json(),
      ).toEqual(defaults);
      const view = TimelineViewSchema.parse(
        await (await fixture.request(`${endpoint}/timeline`)).json(),
      );
      expect(
        (
          await fixture.request(`${endpoint}/commands`, "POST", {
            expectedRevision: view.revision,
            commands: [{ type: "setTrack", index: 0, name: corrupt }],
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await fixture.request(`${endpoint}/timeline-view`, "PUT", {
          density: "compact",
          heights: {},
        })
      ).status,
    ).toBe(200);
    expect(
      await (await fixture.request(`${endpoint}/timeline-view`)).json(),
    ).toEqual({ density: "compact", heights: {}, destinations: {} });
  } finally {
    await fixture.close();
  }
});
