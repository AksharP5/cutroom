import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ResolveExportSchema } from "../src/shared/export";
import { voiceoverWav } from "../src/shared/voiceover";
import { readCube } from "../src/server/grade/luts";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createMcpServer } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";

async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const [error, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
}

/** Two seconds of picture and AAC sound at 29.97, as cameras and screen recorders write it. */
const clip = (path: string, colour: string) =>
  run([
    "ffmpeg",
    ...["-v", "error", "-nostdin"],
    ...["-f", "lavfi", "-i", `color=c=${colour}:s=320x240:r=30000/1001:d=2`],
    ...["-f", "lavfi", "-i", "sine=f=440:d=2:r=48000"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
    ...["-c:a", "aac", "-shortest", path],
  ]);

test.skipIf(!Bun.which("ffmpeg"))(
  "Resolve gets full-level stereo from a mono microphone and keeps native stereo media",
  async () => {
    const f = await projectFixture();
    f.app.route("/api", createHyperframesApi(f.store, f.review));
    try {
      const project = await f.store.create({
        name: "Dialogue",
        width: 320,
        height: 240,
        duration: 2,
      });
      const mono = join(project.path, "mic.wav");
      const stereo = join(project.path, "music.wav");
      await Promise.all([
        run([
          "ffmpeg",
          ...["-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=1:r=48000"],
          ...["-c:a", "pcm_s24le", mono],
        ]),
        run([
          "ffmpeg",
          ...[
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=0.25|0.125:s=48000:d=1",
          ],
          ...["-c:a", "pcm_s24le", stereo],
        ]),
      ]);
      await writeFile(
        join(project.path, "index.html"),
        `<main data-composition-id="main" data-width="320" data-height="240" data-fps="24" data-duration="2">
          <audio id="mic" src="mic.wav" data-start="0" data-duration="1" data-track-index="0" data-volume="0.5" data-fade-in="0.25"></audio>
          <audio id="music" src="music.wav" data-start="1" data-duration="1" data-track-index="0"></audio>
        </main>`,
      );
      const response = await f.app.request(
        `/api/projects/${project.id}/export`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ format: "resolve" }),
        },
      );
      const body: unknown = await response.json();
      expect(response.ok, JSON.stringify(body)).toBe(true);
      const exported = ResolveExportSchema.parse(body);
      const sound = join(exported.outputPath, "Sound");
      expect(await readdir(sound)).toEqual(["mic sound.wav"]);
      const xml = await readFile(exported.timeline, "utf8");
      expect(xml).toContain("Sound/mic%20sound.wav");
      expect(xml).toContain("music.wav");
      expect(xml).toContain('<adjust-volume amount="-6.0206dB"/>');
      expect(await readFile(exported.summary, "utf8")).toContain(
        "use the audio fade handles in Resolve to add a 6-frame fade-in",
      );

      const samples = async (path: string) => {
        const child = Bun.spawn(
          [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            path,
            "-t",
            "0.02",
            "-f",
            "s32le",
            "-",
          ],
          { stdout: "pipe" },
        );
        const raw = await new Response(child.stdout).arrayBuffer();
        expect(await child.exited).toBe(0);
        return new Int32Array(raw);
      };
      const [source, copied] = await Promise.all([
        samples(mono),
        samples(join(sound, "mic sound.wav")),
      ]);
      expect(source.length).toBe(960);
      expect(copied.filter((_, index) => index % 2 === 0)).toEqual(source);
      expect(copied.filter((_, index) => index % 2 === 1)).toEqual(source);
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffprobe"))(
  "Resolve names a clip with authored speed automation before writing an export",
  async () => {
    const f = await projectFixture();
    f.app.route("/api", createHyperframesApi(f.store, f.review));
    try {
      const project = await f.store.create({
        name: "Ramped interview",
        width: 320,
        height: 240,
        duration: 4,
      });
      const wav = voiceoverWav([], 0, 32_000, 8_000);
      await writeFile(join(project.path, "tone.wav"), Buffer.from(wav.bytes));
      const directory = join(f.directory, "deliveries");
      await mkdir(directory);
      const scene = "compositions/interview.html";
      await mkdir(join(project.path, "compositions"), { recursive: true });
      const rate = {
        target: "rate",
        points: [
          { t: 0, v: 0.5 },
          { t: 1, v: 2 },
        ],
      };
      const volume = { target: "volume", points: [{ t: 0, v: 0.5 }] };
      const effect = { target: "fx.n1.threshold", points: [{ t: 0, v: -12 }] };
      const html = (src: string, lanes: (typeof rate)[]) =>
        `<main data-composition-id="interview" data-width="320" data-height="240" data-duration="4"><hf-audio-group id="dialogue" data-volume="0.5"></hf-audio-group><div><audio id="tone" data-label="Interview sound" src="${src}" data-start="2" data-duration="1" data-track-index="0" data-playback-rate="2" data-audio-group="dialogue" data-automation='${JSON.stringify({ version: 1, lanes })}'></audio></div></main>`;
      const start = (options: Record<string, unknown>) =>
        f.app.request(`/api/projects/${project.id}/export`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ format: "resolve", ...options }),
        });

      await writeFile(
        join(project.path, "index.html"),
        html("tone.wav", [rate]),
      );
      const root = await start({ range: { start: 0, end: 30 } });
      expect(root.status).toBe(422);
      expect(await root.json()).toEqual({
        error: expect.stringContaining('"Interview sound"'),
      });
      await expect(
        stat(join(project.path, ".cutroom/renders")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });

      await writeFile(
        join(project.path, scene),
        `<template>${html("../tone.wav", [rate])}</template>`,
      );
      const nested = await start({ composition: scene, directory });
      expect(nested.status).toBe(422);
      expect(await nested.json()).toEqual({
        error: expect.stringContaining('"Interview sound"'),
      });
      expect(await readdir(directory)).toEqual([]);
      const invalid = await start({
        composition: scene,
        directory: join(directory, "missing"),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: "The output folder does not exist.",
      });

      await writeFile(
        join(project.path, scene),
        `<template>${html("../tone.wav", [volume, effect])}</template>`,
      );
      const scalar = await start({ composition: scene });
      const body: unknown = await scalar.json();
      expect(scalar.ok, JSON.stringify(body)).toBe(true);
      const result = ResolveExportSchema.parse(body);
      expect(result.outputPath).toStartWith(
        join(project.path, ".cutroom/renders/"),
      );
      const fcpxml = await readFile(result.timeline, "utf8");
      expect(fcpxml).toContain('name="Interview sound"');
      expect(fcpxml).not.toContain("<timeMap>");
      expect(fcpxml).toContain('<adjust-volume amount="-12.0412dB"/>');
      expect(result.importScript).toBeString();
      const summary = await readFile(result.summary, "utf8");
      expect(summary).toContain(
        '"Interview sound" on A1 at 00:00:02:00 plays at 100%',
      );
      expect(summary).toContain(
        "Change Clip Speed to 200% with Ripple Timeline off",
      );
      expect(summary).toContain("trim or extend the end to 00:00:03:00");
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "a Resolve export writes one new folder that links only the project's own media",
  async () => {
    const f = await projectFixture();
    const editor = createHyperframesApi(f.store, f.review);
    f.app.route("/api", editor);
    f.app.route("/api/cutroom", createTimelineRoutes(f.store, f.review));
    const server = createMcpServer({
      fetch: (url, init) => f.app.request(url, init),
    });
    const client = new Client({ name: "resolve-test", version: "1" });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await server.connect(remote);
    await client.connect(local);
    try {
      const project = await f.store.create({
        name: "Night/shoot",
        width: 320,
        height: 240,
        duration: 4,
      });
      await clip(join(project.path, "red.mp4"), "red");
      await clip(join(project.path, "blue.mp4"), "blue");
      // A file outside the project, linked into it, must never reach the timeline.
      await clip(join(f.directory, "outside.mp4"), "green");
      await symlink(
        join(f.directory, "outside.mp4"),
        join(project.path, "outside.mp4"),
      );
      const box = `style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"`;
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><head><meta charset="utf-8"></head><body><main data-composition-id="main" data-width="320" data-height="240" data-fps="30000/1001" data-duration="4" style="position:relative;width:320px;height:240px">
<video id="a" muted src="red.mp4" ${box} data-start="0" data-duration="2" data-media-start="0" data-track-index="0"></video>
<video id="b" src="blue.mp4" ${box} data-start="2" data-duration="1" data-media-start="0.5" data-track-index="0"></video>
<video id="c" muted src="outside.mp4" ${box} data-start="0" data-duration="1" data-track-index="1"></video>
</main></body></html>`,
      );
      const call = async (args: Record<string, unknown>) =>
        z
          .object({
            isError: z.boolean().optional(),
            content: z.array(z.object({ text: z.string().optional() })),
            structuredContent: z.object({ result: z.unknown() }).optional(),
          })
          .parse(
            await client.callTool({
              name: "export_start",
              arguments: { projectId: project.id, ...args },
            }),
          );

      const directory = join(f.directory, "deliveries");
      await mkdir(directory);
      await writeFile(join(directory, "keep.txt"), "untouched");
      const first = await call({ format: "resolve", directory });
      expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
      const result = ResolveExportSchema.parse(first.structuredContent!.result);
      // The project's name can't make a path: its slash becomes part of one folder name.
      expect(result.outputPath).toBe(join(directory, "Night-shoot Resolve"));
      expect((await readdir(directory)).sort()).toEqual([
        "Night-shoot Resolve",
        "keep.txt",
      ]);
      expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe(
        "untouched",
      );
      const files = (await readdir(result.outputPath)).sort();
      expect(files).toEqual([
        "Import Cutroom Timeline.py",
        "Night-shoot.fcpxml",
        "Sound",
        "Summary.txt",
      ]);
      const fcpxml = await readFile(result.timeline, "utf8");
      expect(await readdir(join(result.outputPath, "Sound"))).toEqual([
        "blue sound.wav",
      ]);
      expect(fcpxml).toContain("Sound/blue%20sound.wav");
      const sources = [...fcpxml.matchAll(/src="file:\/\/([^"]+)"/g)].map(
        ([, path]) => decodeURIComponent(path!),
      );
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources)
        expect(
          source.startsWith(project.path) ||
            source.startsWith(result.outputPath),
        ).toBe(true);
      expect(fcpxml).not.toContain("outside");
      expect(result.notes.some((note) => note.includes("outside.mp4"))).toBe(
        true,
      );
      const summary = await readFile(result.summary, "utf8");
      expect(summary).toContain("File > Import > Timeline");
      expect(summary).toContain("outside.mp4");

      // A second export never touches the first; copied media sits in the new folder.
      const second = ResolveExportSchema.parse(
        (await call({ format: "resolve", directory, copyMedia: true }))
          .structuredContent!.result,
      );
      expect(second.outputPath).toBe(join(directory, "Night-shoot Resolve 2"));
      expect((await readdir(join(second.outputPath, "Media"))).sort()).toEqual([
        "blue.mp4",
        "red.mp4",
      ]);
      const copied = await readFile(second.timeline, "utf8");
      expect(copied).toContain(
        `src="file://${encodeURI(join(second.outputPath, "Media", "red.mp4"))}"`,
      );
      expect(copied).not.toContain(project.path);

      const named = await call({
        format: "resolve",
        directory,
        filename: "x.mp4",
      });
      expect(named.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await editor.dispose();
      await f.close();
    }
  },
  60_000,
);

test.skipIf(!Bun.which("ffmpeg"))(
  "Resolve bakes identical grades once and writes an import script for the exported cuts",
  async () => {
    const f = await projectFixture();
    const api = createHyperframesApi(f.store, f.review);
    try {
      const project = await f.store.create({
        name: 'Chart "A" & cut',
        width: 320,
        height: 240,
        duration: 4,
      });
      await clip(join(project.path, "chart.mp4"), "red");
      const grade = (exposure: number) =>
        `data-color-grading='${JSON.stringify({ adjust: { exposure } })}'`;
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><main data-composition-id="main" data-width="320" data-height="240" data-fps="30000/1001" data-duration="4">
<video id="first" muted src="chart.mp4" data-start="0" data-duration="1.001" data-track-index="0" ${grade(1)}></video>
<video id="same" muted src="chart.mp4" data-start="1.001" data-duration="1.001" data-track-index="0" ${grade(1)}></video>
<video id="other" muted src="chart.mp4" data-start="2.002" data-duration="1.001" data-track-index="0" ${grade(-1)}></video>
<video id="offline" muted src="offline.mp4" data-start="3.003" data-duration="1.001" data-track-index="0" ${grade(2)}></video>
</main>`,
      );
      const response = await api.request(
        `http://localhost/projects/${project.id}/export`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ format: "resolve", directory: f.directory }),
        },
      );
      const body: unknown = await response.json();
      expect(response.ok, JSON.stringify(body)).toBe(true);
      const result = ResolveExportSchema.parse(body);
      expect(result.gradeScript).toBeString();

      const lutFolder = join(result.outputPath, "LUTs", "Cutroom Grades");
      const cubes = await readdir(lutFolder);
      expect(cubes).toHaveLength(2);
      for (const name of cubes) {
        expect(name).toMatch(/^[a-f0-9]{64}\.cube$/);
        const cube = readCube(await readFile(join(lutFolder, name)));
        expect(cube.size).toBe(65);
      }

      const summary = await readFile(result.summary, "utf8");
      const assignments = [
        ...summary.matchAll(
          /at (00:00:\d\d:00) on V1: LUTs\/Cutroom Grades\/([a-f\d]+\.cube)/g,
        ),
      ];
      expect(assignments.map(([, start]) => start)).toEqual([
        "00:00:00:00",
        "00:00:01:00",
        "00:00:02:00",
      ]);
      expect(assignments[0]?.[2]).toBe(assignments[1]?.[2]);
      expect(assignments[2]?.[2]).not.toBe(assignments[0]?.[2]);
      expect(cubes).toContain(assignments[0]?.[2]);
      expect(cubes).toContain(assignments[2]?.[2]);

      expect(summary).toContain("Use local version for new clips in timeline");
      expect(summary).toContain("Open LUT Folder");
      expect(summary).toContain("cutroom_lut_root");
      expect(summary).toContain("File LUT node in Fusion");
      expect(summary).toContain("Workspace > Console");
      expect(summary).toContain(
        `runpy.run_path(${JSON.stringify(result.gradeScript)}`,
      );
      expect(summary).toContain("offline.mp4 is offline");
    } finally {
      await api.dispose();
      await f.close();
    }
  },
  30_000,
);
