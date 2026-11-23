import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pictureSourceWire,
  sourcePictures,
} from "../src/server/media/pictureIndex";
import { fraction, pictureStart } from "../src/shared/timeline/piece";
import { placedMedia } from "../src/shared/timeline/placedMedia";
import {
  encodeTicks,
  framePicture,
  pictureSeek,
  pictureTable,
  presentedPicture,
  readPictureSource,
  readPictureTable,
  slotPiece,
} from "../src/shared/timeline/pictureSource";
import type { Fps } from "../src/shared/timeline/schema";

const ready = Bun.which("ffmpeg") && Bun.which("ffprobe");

async function ffmpeg(...args: string[]) {
  const child = Bun.spawn(["ffmpeg", "-v", "error", "-nostdin", ...args], {
    stderr: "pipe",
  });
  if ((await child.exited) !== 0)
    throw new Error(await new Response(child.stderr).text());
}

/** What the viewer receives: the server's facts after a trip through JSON. */
async function viewerFacts(path: string, html: string) {
  const indexed = await sourcePictures(path);
  if (!indexed) throw new Error("The fixture has no picture index.");
  const source = readPictureSource(
    JSON.parse(JSON.stringify(pictureSourceWire(indexed))),
  );
  const { placed, fps } = placedMedia(html);
  const table = readPictureTable(
    JSON.parse(JSON.stringify(pictureTable(placed, fps))),
  );
  if (!source || !table) throw new Error("The viewer could not read them.");
  const piece = slotPiece("picture", table.videos.picture!, fps, source.end);
  return {
    source,
    at: (frame: number) => {
      const ordinal = framePicture(piece, source.index, frame, fps);
      return ordinal === null ? null : Number(ordinal);
    },
  };
}

const page = (fps: Fps, video: string) =>
  `<!doctype html><html><body><main data-composition-id="main" data-width="96" data-height="54" data-fps="${fps.num}/${fps.den}" data-duration="100">${video}</main></body></html>`;

test.skipIf(!ready)(
  "P13b: the viewer's loop wraps on the native end it receives, at both wraps and for 2,000 frames",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-picture-"));
    try {
      const path = join(root, "loop.mp4");
      await ffmpeg(
        ...["-f", "lavfi", "-i", "nullsrc=s=64x16:r=30000/1001"],
        ...["-frames:v", "61", "-c:v", "libx264", "-preset", "ultrafast"],
        ...["-video_track_timescale", "30000", path],
      );
      const ntsc = { num: 30000, den: 1001 };
      const { source, at } = await viewerFacts(
        path,
        page(
          ntsc,
          `<video id="picture" src="loop.mp4" muted loop data-start="0" data-duration="66.733333" data-media-start="0.500500"></video>`,
        ),
      );
      // 61,061 ticks of 1/30000 s survive the trip as an exact end.
      expect(source.end).toEqual({ n: 61061n, d: 30000n });
      expect([45, 46, 47, 91, 92, 93].map(at)).toEqual([
        60, 15, 16, 60, 15, 16,
      ]);
      for (let frame = 0; frame < 2000; frame++)
        expect(at(frame), `frame ${frame}`).toBe(15 + (frame % 46));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!ready)(
  "P11: a variable-rate file's presented times reach the viewer exactly, and each seek lands inside its picture",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-picture-"));
    try {
      const path = join(root, "vfr.mp4");
      await ffmpeg(
        ...["-f", "lavfi", "-i", "nullsrc=s=64x16:r=1000"],
        "-vf",
        "setpts='if(lt(N,3),if(eq(N,0),0,if(eq(N,1),40,50)),if(eq(N,3),100,if(eq(N,4),120,200)))'",
        ...["-frames:v", "6", "-c:v", "libx264", "-bf", "0"],
        ...["-bsf:v", "setts=duration=1", "-fps_mode", "vfr"],
        ...["-enc_time_base", "1/1000", "-video_track_timescale", "1000", path],
      );
      const { source, at } = await viewerFacts(
        path,
        page(
          { num: 30, den: 1 },
          `<video id="picture" src="vfr.mp4" muted data-start="0" data-duration="0.233333"></video>`,
        ),
      );
      const starts = [0, 40, 50, 100, 120, 200];
      if (!("ticks" in source.index))
        throw new Error("The fixture should index its own times.");
      const { index } = source;
      expect(Array.from(index.ticks, (_, k) => pictureStart(index, k))).toEqual(
        starts.map((ms) => fraction(BigInt(ms), 1000n)),
      );
      expect([0, 1, 2, 3, 4, 5, 6].map(at)).toEqual([0, 0, 2, 3, 4, 4, 5]);
      for (const [ordinal, ms] of starts.entries()) {
        const seek = pictureSeek(source.index, BigInt(ordinal)) * 1000;
        expect(seek).toBeGreaterThan(ms);
        expect(seek).toBeLessThan(starts[ordinal + 1] ?? Infinity);
        // A decoder reports the picture's own timestamp, which names the same picture.
        expect(presentedPicture(source.index, ms * 1000)).toBe(BigInt(ordinal));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("P12: a picture decoded on Matroska's millisecond clock is the grid picture export writes", () => {
  const index = {
    origin: fraction(0n),
    rate: { num: 60, den: 1 },
    count: 600n,
  };
  // OBS stamps picture k at round(k * 1000 / 60) ms, up to a third of a millisecond off its slot.
  for (let k = 0; k < 600; k++)
    expect(presentedPicture(index, Math.round((k * 1000) / 60) * 1000)).toBe(
      BigInt(k),
    );
});

test("a long recording's picture times travel as a few runs and come back exactly", () => {
  // OBS on a millisecond clock at 60 fps, dropping one picture in a thousand, for 2.8 hours.
  const ms = { num: 1n, d: 1000n };
  const step = fraction(1000n, 60n);
  const recorded: number[] = [];
  for (let slot = 0; recorded.length < 604_196; slot++)
    if (slot % 1000 !== 999) recorded.push(Math.round((slot * 1000) / 60));
  const wire = encodeTicks(recorded, step);
  expect(wire.runs.length).toBeLessThan(5000);
  // Any list, such as a phone's variable rate, survives exactly, if not as compactly.
  let at = 7;
  const irregular = Array.from(
    { length: 5000 },
    (_, k) => (at += 1 + ((k * 7919) % 37)),
  );
  for (const [ticks, by] of [
    [recorded, step],
    [irregular, step],
    [irregular, fraction(1n)],
  ] as const) {
    const source = readPictureSource(
      JSON.parse(
        JSON.stringify({
          index: {
            tick: `${ms.num}/${ms.d}`,
            offset: "0/1",
            ticks: encodeTicks(ticks, by),
          },
          end: null,
        }),
      ),
    );
    if (!source || !("ticks" in source.index))
      throw new Error("The viewer could not read the index.");
    expect(Array.from(source.index.ticks)).toEqual(ticks);
  }
});
