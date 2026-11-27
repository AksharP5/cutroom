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
import { addStarterClips } from "./starter-clips";

async function connect() {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Replies" });
  await addStarterClips(project);
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
    request: fixture.request,
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
      `<main data-composition-id="main" data-width="96" data-height="54" data-fps="30" data-duration="2">
        <video id="picture" src="source.mp4" muted data-start="0" data-duration="2" data-track-index="0" style="object-fit:cover"></video>
        <div class="clip" id="heading" data-start="0" data-duration="2" data-track-index="1">Heading</div>
        <div class="clip" id="locked" data-start="0" data-duration="2" data-track-index="2">Locked</div>
      </main>`,
    );
    await mcp.result("timeline_edit", {
      expectedRevision: (await mcp.read()).revision,
      commands: [
        { type: "setTrack", index: 1, name: "Titles", autoSelect: false },
        { type: "setTrack", index: 2, locked: true },
      ],
    });
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
            ids: { picture: ["tail"], heading: ["heading-tail"] },
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
      { id: "heading", start: 0, duration: 24 },
      { id: "heading-tail", start: 84, duration: 36 },
      { id: "locked", start: 0, duration: 60 },
    ]);
    expect(edited.rippleCuts).toEqual([
      { track: 1, name: "Titles", count: 1, framesRemoved: 0 },
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
        mode: "replace",
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

test("a 1,000-clip MCP read gives track spans and its ripple returns every affected id", async () => {
  const mcp = await connect();
  try {
    const clips = Array.from({ length: 1000 }, (_, index) => {
      const id = `shot-${index}`;
      const track = index < 990 ? 0 : 1;
      const start = track === 0 ? index : (index - 989) * 10;
      const style = index === 1 ? ' style="opacity:0.5"' : "";
      const html = `<div id="${id}" class="clip" data-start="${start}" data-duration="1" data-track-index="${track}"${style}>Shot ${index}</div>`;
      return { id, track, start: start * 30, html };
    });
    await writeFile(
      join(mcp.project.path, "index.html"),
      `<main data-composition-id="main" data-fps="30" data-duration="990">${clips.map(({ html }) => html).join("")}</main>`,
    );
    const view = z.object({ revision: z.string(), timeline: z.unknown() });
    const first = view.parse(await mcp.result("timeline_read", {}));
    const configured = view.pick({ revision: true }).parse(
      await mcp.result("timeline_edit", {
        expectedRevision: first.revision,
        commands: [
          { type: "setTrack", index: 2, kind: "video", name: "Empty" },
          { type: "setMarker", frame: 301, name: "Cut" },
        ],
      }),
    );
    const summary = view.parse(await mcp.result("timeline_read", {}));
    expect(summary.revision).toBe(configured.revision);
    expect(summary.timeline).toMatchObject({
      clipSummary: {
        clipCount: 1000,
        tracks: [
          { index: 0, clipCount: 990, from: 0, to: 29_700 },
          { index: 1, clipCount: 10, from: 300, to: 3030 },
          { index: 2, clipCount: 0, from: null, to: null },
        ],
        guidance: expect.stringContaining("from, to"),
      },
      tracks: expect.arrayContaining([
        expect.objectContaining({ index: 2, name: "Empty" }),
      ]),
      markers: [expect.objectContaining({ frame: 301 })],
    });
    expect(summary.timeline).not.toHaveProperty("clips");
    const scoped = view.parse(
      await mcp.result("timeline_read", {
        from: 300,
        to: 330,
        tracks: [1],
        replyFormat: "compact",
      }),
    );
    expect(scoped.revision).toBe(summary.revision);
    expect(scoped.timeline).toMatchObject({
      clips: [{ id: "shot-990", track: 1, start: 300, duration: 30 }],
      markers: [expect.objectContaining({ frame: 301 })],
    });
    const legacy = await mcp.read({ replyFormat: "legacy" });
    expect(legacy.revision).toBe(summary.revision);
    expect(legacy.timeline.clips).toHaveLength(1000);
    expect(legacy.timeline.clips[0]).toMatchObject({
      id: "shot-0",
      opacity: null,
      enabled: true,
      fx: [],
    });
    const commands = [
      { type: "remove", clipIds: ["shot-0"], ripple: true },
      { type: "setClip", clipId: "shot-1", opacity: null },
      { type: "move", clipIds: ["shot-2"], by: 1, mode: "overwrite" },
    ];
    const edit = z.object({
      revision: z.string(),
      changes: z.object({ clips: z.unknown() }),
    });
    const delta = edit.parse(
      await mcp.result("timeline_edit", {
        expectedRevision: summary.revision,
        replyFormat: "compact",
        commands,
      }),
    );
    expect(delta.changes.clips).toEqual({
      removed: ["shot-0"],
      changed: [
        { id: "shot-1", start: 0, opacity: null },
        { id: "shot-2", start: 31 },
        { id: "shot-3", start: 61, duration: 29 },
      ],
      shifted: [{ by: -30, ids: clips.slice(4).map(({ id }) => id) }],
    });
    const editor = TimelineViewSchema.parse(
      await (await mcp.request(`/projects/${mcp.project.id}/timeline`)).json(),
    );
    expect(editor.revision).toBe(delta.revision);
    expect(editor.timeline.clips).toHaveLength(999);
    const saved = new Map(editor.timeline.clips.map((clip) => [clip.id, clip]));
    for (const clip of clips.slice(4))
      expect(saved.get(clip.id)?.start).toBe(clip.start - 30);
    expect(saved.get("shot-1")).toMatchObject({ start: 0, opacity: null });
    expect(saved.get("shot-3")).toMatchObject({ start: 61, duration: 29 });
    const full = TimelineViewSchema.parse(
      await mcp.result("timeline_edit", {
        expectedRevision: delta.revision,
        fullTimeline: true,
        commands: [{ type: "setMarker", frame: 100 }],
      }),
    );
    expect(full.timeline.clips).toEqual(editor.timeline.clips);
    const legacyEdit = edit.parse(
      await mcp.result("timeline_edit", {
        expectedRevision: full.revision,
        replyFormat: "legacy",
        commands: [{ type: "remove", clipIds: ["shot-1"], ripple: true }],
      }),
    );
    expect(legacyEdit.changes.clips).not.toHaveProperty("shifted");
    expect(legacyEdit.changes.clips).toMatchObject({
      removed: ["shot-1"],
      changed: expect.arrayContaining([
        { id: "shot-2", start: 1 },
        { id: "shot-999", start: 2940 },
      ]),
    });
  } finally {
    await mcp.close();
  }
});

test("a project of a few hundred clips keeps detailed reads and compresses uniform ripple shifts", async () => {
  const mcp = await connect();
  try {
    // About 530 bytes a clip, as on a real dialogue edit, so 300 clips stay under the summary limit.
    const html = Array.from(
      { length: 300 },
      (_, index) =>
        `<video id="shot-${index}" class="clip" src="assets/talk-${index % 4}.mp4" data-start="${index}" data-duration="1" data-track-index="0" data-media-start="${index}"></video>`,
    ).join("");
    await writeFile(
      join(mcp.project.path, "index.html"),
      `<main data-composition-id="main" data-fps="30" data-duration="300">${html}</main>`,
    );
    const read = await mcp.read();
    expect(read.timeline.clips).toHaveLength(300);
    expect(read.timeline.clips[0]).toMatchObject({
      id: "shot-0",
      playbackRate: 1,
      opacity: null,
      fx: [],
    });
    const edit = z
      .object({
        changes: z.object({
          clips: z.object({
            shifted: z.array(
              z.object({ by: z.number(), ids: z.array(z.string()) }),
            ),
          }),
        }),
      })
      .parse(
        await mcp.result("timeline_edit", {
          expectedRevision: read.revision,
          commands: [{ type: "remove", clipIds: ["shot-0"], ripple: true }],
        }),
      );
    expect(edit.changes.clips.shifted).toEqual([
      { by: -30, ids: Array.from({ length: 299 }, (_, i) => `shot-${i + 1}`) },
    ]);
  } finally {
    await mcp.close();
  }
});

test("compact snapshots keep authored values and edits keep explicit resets", async () => {
  const mcp = await connect();
  try {
    const source = `<main data-composition-id="main" data-fps="30" data-duration="3">
      <video id="picture" muted src="take.mp4" data-link="pair" data-start="0" data-duration="2" data-track-index="0" data-hidden style="opacity:1;object-fit:cover"></video>
      <audio id="sound" src="take.mp4" data-link="pair" data-start="0" data-media-start="0.5" data-duration="2" data-track-index="1" data-volume="0"></audio>
    </main>`;
    await writeFile(join(mcp.project.path, "index.html"), source);
    const view = z.object({
      revision: z.string(),
      timeline: z.object({ clips: z.array(z.record(z.string(), z.unknown())) }),
    });
    const picture = view.parse(
      await mcp.result("timeline_read", {
        tracks: [0],
        replyFormat: "compact",
      }),
    );
    expect(picture.timeline.clips).toEqual([
      {
        id: "picture",
        track: 0,
        kind: "video",
        start: 0,
        duration: 60,
        mediaStart: 0,
        src: "take.mp4",
        link: "pair",
        opacity: 1,
        enabled: false,
        syncOffset: 15,
        style: { objectFit: "cover" },
      },
    ]);
    const sound = view.parse(
      await mcp.result("timeline_read", {
        tracks: [1],
        replyFormat: "compact",
      }),
    );
    expect(sound.timeline.clips).toMatchObject([
      { id: "sound", hasAudio: true, volume: 0, syncOffset: -15 },
    ]);
    const { revision } = z.object({ revision: z.string() }).parse(
      await mcp.result("timeline_edit", {
        expectedRevision: sound.revision,
        commands: [
          {
            type: "setClip",
            clipId: "sound",
            fadeIn: 5,
            automation: { volume: [{ frame: 0, gain: 1 }] },
            fx: [{ type: "limiter" }],
          },
        ],
      }),
    );
    const delta = await mcp.result("timeline_edit", {
      expectedRevision: revision,
      replyFormat: "compact",
      commands: [
        {
          type: "setClip",
          clipId: "picture",
          opacity: null,
          enabled: true,
          style: { objectFit: null },
        },
        {
          type: "setClip",
          clipId: "sound",
          volume: null,
          fadeIn: 0,
          automation: null,
          fx: [],
        },
        {
          type: "insert",
          at: 60,
          track: 0,
          clip: { id: "title", kind: "title", text: "Next", duration: 30 },
        },
      ],
    });
    expect(delta).toMatchObject({
      changes: {
        clips: {
          changed: [
            { id: "picture", opacity: null, style: {}, enabled: true },
            { id: "sound", volume: null, automation: null, fadeIn: 0, fx: [] },
          ],
          added: [
            {
              id: "title",
              start: 60,
              duration: 30,
              text: "Next",
              title: expect.objectContaining({ position: "lower-left" }),
            },
          ],
        },
      },
    });
    const updated = view.parse(
      await mcp.result("timeline_read", {
        from: 60,
        to: 90,
        replyFormat: "compact",
      }),
    );
    expect(updated.timeline.clips[0]).not.toHaveProperty("automation");
    expect(updated.timeline.clips[0]).not.toHaveProperty("enabled");
    expect(delta).toMatchObject({ revision: updated.revision });
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

test("timeline_add_transitions uses linked sound, keeps existing transitions and writes one undo step", async () => {
  const mcp = await connect();
  try {
    const path = join(mcp.project.path, "index.html");
    await writeFile(
      path,
      `<main data-composition-id="main" data-duration="6" data-fps="30">
      <audio id="a" data-link="la" src="voice.wav" data-start="0" data-duration="2" data-media-start="1" data-track-index="1"></audio>
      <audio id="b" data-link="lb" src="voice.wav" data-start="2" data-duration="2" data-media-start="1" data-track-index="1"></audio>
      <audio id="c" data-link="lc" src="voice.wav" data-start="4" data-duration="2" data-media-start="1" data-track-index="1"></audio>
      <video id="va" muted data-link="la" src="video.mp4" data-start="0" data-duration="2" data-media-start="1" data-track-index="0"></video>
      <video id="vb" muted data-link="lb" src="video.mp4" data-start="2" data-duration="2" data-media-start="2" data-track-index="0"></video>
      <video id="vc" muted data-link="lc" src="video.mp4" data-start="4" data-duration="2" data-media-start="1" data-track-index="0"></video>
    </main>`,
    );
    const initial = await mcp.read();
    const existing = { kind: "dip", alignment: "end", duration: 60 } as const;
    await mcp.result("timeline_edit", {
      expectedRevision: initial.revision,
      commands: [
        {
          type: "setTransition",
          from: "va",
          to: "vb",
          linked: false,
          transition: existing,
        },
      ],
    });
    const before = await mcp.read();
    const reply = await mcp.result("timeline_add_transitions", {
      clipIds: ["va", "vb", "vc"],
      scope: "both",
      expectedRevision: before.revision,
    });
    expect(reply).toMatchObject({
      measured: { added: 3, kept: 1, skipped: 0, shortened: 0 },
    });
    expect(
      (await mcp.read()).timeline.clips.filter((clip) => clip.transitionIn),
    ).toHaveLength(4);
    expect(
      (await mcp.read()).timeline.clips.find(({ id }) => id === "vb")
        ?.transitionIn,
    ).toEqual(existing);
    await mcp.result("history_undo", {});
    expect(
      (await mcp.read()).timeline.clips.filter((clip) => clip.transitionIn),
    ).toHaveLength(1);
  } finally {
    await mcp.close();
  }
});

test("Accept All scopes review to the composition or project and preserves notes and undo", async () => {
  const mcp = await connect();
  const path = `/projects/${mcp.project.id}`;
  try {
    await writeFile(
      join(mcp.project.path, "scene.html"),
      '<main data-composition-id="scene" data-duration="2"><div id="card" class="clip" data-start="0" data-duration="2">Card</div></main>',
    );
    const { id: noteId } = z.object({ id: z.string() }).parse(
      await mcp.result("review_add", {
        body: "Rename the clips",
        time: 0,
        compositionPath: "index.html",
      }),
    );
    await mcp.result("review_claim", { noteId });
    for (const [composition, clipId] of [
      ["index.html", "headline"],
      ["scene.html", "card"],
    ]) {
      const { revision } = await mcp.read({ composition });
      await mcp.result("timeline_edit", {
        composition,
        expectedRevision: revision,
        noteId,
        commands: [{ type: "setClip", clipId, label: "Agent label" }],
      });
    }
    await mcp.result("review_complete", { noteId, note: "Renamed both clips" });
    const ordinary = TimelineViewSchema.parse(
      await (await mcp.request(`${path}/timeline`)).json(),
    );
    expect(ordinary.agentChanges).toEqual(["headline"]);
    expect(ordinary.clipEdits).toBeUndefined();

    const history = await mcp.result("history_list", {});
    const details = await mcp.read({
      composition: "scene.html",
      clipEdits: true,
    });
    const scene = details.clipEdits?.find(({ clipId }) => clipId === "card");
    if (!scene) throw new Error("Scene edit is missing from the ledger.");
    expect(
      await mcp.result("review_accept_all", { composition: "./scene.html" }),
    ).toEqual({ accepted: 1 });
    expect(
      (await mcp.read({ composition: "scene.html" })).agentChanges,
    ).toEqual([]);
    expect((await mcp.read()).agentChanges).toEqual(["headline"]);
    expect(await mcp.result("review_accept_all", {})).toEqual({ accepted: 1 });
    const ledger = await readFile(
      join(mcp.project.path, ".cutroom/review.json"),
      "utf8",
    );
    expect(await mcp.result("review_accept_all", {})).toEqual({ accepted: 0 });
    expect(
      await readFile(join(mcp.project.path, ".cutroom/review.json"), "utf8"),
    ).toBe(ledger);
    expect(await mcp.result("history_list", {})).toEqual(history);
    const queue = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            review: z.object({ status: z.string() }),
          }),
        ),
      })
      .parse(await mcp.result("review_list", {}));
    expect(queue.items).toContainEqual({
      id: noteId,
      review: { status: "done" },
    });

    await mcp.result("history_undo", {});
    expect(
      (
        await mcp.read({ composition: "scene.html", clipEdits: true })
      ).clipEdits?.some((edit) => edit.id === scene.id),
    ).toBe(false);
    await mcp.result("history_redo", {});
    expect(
      (await mcp.read({ composition: "scene.html", clipEdits: true }))
        .clipEdits,
    ).toContainEqual({ ...scene, accepted: true });
  } finally {
    await mcp.close();
  }
});

