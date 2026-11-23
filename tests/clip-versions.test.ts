import { expect, test } from "bun:test";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { SourceSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { ledgerChanges } from "../src/shared/timeline/reviewChanges";
import { projectFixture } from "./project-fixture";

const scene = (id: string, word: string) => `<template>
  <div id="${id}-root" data-composition-id="${id}" data-width="1920" data-height="1080" data-duration="4">
    <div id="${id}-word" class="clip" data-start="0" data-duration="4" data-track-index="0">${word}</div>
  </div>
</template>
`;
const NAMES = ["Card fan", 'Wall "A" <b>', "Carousel", "Orbit"];

test("an agent gives a title four versions; each edit carries them and only the active one is written", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Versions" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "versions-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
    ),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { projectId: project.id, ...args } });
  const result = async (name: string, args: Record<string, unknown>) => {
    const answer = await call(name, args);
    expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
    return z
      .object({ structuredContent: z.object({ result: z.unknown() }) })
      .parse(answer).structuredContent.result;
  };
  const refusal = async (name: string, args: Record<string, unknown>) => {
    const answer = await call(name, args);
    expect(answer.isError).toBe(true);
    return JSON.stringify(answer.content);
  };
  const read = async () =>
    TimelineViewSchema.parse(await result("timeline_read", {}));
  const edit = async (commands: unknown[]) =>
    result("timeline_edit", {
      expectedRevision: (await read()).revision,
      commands,
    });
  const source = async () =>
    SourceSchema.parse(await result("source_read", {})).content;
  const files = NAMES.map((_, index) => `compositions/line-${index}.html`);
  const versions = NAMES.map((name, index) => ({ name, src: files[index] }));
  try {
    for (const [index, path] of files.entries())
      await result("source_write", {
        path,
        expectedVersion: null,
        content: scene(`line-${index}`, `Take ${index}`),
      });
    await edit([
      {
        type: "insert",
        track: 4,
        at: 30,
        clip: { kind: "title", id: "line", text: "Welcome back", duration: 90 },
      },
    ]);

    // Paths and names are untrusted: each refusal leaves the clip as it was.
    for (const [src, reason] of [
      ["../outside.html", "outside hidden folders"],
      [".cutroom/line.html", "outside hidden folders"],
      ["compositions/missing.html", "not a file in this project"],
    ])
      expect(
        await refusal("clip_versions_set", {
          clipId: "line",
          versions: [versions[0], { name: "Bad", src }],
        }),
      ).toContain(reason);
    expect(
      await refusal("clip_versions_set", {
        clipId: "line",
        versions: [versions[0], { name: "Bell\u0007", src: files[1] }],
      }),
    ).toContain("control characters");

    // A title becomes a scene clip in its place, showing the first version.
    const created = z
      .object({ clipId: z.string() })
      .parse(await result("clip_versions_set", { clipId: "line", versions }));
    const id = created.clipId;
    // The owner's Changes list reads it as one change, not as the lift that made room for it.
    const { clipEdits } = TimelineViewSchema.parse(
      await (
        await fixture.request(`/projects/${project.id}/timeline?clipEdits=1`)
      ).json(),
    );
    expect(
      ledgerChanges(clipEdits!)
        .filter((change) => change.members.some((edit) => edit.clipId === id))
        .map(({ label, more }) => [label, more]),
    ).toEqual([['Gave Welcome back 4 versions, showing "Card fan"', null]]);
    const placed = (await read()).timeline.clips.find((clip) => clip.id === id);
    expect(placed).toMatchObject({
      kind: "composition",
      track: 4,
      start: 30,
      duration: 90,
      label: "Welcome back",
      src: files[0],
      versions,
    });
    const written = await source();
    // Only the active file is mounted; the list is an escaped attribute HyperFrames ignores.
    expect(written).toContain(`data-composition-src="${files[0]}"`);
    expect(written).not.toContain(`data-composition-src="${files[1]}"`);
    expect(written).toContain("&quot;Wall \\&quot;A\\&quot; <b>&quot;");

    expect(await result("clip_versions_list", { clipId: id })).toEqual({
      clipId: id,
      kind: "composition",
      start: 30,
      duration: 90,
      track: 4,
      active: 0,
      versions: versions.map((version, index) => ({ index, ...version })),
    });

    // Switching by name rewrites the host to mount the other scene, as one undo step.
    await result("clip_version_show", { clipId: id, version: "Orbit" });
    const shown = await source();
    expect(shown).toContain(`data-composition-src="${files[3]}"`);
    expect(shown).toContain('data-composition-id="line-3"');
    await result("history_undo", {});
    expect(await source()).toContain(`data-composition-src="${files[0]}"`);
    await result("history_redo", {});

    // A razor leaves both pieces holding every version, each switchable on its own.
    await edit([
      { type: "split", at: 60, clipIds: [id], ids: { [id]: ["tail"] } },
      { type: "setVersion", clipId: "tail", version: 1 },
    ]);
    const pieces = (await read()).timeline.clips.filter(
      (clip) => clip.kind === "composition",
    );
    expect(
      pieces.map((clip) => [clip.id, clip.start, clip.src, clip.versions]),
    ).toEqual([
      [id, 30, files[3], versions],
      ["tail", 60, files[1], versions],
    ]);

    // Move, trim and copy and paste keep the list too.
    await edit([{ type: "move", clipIds: ["tail"], by: 60 }]);
    await edit([{ type: "trim", clipId: "tail", edge: "end", to: 140 }]);
    const copied = z.object({ id: z.string() }).parse(
      await result("timeline_copy", {
        clipIds: ["tail"],
        expectedRevision: (await read()).revision,
      }),
    );
    await edit([
      {
        type: "paste",
        clipboardId: copied.id,
        at: 200,
        ids: { tail: ["pasted"] },
      },
    ]);
    const pasted = (await read()).timeline.clips.find(
      (clip) => clip.id === "pasted",
    );
    expect(pasted).toMatchObject({ src: files[1], versions, duration: 20 });

    // Keep drops the others, and its undo brings the whole list back.
    await result("clip_version_keep", { clipId: "pasted" });
    const kept = (await read()).timeline.clips.find(
      (clip) => clip.id === "pasted",
    );
    expect(kept?.versions).toBeUndefined();
    expect(kept?.src).toBe(files[1]);
    await result("history_undo", {});
    expect(
      (await read()).timeline.clips.find((clip) => clip.id === "pasted")
        ?.versions,
    ).toEqual(versions);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});

