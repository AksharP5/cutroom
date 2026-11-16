import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVideoTrack } from "../src/client/pipeline/mp4";

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
