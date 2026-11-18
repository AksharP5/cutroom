import { expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyAll } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput, Timeline } from "../src/shared/timeline/schema";
import { newTrack } from "../src/shared/timeline/tracks";
import { exportResolve } from "../src/server/resolve/export";
import { layerHtml, layerTracks } from "../src/server/resolve/layers";
import { parseComposition } from "../src/server/timeline/composition";
import { projectFixture } from "./project-fixture";

const NTSC = { num: 30000, den: 1001 };

/** Footage on V1, a title on V2, a zoom and a blur layer on V3 and V4. */
function edit(): Timeline {
  const commands: CommandInput[] = [
    {
      type: "insert",
      track: 0,
      at: 0,
      clip: { id: "shot", kind: "video", src: "shot.mp4", duration: 90 },
    },
    {
      type: "insert",
      track: 1,
      at: 30,
      clip: { id: "hello", kind: "title", text: "Hello", duration: 30 },
    },
    {
      type: "insert",
      track: 1,
      at: 75,
      clip: { id: "bye", kind: "title", text: "Bye", duration: 10 },
    },
    {
      type: "insert",
      track: 2,
      at: 0,
      clip: {
        id: "zoom",
        kind: "adjustment",
        duration: 30,
        region: { effect: "zoom" },
      },
    },
    {
      type: "insert",
      track: 3,
      at: 60,
      clip: {
        id: "blur",
        kind: "adjustment",
        duration: 15,
        region: { effect: "blur" },
      },
    },
  ];
  return applyAll(
    {
      fps: NTSC,
      duration: 90,
      tracks: [0, 1, 2, 3].map((index) => newTrack(index, "video")),
      clips: [],
      markers: [],
      range: { in: null, out: null },
    },
    commands.map((command) => CommandSchema.parse(command)),
    { mediaLengths: new Map([["shot.mp4", 10]]) },
  );
}

test("each video track renders what Resolve can't open in one layer; zooms stay keyframes", () => {
  const layers = layerTracks(edit(), new Set(["shot"]));
  expect(
    layers.map(({ track, start, end, clips, flatten }) => ({
      track,
      start,
      end,
      clips: clips.map((clip) => clip.id),
      flatten,
    })),
  ).toEqual([
    { track: 1, start: 30, end: 85, clips: ["hello", "bye"], flatten: false },
    { track: 3, start: 60, end: 75, clips: ["blur"], flatten: true },
  ]);
});

test("a layer render shows only its own clips, silent, over a clear background", () => {
  const html = `<!doctype html><html><head><style>main{background:#000}</style></head><body>
<main data-composition-id='a"b' data-width="320" data-height="240" data-duration="3" style="background:#111">
<video id="shot" src="shot.mp4" data-start="0" data-duration="3" data-track-index="0"></video>
<div id="hello" class="clip" data-start="1" data-duration="1" data-track-index="1">Hello</div>
<div id="other" class="clip" data-start="0" data-duration="2" data-track-index="2">Other</div>
<audio id="music" src="music.wav" data-start="0" data-duration="3" data-track-index="3"></audio>
</main></body></html>`;
  const parsed = parseComposition(html, emptyTimelineSettings());
  const layer = layerTracks(parsed.timeline, new Set(["shot", "music"])).find(
    ({ track }) => track === 1,
  )!;
  const drawn = layerHtml(parsed, layer);
  const tag = (id: string) =>
    drawn.match(new RegExp(`<[a-z]+ id="${id}"[^>]*>`))![0];
  expect(tag("shot")).toContain("data-hidden");
  expect(tag("other")).toContain("data-hidden");
  expect(tag("hello")).not.toContain("data-hidden");
  expect(tag("music")).toContain("data-hidden");
  // The id is a CSS string, so its quote can't end the selector or the style element.
  expect(drawn).toContain(
    '<style>html,body,[data-composition-id="a\\22 b"]{background:transparent!important}</style></head>',
  );
});

test.skipIf(!Bun.which("ffmpeg"))(
  "layer clips are cuts of their track's render",
  async () => {
    const f = await projectFixture();
    try {
      const project = await f.store.create({
        name: "Layers",
        width: 320,
        height: 240,
        duration: 3,
      });
      const run = async (args: string[]) => {
        const child = Bun.spawn(args, { stderr: "pipe" });
        if ((await child.exited) !== 0)
          throw new Error(await new Response(child.stderr).text());
      };
      await run([
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x240:r=30000/1001:d=4",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        join(project.path, "shot.mp4"),
      ]);
      const rendered: { track: number; start: number; end: number }[] = [];
      const result = await exportResolve(
        {
          project,
          composition: "index.html",
          name: "Layers",
          timeline: edit(),
          size: { width: 320, height: 240 },
          images: new Map(),
        },
        {
          directory: f.directory,
          copyMedia: false,
          render: async (layer, output) => {
            rendered.push({
              track: layer.track,
              start: layer.start,
              end: layer.end,
            });
            const path = join(output.directory, output.filename);
            await run([
              "ffmpeg",
              "-v",
              "error",
              "-nostdin",
              "-f",
              "lavfi",
              "-i",
              `color=c=black@0:s=320x240:r=30000/1001:d=${((layer.end - layer.start) * 1001) / 30000},format=yuva444p10le`,
              "-c:v",
              "prores_ks",
              "-profile:v",
              "4444",
              path,
            ]);
            return path;
          },
        },
      );
      expect(rendered).toEqual([
        { track: 1, start: 30, end: 85 },
        { track: 3, start: 60, end: 75 },
      ]);
      expect((await readdir(join(result.outputPath, "Layers"))).sort()).toEqual(
        ["V2.mov", "V4.mov"],
      );
      const fcpxml = await readFile(result.timeline, "utf8");
      // "Bye" starts 45 frames into V2's render, at frame 75 on lane 1.
      expect(fcpxml).toMatch(
        /<video ref="r\d+" lane="1" name="Bye" offset="[^"]+" start="3003\/2000s"/,
      );
      expect(fcpxml).toMatch(
        /<video ref="r\d+" lane="3" name="[^"]*" offset="[^"]+" start="0s" duration="1001\/2000s"/,
      );
      const summary = await readFile(result.summary, "utf8");
      expect(summary).toContain(
        "V2's titles, scenes and other clips Resolve can't open are rendered with transparency in Layers/V2.mov",
      );
      expect(summary).not.toContain("not carried: Resolve can't open it");

      // A render that fails takes the half-written folder with it.
      await writeFile(join(f.directory, "marker"), "");
      await expect(
        exportResolve(
          {
            project,
            composition: "index.html",
            name: "Layers",
            timeline: edit(),
            size: { width: 320, height: 240 },
            images: new Map(),
          },
          {
            directory: f.directory,
            copyMedia: false,
            render: async () => {
              throw new Error("no browser");
            },
          },
        ),
      ).rejects.toThrow("no browser");
      expect(
        (await readdir(f.directory)).filter((name) =>
          name.startsWith("Layers Resolve"),
        ),
      ).toEqual(["Layers Resolve"]);
    } finally {
      await f.close();
    }
  },
  60_000,
);
