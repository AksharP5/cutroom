import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMediaMetadata } from "@hyperframes/engine";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
import { browserExecutable } from "../src/server/hyperframes/render";
import { sourcePictures } from "../src/server/media/pictureIndex";
import {
  parseComposition,
  patchComposition,
} from "../src/server/timeline/composition";
import { applyAll, canonicalTimeline } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import { emptyTimelineSettings } from "../src/shared/timeline/schema";
import type { Fps } from "../src/shared/timeline/schema";
import { countingIds } from "./clip-ids";

const ready =
  browserExecutable() && Bun.which("ffmpeg") && Bun.which("ffprobe");
const thirty = { num: 30, den: 1 };
const ntsc = { num: 30000, den: 1001 };

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(error);
  return Buffer.from(out);
}

const ffmpeg = (...args: string[]) =>
  command(["ffmpeg", "-v", "error", "-nostdin", ...args]);
const probe = async (path: string, ...args: string[]) =>
  (
    await command([
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      ...args,
      "-of",
      "csv=p=0",
      path,
    ])
  )
    .toString()
    .trim();

async function source(
  path: string,
  rate: string,
  count: number,
  extra: string[] = [],
) {
  // Encode the source ordinal in eight black and white cells, before retiming or reordering.
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    `nullsrc=s=96x54:r=${rate},geq=lum='if(mod(floor(N/pow(2,floor(X/12))),2),235,16)':cb=128:cr=128`,
    "-frames:v",
    String(count),
    "-c:v",
    "libx264",
    "-crf",
    "15",
    "-threads",
    "1",
    ...extra,
    path,
  );
}

async function labels(path: string) {
  const cells = await ffmpeg(
    "-i",
    path,
    "-map",
    "0:v:0",
    "-vf",
    "crop=96:2:0:26,scale=8:1:flags=area,format=gray",
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    "pipe:1",
  );
  return Array.from({ length: cells.length / 8 }, (_, frame) =>
    cells
      .subarray(frame * 8, frame * 8 + 8)
      .reduce((label, value, bit) => label + (value > 128 ? 1 << bit : 0), 0),
  );
}

const sequence = (count: number, at: (index: number) => number = (i) => i) =>
  Array.from({ length: count }, (_, index) => at(index));
const presentation = async (path: string) =>
  (await probe(path, "-show_entries", "frame=pts"))
    .split("\n")
    .filter(Boolean)
    .map((line) => Number(line.split(",")[0]));

function html(
  src: string,
  fps: Fps,
  count: number,
  mediaStart = 0,
  attrs = "",
) {
  const duration = ((count * fps.den) / fps.num).toFixed(6);
  return `<!doctype html><html><head><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}.stage{position:relative;width:100%;height:100%}</style></head>
<body><main id="main" class="stage" data-composition-id="main" data-no-timeline data-width="96" data-height="54" data-fps="${fps.num}/${fps.den}" data-duration="${duration}">
<video id="picture" src="${src}" muted data-start="0" data-duration="${duration}" data-media-start="${mediaStart}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain" ${attrs}></video>
</main></body></html>`;
}

function split(html: string) {
  const parsed = parseComposition(html, emptyTimelineSettings());
  const origins = new Map<string, ClipOrigin>();
  const timeline = canonicalTimeline(
    applyAll(
      parsed.timeline,
      [
        {
          type: "split",
          at: 59,
          clipIds: ["picture"],
          ids: { picture: ["tail"] },
        },
      ],
      { onCreate: (id, origin) => origins.set(id, origin), newId: countingIds },
    ),
  );
  return patchComposition(parsed, timeline, origins);
}

