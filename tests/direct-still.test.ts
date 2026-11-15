import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeStills } from "../src/server/hyperframes/directStill";
import type { DirectPlan } from "../src/server/hyperframes/directSchema";

const placement = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
  opacity: 1,
  beneath: null,
};
const plan = (src: string, beneath: string | null = null): DirectPlan => ({
  width: 640,
  height: 360,
  durationFrames: 20,
  frames: { start: 0, end: 20 },
  segments: [
    { kind: "source", start: 0, end: 10, src: "a.mp4", mediaStart: 0 },
    {
      kind: "source",
      start: 10,
      end: 20,
      src,
      mediaStart: 0,
      still: { fit: "contain" },
      placement: { ...placement, beneath },
    },
  ],
});

/** An APP1 segment holding only an EXIF orientation. */
function exif(orientation: number) {
  const tiff = Buffer.alloc(26);
  tiff.write("MM\0*", 0, "latin1");
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([header, body]);
}

test.skipIf(!Bun.which("ffmpeg"))(
  "a still FFmpeg would draw differently from the browser goes to the browser",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "direct-still-"));
    try {
      const make = (name: string, size: string) =>
        Bun.spawn([
          "ffmpeg",
          ...["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${size}`],
          ...["-frames:v", "1", join(root, name)],
        ]).exited;
      await Promise.all([
        make(
          "wide.png",
          "640x360,format=rgb24,setparams=color_primaries=unknown:color_trc=unknown:colorspace=unknown",
        ),
        // FFmpeg tags a BT.709 frame's PNG with cICP, cHRM and gAMA, which the browser converts.
        make(
          "tagged.png",
          "640x360,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
        ),
        make("photo.jpg", "480x360"),
      ]);
      const jpeg = await readFile(join(root, "photo.jpg"));
      const withExif = (orientation: number) =>
        Buffer.concat([
          jpeg.subarray(0, 2),
          exif(orientation),
          jpeg.subarray(2),
        ]);
      await writeFile(join(root, "upright.jpg"), withExif(1));
      // A phone photo stored sideways: the browser turns it upright, FFmpeg would not.
      await writeFile(join(root, "sideways.jpg"), withExif(6));

      // Full frame: drawn from the file at its own size.
      expect(await placeStills(plan("wide.png"), root)).toMatchObject({
        segments: [
          { kind: "source" },
          { kind: "source", still: { width: 640, height: 360 } },
        ],
      });
      // A 4:3 photo is letterboxed, so it needs a known colour beneath it.
      expect(await placeStills(plan("photo.jpg"), root)).toMatchObject({
        segments: [{ kind: "source" }, { kind: "capture", start: 10 }],
      });
      expect(
        await placeStills(plan("upright.jpg", "#111111"), root),
      ).toMatchObject({
        segments: [
          { kind: "source" },
          { kind: "source", still: { width: 480, height: 360 } },
        ],
      });
      expect(
        await placeStills(plan("sideways.jpg", "#111111"), root),
      ).toMatchObject({
        segments: [{ kind: "source" }, { kind: "capture", start: 10 }],
      });
      expect(await placeStills(plan("tagged.png"), root)).toMatchObject({
        segments: [{ kind: "source" }, { kind: "capture", start: 10 }],
      });
      // A file outside the project is refused like any other source.
      expect(await placeStills(plan("../outside.png"), root)).toMatchObject({
        segments: [{ kind: "source" }, { kind: "capture" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
