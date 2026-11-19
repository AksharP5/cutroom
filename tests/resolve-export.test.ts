import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ResolveExportSchema } from "../src/shared/export";
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
      expect(files).toEqual(
        process.platform === "linux"
          ? ["Night-shoot.fcpxml", "Sound", "Summary.txt"]
          : ["Night-shoot.fcpxml", "Summary.txt"],
      );
      const fcpxml = await readFile(result.timeline, "utf8");
      if (process.platform === "linux") {
        // Resolve on Linux can't decode AAC, so the sound that plays comes as a WAV Resolve won't swap back.
        expect(
          (await readdir(join(result.outputPath, "Sound"))).sort(),
        ).toEqual(["blue sound.wav"]);
        expect(fcpxml).toContain("Sound/blue%20sound.wav");
      }
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

      const script = await readFile(result.gradeScript!, "utf8");
      expect(script).toContain(JSON.stringify('Chart "A" & cut.fcpxml'));
      expect(script).toContain(
        'ImportTimelineFromFile(str(path), {"importSourceClips": True})',
      );
      expect(script).toContain("project.RefreshLUTList()");
      expect(script).toContain('destination.open("xb")');
      expect(script).toMatch(
        /GetSetting\("colorUseLocalVersionsAsDefault"\)[\s\S]+raise RuntimeError[\s\S]+ImportTimelineFromFile/,
      );
      expect(script).toContain('imported.GetItemListInTrack("video", track)');
      expect(script).toContain("graph.SetLUT(1, lut)");
      const assignments = [
        ...script.matchAll(
          /\[1,(\d+),(\d+),"Cutroom Grades\/([a-f\d]+\.cube)"\]/g,
        ),
      ];
      expect(assignments.map(([, start, end]) => [start, end])).toEqual([
        ["0", "30"],
        ["30", "60"],
        ["60", "90"],
      ]);
      expect(assignments[0]?.[3]).toBe(assignments[1]?.[3]);
      expect(assignments[2]?.[3]).not.toBe(assignments[0]?.[3]);
      expect(cubes).toContain(assignments[0]?.[3]);
      expect(cubes).toContain(assignments[2]?.[3]);

      const summary = await readFile(result.summary, "utf8");
      expect(summary).toContain("Use local version for new clips in timeline");
      expect(summary).toContain("Open LUT Folder");
      expect(summary).toContain("cutroom_lut_root");
      expect(summary).toContain("Workspace > Console");
      expect(summary).toContain(
        `runpy.run_path(${JSON.stringify(result.gradeScript)}`,
      );
      expect(summary).toContain(
        `at 00:00:01:00 on V1: LUTs/Cutroom Grades/${assignments[1]?.[3]}`,
      );
      expect(summary).toContain("offline.mp4 is offline");
    } finally {
      await api.dispose();
      await f.close();
    }
  },
  30_000,
);
