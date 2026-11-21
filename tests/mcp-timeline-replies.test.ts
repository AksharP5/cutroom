import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { projectFixture } from "./project-fixture";

async function connect() {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Replies" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "reply-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
    ),
  );
  const result = async (name: string, args: Record<string, unknown>) => {
    const answer = await client.callTool({
      name,
      arguments: { projectId: project.id, ...args },
    });
    expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
    return z
      .object({ structuredContent: z.object({ result: z.unknown() }) })
      .parse(answer).structuredContent.result;
  };
  const read = async (args: Record<string, unknown> = {}) =>
    TimelineViewSchema.parse(await result("timeline_read", args));
  return {
    client,
    result,
    read,
    project,
    async close() {
      await client.close();
      server.stop(true);
      await fixture.close();
    },
  };
}

test("timeline_edit creates a named audio group and reports its routed clips", async () => {
  const mcp = await connect();
  try {
    const path = join(mcp.project.path, "index.html");
    const source = `<main data-composition-id="main" data-duration="4"><audio id="lead" src="voice.wav" data-start="0" data-duration="2" data-track-index="1"></audio><audio id="pickup" src="voice.wav" data-start="2" data-duration="2" data-track-index="2"></audio></main>`;
    await writeFile(path, source);
    const before = await mcp.read();
    const reply = await mcp.result("timeline_edit", {
      expectedRevision: before.revision,
      commands: [
        {
          type: "routeAudioGroup",
          clipIds: ["lead", "pickup"],
          group: { label: "Voices", volume: 0.25 },
        },
      ],
    });
    const id = z
      .object({
        changes: z.object({
          authoredAudioGroups: z.object({
            added: z.tuple([
              z.object({ id: z.string().regex(/^cutroom-bus-/) }),
            ]),
          }),
        }),
      })
      .parse(reply).changes.authoredAudioGroups.added[0].id;
    expect(reply).toMatchObject({
      changes: {
        authoredAudioGroups: {
          added: [{ id, label: "Voices", volume: 0.25 }],
        },
        clips: {
          changed: [
            { id: "lead", authoredAudioGroupId: id },
            { id: "pickup", authoredAudioGroupId: id },
          ],
        },
      },
    });
    expect(
      (await mcp.read()).timeline.clips.map(
        ({ authoredAudioGroupId }) => authoredAudioGroupId,
      ),
    ).toEqual([id, id]);
    await mcp.result("history_undo", {});
    expect(await readFile(path, "utf8")).toBe(source);
  } finally {
    await mcp.close();
  }
});

test("timeline_edit adds a freeze clip with its PNG through the typed MCP command", async () => {
  const mcp = await connect();
  try {
    const video = join(mcp.project.path, "source.mp4");
    const ffmpeg = Bun.spawnSync([
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=96x54:r=30:d=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      video,
    ]);
    expect(ffmpeg.stderr.toString()).toBe("");
    expect(ffmpeg.exitCode).toBe(0);
    await writeFile(
      join(mcp.project.path, "index.html"),
      `<main data-composition-id="main" data-width="96" data-height="54" data-fps="30" data-duration="2"><video id="picture" src="source.mp4" muted data-start="0" data-duration="2" data-track-index="0" style="object-fit:cover"></video></main>`,
    );
    const before = await mcp.read();
    // The export variant is written second. A collision must leave the HTML and
    // the preview asset untouched, and keep the file the edit did not create.
    const freezeDir = join(mcp.project.path, "assets/freeze");
    await mkdir(join(freezeDir, "export"), { recursive: true });
    const taken = join(freezeDir, "export/taken.png");
    await writeFile(taken, "existing file");
    const collision = await mcp.client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: mcp.project.id,
        expectedRevision: before.revision,
        commands: [{ type: "freeze", clipId: "picture", at: 24, id: "taken" }],
      },
    });
    expect(collision.isError).toBe(true);
    expect(JSON.stringify(collision.content)).toContain(
      "already exists at the freeze frame",
    );
    expect(await mcp.read()).toEqual(before);
    expect(await Bun.file(join(freezeDir, "taken.png")).exists()).toBe(false);
    expect(await Bun.file(taken).text()).toBe("existing file");

    const edited = TimelineViewSchema.parse(
      await mcp.result("timeline_edit", {
        expectedRevision: before.revision,
        fullTimeline: true,
        commands: [
          {
            type: "freeze",
            clipId: "picture",
            at: 24,
            id: "still",
            ids: { picture: ["tail"] },
          },
        ],
      }),
    );
    expect(edited.timeline.clips).toMatchObject([
      { id: "picture", start: 0, duration: 24 },
      {
        id: "still",
        start: 24,
        duration: 60,
        kind: "image",
        src: "assets/freeze/still.png",
        style: { objectFit: "cover" },
      },
      { id: "tail", start: 84, duration: 36, mediaStart: 0.8 },
    ]);
    expect(
      await Bun.file(
        join(mcp.project.path, "assets/freeze/still.png"),
      ).exists(),
    ).toBe(true);
  } finally {
    await mcp.close();
  }
});