test("large timeline edits report counts within a bounded MCP reply", async () => {
  const mcp = await connect();
  try {
    await writeFile(
      join(mcp.project.path, "index.html"),
      '<main data-composition-id="main" data-fps="30" data-duration="500"><video id="take" src="take.mp4" data-start="0" data-duration="500" data-track-index="0"></video></main>',
    );
    const { revision } = await mcp.read();
    const reply = await mcp.client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: mcp.project.id,
        expectedRevision: revision,
        commands: Array.from({ length: 450 }, (_, i) => ({
          type: "split",
          at: (i + 1) * 30,
        })),
      },
    });
    expect(reply.isError).not.toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(reply));
    console.log(`450 splits: ${bytes} bytes`);
    expect(bytes).toBeLessThanOrEqual(16 * 1024);
    const saved = z
      .object({ result: z.object({ revision: z.string() }) })
      .parse(reply.structuredContent);
    expect(reply.structuredContent).toMatchObject({
      historyId: expect.any(String),
      result: {
        revision: saved.result.revision,
        changeCounts: { clips: { added: 450, changed: 1, removed: 0 } },
        guidance: expect.stringContaining("timeline_read"),
      },
    });
    const editor = TimelineViewSchema.parse(
      await (await mcp.request(`/projects/${mcp.project.id}/timeline`)).json(),
    );
    expect(editor.revision).toBe(saved.result.revision);
    expect(editor.timeline.clips).toHaveLength(451);
  } finally {
    await mcp.close();
  }
});