async function fixture(run: (root: string, render: Render) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "export-picture-"));
  const scratchDir = root + "-scratch";
  const workerPath =
    process.env.GITHUB_ACTIONS === "true"
      ? join(import.meta.dir, "fixtures/picture-render-worker.ts")
      : undefined;
  const capture = createRenderWorkers({
    scratchDir,
    workerPath,
    directExport: false,
  });
  const direct = createRenderWorkers({ scratchDir, workerPath });
  let output = 0;
  try {
    await run(root, async (html, fps, expected, renderer, range) => {
      await writeFile(join(root, "index.html"), html);
      const filename = `output-${++output}.mp4`;
      const workers = renderer === "direct" ? direct : capture;
      const state = workers.start(
        {
          project: { id: "picture-proof", dir: root },
          outputPath: join(root, filename),
          format: "mp4",
          fps,
          quality: "draft",
          jobId: filename,
        },
        { filename, directory: root, range: range ?? null },
      );
      const deadline = Date.now() + 150_000;
      while (state.status === "rendering" && Date.now() < deadline)
        await Bun.sleep(50);
      if (state.status === "rendering") {
        const stage = state.stage;
        await state.cancel();
        throw new Error(`Timed out exporting ${filename} at ${stage}.`);
      }
      if (state.error) throw new Error(state.error);
      expect(state.status).toBe("complete");
      expect(state.renderer).toBe(renderer);
      const actual = await labels(state.outputPath);
      expect(actual).toHaveLength(expected.length);
      const wrong = actual.findIndex(
        (label, index) => label !== expected[index],
      );
      expect(
        wrong,
        `${renderer} ${html.match(/src="([^"]+)"/)?.[1]} frame ${wrong + (range?.start ?? 0)} expected label ${expected[wrong]}, got ${actual[wrong]}`,
      ).toBe(-1);
    });
  } finally {
    await Promise.all(
      [root, scratchDir].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  }
}

type Render = (
  html: string,
  fps: Fps,
  expected: number[],
  renderer: "capture" | "direct",
  range?: { start: number; end: number },
) => Promise<void>;

test.skipIf(!ready)(
  "P1–P4: full, split and marked exports keep open-GOP pictures 58 and 59",
  async () => {
    await fixture(async (root, render) => {
      const path = join(root, "open.mp4");
      await source(path, "30", 100, [
        "-g",
        "30",
        "-bf",
        "2",
        "-x264-params",
        "open-gop=1:scenecut=0:b-adapt=0",
      ]);
      const pts = await presentation(path);
      expect(pts).toHaveLength(100);
      expect(pts.slice(58, 61)).toEqual([29696, 30208, 30720]);
      const packets = (
        await probe(path, "-show_entries", "packet=pts,dts,flags")
      ).split("\n");
      const nextKey = packets.findIndex((line) => /^30720,.*K/.test(line));
      expect(nextKey).toBeGreaterThan(0);
      expect(
        packets
          .slice(nextKey + 1, nextKey + 3)
          .map((line) => Number(line.split(",")[0])),
      ).toEqual([29696, 30208]);
      expect(await labels(path)).toEqual(sequence(100));

      const lane =
        'data-automation=\'{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":1}]}]}\'';
      const ramp = html("open.mp4", thirty, 100, 0, lane);
      await render(ramp, thirty, sequence(100), "capture");
      await render(split(ramp), thirty, sequence(100), "capture");
      await render(
        ramp,
        thirty,
        sequence(31, (i) => i + 59),
        "capture",
        { start: 59, end: 90 },
      );
      const plain = split(html("open.mp4", thirty, 100));
      for (const renderer of ["capture", "direct"] as const) {
        await render(plain, thirty, sequence(100), renderer);
        await render(plain, thirty, [59, 60, 61], renderer, {
          start: 59,
          end: 62,
        });
      }

      // Stream copy keeps decode preroll packets but presents only the edited window.
      const edit = join(root, "edited.mp4");
      await ffmpeg(
        "-ss",
        "0.5",
        "-i",
        path,
        "-t",
        "1.05",
        "-map",
        "0:v:0",
        "-c",
        "copy",
        edit,
      );
      expect(await probe(edit, "-show_entries", "packet=pts,flags")).toContain(
        "-7680,KD",
      );
      const editedPts = await presentation(edit);
      const editedLabels = await labels(edit);
      expect(editedPts).toEqual(sequence(editedLabels.length, (i) => i * 512));
      expect(editedLabels).toEqual(sequence(editedPts.length, (i) => i + 15));
      await render(
        html("edited.mp4", thirty, 45),
        thirty,
        sequence(
          45,
          (i) => editedLabels[Math.min(i, editedLabels.length - 1)]!,
        ),
        "capture",
      );
    });
  },
  180_000,
);

