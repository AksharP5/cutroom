import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { voiceoverCommands, voiceoverWav } from "../src/shared/voiceover";
import { desktopPermission } from "../src/desktop/permissions";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { newTrack } from "../src/shared/timeline/tracks";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";

test("sample-clock crop removes a fractional-frame delay and writes portable PCM WAV", () => {
  const { bytes, droppedSamples } = voiceoverWav(
    [
      { frame: 100, samples: Int16Array.of(9, 8, 7, 6) },
      { frame: 104, samples: Int16Array.of(5, 4, 3, 2) },
    ],
    103,
    4,
    48000,
  );
  const view = new DataView(bytes);
  expect(Buffer.from(bytes).subarray(0, 4).toString()).toBe("RIFF");
  expect(view.getUint32(24, true)).toBe(48000);
  expect(view.getUint32(40, true)).toBe(8);
  expect([44, 46, 48, 50].map((at) => view.getInt16(at, true))).toEqual([
    6, 5, 4, 3,
  ]);
  expect(droppedSamples).toBe(0);
  const partial = voiceoverWav(
    [{ frame: 105, samples: Int16Array.of(1) }],
    103,
    4,
    48000,
  );
  expect(partial.droppedSamples).toBe(3);
  expect(Array.from(new Int16Array(partial.bytes, 44))).toEqual([0, 0, 1, 0]);
});

test("a gap keeps every surviving sample at its exact position", () => {
  const { bytes, droppedSamples } = voiceoverWav(
    [
      { frame: 100, samples: Int16Array.of(11, 12, 13, 14) },
      { frame: 107, samples: Int16Array.of(-15, -16, -17, -18) },
    ],
    102,
    8,
    48000,
  );
  expect(Array.from(new Int16Array(bytes, 44))).toEqual([
    13, 14, 0, 0, 0, -15, -16, -17,
  ]);
  expect(droppedSamples).toBe(3);
});

test("recorded takes use the engine, preserve occupied audio, and undo leaves the media file", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Voiceover" });
  const base = `/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.request(`${base}/timeline`)).json(),
    );
  const armed = newTrack(3, "audio");
  try {
    await mkdir(join(project.path, "assets/voiceover"), { recursive: true });
    const file = "assets/voiceover/take.wav";
    const { bytes: wav } = voiceoverWav(
      [{ frame: 0, samples: new Int16Array(96000) }],
      0,
      96000,
      48000,
    );
    await writeFile(join(project.path, file), new Uint8Array(wav));
    const first = await read();
    const commands = voiceoverCommands(first.timeline, armed, 30, 60, file);
    const placed = await fixture.request(`${base}/commands`, "POST", {
      expectedRevision: first.revision,
      commands,
      label: "Record voiceover",
    });
    expect(placed.status).toBe(200);
    const after = TimelineViewSchema.parse(await placed.json());
    const take = after.timeline.clips.find(
      (clip) => clip.kind === "voiceover",
    )!;
    expect(take).toMatchObject({
      start: 30,
      duration: 60,
      mediaStart: 0,
      hasAudio: true,
      track: 3,
      src: file,
      sourceDuration: 2,
    });
    const html = await readFile(join(project.path, "index.html"), "utf8");
    expect(html).toContain('data-cutroom-kind="voiceover"');
    expect(html).toMatch(/<audio[^>]*data-cutroom-kind="voiceover"/);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createMcpHttpHandler({
        fetch: (url, init) => fixture.app.request(url, init),
      }),
    });
    const client = new Client({ name: "voiceover-agent", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${server.port}/mcp`),
        ),
      );
      const readback = z
        .object({ structuredContent: z.object({ result: TimelineViewSchema }) })
        .parse(
          await client.callTool({
            name: "timeline_read",
            arguments: { projectId: project.id },
          }),
        );
      expect(
        readback.structuredContent.result.timeline.clips.find(
          (clip) => clip.id === take.id,
        ),
      ).toEqual(take);
      const edited = z
        .object({ structuredContent: z.object({ result: TimelineViewSchema }) })
        .parse(
          await client.callTool({
            name: "timeline_edit",
            arguments: {
              projectId: project.id,
              expectedRevision: readback.structuredContent.result.revision,
              commands: [
                {
                  type: "setClip",
                  clipId: take.id,
                  volume: 0.5,
                  fadeIn: 5,
                  fadeOut: 7,
                },
                { type: "move", clipIds: [take.id], trackBy: 1 },
              ],
            },
          }),
        );
      expect(
        edited.structuredContent.result.timeline.clips.find(
          (clip) => clip.id === take.id,
        ),
      ).toMatchObject({
        kind: "voiceover",
        volume: 0.5,
        fadeIn: 5,
        fadeOut: 7,
        track: 4,
      });
      expect(
        edited.structuredContent.result.clipEdits?.some(
          (edit) =>
            edit.clipId === take.id && edit.label.includes("1 track down"),
        ),
      ).toBe(true);
      await fixture.request(`${base}/history/undo`, "POST", {});
      expect((await read()).timeline).toEqual(after.timeline);
    } finally {
      await client.close();
      await server.stop(true);
    }
    const repeat = voiceoverCommands(after.timeline, armed, 60, 30, file);
    const second = await fixture.request(`${base}/commands`, "POST", {
      expectedRevision: after.revision,
      commands: repeat,
    });
    expect(second.status).toBe(200);
    const doubled = await read();
    expect(doubled.timeline.clips.find((clip) => clip.id === take.id)).toEqual(
      take,
    );
    expect(
      doubled.timeline.clips
        .filter((clip) => clip.kind === "voiceover")
        .map((clip) => clip.track),
    ).toEqual([3, 4]);
    await fixture.request(`${base}/history/undo`, "POST", {});
    expect((await read()).timeline).toEqual(after.timeline);
    await fixture.request(`${base}/history/undo`, "POST", {});
    expect((await read()).timeline).toEqual(first.timeline);
    expect((await readFile(join(project.path, file))).byteLength).toBe(
      wav.byteLength,
    );
    const locked = {
      ...after.timeline,
      tracks: after.timeline.tracks.map((track) => ({
        ...track,
        locked: true,
      })),
    };
    expect(voiceoverCommands(locked, armed, 120, 30, file)[0]).toMatchObject({
      type: "setTrack",
      index: 4,
      kind: "audio",
    });
  } finally {
    await fixture.close();
  }
});

test("desktop microphone permission is audio-only and restricted to the editor main frame", () => {
  const origin = "http://127.0.0.1:4317";
  expect(desktopPermission("media", origin, origin, true, ["audio"])).toBe(
    true,
  );
  expect(desktopPermission("media", origin, origin, false, ["audio"])).toBe(
    false,
  );
  expect(
    desktopPermission("media", origin, origin, true, ["audio", "video"]),
  ).toBe(false);
  expect(desktopPermission("media", origin, origin, true, [])).toBe(false);
  expect(
    desktopPermission("media", "https://example.com", origin, true, ["audio"]),
  ).toBe(false);
});