test("history_list pages back from the newest entries without changing session undo", async () => {
  const mcp = await connect();
  try {
    let { revision } = await mcp.read();
    for (const frame of [1, 2, 3, 4, 5, 6]) {
      const result = z.object({ revision: z.string() }).parse(
        await mcp.result("timeline_edit", {
          expectedRevision: revision,
          commands: [{ type: "setMarker", frame, label: `Cue ${frame}` }],
        }),
      );
      revision = result.revision;
    }
    const page = z.object({
      entries: z.array(
        z.object({ id: z.string(), label: z.string(), mine: z.boolean() }),
      ),
      nextBefore: z.string().nullable(),
      nextUndo: z.object({ id: z.string() }),
    });
    const history = async (args: Record<string, unknown>) => {
      const reply = await mcp.client.callTool({
        name: "history_list",
        arguments: { projectId: mcp.project.id, limit: 2, ...args },
      });
      expect(reply.isError).not.toBe(true);
      console.log(
        `history page: ${Buffer.byteLength(JSON.stringify(reply))} bytes`,
      );
      const result = z
        .object({ result: z.unknown() })
        .parse(reply.structuredContent).result;
      expect(
        z.object({ entries: z.array(z.unknown()) }).parse(result).entries,
      ).toHaveLength(2);
      return page.parse(result);
    };
    const newest = await history({});
    const older = await history({ before: newest.nextBefore });
    expect(newest.entries.map(({ label }) => label)).toEqual([
      "Set marker at 00:00:00:05",
      "Set marker at 00:00:00:06",
    ]);
    expect(older.entries.map(({ label }) => label)).toEqual([
      "Set marker at 00:00:00:03",
      "Set marker at 00:00:00:04",
    ]);
    expect(older.entries.every(({ mine }) => mine)).toBe(true);
    expect(older.nextUndo).toEqual(newest.nextUndo);
    expect(newest.nextUndo.id).toBe(newest.entries[1]?.id);
    const owner = await (
      await mcp.request(`/projects/${mcp.project.id}/history`)
    ).json();
    expect(
      z.object({ entries: z.array(z.unknown()) }).parse(owner).entries.length,
    ).toBeGreaterThanOrEqual(6);
  } finally {
    await mcp.close();
  }
});

