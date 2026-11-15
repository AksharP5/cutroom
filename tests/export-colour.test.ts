import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const colours = ["ff0000", "00ff00", "0000ff", "c08060"];
const hex = (colour: string) =>
  [0, 2, 4].map((at) => parseInt(colour.slice(at, at + 2), 16));
// What Chromium's colour-managed preview (the capture browser) draws for each source,
// sampled from its screenshots. Untagged H.264 under 720 lines is BT.601 there, gamut
// included; from 720 lines it is BT.709, so these BT.601-encoded bars shift.
const rows = [
  { name: "CSS", source: null, expected: colours.map(hex) },
  {
    name: "untagged SD",
    source: { size: "640x360", encode: "format=yuv420p" },
    expected: [
      [248, 36, 0],
      [63, 251, 0],
      [26, 34, 254],
      [187, 128, 93],
    ],
  },
  {
    name: "untagged HD",
    source: { size: "1280x720", encode: "format=yuv420p" },
    expected: [
      [255, 24, 0],
      [0, 214, 0],
      [0, 15, 255],
      [196, 131, 91],
    ],
  },
  {
    name: "tagged BT.709 HD",
    source: {
      size: "1280x720",
      encode:
        "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
    },
    expected: colours.map(hex),
  },
];
// 4:2:0 encoding twice, and Chromium's own rounding, move flat patches by up to 3.
const tolerance = 6;

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "exports draw CSS and video colours as the preview does, tagged BT.709",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-colour-"));
    // The project is the whole folder, so its scratch lives beside it.
    const scratchDir = `${root}-scratch`;
    const workers = createRenderWorkers({ scratchDir });
    try {
      const bars = colours.map((colour) => `color=c=0x${colour}:s=40x40`);
      const videos = await Promise.all(
        rows.map(async ({ source }, index) => {
          if (!source) return "";
          const file = `source-${index}.mp4`;
          await command([
            "ffmpeg",
            ...["-v", "error", "-nostdin", "-f", "lavfi", "-i"],
            `${bars.map((bar, at) => `${bar}:d=1[c${at}]`).join(";")};${colours.map((_, at) => `[c${at}]`).join("")}hstack=inputs=${colours.length},scale=${source.size}:flags=neighbor,format=rgb24`,
            ...["-r", "30", "-c:v", "libx264", "-preset", "ultrafast"],
            ...["-crf", "8", "-vf", source.encode, join(root, file)],
          ]);
          return `<video class="clip" src="${file}" muted data-start="0" data-duration="1" data-media-start="0" data-track-index="${index}" style="position:absolute;left:0;top:${index * 90}px;width:640px;height:90px;object-fit:fill"></video>`;
        }),
      );
      const css = colours
        .map(
          (colour, at) =>
            `<div style="position:absolute;left:${at * 160}px;top:0;width:160px;height:90px;background:#${colour}"></div>`,
        )
        .join("");
      await writeFile(
        join(root, "index.html"),
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}</style></head><body><main data-composition-id="main" data-width="640" data-height="360" data-fps="30/1" data-duration="1" style="position:relative;width:640px;height:360px">${css}${videos.join("")}</main></body></html>`,
      );
      const outputPath = join(root, "export.mp4");
      const state = workers.start(
        {
          project: { id: "colour", dir: root },
          outputPath,
          format: "mp4",
          fps: { num: 30, den: 1 },
          quality: "high",
          jobId: "colour",
        },
        { filename: "export.mp4", directory: root, range: null },
      );
      const deadline = Date.now() + 60_000;
      while (state.status === "rendering" && Date.now() < deadline)
        await Bun.sleep(50);
      expect(state.error).toBeUndefined();
      expect(state.status).toBe("complete");

      const tags = await command([
        "ffprobe",
        ...["-v", "error", "-select_streams", "v", "-of", "json"],
        "-show_entries",
        "stream=color_space,color_primaries,color_transfer,color_range",
        outputPath,
      ]);
      expect(JSON.parse(tags.toString()).streams[0]).toEqual({
        color_range: "tv",
        color_space: "bt709",
        color_transfer: "bt709",
        color_primaries: "bt709",
      });

      // Decoded as a player would, from the file's tags.
      const frame = await command([
        "ffmpeg",
        ...["-v", "error", "-i", outputPath, "-vf", "select=eq(n\\,15)"],
        ...["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
      ]);
      const drawn = rows.map((_, row) =>
        colours.map((_, column) => {
          const sum = [0, 0, 0];
          for (let y = row * 90 + 41; y < row * 90 + 50; y++)
            for (let x = column * 160 + 76; x < column * 160 + 85; x++)
              for (let k = 0; k < 3; k++)
                sum[k]! += frame[(y * 640 + x) * 3 + k]!;
          return sum.map((total) => Math.round(total / 81));
        }),
      );
      for (const [row, { name, expected }] of rows.entries())
        for (const [column, colour] of expected.entries()) {
          const actual = drawn[row]![column]!;
          const error = Math.max(
            ...actual.map((value, k) => Math.abs(value - colour[k]!)),
          );
          expect(
            error,
            `${name} #${colours[column]} drew ${actual}, preview ${colour}`,
          ).toBeLessThanOrEqual(tolerance);
        }
    } finally {
      await workers.cancelAll();
      await rm(root, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
    }
  },
  // Encodes three sources, captures 30 Chromium frames, and decodes one.
  90_000,
);
