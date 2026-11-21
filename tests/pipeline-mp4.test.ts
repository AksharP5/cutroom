import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, readVideoTrack } from "../src/shared/video/mp4";

async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return out;
}

/** The demuxer's samples against ffprobe's packets for the same file. */
async function compare(
  encoder: string[],
  rate: string,
  container: "mp4" | "mov",
  codec: RegExp,
  /** The `ctts` version the file must carry, when the case is about it. */
  offsets?: 0 | 1,
  /** Rewrites the file before it is read, as another muxer would have written it. */
  rewrite?: (bytes: Uint8Array) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-mp4-"));
  try {
    const path = join(directory, `clip.${container}`);
    // B-frames give the track composition offsets and an edit list, as camera files have.
    await run([
      "ffmpeg",
      ...["-v", "error", "-f", "lavfi", "-i"],
      `testsrc2=size=320x180:rate=${rate}:duration=2`,
      ...encoder,
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    const file = Bun.file(path);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (rewrite) {
      rewrite(bytes);
      await Bun.write(path, bytes);
    }
    if (offsets !== undefined)
      expect(bytes[Buffer.from(bytes).indexOf("ctts") + 4]).toBe(offsets);
    const track = await readVideoTrack(
      async (start, end) => bytes.slice(start, end),
      bytes.length,
    );
    const probe = JSON.parse(
      await run([
        "ffprobe",
        ...["-v", "error", "-select_streams", "v:0", "-show_packets"],
        ...["-show_entries", "packet=pts_time,pos,size,flags", "-of", "json"],
        path,
      ]),
    ) as {
      packets: { pts_time: string; pos: string; size: string; flags: string }[];
    };
    expect(track.codec).toMatch(codec);
    expect([track.width, track.height]).toEqual([320, 180]);
    expect(track.samples.length).toBe(probe.packets.length);
    for (const [index, packet] of probe.packets.entries()) {
      const sample = track.samples[index]!;
      expect(sample.offset).toBe(Number(packet.pos));
      expect(sample.size).toBe(Number(packet.size));
      expect(sample.key).toBe(packet.flags.startsWith("K"));
      expect(sample.time).toBeCloseTo(Number(packet.pts_time), 4);
    }
    // Presentation order starts at zero after the edit list and steps one frame at a time.
    const [num, den] = rate.split("/").map(Number) as [number, number?];
    const step = (den ?? 1) / num;
    for (const [index, sample] of track.shown.entries())
      expect(track.samples[sample]!.time).toBeCloseTo(index * step, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const ffmpeg = Bun.which("ffmpeg") && Bun.which("ffprobe");

test.skipIf(!ffmpeg)(
  "reads H.264 samples, keyframes and presentation times as ffprobe does",
  async () => {
    await compare(
      ["-c:v", "libx264", "-preset", "veryfast", "-g", "12", "-bf", "3"],
      "30000/1001",
      "mp4",
      /^avc1\.64/,
    );
    await compare(
      ["-c:v", "libx264", "-preset", "veryfast", "-g", "10"],
      "24000/1001",
      "mov",
      /^avc1\./,
    );
  },
);

test.skipIf(!ffmpeg)(
  "reads signed composition offsets in either ctts version",
  async () => {
    await compare(
      [
        ...["-c:v", "libx264", "-preset", "veryfast", "-g", "12", "-bf", "3"],
        ...["-movflags", "+negative_cts_offsets"],
      ],
      "30",
      "mp4",
      /^avc1\./,
      1,
    );
    // DaVinci Resolve writes the same negative offsets in a version 0 box.
    await compare(
      [
        ...["-c:v", "libx264", "-preset", "veryfast", "-g", "12", "-bf", "3"],
        ...["-movflags", "+negative_cts_offsets"],
      ],
      "30",
      "mov",
      /^avc1\./,
      0,
      (bytes) => {
        bytes[Buffer.from(bytes).indexOf("ctts") + 4] = 0;
      },
    );
  },
);

/** A small real MP4, then one field of one box rewritten, as a crafted file would be. */
async function crafted(edits: [box: string, at: number, value: number][]) {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-mp4-"));
  try {
    const path = join(directory, "clip.mp4");
    await run([
      "ffmpeg",
      ...[
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=30:duration=1",
      ],
      ...[
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        path,
      ],
    ]);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const view = new DataView(bytes.buffer);
    for (const [box, at, value] of edits)
      // Offsets count from the end of the box's 8-byte header.
      view.setUint32(Buffer.from(bytes).indexOf(box) + 4 + at, value);
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Fails, quickly and without holding much memory, instead of building the samples. */
async function refuses(bytes: Uint8Array, reason: RegExp) {
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  const started = performance.now();
  await expect(
    readVideoTrack(async (start, end) => bytes.slice(start, end), bytes.length),
  ).rejects.toThrow(reason);
  expect(performance.now() - started).toBeLessThan(250);
  expect(process.memoryUsage().rss - before).toBeLessThan(64 << 20);
}

test.skipIf(!ffmpeg)(
  "a crafted sample table fails fast instead of allocating",
  async () => {
    // A fixed sample size with four billion samples, in a file of a few kilobytes.
    await refuses(
      await crafted([
        ["stsz", 4, 1],
        ["stsz", 8, 0xffffffff],
      ]),
      /cut short/,
    );
    // Three million one-byte samples poured into one chunk by a huge samples-per-chunk.
    await refuses(
      await crafted([
        ["stsz", 4, 1],
        ["stsz", 8, 3_000_000],
        ["stsc", 12, 0xffffffff],
      ]),
      /cut short/,
    );
    // Sizes that fit the table but point past the end of the file.
    await refuses(await crafted([["stco", 8, 0x7fffffff]]), /outside the file/);
    // No timescale makes every presentation time infinite.
    await refuses(await crafted([["mdhd", 12, 0]]), /no timescale/);
    expect(LIMITS.samples).toBeLessThan(1 << 22);
  },
);

test.skipIf(!ffmpeg)("reads HEVC tagged as hvc1", async () => {
  const encoders = await run(["ffmpeg", "-hide_banner", "-encoders"]);
  if (!encoders.includes("libx265")) return;
  await compare(
    [
      ...["-c:v", "libx265", "-preset", "veryfast", "-tag:v", "hvc1"],
      ...["-x265-params", "keyint=12:bframes=2:log-level=error"],
    ],
    "30",
    "mp4",
    /^hvc1\.1\.6\.L\d+\.[0-9A-F]+/i,
  );
});

/** A one-second clip made by ffmpeg with `args` around its output, read by the demuxer. */
async function made(name: string, args: (path: string) => string[][]) {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-mp4-"));
  try {
    const source = join(directory, "source.mp4");
    await run([
      "ffmpeg",
      ...[
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=30:duration=1",
      ],
      ...[
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        source,
      ],
    ]);
    const path = join(directory, name);
    for (const step of args(path))
      await run(["ffmpeg", "-v", "error", "-y", ...step]);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    return () =>
      readVideoTrack(
        async (start, end) => bytes.slice(start, end),
        bytes.length,
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.skipIf(!ffmpeg)(
  "reads a phone's rotation and refuses a mirrored picture",
  async () => {
    // ffmpeg names rotations counter-clockwise; the browser turns the picture back clockwise.
    for (const [counter, clockwise] of [
      [0, 0],
      [90, 270],
      [180, 180],
      [270, 90],
    ])
      expect(
        (
          await (
            await made("turned.mp4", (path) => [
              [
                ...["-display_rotation:v:0", String(counter)],
                ...["-i", path.replace("turned", "source"), "-c", "copy", path],
              ],
            ])
          )()
        ).rotation,
      ).toBe(clockwise as 0);
    await expect(
      (
        await made("mirrored.mp4", (path) => [
          [
            ...["-display_hflip:v:0", "-i", path.replace("mirrored", "source")],
            ...["-c", "copy", path],
          ],
        ])
      )(),
    ).rejects.toThrow(/mirrors/);
  },
);

test.skipIf(!ffmpeg)(
  "reads QuickTime colour tags and refuses HDR in a MOV",
  async () => {
    const tagged = (tags: string) =>
      made("clip.mov", (path) => [
        [
          ...["-i", path.replace("clip.mov", "source.mp4")],
          ...["-vf", `setparams=${tags}`, "-c:v", "libx264", path],
        ],
      ]);
    const track = await (
      await tagged("color_primaries=bt709:color_trc=bt709:colorspace=bt709")
    )();
    expect(track.colour).toEqual({
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      fullRange: false,
    });
    await expect(
      (
        await tagged(
          "color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc",
        )
      )(),
    ).rejects.toThrow(/HDR/);
  },
);

test.skipIf(!ffmpeg)(
  "reads a trim's edit list and refuses one that delays the picture",
  async () => {
    // A stream copy from 0.4 s starts presentation inside a GOP, as a phone's trim does.
    const trimmed = await (
      await made("trimmed.mp4", (path) => [
        [
          "-ss",
          "0.4",
          "-i",
          path.replace("trimmed", "source"),
          "-c",
          "copy",
          path,
        ],
      ])
    )();
    const first = trimmed.shown.find(
      (index) => trimmed.samples[index]!.time >= 0,
    );
    expect(trimmed.samples[first!]!.time).toBeCloseTo(0, 6);
    expect(trimmed.samples[trimmed.shown[0]!]!.time).toBeLessThan(0);
    await expect(
      (
        await made("delayed.mp4", (path) => [
          [
            "-itsoffset",
            "0.5",
            "-i",
            path.replace("delayed", "source"),
            "-c",
            "copy",
            path,
          ],
        ])
      )(),
    ).rejects.toThrow(/delays or rearranges/);
  },
);