test("media_list groups 1,000 clip uses by file and returns a page", async () => {
  const mcp = await connect();
  try {
    const sources = ["a.wav", "b.wav", "c.wav"];
    const audio = Bun.spawnSync([
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=8000:cl=mono",
      "-t",
      "1",
      join(mcp.project.path, sources[0]!),
    ]);
    expect(audio.exitCode, audio.stderr.toString()).toBe(0);
    const wav = await readFile(join(mcp.project.path, sources[0]!));
    await Promise.all(
      sources
        .slice(1)
        .map((src) => writeFile(join(mcp.project.path, src), wav)),
    );
    const html = Array.from(
      { length: 1000 },
      (_, i) =>
        `<audio id="clip-${i}" src="${sources[i % sources.length]}" data-start="${i}" data-duration="1" data-track-index="1"></audio>`,
    ).join("");
    await writeFile(
      join(mcp.project.path, "index.html"),
      `<main data-composition-id="main" data-duration="1000">${html}</main>`,
    );
    const page = z.object({
      media: z.array(
        z.object({
          mediaPath: z.string(),
          kind: z.literal("audio"),
          uses: z.number(),
        }),
      ),
      total: z.number(),
      nextOffset: z.number().nullable(),
    });
    const list = async (offset: number) => {
      const reply = await mcp.client.callTool({
        name: "media_list",
        arguments: { projectId: mcp.project.id, limit: 2, offset },
      });
      expect(reply.isError).not.toBe(true);
      const bytes = Buffer.byteLength(JSON.stringify(reply));
      console.log(`media page: ${bytes} bytes`);
      expect(bytes).toBeLessThan(4096);
      return z.object({ result: page }).parse(reply.structuredContent).result;
    };
    expect(await list(0)).toEqual({
      media: [
        { mediaPath: "a.wav", kind: "audio", uses: 334 },
        { mediaPath: "b.wav", kind: "audio", uses: 333 },
      ],
      total: 3,
      nextOffset: 2,
    });
    expect(await list(2)).toEqual({
      media: [{ mediaPath: "c.wav", kind: "audio", uses: 333 }],
      total: 3,
      nextOffset: null,
    });
    const owner = await (
      await mcp.request(`/projects/${mcp.project.id}/media`)
    ).json();
    expect(
      z.object({ media: z.array(z.unknown()) }).parse(owner).media,
    ).toHaveLength(1000);
  } finally {
    await mcp.close();
  }
});
