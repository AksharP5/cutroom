import { expect, test } from "bun:test";
import { readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { peakRange } from "../src/server/media/range";
import { join } from "node:path";
import { z } from "zod";
import { encodePeaks } from "../src/server/media/peaks";
import { createMediaRoutes } from "../src/server/media/routes";
import { projectFixture } from "./project-fixture";

async function ffmpeg(args: string[]) {
  const child = Bun.spawn(
    ["ffmpeg", "-v", "error", "-nostdin", "-threads", "1", ...args],
    { stdout: "ignore", stderr: "pipe" },
  );
  const error = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(error);
}
async function ready(request: () => Promise<Response> | Response) {
  const deadline = Date.now() + 15000;
  while (true) {
    const response = await request();
    if (response.status !== 202) return response;
    if (Date.now() > deadline) throw new Error("Media request timed out.");
    await Bun.sleep(10);
  }
}
function pairs(bytes: Buffer) {
  const count = bytes.readUInt32LE(36);
  const offset = bytes.readUInt32LE(40);
  return Array.from({ length: count }, (_, index) => [
    bytes.readInt16LE(offset + index * 4),
    bytes.readInt16LE(offset + index * 4 + 2),
  ]);
}
async function fixture() {
  const base = await projectFixture();
  const routes = createMediaRoutes(base.store);
  base.app.route("/api/cutroom", routes);
  const project = await base.store.create({ name: "50% cut" });
  const url = `/projects/${project.id}/media`;
  return {
    ...base,
    project,
    url,
    async close() {
      await routes.dispose();
      await base.close();
    },
  };
}

test("impulses 8 ms apart occupy separate 2 ms base buckets", async () => {
  const pcm = Buffer.alloc(960 * 2);
  pcm.writeInt16LE(20000, 48 * 2);
  pcm.writeInt16LE(-20000, 432 * 2);
  const peaks = await encodePeaks(new Blob([pcm]).stream());
  expect(peaks.readUInt32LE(24)).toBe(96);
  expect(
    pairs(peaks).filter(([min, max]) => min !== 0 || max !== 0),
  ).toHaveLength(2);
  expect(pairs(peaks)[0]).toEqual([0, 20000]);
  expect(pairs(peaks)[4]).toEqual([-20000, 0]);
});

test.skipIf(!Bun.which("ffmpeg"))(
  "stereo phase and a one-sided mic preserve channel extrema",
  async () => {
    const f = await fixture();
    try {
      for (const [name, expression] of [
        ["phase", "sin(2*PI*500*t)|-sin(2*PI*500*t)"],
        ["mic", "sin(2*PI*500*t)|0"],
      ]) {
        await ffmpeg([
          "-f",
          "lavfi",
          "-i",
          `aevalsrc=${expression}:s=48000:d=0.1`,
          "-c:a",
          "pcm_s16le",
          join(f.project.path, `${name}.wav`),
        ]);
        const response = await ready(() =>
          f.request(`${f.url}/peaks?path=${name}.wav`),
        );
        expect(response.status).toBe(200);
        const envelope = pairs(Buffer.from(await response.arrayBuffer()));
        expect(envelope[0]![0]).toBeLessThan(-32000);
        expect(envelope[0]![1]).toBeGreaterThan(32000);
      }
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "ranged peaks return only the selected level and buckets with variant ETags",
  async () => {
    const f = await fixture();
    try {
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "sine=duration=2:sample_rate=48000",
        join(f.project.path, "audio.wav"),
      ]);
      const full = await ready(() =>
        f.request(`${f.url}/peaks?path=audio.wav`),
      );
      expect(full.status).toBe(200);
      const fullBytes = Buffer.from(await full.arrayBuffer());
      const sliceUrl = `${f.url}/peaks?path=audio.wav&level=1&start=0.1&end=0.2`;
      const slice = await f.request(sliceUrl);
      expect(slice.status).toBe(200);
      expect(slice.headers.get("etag")).not.toBe(full.headers.get("etag"));
      const bytes = Buffer.from(await slice.arrayBuffer());
      expect(bytes.readUInt32LE(8)).toBe(1);
      expect(bytes.readUInt32LE(28)).toBe(12);
      expect(bytes.readUInt32LE(32)).toBe(384);
      expect(bytes.readUInt32LE(36)).toBe(13);
      expect(bytes.length).toBe(48 + 13 * 4);
      const levelOffset = fullBytes.readUInt32LE(56);
      expect(bytes.subarray(48)).toEqual(
        fullBytes.subarray(levelOffset + 12 * 4, levelOffset + 25 * 4),
      );
      const unchanged = await f.app.request(`/api/cutroom${sliceUrl}`, {
        headers: { "if-none-match": slice.headers.get("etag")! },
      });
      expect(unchanged.status).toBe(304);
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "portrait filmstrips work inside percent paths and split after 100 tiles",
  async () => {
    const f = await fixture();
    try {
      const percent = join(f.directory, "50% cut");
      await rename(f.project.path, percent);
      const imported = await f.store.importProject({ path: percent });
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=red:size=90x160:rate=1:duration=204",
        "-c:v",
        "libx264",
        "-g",
        "1",
        "-threads",
        "1",
        join(percent, "portrait.mp4"),
      ]);
      const response = await ready(() =>
        f.request(`/projects/${imported.id}/media/filmstrip?path=portrait.mp4`),
      );
      expect(response.status).toBe(200);
      const metadata = z
        .object({
          tileHeight: z.literal(90),
          tileWidth: z.number(),
          count: z.number(),
          sheets: z.array(
            z.object({ count: z.number(), spriteUrl: z.string() }),
          ),
        })
        .parse(await response.json());
      expect(metadata.tileWidth).toBeLessThan(60);
      expect(metadata.count).toBe(102);
      expect(metadata.sheets.map((sheet) => sheet.count)).toEqual([100, 2]);
      for (const sheet of metadata.sheets)
        expect((await f.app.request(sheet.spriteUrl)).status).toBe(200);
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "precise frames reach a blue shot inside a two-second overview tile",
  async () => {
    const f = await fixture();
    try {
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=red:size=160x90:rate=30:duration=2",
        "-vf",
        "drawbox=c=blue:t=fill:enable='between(t,0.8,1.199)'",
        "-c:v",
        "libx264",
        "-g",
        "60",
        "-threads",
        "1",
        join(f.project.path, "shot.mp4"),
      ]);
      const response = await ready(() =>
        f.request(`${f.url}/frame?path=shot.mp4&time=1`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      const imagePath = join(f.directory, "frame.jpg");
      await Bun.write(imagePath, response);
      const decoder = Bun.spawn(
        [
          "ffmpeg",
          "-v",
          "error",
          "-i",
          imagePath,
          "-vf",
          "crop=2:2:0:0,format=rgb24",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      const pixel = new Uint8Array(
        await new Response(decoder.stdout).arrayBuffer(),
      );
      expect(await decoder.exited).toBe(0);
      expect(pixel[2]).toBeGreaterThan(230);
      expect(pixel[0]).toBeLessThan(20);
      const near = await f.request(`${f.url}/frame?path=shot.mp4&time=1.001`);
      expect(near.status).toBe(200);
      expect(near.headers.get("etag")).toBe(response.headers.get("etag"));
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "a same-size edit with restored mtime invalidates peaks",
  async () => {
    const f = await fixture();
    try {
      const path = join(f.project.path, "audio.wav");
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "sine=duration=0.1:sample_rate=48000",
        path,
      ]);
      const before = await ready(() =>
        f.request(`${f.url}/peaks?path=audio.wav`),
      );
      const info = await stat(path);
      const content = await readFile(path);
      content[content.length - 2] = content[content.length - 2]! ^ 127;
      await writeFile(path, content);
      await utimes(path, info.atime, info.mtime);
      expect((await stat(path)).size).toBe(info.size);
      const after = await ready(() =>
        f.request(`${f.url}/peaks?path=audio.wav`),
      );
      expect(after.status).toBe(200);
      expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "sparse keyframes fall back to seeking each overview tile",
  async () => {
    const f = await fixture();
    try {
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=red:size=160x90:rate=30:duration=8",
        "-vf",
        "drawbox=c=blue:t=fill:enable='between(t,1.5,2.5)'",
        "-c:v",
        "libx264",
        "-g",
        "240",
        "-keyint_min",
        "240",
        "-sc_threshold",
        "0",
        "-threads",
        "1",
        join(f.project.path, "sparse.mp4"),
      ]);
      const response = await ready(() =>
        f.request(`${f.url}/filmstrip?path=sparse.mp4`),
      );
      expect(response.status).toBe(200);
      const result = z
        .object({
          count: z.number(),
          sheets: z.array(z.object({ spriteUrl: z.string() })),
        })
        .parse(await response.json());
      expect(result.count).toBe(4);
      const path = join(f.directory, "sparse.jpg");
      await Bun.write(path, await f.app.request(result.sheets[0]!.spriteUrl));
      const decoder = Bun.spawn(
        [
          "ffmpeg",
          "-v",
          "error",
          "-i",
          path,
          "-vf",
          "crop=2:2:160:0,format=rgb24",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      const pixel = new Uint8Array(
        await new Response(decoder.stdout).arrayBuffer(),
      );
      expect(await decoder.exited).toBe(0);
      expect(pixel[2]).toBeGreaterThan(230);
      expect(pixel[0]).toBeLessThan(20);
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "CAF and Wave64 audio and MXF video pass the local format allow-list",
  async () => {
    const f = await fixture();
    try {
      for (const format of ["caf", "w64"]) {
        await ffmpeg([
          "-f",
          "lavfi",
          "-i",
          "sine=duration=0.1",
          "-c:a",
          "pcm_s16le",
          "-f",
          format,
          join(f.project.path, `audio.${format}`),
        ]);
        expect(
          (await ready(() => f.request(`${f.url}/peaks?path=audio.${format}`)))
            .status,
        ).toBe(200);
      }
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=red:size=720x576:rate=25:duration=0.2",
        "-c:v",
        "mpeg2video",
        "-pix_fmt",
        "yuv422p",
        "-threads",
        "1",
        "-f",
        "mxf",
        join(f.project.path, "video.mxf"),
      ]);
      expect(
        (await ready(() => f.request(`${f.url}/frame?path=video.mxf&time=0`)))
          .status,
      ).toBe(200);
    } finally {
      await f.close();
    }
  },
);

test("a two-hour cached waveform serves a kilobyte overview without sending base samples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-long-peaks-"));
  try {
    const path = join(directory, "peaks.bin");
    const header = Buffer.alloc(64);
    header.write("CRPK");
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(2, 8);
    header.writeUInt32LE(48000, 12);
    header.writeDoubleLE(345600000, 16);
    header.writeUInt32LE(96, 24);
    header.writeUInt32LE(96, 32);
    header.writeUInt32LE(3600000, 36);
    header.writeUInt32LE(64, 40);
    header.writeUInt32LE(14400000, 44);
    header.writeUInt32LE(393216, 48);
    header.writeUInt32LE(879, 52);
    header.writeUInt32LE(14400064, 56);
    header.writeUInt32LE(3516, 60);
    const file = await open(path, "w");
    try {
      await file.write(header);
      await file.truncate(14403580);
    } finally {
      await file.close();
    }
    const range = await peakRange(path, 1, 0, 7200);
    const bytes = Buffer.from(await new Response(range.body).arrayBuffer());
    expect(bytes.length).toBe(3564);
    expect(bytes.readUInt32LE(36)).toBe(879);
    expect((await stat(path)).size).toBeGreaterThan(14000000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
