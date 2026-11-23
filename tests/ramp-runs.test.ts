import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { collectRenderMedia } from "@hyperframes/producer";
import { PREVIEW_BUNDLE_OPTIONS } from "@hyperframes/studio-server";
import { parseHTML } from "linkedom";
import { applyAll, canonicalTimeline } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  parseComposition,
  patchComposition,
} from "../src/server/timeline/composition";
import { syncOffsets } from "../src/shared/timeline/sync";
import { placedMedia } from "../src/shared/timeline/placedMedia";
import {
  documentRampRuns,
  RUN_BLOCK_SAMPLES,
  RUN_MARGIN_SAMPLES,
  runBuildFrames,
} from "../src/shared/timeline/rampRuns";
import type { RampRun } from "../src/shared/timeline/rampRuns";
import { sampleGridAudio } from "../src/server/hyperframes/audioClock";
import { createMediaService } from "../src/server/media/service";
import type { MediaService } from "../src/server/media/service";
import { prepareRampExport } from "../src/server/hyperframes/rampExport";
import {
  prepareRampPreview,
  rampSliceResponse,
} from "../src/server/hyperframes/rampPreview";
import {
  prepareLocalRun,
  sliceLocalRun,
} from "../src/server/hyperframes/rampSource";
import { prepareStretch } from "../src/server/hyperframes/rampAudio";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
import { browserExecutable } from "../src/server/hyperframes/render";
import { countingIds } from "./clip-ids";

const RAMP = JSON.stringify({
  version: 1,
  lanes: [
    {
      target: "rate",
      points: [
        { t: 0, v: 0.5 },
        { t: 4, v: 2 },
      ],
    },
  ],
});
const composition = (body: string, fps: number | string = 30) =>
  `<main data-composition-id="main" data-duration="12" data-fps="${fps}" data-width="160" data-height="120">\n${body}\n</main>\n`;
/** P6 with sound: 0.5x to 2x over 4 s, from the start of the source, 5 s long. */
const p6 = composition(
  `<audio id="snd" src="index.wav" data-start="0" data-duration="5" data-track-index="0" data-automation='${RAMP}'></audio>
<audio id="next" src="index.wav" data-start="5" data-duration="3" data-media-start="1" data-track-index="0"></audio>`,
);

function edit(html: string, commands: CommandInput[]) {
  const parsed = parseComposition(html, emptyTimelineSettings());
  const origins = new Map<string, ClipOrigin>();
  const timeline = canonicalTimeline(
    applyAll(
      parsed.timeline,
      commands.map((command) => CommandSchema.parse(command)),
      { onCreate: (id, origin) => origins.set(id, origin), newId: countingIds },
    ),
  );
  return patchComposition(parsed, timeline, origins);
}

/** The run each ramp clip slices, by element id. */
const runsOf = (html: string) =>
  new Map(
    Array.from(documentRampRuns(placedMedia(html)), ([key, slice]) => [
      key.replace(/^(audio|video):/, ""),
      slice,
    ]),
  );

const runKey = (run: RampRun | undefined) => JSON.stringify(run);

test("S2-S4: a split, and a split with a tail dissolve, slice the uncut ramp's run end to end", () => {
  const uncut = runsOf(p6).get("snd")!;
  expect(uncut).toMatchObject({ from: 0, to: 240_000 });
  const split = runsOf(
    edit(p6, [
      { type: "split", at: 60, clipIds: ["snd"], ids: { snd: ["tail"] } },
    ]),
  );
  const whole = { src: "index.wav", run: uncut.run, frames: 240_000 };
  expect([split.get("snd"), split.get("tail")]).toEqual([
    { ...whole, from: 0, to: 96_000 },
    { ...whole, from: 96_000, to: 240_000 },
  ]);
  const dissolved = edit(p6, [
    { type: "split", at: 60, clipIds: ["snd"], ids: { snd: ["tail"] } },
    {
      type: "setTransition",
      from: "tail",
      to: "next",
      transition: { duration: 10 },
    },
  ]);
  const runs = runsOf(dissolved);
  // The tail runs 5 frames past the cut under the dissolve: the same run, reaching further.
  expect(runs.get("tail")).toEqual({
    ...whole,
    from: 96_000,
    to: 248_000,
    frames: 248_000,
  });
});