test("video versions bind native source frames to both linked elements through slips, cuts and history", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Media versions" });
  const base = `/api/cutroom/projects/${project.id}`;
  const post = (path: string, body: unknown) =>
    fixture.app.request(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.app.request(base + "/timeline")).json(),
    );
  const source = () => Bun.file(`${project.path}/index.html`).text();
  const edit = async (commands: unknown[]) => {
    const response = await post("/commands", {
      expectedRevision: (await read()).revision,
      commands,
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    return TimelineViewSchema.parse(await response.json());
  };
  const clip = async (id: string) =>
    (await read()).timeline.clips.find((clip) => clip.id === id);
  try {
    for (const [name, rate, duration, audio] of [
      ["interview", 30, 5, true],
      ["wide", 24, 5, false],
      ["short", 30, 1, false],
    ] as const) {
      const process = Bun.spawn(
        [
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=s=64x64:r=${rate}:d=${duration}`,
          ...(audio
            ? [
                "-f",
                "lavfi",
                "-i",
                `sine=frequency=440:duration=${duration}`,
                "-c:a",
                "aac",
              ]
            : []),
          "-c:v",
          "libx264",
          "-threads",
          "1",
          `${project.path}/${name}.mp4`,
        ],
        { stderr: "pipe" },
      );
      expect(
        await process.exited,
        await new Response(process.stderr).text(),
      ).toBe(0);
    }
    await edit([
      {
        type: "insert",
        track: 3,
        at: 30,
        linkedAudio: { id: "sound" },
        clip: {
          kind: "video",
          src: "interview.mp4",
          id: "picture",
          duration: 60,
          mediaStart: 1,
        },
      },
    ]);
    await edit([{ type: "addVersion", clipId: "picture" }]);
    await edit([{ type: "slip", clipId: "picture", by: 12 }]);
    expect(await clip("picture")).toMatchObject({
      versionIndex: 1,
      mediaStart: 1.4,
      versions: [
        { name: "Take 1", sourceIn: 30 },
        { name: "Take 2", sourceIn: 42 },
      ],
    });
    expect(await clip("sound")).toMatchObject({
      mediaStart: 1.4,
      hasAudio: true,
    });
    await edit([
      {
        type: "setVersions",
        clipId: "picture",
        versions: [
          // Commands give the In in seconds; the timeline counts source frames.
          { name: "Take 1", src: "interview.mp4", sourceIn: 1 },
          { name: "Wide", src: "wide.mp4", sourceIn: 1.5 },
          { name: "Short", src: "short.mp4" },
        ],
      },
    ]);
    expect(await clip("picture")).toMatchObject({
      versions: [{ fits: true }, { fits: true }, { fits: false, shortBy: 30 }],
    });
    await edit([{ type: "setVersion", clipId: "picture", version: 1 }]);
    expect(await clip("picture")).toMatchObject({
      src: "wide.mp4",
      mediaStart: 1.5,
      start: 30,
      duration: 60,
    });
    expect(await clip("sound")).toMatchObject({
      src: "wide.mp4",
      mediaStart: 1.5,
      hasAudio: false,
    });
    expect(await source()).toMatch(/<audio[^>]*src="wide.mp4"[^>]*muted=""/);

    await edit([
      {
        type: "split",
        at: 45,
        clipIds: ["picture"],
        ids: { picture: ["tail"], sound: ["tail-sound"] },
      },
    ]);
    expect(await clip("picture")).toMatchObject({
      versions: [{ sourceIn: 30 }, { sourceIn: 36 }, { sourceIn: 0 }],
    });
    expect(await clip("tail")).toMatchObject({
      duration: 45,
      mediaStart: 2,
      versionIndex: 1,
      versions: [
        { sourceIn: 45 },
        { sourceIn: 48 },
        { sourceIn: 15, fits: false },
      ],
    });
    await edit([{ type: "trim", clipId: "tail", edge: "start", to: 51 }]);
    expect(await clip("tail")).toMatchObject({
      versions: [{ sourceIn: 51 }, { sourceIn: 52.8 }, { sourceIn: 21 }],
    });
    await edit([{ type: "setVersion", clipId: "tail", version: 0 }]);
    expect(await clip("tail-sound")).toMatchObject({
      src: "interview.mp4",
      mediaStart: 1.7,
      hasAudio: true,
    });
    const complete = await source();
    await edit([{ type: "keepVersion", clipId: "tail" }]);
    expect((await clip("tail"))?.versions).toBeUndefined();
    expect((await post("/history/undo", {})).ok).toBe(true);
    expect(await source()).toBe(complete);
  } finally {
    await fixture.close();
  }
});

test("an offline take stays unavailable after a rename or a cross-folder paste", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Offline take" });
  const base = `/projects/${project.id}`;
  const entry = "index.html";
  const scene = "compositions/scene.html";
  const read = async (composition: string) =>
    TimelineViewSchema.parse(
      await (
        await fixture.request(`${base}/timeline?composition=${composition}`)
      ).json(),
    );
  const edit = async (composition: string, commands: unknown[]) =>
    fixture.request(`${base}/commands`, "POST", {
      composition,
      expectedRevision: (await read(composition)).revision,
      commands,
    });
  const versionState = ({ timeline }: z.infer<typeof TimelineViewSchema>) =>
    timeline.clips[0]?.versions?.map(({ name, src, offline }) => ({
      name,
      src,
      offline: offline === true,
    }));
  try {
    const live = join(project.path, "live.wav");
    const alternate = join(project.path, "alternate.wav");
    const parked = join(project.path, "moved.wav");
    const ffmpeg = Bun.spawnSync([
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=2",
      live,
    ]);
    expect(ffmpeg.exitCode, ffmpeg.stderr.toString()).toBe(0);
    await Bun.write(alternate, Bun.file(live));
    await Bun.write(
      join(project.path, entry),
      '<main data-composition-id="main" data-fps="30"><audio id="voice" src="live.wav" data-start="0" data-duration="2" data-track-index="0"></audio></main>',
    );
    await mkdir(join(project.path, "compositions"), { recursive: true });
    await Bun.write(
      join(project.path, scene),
      '<template><div data-composition-id="scene" data-fps="30"></div></template>',
    );
    const seeded = await edit(entry, [
      {
        type: "setVersions",
        clipId: "voice",
        versions: [
          { name: "Live", src: "live.wav" },
          { name: "Alternate", src: "alternate.wav" },
        ],
      },
    ]);
    expect(seeded.status, await seeded.text()).toBe(200);

    await rename(alternate, parked);
    const renamed = TimelineViewSchema.parse(
      await (
        await edit(entry, [
          {
            type: "renameVersion",
            clipId: "voice",
            version: 1,
            name: "Alternate read",
          },
        ])
      ).json(),
    );
    expect(versionState(renamed)).toEqual([
      { name: "Live", src: "live.wav", offline: false },
      { name: "Alternate read", src: "alternate.wav", offline: true },
    ]);

    await rename(parked, alternate);
    const copied = await fixture.request(`${base}/timeline/copy`, "POST", {
      composition: entry,
      expectedRevision: (await read(entry)).revision,
      clipIds: ["voice"],
    });
    const clipboard = z.object({ id: z.string() }).parse(await copied.json());
    await rename(alternate, parked);
    const paste = {
      type: "paste",
      clipboardId: clipboard.id,
      at: 0,
      ids: { voice: ["pasted"] },
    };
    const refused = await edit(scene, [
      paste,
      { type: "setVersion", clipId: "pasted", version: 1 },
    ]);
    expect(refused.status, await refused.clone().text()).toBe(422);
    expect(await refused.text()).toContain("Alternate read is offline");
    const pasted = TimelineViewSchema.parse(
      await (await edit(scene, [paste])).json(),
    );
    expect(versionState(pasted)).toEqual([
      { name: "Live", src: "../live.wav", offline: false },
      { name: "Alternate read", src: "../alternate.wav", offline: true },
    ]);
    expect(versionState(await read(scene))).toEqual(versionState(pasted));
  } finally {
    await fixture.close();
  }
});

test("renaming a take's file in Media renames it in the clip's versions", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Renamed take" });
  const base = `/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.request(`${base}/timeline`)).json(),
    );
  try {
    const live = join(project.path, "live.wav");
    const ffmpeg = Bun.spawnSync([
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=2",
      live,
    ]);
    expect(ffmpeg.exitCode, ffmpeg.stderr.toString()).toBe(0);
    await Bun.write(join(project.path, "alternate.wav"), Bun.file(live));
    await Bun.write(
      join(project.path, "index.html"),
      '<main data-composition-id="main" data-fps="30"><audio id="voice" src="live.wav" data-start="0" data-duration="2" data-track-index="0"></audio></main>',
    );
    const seeded = await fixture.request(`${base}/commands`, "POST", {
      expectedRevision: (await read()).revision,
      commands: [
        {
          type: "setVersions",
          clipId: "voice",
          versions: [
            { name: "Live", src: "live.wav" },
            { name: "Alternate", src: "alternate.wav", sourceIn: 0.5 },
          ],
        },
      ],
    });
    expect(seeded.status, await seeded.text()).toBe(200);
    const renamed = await fixture.request(`${base}/media/rename`, "POST", {
      path: "alternate.wav",
      name: "second read.wav",
    });
    expect(renamed.status, await renamed.text()).toBe(200);
    const [voice] = (await read()).timeline.clips;
    expect(
      voice!.versions!.map(({ name, src, offline }) => ({
        name,
        src,
        offline,
      })),
    ).toEqual([
      { name: "Live", src: "live.wav", offline: undefined },
      { name: "Alternate", src: "second read.wav", offline: undefined },
    ]);
    // The take keeps its In through the rename.
    expect(voice!.versions![1]!.sourceIn).toBeCloseTo(15, 6);
  } finally {
    await fixture.close();
  }
});
