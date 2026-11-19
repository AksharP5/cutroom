import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
import { prepareRampAudio } from "../src/server/hyperframes/rampAudio";
import { browserExecutable } from "../src/server/hyperframes/render";

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [bytes, error, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return Buffer.from(bytes);
}

function correlation(
  actual: Float32Array,
  expected: Float32Array,
  start: number,
  end: number,
) {
  let product = 0;
  let actualPower = 0;
  let expectedPower = 0;
  for (let i = start; i < end; i++) {
    product += actual[i]! * expected[i]!;
    actualPower += actual[i]! ** 2;
    expectedPower += expected[i]! ** 2;
  }
  return product / Math.sqrt(actualPower * expectedPower);
}

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "native marked exports capture only N frames and preserve both video and audio edges at integer and NTSC fps",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-"));
    // The project is the whole folder, so its scratch lives beside it.
    const scratchDir = `${root}-scratch`;
    const workers = createRenderWorkers({ scratchDir });
    try {
      const media = join(root, "source.mp4");
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x120:rate=30:duration=5",
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=0.2*sin(2*PI*(220*t+80*t*t)):s=48000:d=5",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        media,
      ]);
      for (const fps of [
        { num: 30, den: 1 },
        { num: 30000, den: 1001 },
      ]) {
        await writeFile(
          join(root, "index.html"),
          `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}video{position:absolute;inset:0;width:160px;height:120px}</style></head><body><main data-composition-id="main" data-width="160" data-height="120" data-fps="${fps.num}/${fps.den}" data-duration="4" style="position:relative;width:160px;height:120px"><video id="picture" class="clip" src="source.mp4" data-start="0" data-duration="4" data-media-start="0.5" data-track-index="0"></video></main></body></html>`,
        );
        const paths: string[] = [];
        for (const range of [null, { start: 37, end: 67 }]) {
          const name = `${fps.num}-${range ? "range" : "whole"}`;
          const outputPath = join(root, `${name}.mp4`);
          paths.push(outputPath);
          const state = workers.start(
            {
              project: { id: "range", dir: root },
              outputPath,
              format: "mp4",
              fps,
              quality: "high",
              jobId: name,
            },
            { filename: `${name}.mp4`, directory: root, range },
          );
          const captures: number[] = [];
          const deadline = Date.now() + 45000;
          while (state.status === "rendering" && Date.now() < deadline) {
            if (state.stageProgress?.code === "capture")
              captures.push(state.stageProgress.total ?? 0);
            await Bun.sleep(20);
          }
          expect(state.error).toBeUndefined();
          expect(state.status).toBe("complete");
          if (range) {
            expect(captures.length).toBeGreaterThan(0);
            expect(new Set(captures)).toEqual(new Set([30]));
          }
        }
        const [whole, selected] = paths;
        if (!whole || !selected) throw new Error("Exports were not produced.");
        const duration = (30 * fps.den) / fps.num;
        const probe = z
          .object({
            streams: z.array(
              z.object({
                codec_type: z.string(),
                nb_read_frames: z.string().optional(),
                duration: z.string(),
                r_frame_rate: z.string(),
              }),
            ),
          })
          .parse(
            JSON.parse(
              (
                await command([
                  "ffprobe",
                  "-v",
                  "error",
                  "-count_frames",
                  "-show_entries",
                  "stream=codec_type,duration,nb_read_frames,r_frame_rate",
                  "-of",
                  "json",
                  selected,
                ])
              ).toString(),
            ),
          );
        expect(
          probe.streams.find((s) => s.codec_type === "video"),
        ).toMatchObject({
          nb_read_frames: "30",
          r_frame_rate: `${fps.num}/${fps.den}`,
        });
        for (const stream of probe.streams)
          expect(Number(stream.duration)).toBeCloseTo(duration, 3);

        const edge = (path: string, first: number, last: number) =>
          command([
            "ffmpeg",
            "-v",
            "error",
            "-i",
            path,
            "-vf",
            `select=eq(n\\,${first})+eq(n\\,${last})`,
            "-fps_mode",
            "passthrough",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
          ]);
        const expected = await edge(whole, 37, 66);
        const actual = await edge(selected, 0, 29);
        expect(actual.length).toBe(160 * 120 * 3 * 2);
        for (const start of [0, 160 * 120 * 3]) {
          let difference = 0;
          for (let i = start; i < start + 160 * 120 * 3; i++)
            difference += Math.abs(actual[i]! - expected[i]!);
          expect(difference / (160 * 120 * 3)).toBeLessThan(3);
        }
        const audio = async (path: string, seek: number) => {
          const bytes = await command([
            "ffmpeg",
            "-v",
            "error",
            "-i",
            path,
            "-ss",
            String(seek),
            "-t",
            String(duration),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "pipe:1",
          ]);
          return new Float32Array(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          );
        };
        const sourceAudio = await audio(media, 0.5 + (37 * fps.den) / fps.num);
        const rangeAudio = await audio(selected, 0);
        expect(rangeAudio.length).toBe(sourceAudio.length);
        expect(correlation(rangeAudio, sourceAudio, 512, 4800)).toBeGreaterThan(
          0.98,
        );
        expect(
          correlation(
            rangeAudio,
            sourceAudio,
            rangeAudio.length - 4800,
            rangeAudio.length - 512,
          ),
        ).toBeGreaterThan(0.98);
      }
    } finally {
      await workers.cancelAll();
      await rm(root, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
    }
  },
  // Captures four Chromium renders, encodes MP4s, and decodes their video and audio edges.
  120_000,
);