test("S3: a ramp a hair before frame 30 starts at sample 48,000 and its split joins at 96,000", () => {
  const html = composition(
    `<audio id="snd" src="index.wav" data-start="0.99998" data-duration="4" data-track-index="0" data-automation='${RAMP}'></audio>`,
  );
  const uncut = runsOf(html).get("snd")!;
  const split = runsOf(
    edit(html, [
      { type: "split", at: 60, clipIds: ["snd"], ids: { snd: ["tail"] } },
    ]),
  );
  // Curve zero is frame 30, exactly sample 48,000, so the run counts from there.
  expect(uncut.run).toMatchObject({ phase: ["0", "1"], first: 0 });
  expect([uncut.from, split.get("snd")!.to, split.get("tail")!.to]).toEqual([
    0, 48_000, 192_000,
  ]);
  expect(split.get("tail")!.run).toEqual(uncut.run);
});

test("E5: a trim of a tail, shorter or longer, keeps the run; a head trim into the next block starts another", () => {
  const long = composition(
    `<audio id="snd" src="index.wav" data-start="0" data-duration="12" data-track-index="0" data-automation='${RAMP}'></audio>`,
  );
  const split = edit(long, [
    { type: "split", at: 120, clipIds: ["snd"], ids: { snd: ["tail"] } },
  ]);
  const before = runsOf(split);
  expect(before.get("tail")).toMatchObject({ frames: 12 * 48_000 });
  // Trimming the tail by 1 s, or back across the 10 s block boundary, keeps the run: it starts
  // where it did and needs to reach less far.
  for (const [to, seconds] of [
    [330, 11],
    [270, 9],
  ] as const) {
    const trimmed = runsOf(
      edit(split, [{ type: "trim", clipId: "tail", edge: "end", to }]),
    );
    for (const id of ["snd", "tail"]) {
      expect(runKey(trimmed.get(id)!.run)).toBe(runKey(before.get(id)!.run));
      expect(trimmed.get(id)!.frames).toBe(seconds * 48_000);
    }
  }
  // A head trim that leaves the first piece starting in the next block starts the run there.
  const alone = runsOf(
    edit(long, [{ type: "trim", clipId: "snd", edge: "start", to: 315 }]),
  );
  expect(alone.get("snd")).toMatchObject({
    run: { first: 1 },
    from: 10.5 * 48_000 - RUN_BLOCK_SAMPLES,
  });
  // One that stays in the first block keeps it.
  const inside = runsOf(
    edit(long, [{ type: "trim", clipId: "snd", edge: "start", to: 150 }]),
  );
  expect(runKey(inside.get("snd")!.run)).toBe(
    runKey(runsOf(long).get("snd")!.run),
  );
});

test("pieces a whole block apart get separate runs, and nothing is stretched between them", () => {
  const html = composition(
    `<audio id="snd" src="index.wav" data-start="0" data-duration="40" data-track-index="0" data-automation='${RAMP}'></audio>`,
  ).replace('data-duration="12"', 'data-duration="40"');
  const cut = runsOf(
    edit(html, [
      {
        type: "split",
        at: 150,
        clipIds: ["snd"],
        ids: { snd: ["middle"] },
      },
      {
        type: "split",
        at: 1050,
        clipIds: ["middle"],
        ids: { middle: ["tail"] },
      },
      { type: "remove", clipIds: ["middle"] },
    ]),
  );
  // 0-5 s is block 0; 35-40 s is block 3. Blocks 1 and 2 are not stretched.
  expect(cut.get("snd")).toMatchObject({ run: { first: 0 }, frames: 240_000 });
  expect(cut.get("tail")).toMatchObject({
    run: { first: 3 },
    from: 35 * 48_000 - 3 * RUN_BLOCK_SAMPLES,
    to: 40 * 48_000 - 3 * RUN_BLOCK_SAMPLES,
    frames: 40 * 48_000 - 3 * RUN_BLOCK_SAMPLES,
  });
});