test("timeline_edit holds VFR predecessors and the final picture across a longer audio stream", async () => {
  const mcp = await connect();
  try {
    const project = mcp.project.path;
    const ffmpeg = (...args: string[]) => {
      const child = Bun.spawnSync(["ffmpeg", "-v", "error", ...args]);
      expect(child.stderr.toString()).toBe("");
      expect(child.exitCode).toBe(0);
      return child.stdout;
    };
    const unshifted = join(project, "vfr-0.mp4");
    ffmpeg(
      "-f",
      "lavfi",
      "-i",
      "color=red:s=32x32:r=50:d=0.1",
      "-f",
      "lavfi",
      "-i",
      "sine=d=1",
      "-vf",
      "drawbox=c=blue:t=fill:enable=gte(n\\,3),select=eq(n\\,0)+eq(n\\,3)",
      "-fps_mode",
      "vfr",
      "-c:v",
      "libx264",
      "-g",
      "1",
      "-c:a",
      "aac",
      unshifted,
    );
    const shifted = join(project, "vfr-0.2.mp4");
    // Older MP4 muxers truncate the final frame when the raw input is retimed on encode.
    ffmpeg(
      "-itsoffset",
      "0.2",
      "-i",
      unshifted,
      "-i",
      unshifted,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c",
      "copy",
      shifted,
    );
    const cases = [
      { media: 0, offset: 0.03998, colour: "red" },
      { media: 0.2, offset: 0.23998, colour: "red" },
      { media: 0.2, offset: 0.24, colour: "blue" },
      { media: 0.2, offset: 0.68, colour: "blue" },
    ];
    await writeFile(
      join(project, "index.html"),
      `<main data-composition-id="main" data-width="32" data-height="32" data-fps="50" data-duration="1">
        ${cases
          .map(
            ({ media, offset }, index) =>
              `<video id="v${index}" src="vfr-${media}.mp4" muted data-start="0" data-duration="0.24" data-media-start="${offset}" data-track-index="${index}"></video>`,
          )
          .join("")}
      </main>`,
    );
    const before = await mcp.read();
    await mcp.result("timeline_edit", {
      expectedRevision: before.revision,
      commands: cases.map((_, index) => ({
        type: "freeze",
        clipId: `v${index}`,
        at: 1,
        id: `still${index}`,
      })),
    });
    expect(
      (await mcp.read()).timeline.clips.filter(({ kind }) => kind === "image"),
    ).toHaveLength(cases.length);
    for (const [{ colour }, index] of cases.map(
      (item, index) => [item, index] as const,
    )) {
      const [red, , blue] = ffmpeg(
        "-i",
        join(project, `assets/freeze/still${index}.png`),
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      );
      expect(colour === "red" ? red : blue).toBeGreaterThan(240);
      expect(colour === "red" ? blue : red).toBeLessThan(15);
    }
  } finally {
    await mcp.close();
  }
});

test("timeline_edit answers with the next revision and only what changed", async () => {
  const mcp = await connect();
  try {
    const before = await mcp.read();
    const marker = await mcp.result("timeline_edit", {
      expectedRevision: before.revision,
      commands: [{ type: "setMarker", id: "beat", frame: 30, name: "Beat" }],
    });
    // The whole timeline and the edit ledger stay out unless asked for.
    expect(marker).toEqual({
      revision: (await mcp.read()).revision,
      composition: "index.html",
      changes: {
        markers: {
          added: [
            {
              id: "beat",
              frame: 30,
              duration: 0,
              name: "Beat",
              note: "",
              color: "blue",
            },
          ],
        },
      },
    });

    const caption = before.timeline.clips.find((clip) => clip.id === "caption");
    if (!caption) throw new Error("The new project has no caption clip.");
    const razor = z
      .object({
        revision: z.string(),
        changes: z.object({
          clips: z.object({
            added: z.array(z.object({ id: z.string(), start: z.number() })),
            changed: z.array(z.record(z.string(), z.unknown())),
          }),
        }),
      })
      .parse(
        await mcp.result("timeline_edit", {
          expectedRevision: (marker as { revision: string }).revision,
          commands: [
            {
              type: "split",
              at: caption.start + 60,
              clipIds: ["caption"],
              ids: { caption: ["caption-tail"] },
            },
          ],
        }),
      );
    // The new piece arrives whole, so its id is known without another read.
    expect(razor.changes.clips.added).toEqual([
      expect.objectContaining({
        id: "caption-tail",
        start: caption.start + 60,
      }),
    ]);
    // A changed clip names only the fields that changed.
    expect(razor.changes.clips.changed).toEqual([
      { id: "caption", duration: 60 },
    ]);

    const full = TimelineViewSchema.parse(
      await mcp.result("timeline_edit", {
        expectedRevision: razor.revision,
        fullTimeline: true,
        commands: [{ type: "removeMarker", id: "beat" }],
      }),
    );
    expect(full).toEqual(await mcp.read());
  } finally {
    await mcp.close();
  }
});