test("marked export planning refuses links outside the project before copying them", async () => {
  const root = await mkdtemp(join(tmpdir(), "export-link-"));
  const project = join(root, "project");
  const workers = createRenderWorkers({ scratchDir: join(root, "scratch") });
  try {
    await mkdir(project);
    await writeFile(join(root, "private.txt"), "outside the project");
    await symlink(join(root, "private.txt"), join(project, "leak.txt"));
    await writeFile(
      join(project, "index.html"),
      '<main data-composition-id="main" data-width="160" data-height="120" data-duration="1"></main>',
    );
    const state = workers.start(
      {
        project: { id: "link", dir: project },
        outputPath: join(root, "out.mp4"),
        format: "mp4",
        fps: { num: 30, den: 1 },
        quality: "draft",
        jobId: "link",
      },
      { filename: "out.mp4", directory: root, range: { start: 5, end: 10 } },
    );
    const deadline = Date.now() + 10000;
    while (state.status === "rendering" && Date.now() < deadline)
      await Bun.sleep(20);
    expect(state.status).toBe("failed");
    expect(state.error).toContain(
      "Links outside the project cannot be accessed",
    );
  } finally {
    await workers.cancelAll();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "an authored speed ramp keeps its pitch, audio landmarks and group gain in whole and marked MP4s",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-ramp-"));
    const project = join(root, "project");
    const workers = createRenderWorkers({ scratchDir: join(root, "scratch") });
    const sampleRate = 48_000;
    // Source times include a half-second trim. Expected playhead times are
    // landmarks for the pinned 0.25× to 4× rate integral, in seconds.
    const landmarks = [
      { source: 0.71, timeline: 0.66169 },
      { source: 1.0, timeline: 1.25442 },
      { source: 1.7, timeline: 2.11254 },
      { source: 2.15, timeline: 2.47812 },
      { source: 5.55, timeline: 3.90641 },
    ];
    const pulses = landmarks
      .map(
        ({ source }) =>
          `if(lt(abs(t-${source})\\,0.008)\\,cos(PI*(t-${source})/0.016)^2\\,0)`,
      )
      .join("+");
    try {
      await mkdir(project);
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc=0.12*sin(2*PI*440*t)|0.6*sin(2*PI*1750*t)*(${pulses}):s=${sampleRate}:d=6`,
        "-c:a",
        "pcm_s16le",
        join(project, "sound.wav"),
      ]);
      await writeFile(
        join(project, "index.html"),
        `<main data-composition-id="main" data-width="160" data-height="120" data-duration="4" data-fps="60" style="background:orange">
          <hf-audio-group id="dialogue" data-volume="0.5"></hf-audio-group>
          <audio id="sound" src="sound.wav" data-start="0" data-duration="4" data-media-start="0.5" data-audio-group="dialogue" data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":0.25},{"t":4,"v":4}]}]}'></audio>
        </main>`,
      );
      for (const range of [null, { start: 60, end: 180 }]) {
        const name = range ? "marked" : "whole";
        const path = join(root, `${name}.mp4`);
        const state = workers.start(
          {
            project: { id: name, dir: project },
            outputPath: path,
            format: "mp4",
            fps: { num: 60, den: 1 },
            quality: "draft",
            jobId: name,
          },
          { filename: `${name}.mp4`, directory: root, range },
        );
        const deadline = Date.now() + 45000;
        while (state.status === "rendering" && Date.now() < deadline)
          await Bun.sleep(20);
        expect(state.error).toBeUndefined();
        expect(state.status).toBe("complete");
        const pcm = await command([
          "ffmpeg",
          "-v",
          "error",
          "-i",
          path,
          "-vn",
          "-ac",
          "2",
          "-ar",
          String(sampleRate),
          "-f",
          "f32le",
          "pipe:1",
        ]);
        const sound = new Float32Array(
          pcm.buffer,
          pcm.byteOffset,
          pcm.byteLength / 4,
        );
        const start = (range?.start ?? 0) / 60;
        const end = (range?.end ?? 240) / 60;
        expect(sound.length).toBe((end - start) * sampleRate * 2);
        for (const { timeline } of landmarks) {
          if (timeline <= start || timeline >= end) continue;
          const expected = timeline - start;
          let energy = 0;
          let weightedTime = 0;
          for (
            let i = Math.round((expected - 0.06) * sampleRate);
            i < Math.round((expected + 0.06) * sampleRate);
            i++
          ) {
            const power = sound[2 * i + 1]! ** 2;
            energy += power;
            weightedTime += (i / sampleRate) * power;
          }
          expect(energy, `${name} landmark at ${timeline}s`).toBeGreaterThan(1);
          expect(
            Math.abs(weightedTime / energy - expected),
            `${name} landmark at ${timeline}s`,
          ).toBeLessThan(1 / 120);
        }
        let upwardCrossings = 0;
        let carrierPower = 0;
        let quietestRms = Infinity;
        for (let from = 4800; from < sound.length / 2 - 4800; from += 480) {
          let power = 0;
          for (let i = from; i < from + 480; i++) {
            const sample = sound[2 * i]!;
            power += sample ** 2;
            if (sample > 0 && sound[2 * i - 2]! <= 0) upwardCrossings++;
          }
          carrierPower += power;
          quietestRms = Math.min(quietestRms, Math.sqrt(power / 480));
        }
        const measuredSeconds = end - start - 0.2;
        // The carrier stays audible through former slice boundaries and averages half gain.
        expect(quietestRms).toBeGreaterThan(0.012);
        expect(
          Math.sqrt(carrierPower / (measuredSeconds * sampleRate)),
        ).toBeCloseTo(0.06 / Math.SQRT2, 2);
        const pitch = upwardCrossings / measuredSeconds;
        expect(Math.abs(pitch - 440)).toBeLessThan(2);
      }
    } finally {
      await workers.cancelAll();
      await rm(root, { recursive: true, force: true });
    }
  },
  100_000,
);

test.skipIf(!Bun.which("ffmpeg"))(
  "stretching a slow ramp twice produces the same dry samples",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-ramp-repeat-"));
    try {
      const source = join(directory, "source.wav");
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=0.12*sin(2*PI*440*t)|0.12*sin(2*PI*331*t)+0.12*sin(2*PI*2273*t):s=48000:d=1",
        "-c:a",
        "pcm_s16le",
        source,
      ]);
      const stretched = async (name: string) => {
        const path = join(directory, name);
        const result = await prepareRampAudio(
          path,
          1,
          {
            target: "rate",
            points: [
              { t: 0, v: 0.25 },
              { t: 1, v: 0.4 },
            ],
          },
          async (outputPath) => {
            await copyFile(source, outputPath);
            return { success: true, outputPath };
          },
        );
        expect(result?.success).toBe(true);
        return readFile(path);
      };
      const first = await stretched("first.wav");
      expect(first.readUInt32LE(40)).toBe(48_000 * 4);
      expect(first.equals(await stretched("second.wav"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

// The editor rewrites .cutroom during an export, so the copy must not walk it either.
test.each(["trash", ".cutroom/cache"])(
  "review: marked export preparation skips %s",
  async (skipped) => {
    const root = await mkdtemp(join(tmpdir(), "export-trash-"));
    const project = join(root, "project");
    const workers = createRenderWorkers({ scratchDir: join(root, "scratch") });
    try {
      await mkdir(join(project, skipped), { recursive: true });
      await writeFile(join(root, "private.txt"), "not part of the export");
      await symlink(
        join(root, "private.txt"),
        join(project, skipped, "ignored.txt"),
      );
      await writeFile(
        join(project, "index.html"),
        '<main data-composition-id="main" data-width="160" data-height="120" data-duration="1" style="background:orange"></main>',
      );
      const state = workers.start(
        {
          project: { id: "trash", dir: project },
          outputPath: join(root, "out.mp4"),
          format: "mp4",
          fps: { num: 30, den: 1 },
          quality: "draft",
          jobId: "trash",
        },
        { filename: "out.mp4", directory: root, range: { start: 5, end: 10 } },
      );
      const deadline = Date.now() + 30000;
      while (state.status === "rendering" && Date.now() < deadline)
        await Bun.sleep(20);
      expect(state.error).toBeUndefined();
      expect(state.status).toBe("complete");
      expect(await Bun.file(join(root, "out.mp4")).exists()).toBe(true);
      expect(await Bun.file(join(project, skipped, "ignored.txt")).text()).toBe(
        "not part of the export",
      );
    } finally {
      await workers.cancelAll();
      await rm(root, { recursive: true, force: true });
    }
  },
  40000,
);

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "a repeated marked export reuses the frames the first extracted, in a cache trimmed before each export",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-frames-"));
    const project = join(root, "project");
    const cache = join(root, "frames");
    const workers = createRenderWorkers({
      scratchDir: join(root, "scratch"),
      frameCache: { dir: cache, maxBytes: 1024 ** 2 },
    });
    try {
      await mkdir(project);
      await command([
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x120:rate=30:duration=2",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        join(project, "source.mp4"),
      ]);
      await writeFile(
        join(project, "index.html"),
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}video{position:absolute;inset:0;width:160px;height:120px}</style></head><body><main data-composition-id="main" data-width="160" data-height="120" data-fps="30" data-duration="2" style="position:relative;width:160px;height:120px"><video id="picture" class="clip" src="source.mp4" muted data-start="0" data-duration="2" data-media-start="0" data-track-index="0"></video></main></body></html>`,
      );
      // An entry from a recent export, over the limit on its own. HyperFrames' own sweep spares
      // entries used within the hour; Cutroom trims before each export, when no render reads them.
      const stale = join(cache, "hfcache-v8-0123456789abcdef");
      await mkdir(stale, { recursive: true });
      await writeFile(
        join(stale, "frame_00001.jpg"),
        Buffer.alloc(2 * 1024 ** 2),
      );
      await writeFile(join(stale, ".hf-complete"), "");
      const entries = async () =>
        (await readdir(cache)).filter((name) => name.startsWith("hfcache-"));
      const kept: string[][] = [];
      for (const name of ["first", "second"]) {
        const state = workers.start(
          {
            project: { id: "frames", dir: project },
            outputPath: join(root, `${name}.mp4`),
            format: "mp4",
            fps: { num: 30, den: 1 },
            quality: "draft",
            jobId: name,
          },
          {
            filename: `${name}.mp4`,
            directory: root,
            range: { start: 15, end: 30 },
          },
        );
        const deadline = Date.now() + 45000;
        while (state.status === "rendering" && Date.now() < deadline)
          await Bun.sleep(20);
        expect(state.error).toBeUndefined();
        expect(state.status).toBe("complete");
        kept.push(await entries());
      }
      const [first, second] = kept;
      expect(first).not.toContain("hfcache-v8-0123456789abcdef");
      expect(first?.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
    } finally {
      await workers.cancelAll();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