const linked = composition(
  `<video id="pic" src="clip.mp4" muted data-link="lk" data-sync-origin="lk" data-start="0" data-duration="5" data-track-index="0" data-automation='${RAMP}'></video>
<audio id="snd" src="clip.mp4" data-link="lk" data-sync-origin="lk" data-start="0" data-duration="5" data-track-index="1" data-automation='${RAMP}'></audio>`,
);

test("S7: an L-cut of linked ramp picture and sound keeps the sound's run and the pair in sync", () => {
  const split = edit(linked, [
    {
      type: "split",
      at: 60,
      clipIds: ["pic", "snd"],
      ids: { pic: ["pic-tail"], snd: ["snd-tail"] },
    },
  ]);
  const lcut = edit(split, [
    { type: "trim", clipId: "snd", edge: "end", to: 57, linked: false },
    {
      type: "trim",
      clipId: "snd-tail",
      edge: "start",
      to: 57,
      linked: false,
    },
  ]);
  const before = runsOf(split);
  const after = runsOf(lcut);
  expect(after.get("snd")).toMatchObject({ from: 0, to: 91_200 });
  expect(after.get("snd-tail")).toMatchObject({ from: 91_200, to: 240_000 });
  for (const id of ["snd", "snd-tail"])
    expect(after.get(id)!.run).toEqual(before.get("snd")!.run);
  for (const html of [split, lcut])
    expect(
      syncOffsets(parseComposition(html, emptyTimelineSettings()).timeline),
    ).toEqual(new Map());
});

test("S8: sound moved alone two frames later leaves the family and gets its own run", () => {
  // 12 s, cut at 9 s: the tail reaches into the second block, so the family's run has two.
  const long = linked.replaceAll('data-duration="5"', 'data-duration="12"');
  const split = edit(long, [
    {
      type: "split",
      at: 270,
      clipIds: ["pic", "snd"],
      ids: { pic: ["pic-tail"], snd: ["snd-tail"] },
    },
  ]);
  const moved = edit(split, [
    // Linked selection off: the sound moves alone and stays linked, so the badge shows.
    { type: "move", clipIds: ["snd-tail"], by: 2, linked: false },
  ]);
  const before = runsOf(split);
  const runs = runsOf(moved);
  // The muted picture has no sound to prepare.
  expect([...before.keys()]).toEqual(["snd", "snd-tail"]);
  expect(before.get("snd")!.run).toEqual(before.get("snd-tail")!.run);
  expect(before.get("snd")!.frames).toBe(12 * 48_000);
  // The head of the sound is now a family alone and needs only its own 9 s. The moved tail is a
  // family of its own, counted from its own curve zero. Two frames at 30 fps are whole samples,
  // so its run plays the same samples as the head's and is the same file.
  expect(runs.get("snd")!.frames).toBe(9 * 48_000);
  expect(runs.get("snd-tail")).toMatchObject({
    from: 9 * 48_000,
    to: 12 * 48_000,
    frames: 12 * 48_000,
  });
  const offsets = syncOffsets(
    parseComposition(moved, emptyTimelineSettings()).timeline,
  );
  expect([offsets.get("pic-tail"), offsets.get("snd-tail")]).toEqual([-2, 2]);
});