test.skipIf(!ready)(
  "P8–P12 and P14: source cadence, variable PTS and held tails agree in capture and direct MP4s",
  async () => {
    await fixture(async (root, render) => {
      for (const fixture of [
        {
          name: "p8.mp4",
          fps: ntsc,
          rate: "25",
          pts: [0, 512, 1024, 1536],
          expected: [0, 0, 1, 2, 3, 4, 5, 5, 6, 7],
        },
        {
          name: "p9.mp4",
          fps: ntsc,
          rate: "24000/1001",
          pts: [0, 1001, 2002, 3003],
          expected: [0, 0, 1, 2, 3, 4, 4, 5, 6, 7, 8],
        },
        {
          name: "p10.mp4",
          fps: ntsc,
          rate: "60000/1001",
          pts: [0, 1001, 2002, 3003],
          expected: sequence(12, (i) => 2 * i),
        },
        {
          name: "p11.mp4",
          fps: thirty,
          rate: "1000",
          pts: [0, 40, 50, 100, 120, 200],
          expected: [0, 0, 2, 3, 4, 4, 5],
        },
        {
          name: "p12.mkv",
          fps: { num: 60, den: 1 },
          rate: "60",
          pts: [0, 17, 33, 50],
          expected: sequence(10),
        },
        {
          name: "p14.mp4",
          fps: thirty,
          rate: "30",
          pts: [0, 512, 1024, 1536],
          expected: sequence(90, (i) => Math.min(i, 59)),
        },
      ]) {
        const { name, rate, fps, pts, expected } = fixture;
        const path = join(root, name);
        const count = rate === "1000" ? pts.length : 60;
        const extra =
          rate === "1000"
            ? [
                "-vf",
                "setpts='if(lt(N,3),if(eq(N,0),0,if(eq(N,1),40,50)),if(eq(N,3),100,if(eq(N,4),120,200)))'",
                // Give the last VFR packet one tick inside the MP4 edit list.
                "-bf",
                "0",
                "-bsf:v",
                "setts=duration=1",
                "-fps_mode",
                "vfr",
                "-enc_time_base",
                "1/1000",
                "-video_track_timescale",
                "1000",
              ]
            : [];
        await source(path, rate, count, extra);
        expect((await presentation(path)).slice(0, pts.length), name).toEqual(
          pts,
        );
        expect(await labels(path)).toEqual(sequence(count));
        if (name === "p12.mkv")
          expect(
            (await sourcePictures(path, await extractMediaMetadata(path)))?.end
              ?.from,
          ).toBe("packet");
        const project = html(name, fps, expected.length);
        for (const renderer of ["capture", "direct"] as const) {
          await render(project, fps, expected, renderer);
          await render(
            project,
            fps,
            expected.slice(expected.length - 3),
            renderer,
            { start: expected.length - 3, end: expected.length },
          );
        }
      }
    });
  },
  240_000,
);

test.skipIf(!ready)(
  "P13 and P13b: 2,000 exported frames wrap on the native end, including marked exports",
  async () => {
    await fixture(async (root, render) => {
      for (const { name, fps, count, ticks, mediaStart } of [
        {
          name: "integer.mp4",
          fps: thirty,
          count: 60,
          ticks: 60000,
          mediaStart: 0.5,
        },
        {
          name: "fraction.mp4",
          fps: ntsc,
          count: 61,
          ticks: 61061,
          mediaStart: 0.5005,
        },
      ]) {
        const path = join(root, name);
        await source(path, `${fps.num}/${fps.den}`, count, [
          "-video_track_timescale",
          "30000",
        ]);
        expect(await probe(path, "-show_entries", "stream=duration_ts")).toBe(
          String(ticks),
        );
        expect(await presentation(path)).toEqual(
          sequence(count, (i) => i * (ticks / count)),
        );
        expect(await labels(path)).toEqual(sequence(count));
        const cycle = count - 15;
        const expected = sequence(2000, (frame) => 15 + (frame % cycle));
        const project = html(name, fps, expected.length, mediaStart, "loop");
        await render(project, fps, expected, "capture");
        await render(
          project,
          fps,
          expected.slice(cycle, cycle + 3),
          "capture",
          { start: cycle, end: cycle + 3 },
        );
      }

      const mixed = join(root, "mixed.mp4");
      await ffmpeg(
        "-itsoffset",
        "0.300300",
        "-i",
        join(root, "fraction.mp4"),
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000",
        "-t",
        "4",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-movie_timescale",
        "30000",
        mixed,
      );
      expect(
        await probe(mixed, "-show_entries", "stream=start_pts,duration_ts"),
      ).toBe("9009,61061");
      const mixedPictures = await sourcePictures(
        mixed,
        await extractMediaMetadata(mixed),
      );
      expect(mixedPictures?.end).toEqual({
        time: { n: 7007n, d: 3000n },
        from: "stream",
      });
      const project = html("mixed.mp4", ntsc, 96, 0.8008, "loop");
      await render(
        project,
        ntsc,
        sequence(96, (i) => 15 + (i % 46)),
        "capture",
      );
    });
  },
  180_000,
);
