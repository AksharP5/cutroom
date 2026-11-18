import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ResolveExportSchema } from "../src/shared/export";
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
