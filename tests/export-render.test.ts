import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
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
    const workers = createRenderWorkers();
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
    }
  },
  // Captures four Chromium renders, encodes MP4s, and decodes their video and audio edges.
  120_000,
);

test("marked export planning refuses links outside the project before copying them", async () => {
  const root = await mkdtemp(join(tmpdir(), "export-link-"));
  const project = join(root, "project");
  const workers = createRenderWorkers();
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