test("timeline_read narrows to a frame range and tracks, and holds the edit ledger back unless asked", async () => {
  const mcp = await connect();
  try {
    const all = await mcp.read();
    await mcp.result("timeline_edit", {
      expectedRevision: all.revision,
      commands: [
        { type: "setMarker", frame: 10 },
        { type: "setMarker", frame: 200 },
        { type: "setClip", clipId: "caption", opacity: 0.5 },
      ],
    });
    const whole = await mcp.read();
    expect(whole.clipEdits).toBeUndefined();
    expect(
      (await mcp.read({ clipEdits: true })).clipEdits?.map(
        (edit) => edit.clipId,
      ),
    ).toEqual(["caption"]);

    const tracks = [...new Set(whole.timeline.clips.map((clip) => clip.track))];
    expect(tracks.length).toBeGreaterThan(1);
    const [track] = tracks;
    const narrowed = await mcp.read({ from: 0, to: 100, tracks: [track] });
    expect(narrowed.revision).toBe(whole.revision);
    expect(narrowed.timeline.tracks).toEqual(whole.timeline.tracks);
    expect(narrowed.timeline.clips).toEqual(
      whole.timeline.clips.filter(
        (clip) => clip.track === track && clip.start < 100,
      ),
    );
    expect(narrowed.timeline.markers.map((marker) => marker.frame)).toEqual([
      10,
    ]);
  } finally {
    await mcp.close();
  }
});

test("setClip scale, rotation and crop answer as changed fields and read back as the clip's transform", async () => {
  const mcp = await connect();
  try {
    const before = await mcp.read();
    const edit = z
      .object({
        changes: z.object({
          clips: z.object({
            changed: z.array(z.record(z.string(), z.unknown())),
          }),
        }),
      })
      .parse(
        await mcp.result("timeline_edit", {
          expectedRevision: before.revision,
          commands: [
            {
              type: "setClip",
              clipId: "caption",
              scale: 1.1,
              rotation: 90,
              crop: { left: 40 },
            },
          ],
        }),
      );
    const transform = {
      scaleX: 1.1,
      scaleY: 1.1,
      rotation: 90,
      crop: { top: 0, right: 0, bottom: 0, left: 40 },
    };
    expect(edit.changes.clips.changed).toEqual([
      { id: "caption", ...transform },
    ]);
    const caption = (await mcp.read()).timeline.clips.find(
      (clip) => clip.id === "caption",
    );
    expect(caption).toMatchObject(transform);
  } finally {
    await mcp.close();
  }
});

test("timeline_add_transitions reports added cuts and writes one undo step", async () => {
  const mcp = await connect();
  try {
    const path = join(mcp.project.path, "index.html");
    await writeFile(
      path,
      `<main data-composition-id="main" data-duration="6" data-fps="30">
      <audio id="a" src="voice.wav" data-start="0" data-duration="2" data-media-start="1" data-track-index="1"></audio>
      <audio id="b" src="voice.wav" data-start="2" data-duration="2" data-media-start="1" data-track-index="1"></audio>
      <audio id="c" src="voice.wav" data-start="4" data-duration="2" data-media-start="1" data-track-index="1"></audio>
    </main>`,
    );
    const before = await mcp.read();
    const reply = await mcp.result("timeline_add_transitions", {
      clipIds: ["a", "b", "c"],
      scope: "audio",
      expectedRevision: before.revision,
    });
    expect(reply).toMatchObject({
      measured: { added: 2, skipped: 0, shortened: 0 },
    });
    expect(
      (await mcp.read()).timeline.clips.filter((clip) => clip.transitionIn),
    ).toHaveLength(2);
    await mcp.result("history_undo", {});
    expect(
      (await mcp.read()).timeline.clips.filter((clip) => clip.transitionIn),
    ).toHaveLength(0);
  } finally {
    await mcp.close();
  }
});