test("S8 at 29.97: two frames move curve zero off its sample phase, so the moved sound has a run of its own", () => {
  const ntsc = linked.replaceAll('data-fps="30"', 'data-fps="30000/1001"');
  const split = edit(ntsc, [
    {
      type: "split",
      at: 60,
      clipIds: ["pic", "snd"],
      ids: { pic: ["pic-tail"], snd: ["snd-tail"] },
    },
  ]);
  const runs = runsOf(
    edit(split, [
      { type: "move", clipIds: ["snd-tail"], by: 2, linked: false },
    ]),
  );
  // Two frames are 3,203.2 samples.
  expect(runs.get("snd")!.run.phase).toEqual(["0", "1"]);
  expect(runs.get("snd-tail")!.run.phase).toEqual(["1", "5"]);
});

/** 20 s of stereo 48 kHz where each sample names itself: left `n mod 8192`, right `n / 8192`. */
async function indexWav(path: string, seconds = 20) {
  const count = 48_000 * seconds;
  const wav = Buffer.alloc(44 + count * 4);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + count * 4, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(192_000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(count * 4, 40);
  for (let n = 0; n < count; n++) {
    wav.writeInt16LE(n % 8192, 44 + n * 4);
    wav.writeInt16LE(Math.floor(n / 8192), 46 + n * 4);
  }
  await writeFile(path, wav);
}

async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [bytes, error, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return Buffer.from(bytes);
}

/** The export mixer's PCM for a document, before the encoder: interleaved stereo floats. */
async function mixed(dir: string, name: string, html: string, frames: number) {
  await writeFile(join(dir, `${name}.html`), html);
  await run([
    "node",
    "--experimental-strip-types",
    join(import.meta.dir, "fixtures", "sample-grid-mix.ts"),
    dir,
    name,
    "30",
    "1",
    String(frames),
  ]);
  const pcm = await readFile(
    join(dir, name, "plan", "work", "audio-source.wav"),
  );
  const data = pcm.indexOf("data", 12);
  return new Float32Array(
    pcm.buffer.slice(
      pcm.byteOffset + data + 8,
      pcm.byteOffset + data + 8 + pcm.readUInt32LE(data + 4),
    ),
  );
}

const firstDifference = (
  a: Float32Array,
  b: Float32Array,
  from = 0,
  to = a.length,
) => {
  for (let i = from; i < to; i++) if (a[i] !== b[i]) return i / 2;
  return null;
};

test.skipIf(!Bun.which("node") || !Bun.which("ffmpeg"))(
  "S2-S4: the export mix of a split ramp, with and without a tail dissolve, is the uncut ramp's PCM",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ramp-runs-mix-"));
    try {
      await indexWav(join(dir, "index.wav"));
      await writeFile(join(dir, "scene.html"), "");
      const uncut = await mixed(dir, "uncut", p6, 240);
      const split = await mixed(
        dir,
        "split",
        edit(p6, [
          { type: "split", at: 60, clipIds: ["snd"], ids: { snd: ["tail"] } },
        ]),
        240,
      );
      // S2: 0 samples differ, including across the cut at sample 96,000.
      expect(split.length).toBe(uncut.length);
      expect(firstDifference(split, uncut)).toBeNull();
      // The ramp is heard on both sides of the cut, not silence.
      for (const at of [95_999, 96_000])
        expect(
          Math.abs(uncut[2 * at]!) + Math.abs(uncut[2 * at + 2]!),
        ).toBeGreaterThan(0);

      const dissolved = edit(p6, [
        { type: "split", at: 60, clipIds: ["snd"], ids: { snd: ["tail"] } },
        {
          type: "setTransition",
          from: "tail",
          to: "next",
          transition: { duration: 10 },
        },
      ]);
      const crossed = await mixed(dir, "dissolved", dissolved, 240);
      const without = (...ids: string[]) => {
        const { document } = parseHTML(dissolved);
        for (const id of ids) document.getElementById(id)?.remove();
        return document.toString();
      };
      const rampOnly = await mixed(dir, "ramp-only", without("next"), 240);
      const nextOnly = await mixed(
        dir,
        "next-only",
        without("snd", "tail"),
        240,
      );
      // S4: outside the dissolve, frames 145 to 155, the mix is the uncut one.
      expect(firstDifference(crossed, uncut, 0, 2 * 232_000)).toBeNull();
      expect(firstDifference(crossed, uncut, 2 * 248_000)).toBeNull();
      // Inside, it is the faded ramp and the faded next clip summed.
      let worst = 0;
      for (let i = 2 * 232_000; i < 2 * 248_000; i++)
        worst = Math.max(
          worst,
          Math.abs(crossed[i]! - rampOnly[i]! - nextOnly[i]!),
        );
      expect(worst).toBeLessThan(1e-6);
      // And the faded ramp is the uncut run carried on past the old end, faded out.
      expect(firstDifference(rampOnly, uncut, 0, 2 * 232_000)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

const project = (path: string) => ({
  id: "project",
  name: "Project",
  path,
  createdAt: "",
  updatedAt: "",
});

/** The viewer's prepared document, once its runs are made, with each ramp element's served slice. */
async function viewerSlices(dir: string, media: MediaService) {
  const prefix = "/api/isolated/key/";
  const html = (await bundleToSingleHtml(dir, PREVIEW_BUNDLE_OPTIONS)).replace(
    "<head>",
    `<head><base href="${prefix}preview/">`,
  );
  const prepare = () =>
    prepareRampPreview(
      html,
      new URL(`http://127.0.0.1${prefix}preview`),
      prefix,
      project(dir),
      media,
    );
  const first = await prepare();
  first?.pins.release();
  await Promise.all(first?.pending ?? []);
  const prepared = (await prepare())!;
  const { document } = parseHTML(prepared.html);
  return {
    prepared,
    slices: new Map(
      Array.from(
        document.querySelectorAll("audio[src*='ramp-audio/']"),
        (element) => {
          const [, key, from, to] =
            /ramp-audio\/([a-f0-9]{64})-(\d+)-(\d+)\.wav$/.exec(
              element.getAttribute("src")!,
            )!;
          return [
            element.id,
            { key: key!, from: Number(from), to: Number(to) },
          ] as const;
        },
      ),
    ),
  };
}

const jobs = async (dir: string) =>
  (await readdir(join(dir, ".cutroom", "cache", "ramp-runs"))).filter((name) =>
    name.endsWith(".wav"),
  );

test.skipIf(!Bun.which("ffmpeg"))(
  "S6: the bytes the viewer serves for each ramp piece are the mixer's input from the same run file",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ramp-runs-viewer-"));
    const media = createMediaService();
    try {
      await indexWav(join(dir, "index.wav"));
      await writeFile(
        join(dir, "index.html"),
        edit(p6, [
          { type: "split", at: 60, clipIds: ["snd"], ids: { snd: ["tail"] } },
        ]),
      );
      const { prepared, slices } = await viewerSlices(dir, media);
      expect([...slices.keys()]).toEqual(["snd", "tail"]);
      expect(slices.get("snd")!.key).toBe(slices.get("tail")!.key);
      // Export asks the same service for the same run, and the worker reads it by its id.
      const exported = await prepareRampExport({
        project: project(dir),
        composition: "index.html",
        media,
        signal: new AbortController().signal,
        onWait: () => {},
      });
      const file = await media.rampRunFile(
        project(dir),
        slices.get("snd")!.key,
      );
      expect(Object.values(exported!.runs)).toEqual([file]);
      const html = await bundleToSingleHtml(dir);
      const audios = sampleGridAudio(
        collectRenderMedia(html).audios,
        html,
        new Map(),
        undefined,
        exported!.runs,
      );
      let joined = Buffer.alloc(0);
      for (const audio of audios.filter(({ rampRun }) => rampRun)) {
        expect(audio.rampRun!.file).toBe(file);
        const output = join(dir, `${audio.id}-mixer.wav`);
        await sliceLocalRun(join(dir, "index.wav"), output, audio.rampRun!);
        const { from, to } = slices.get(audio.id)!;
        expect(audio.rampRun).toMatchObject({ from, to });
        const served = Buffer.from(
          await (
            await rampSliceResponse(file, from, to, undefined)
          ).arrayBuffer(),
        );
        expect(served.equals(await readFile(output))).toBe(true);
        joined = Buffer.concat([joined, served.subarray(44)]);
        // A browser seeking asks for a range; it gets those bytes of the same WAV.
        const ranged = await rampSliceResponse(file, from, to, "bytes=40-1039");
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("Content-Range")).toBe(
          `bytes 40-1039/${served.length}`,
        );
        expect(
          Buffer.from(await ranged.arrayBuffer()).equals(
            served.subarray(40, 1040),
          ),
        ).toBe(true);
      }
      // The two pieces together are the uncut piece's samples of the run.
      const uncut = Buffer.from(
        await (
          await rampSliceResponse(file, 0, 240_000, undefined)
        ).arrayBuffer(),
      );
      expect(joined.equals(uncut.subarray(44))).toBe(true);
      exported!.release();
      prepared.pins.release();
    } finally {
      await media.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!Bun.which("ffmpeg"))(
  "E5, E6 and churn: one run per ramp; it grows when a piece needs more and keeps every sample it had",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ramp-runs-cache-"));
    const media = createMediaService();
    const ask = (html: string) => {
      const { run, frames } = runsOf(html).get("snd")!;
      return media.rampRun(project(dir), "index.wav", run, frames);
    };
    const data = async (key: string) =>
      (await readFile(await media.rampRunFile(project(dir), key))).subarray(44);
    const clip = (seconds: number) =>
      composition(
        `<audio id="snd" src="index.wav" data-start="0" data-duration="${seconds}" data-track-index="0" data-automation='${RAMP}'></audio>`,
      );
    try {
      await indexWav(join(dir, "index.wav"));
      const first = await ask(clip(5));
      expect(first.available).toBe(false);
      expect(await first.pending).toBe(true);
      const short = await data(first.key);
      // Made to the next whole second past 5 s and the flush margin.
      expect(short.length).toBe(6 * 48_000 * 4);
      // E6: the run exists, so asking again queues nothing.
      expect(await ask(clip(5))).toEqual({
        key: first.key,
        available: true,
        pending: undefined,
      });
      // A piece that needs 12 s asks for the same run, which is made longer once.
      const longer = await ask(clip(12));
      expect(longer.key).toBe(first.key);
      expect(longer.available).toBe(false);
      expect(await longer.pending).toBe(true);
      const long = await data(first.key);
      expect(long.length).toBe(13 * 48_000 * 4);
      // Every sample the shorter file covered is the same, to the bit.
      const covered = (6 * 48_000 - RUN_MARGIN_SAMPLES) * 4;
      expect(long.subarray(0, covered).equals(short.subarray(0, covered))).toBe(
        true,
      );
      // A split, E5's one-second trim, and a trim back across the block boundary need no work.
      const split = edit(clip(12), [
        { type: "split", at: 120, clipIds: ["snd"], ids: { snd: ["tail"] } },
      ]);
      for (const html of [
        split,
        edit(split, [{ type: "trim", clipId: "tail", edge: "end", to: 330 }]),
        edit(split, [{ type: "trim", clipId: "tail", edge: "end", to: 270 }]),
      ])
        expect(await ask(html)).toEqual({
          key: first.key,
          available: true,
          pending: undefined,
        });
      expect(await jobs(dir)).toEqual([`${first.key}.wav`]);
      // A run file cut short on disk no longer covers the pieces, so it is made again.
      const file = await media.rampRunFile(project(dir), first.key);
      await writeFile(file, (await readFile(file)).subarray(0, 44));
      const repaired = await ask(clip(12));
      expect(repaired.available).toBe(false);
      expect(await repaired.pending).toBe(true);
      expect((await data(first.key)).equals(long)).toBe(true);
    } finally {
      await media.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!Bun.which("ffmpeg"))(
  "E7: past the budget, the least recently used runs go and the open preview's stay",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ramp-runs-budget-"));
    const runBytes = 44 + runBuildFrames(2 * 48_000) * 4;
    // Room for two runs.
    const media = createMediaService({ rampRunBytes: 2.5 * runBytes });
    const runAt = (mediaStart: number) =>
      runsOf(
        composition(
          `<audio id="snd" src="index.wav" data-start="0" data-duration="2" data-media-start="${mediaStart}" data-track-index="0" data-automation='${RAMP}'></audio>`,
        ),
      ).get("snd")!;
    try {
      await indexWav(join(dir, "index.wav"));
      const preview = media.rampPins();
      const build = async (mediaStart: number, pins?: typeof preview) => {
        const { run, frames } = runAt(mediaStart);
        const result = await media.rampRun(
          project(dir),
          "index.wav",
          run,
          frames,
          pins,
        );
        await result.pending;
        return `${result.key}.wav`;
      };
      const open = await build(0, preview);
      const older = await build(1);
      const newer = await build(2);
      // Three runs: the oldest unpinned one goes, the pinned one stays though it is older.
      expect((await jobs(dir)).sort()).toEqual([open, newer].sort());
      expect(older).not.toBe(open);
      // Once the preview closes, its run is the least recently used.
      preview.release();
      const latest = await build(3);
      expect((await jobs(dir)).sort()).toEqual([newer, latest].sort());
      // Pinned runs past the budget stay, and are reported.
      const pins = media.rampPins();
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (message: string) => warned.push(message);
      try {
        for (const start of [4, 5, 6]) await build(start, pins);
      } finally {
        console.warn = warn;
      }
      expect((await jobs(dir)).length).toBe(3);
      expect(warned.at(-1)).toContain("over the");
      pins.release();
    } finally {
      await media.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

test("a run that starts before its source is silent there, not an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ramp-runs-before-"));
  try {
    await indexWav(join(dir, "index.wav"), 2);
    const output = join(dir, "run.wav");
    // One second before the source, then one second of it at 1x.
    const result = await prepareStretch(
      output,
      96_000,
      (frame) => frame / 48_000 - 1,
      async (path, start, seconds) => {
        // The source from its start, and a second past the end for the stretcher to read ahead.
        expect([start, seconds]).toEqual([0, 2]);
        await writeFile(path, await readFile(join(dir, "index.wav")));
        return { success: true, outputPath: path };
      },
    );
    expect(result?.success).toBe(true);
    const wav = await readFile(output);
    const sample = (frame: number) => wav.readInt16LE(44 + frame * 4);
    expect(
      Array.from({ length: 40_000 }, (_, i) => sample(i)).some(Boolean),
    ).toBe(false);
    expect(
      Array.from({ length: 40_000 }, (_, i) => sample(50_000 + i)).some(
        Boolean,
      ),
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "S2 in the MP4: export reads the service's run, and a split ramp sounds like the uncut one",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ramp-runs-export-"));
    const dir = join(root, "project");
    const media = createMediaService();
    let silenced = false;
    const workers = createRenderWorkers({
      scratchDir: join(root, "scratch"),
      prepareRampRuns: async (input) => {
        const prepared = await prepareRampExport({
          ...input,
          project: project(dir),
          media,
        });
        if (!prepared || !silenced) return prepared;
        // A copy of the run with its samples zeroed: export plays it only if it reads the file.
        const runs: Record<string, string> = {};
        for (const [id, file] of Object.entries(prepared.runs)) {
          const wav = await readFile(file);
          wav.fill(0, 44);
          runs[id] = join(root, "silent.wav");
          await writeFile(runs[id], wav);
        }
        return { runs, release: prepared.release };
      },
    });
    const exported = async (name: string, html: string) => {
      await writeFile(join(dir, "index.html"), html);
      const path = join(root, `${name}.mp4`);
      const state = workers.start(
        {
          project: { id: name, dir },
          outputPath: path,
          format: "mp4",
          fps: { num: 30, den: 1 },
          quality: "draft",
          jobId: name,
        },
        { filename: `${name}.mp4`, directory: root, range: null },
      );
      const deadline = Date.now() + 60_000;
      while (state.status === "rendering" && Date.now() < deadline)
        await Bun.sleep(20);
      expect(state.error).toBeUndefined();
      expect(state.status).toBe("complete");
      const pcm = await run([
        ...["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "2"],
        ...["-ar", "48000", "-t", "8", "-f", "f32le", "pipe:1"],
      ]);
      return new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
    };
    try {
      await mkdir(dir);
      await indexWav(join(dir, "index.wav"));
      const uncut = await exported("uncut", p6);
      const split = await exported(
        "split",
        edit(p6, [
          { type: "split", at: 60, clipIds: ["snd"], ids: { snd: ["tail"] } },
        ]),
      );
      // Two AAC encodes: the same signal at lag 0, and at least 60 dB below it in difference.
      const energy = (
        from: number,
        to: number,
        value: (i: number) => number,
      ) => {
        let sum = 0;
        for (let i = from; i < to; i++) sum += value(i) ** 2;
        return sum;
      };
      const [from, to] = [2 * 4_800, 2 * 235_000];
      const signal = energy(from, to, (i) => uncut[i]!);
      const residual = energy(from, to, (i) => split[i]! - uncut[i]!);
      expect(10 * Math.log10(residual / signal)).toBeLessThan(-60);
      const at = (lag: number) =>
        energy(from, to, (i) => uncut[i]! * split[i + 2 * lag]!);
      for (const lag of [-2, -1, 1, 2]) expect(at(0)).toBeGreaterThan(at(lag));
      // Around the cut at 2 s, the split export carries the sound through.
      expect(energy(2 * 95_000, 2 * 97_000, (i) => split[i]!)).toBeGreaterThan(
        0.1 * energy(2 * 95_000, 2 * 97_000, (i) => uncut[i]!),
      );
      silenced = true;
      const quiet = await exported("silenced", p6);
      expect(energy(from, 2 * 230_000, (i) => quiet[i]!)).toBeLessThan(
        1e-6 * signal,
      );
    } finally {
      await workers.cancelAll();
      await media.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);

test.skipIf(!Bun.which("ffmpeg"))(
  "a run made longer keeps every sample it covered, to the bit, along a steep ramp",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ramp-runs-extend-"));
    try {
      await indexWav(join(dir, "index.wav"), 40);
      // Slow to fast and back: 0.25x to 8x, where the stretcher reads furthest ahead.
      const run = {
        points: [
          { t: 0, v: 0.25 },
          { t: 2, v: 8 },
          { t: 3, v: 0.5 },
        ],
        zero: 250_000,
        phase: ["2", "5"] as [string, string],
        first: 0,
      };
      const lengths = [1.2, 2.5, 4, 9.3].map((seconds) => seconds * 48_000);
      const files = await Promise.all(
        lengths.map(async (frames, index) => {
          const output = join(dir, `${index}.wav`);
          const result = await prepareLocalRun(
            join(dir, "index.wav"),
            output,
            run,
            frames,
          );
          expect(result?.success).toBe(true);
          return (await readFile(output)).subarray(44);
        }),
      );
      const longest = files.at(-1)!;
      for (const [index, frames] of lengths.slice(0, -1).entries()) {
        const covered = (runBuildFrames(frames) - RUN_MARGIN_SAMPLES) * 4;
        expect(covered).toBeGreaterThanOrEqual(frames * 4);
        expect(
          files[index]!.subarray(0, covered).equals(
            longest.subarray(0, covered),
          ),
        ).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
