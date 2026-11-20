import { expect, test } from "bun:test";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeResolveImporter } from "../src/server/resolve/importer";
import { planResolveTimeline } from "../src/server/resolve/plan";
import type { ClipMedia } from "../src/server/resolve/plan";
import { applyAll } from "../src/shared/timeline/apply";
import { CommandSchema, TimelineSchema } from "../src/shared/timeline/schema";
import { newTrack } from "../src/shared/timeline/tracks";
import { projectFixture } from "./project-fixture";

test.skipIf(!Bun.which("python3"))(
  "the exported Resolve command checks its inputs, restores cuts and rolls back failures",
  async () => {
    const fixture = await projectFixture();
    try {
      const project = await fixture.store.create({
        name: "Portable",
        width: 640,
        height: 360,
        duration: 4,
      });
      const original = join(fixture.directory, "old\u2028package\u2029");
      const moved = join(fixture.directory, "new package");
      const lutRoot = join(fixture.directory, "registered LUTs");
      await mkdir(join(original, "Media"), { recursive: true });
      await mkdir(lutRoot);
      const source = join(original, "Media", "camera #1.mov");
      const audio = join(original, "Media", "voice.wav");
      await writeFile(source, "MediaPool test double does not decode inputs.");
      await writeFile(audio, "MediaPool test double does not decode inputs.");
      const fps = { num: 24, den: 1 };
      const size = { width: 640, height: 360 };
      const empty = TimelineSchema.parse({
        fps,
        duration: 96,
        tracks: [
          newTrack(0, "video"),
          { ...newTrack(1, "video"), name: "Spare", locked: true },
          newTrack(2, "video"),
          newTrack(3, "audio"),
        ],
        clips: [],
        markers: [],
        range: { in: null, out: null },
      });
      const timeline = applyAll(
        empty,
        [
          {
            type: "insert",
            track: 2,
            at: 12,
            clip: {
              id: "camera",
              kind: "video",
              src: "camera #1.mov",
              mediaStart: 1.5,
              duration: 48,
              label: "Camera\u2028left\uD800",
              muted: true,
            },
          },
          { type: "setTiming", clipId: "camera", playbackRate: 0.5 },
          {
            type: "setClip",
            clipId: "camera",
            grade: { adjust: { exposure: 1 } },
          },
          ...[12, 36].map((at, index) => ({
            type: "insert",
            track: 3,
            at,
            clip: {
              id: `voice-${index}`,
              kind: "audio",
              src: "voice.wav",
              mediaStart: 1.5,
              duration: 24,
              label: `Voice take ${index + 1}`,
            },
          })),
          {
            type: "setTransition",
            from: "voice-0",
            to: "voice-1",
            transition: { duration: 12 },
          },
          {
            type: "setMarker",
            frame: 7,
            color: "cyan",
            duration: 5,
            name: "Lead \uD800\ncue",
            note: "First line\nCafé\uDC00",
          },
          { type: "setMarker", frame: 7, name: "Spare\nrow\uD800" },
        ].map((command) => CommandSchema.parse(command)),
        {
          mediaLengths: new Map([
            ["camera #1.mov", 8],
            ["voice.wav", 8],
          ]),
        },
      );
      const voice = {
        kind: "file" as const,
        facts: {
          path: audio,
          video: null,
          audio: { channels: 1, sampleRate: 48000, codec: "pcm_s16le" },
          duration: 8,
        },
      };
      const plan = planResolveTimeline({
        name: "Portable",
        timeline,
        size,
        media: new Map<string, ClipMedia>([
          [
            "camera",
            {
              kind: "file",
              facts: {
                path: source,
                video: { rate: fps, ...size, timecode: 0, start: 0 },
                audio: null,
                duration: 8,
              },
            },
          ],
          ["voice-0", voice],
          ["voice-1", voice],
        ]),
      });
      const fcpxml = join(original, "Portable.fcpxml");
      await writeFile(fcpxml, plan.fcpxml);
      const importer = await writeResolveImporter(
        {
          project,
          name: "Portable",
          composition: "index.html",
          timeline,
          size,
          images: new Map(),
        },
        fcpxml,
        plan,
      );
      expect(plan.notes.join("\n")).toContain('marker "Spare row\uFFFD"');
      expect(importer.instructions.join("\n")).toContain(
        '"Camera left\uFFFD" on V3',
      );
      const commands = importer.instructions.filter((line) =>
        line.startsWith("import runpy"),
      );
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        expect(command).toContain("old\\u2028package\\u2029");
        expect(command).not.toMatch(/[\u2028\u2029]/);
      }
      await rename(original, moved);
      const runner = new URL(
        "./fixtures/resolve-import-probe.py",
        import.meta.url,
      );
      const process = Bun.spawn(
        ["python3", fileURLToPath(runner), moved, lutRoot],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const [stderr, code] = await Promise.all([
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(code, stderr).toBe(0);
    } finally {
      await fixture.close();
    }
  },
  30_000,
);
