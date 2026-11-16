/**
 * Just enough ISO BMFF (MP4, MOV) to feed WebCodecs: the first video track's codec, decoder
 * description, colour tags and sample table, read with byte ranges so the media stays on disk.
 * Fragmented files and anything else unusual throw, and the clip stays with HyperFrames.
 */

export interface Sample {
  offset: number;
  size: number;
  /** Presentation time in seconds, after the track's edit list. */
  time: number;
  key: boolean;
}

export interface VideoTrack {
  codec: string;
  description: Uint8Array;
  /** Stored picture size, before rotation. */
  width: number;
  height: number;
  /** Clockwise quarter turns the track's matrix shows the picture with, in degrees. */
  rotation: 0 | 90 | 180 | 270;
  /** Tags from the container's `colr` box, or null when it has none. */
  colour: VideoColorSpaceInit | null;
  /** Decode order. */
  samples: Sample[];
  /** Sample indexes in presentation order. */
  shown: number[];
}

export type ReadRange = (start: number, end: number) => Promise<Uint8Array>;

/**
 * Bounds that real files sit far inside, so a crafted header fails fast instead of allocating:
 * a movie header of 64 MB holds hours of 4K footage, and 2 million samples is nine hours at
 * 60 fps. One compressed frame is never near 64 MB.
 */
export const LIMITS = {
  movie: 64 << 20,
  samples: 2_000_000,
  sample: 64 << 20,
};

class Box {
  constructor(
    readonly type: string,
    readonly data: DataView,
  ) {}
  children() {
    return readBoxes(this.data, 0);
  }
  child(type: string) {
    return this.children().find((box) => box.type === type);
  }
  path(...types: string[]) {
    let box: Box | undefined = this;
    for (const type of types) box = box?.child(type);
    return box;
  }
}

const fourcc = (view: DataView, at: number) =>
  String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );

function readBoxes(view: DataView, from: number) {
  const boxes: Box[] = [];
  for (let at = from; at + 8 <= view.byteLength;) {
    let size = view.getUint32(at);
    const type = fourcc(view, at + 4);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = view.byteLength - at;
    if (size < header || at + size > view.byteLength) break;
    boxes.push(
      new Box(
        type,
        new DataView(view.buffer, view.byteOffset + at + header, size - header),
      ),
    );
    at += size;
  }
  return boxes;
}

/** Finds the top-level `moov` from box headers alone, then reads only it. */
async function readMovie(read: ReadRange, size: number) {
  for (let at = 0; at + 8 <= size;) {
    const bytes = await read(at, Math.min(size, at + 16));
    if (bytes.byteLength < 8) break;
    const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let length = head.getUint32(0);
    const type = fourcc(head, 4);
    let header = 8;
    if (length === 1) {
      if (bytes.byteLength < 16) break;
      length = Number(head.getBigUint64(8));
      header = 16;
    } else if (length === 0) length = size - at;
    if (length < header || at + length > size) break;
    if (type === "moov") {
      if (length > LIMITS.movie)
        throw new Error("The movie header is larger than any real file's.");
      const movie = await read(at + header, at + length);
      return new Box(
        "moov",
        new DataView(movie.buffer, movie.byteOffset, movie.byteLength),
      );
    }
    if (type === "moof") break;
    at += length;
  }
  throw new Error("The file has no movie header the pipeline can read.");
}

const PRIMARIES: Record<number, VideoColorPrimaries> = {
  1: "bt709",
  5: "bt470bg",
  6: "smpte170m",
};
const TRANSFERS: Record<number, VideoTransferCharacteristics> = {
  1: "bt709",
  6: "smpte170m",
  13: "iec61966-2-1",
};
const MATRICES: Record<number, VideoMatrixCoefficients> = {
  0: "rgb",
  1: "bt709",
  5: "bt470bg",
  6: "smpte170m",
};

const hex = (value: number) => value.toString(16).padStart(2, "0");

/** RFC 6381 codec strings, as WebCodecs names them. */
function codecString(type: string, config: DataView) {
  if (type === "avc1" || type === "avc3")
    return `${type}.${hex(config.getUint8(1))}${hex(config.getUint8(2))}${hex(config.getUint8(3))}`;
  // hvcC: profile space, tier and profile, compatibility flags, constraint flags, level.
  const first = config.getUint8(1);
  const space = ["", "A", "B", "C"][first >> 6]!;
  const tier = first & 0x20 ? "H" : "L";
  const profile = first & 0x1f;
  let flags = config.getUint32(2);
  let reversed = 0;
  for (let bit = 0; bit < 32; bit++) {
    reversed = (reversed << 1) | (flags & 1);
    flags >>>= 1;
  }
  const constraints: string[] = [];
  for (let at = 6; at < 12; at++) constraints.push(hex(config.getUint8(at)));
  while (constraints.length > 1 && constraints.at(-1) === "00")
    constraints.pop();
  return `${type}.${space}${profile}.${(reversed >>> 0).toString(16)}.${tier}${config.getUint8(12)}.${constraints
    .map((value) => value.replace(/^0/, "") || "0")
    .join(".")}`;
}

/**
 * The clockwise rotation of a track header's matrix, as Chrome shows a phone's portrait video.
 * Mirrors, scales and shears are refused: the browser would draw them in ways the pipeline does not.
 */
function rotationOf(tkhd: Box | undefined): VideoTrack["rotation"] {
  if (!tkhd) return 0;
  const at = tkhd.data.getUint8(0) === 1 ? 52 : 40;
  if (at + 36 > tkhd.data.byteLength)
    throw new Error("The track header is cut short.");
  // 16.16 fixed point: x' = a x + c y, y' = b x + d y, with y pointing down.
  const [a, b, , c, d] = [0, 4, 8, 12, 16].map(
    (offset) => tkhd.data.getInt32(at + offset) / 65536,
  ) as [number, number, number, number, number];
  const turns = {
    "1,0,0,1": 0,
    "0,1,-1,0": 90,
    "-1,0,0,-1": 180,
    "0,-1,1,0": 270,
  } as const;
  const rotation = turns[`${a},${b},${c},${d}` as keyof typeof turns];
  if (rotation === undefined)
    throw new Error("The video's matrix mirrors or distorts its picture.");
  return rotation;
}

export async function readVideoTrack(
  read: ReadRange,
  size: number,
): Promise<VideoTrack> {
  const movie = await readMovie(read, size);
  const track = movie
    .children()
    .filter((box) => box.type === "trak")
    .find((trak) => {
      const handler = trak.path("mdia", "hdlr");
      return handler && fourcc(handler.data, 8) === "vide";
    });
  if (!track) throw new Error("The file has no video track.");
  const mdhd = track.path("mdia", "mdhd")?.data;
  if (!mdhd) throw new Error("The video track has no media header.");
  const timescale =
    mdhd.getUint8(0) === 1 ? mdhd.getUint32(20) : mdhd.getUint32(12);
  const table = track.path("mdia", "minf", "stbl");
  const description = table?.child("stsd");
  if (!table || !description)
    throw new Error("The video track has no samples.");
  const entry = readBoxes(description.data, 8)[0];
  if (!entry || !["avc1", "avc3", "hvc1", "hev1"].includes(entry.type))
    throw new Error(
      `The pipeline cannot decode ${entry?.type ?? "this"} video.`,
    );
  const width = entry.data.getUint16(24);
  const height = entry.data.getUint16(26);
  const extensions = readBoxes(entry.data, 78);
  const config = extensions.find(
    (box) => box.type === (entry.type.startsWith("avc") ? "avcC" : "hvcC"),
  );
  if (!config) throw new Error("The video track has no decoder configuration.");
  // MP4 writes `nclx`; QuickTime's `nclc` has the same tags without the range flag.
  const colr = extensions.find(
    (box) =>
      box.type === "colr" && ["nclx", "nclc"].includes(fourcc(box.data, 0)),
  );
  // Wide-gamut and HDR footage needs Chrome's tone mapping, so HyperFrames keeps it.
  if (
    colr &&
    ([9, 12].includes(colr.data.getUint16(4)) ||
      [16, 18].includes(colr.data.getUint16(6)))
  )
    throw new Error("Wide-gamut and HDR video stays with HyperFrames.");
  const colour = colr
    ? {
        primaries: PRIMARIES[colr.data.getUint16(4)] ?? null,
        transfer: TRANSFERS[colr.data.getUint16(6)] ?? null,
        matrix: MATRICES[colr.data.getUint16(8)] ?? null,
        fullRange:
          fourcc(colr.data, 0) === "nclx" &&
          (colr.data.getUint8(10) & 0x80) !== 0,
      }
    : null;
  const rotation = rotationOf(track.child("tkhd"));

  if (!(timescale > 0)) throw new Error("The video track has no timescale.");
  const cut = () => new Error("The sample table is cut short.");
  /** A table of `count` rows of `fields` 32-bit numbers, read in place. */
  const rows = (box: Box | undefined, fields: number, from = 8) => {
    if (!box) return { count: 0, at: () => 0 };
    const count = box.data.getUint32(4);
    if (from + count * fields * 4 > box.data.byteLength) throw cut();
    return {
      count,
      at: (row: number, field: number) =>
        box.data.getUint32(from + (row * fields + field) * 4),
    };
  };
  const durations = rows(table.child("stts"), 2);
  const offsets = rows(table.child("ctts"), 2);
  // Signed in either version, as FFmpeg and so Chrome read them: DaVinci Resolve writes negative
  // offsets in a version 0 box.
  const offsetAt = (row: number) => offsets.at(row, 1) | 0;
  const stco = table.child("stco");
  const co64 = table.child("co64");
  const chunks = stco
    ? rows(stco, 1)
    : co64
      ? (() => {
          const count = co64.data.getUint32(4);
          if (8 + count * 8 > co64.data.byteLength) throw cut();
          return {
            count,
            at: (row: number) => Number(co64.data.getBigUint64(8 + row * 8)),
          };
        })()
      : { count: 0, at: () => 0 };
  const stsz = table.child("stsz");
  if (!stsz || stsz.data.byteLength < 12)
    throw new Error("The video track has no sample sizes.");
  const fixed = stsz.data.getUint32(4);
  const count = stsz.data.getUint32(8);
  if (fixed ? fixed * count > size : 12 + count * 4 > stsz.data.byteLength)
    throw cut();
  if (count > LIMITS.samples)
    throw new Error("The video track has more samples than any real file's.");
  const sizeOf = (sample: number) =>
    fixed || stsz.data.getUint32(12 + sample * 4);
  const stss = rows(table.child("stss"), 1);
  const keys = stss.count
    ? new Set(
        Array.from({ length: stss.count }, (_, row) => stss.at(row, 0) - 1),
      )
    : null;
  const toChunk = rows(table.child("stsc"), 3);

  // One edit whose media time is where presentation starts, as encoders and phone trims write.
  // An empty edit delays the picture and more edits rearrange it; the browser plays those its own
  // way, so they stay with HyperFrames.
  let shift = 0;
  const elst = track.path("edts", "elst");
  if (elst) {
    const wide = elst.data.getUint8(0) === 1;
    const edits = elst.data.getUint32(4);
    if (8 + edits * (wide ? 20 : 12) > elst.data.byteLength) throw cut();
    const played: number[] = [];
    for (let index = 0, at = 8; index < edits; index++, at += wide ? 20 : 12) {
      const duration = wide
        ? Number(elst.data.getBigUint64(at))
        : elst.data.getUint32(at);
      const mediaTime = wide
        ? Number(elst.data.getBigInt64(at + 8))
        : elst.data.getInt32(at + 4);
      const rate = elst.data.getUint32(at + (wide ? 16 : 8));
      if (mediaTime < 0 ? duration > 0 : rate !== 0x10000 || played.length)
        throw new Error(
          "The video's edit list delays or rearranges its frames.",
        );
      if (mediaTime >= 0) played.push(mediaTime);
    }
    shift = played[0] ?? 0;
  }

  const samples: Sample[] = [];
  let decodeTime = 0;
  let durationRun = 0;
  let durationIndex = 0;
  let offsetRun = 0;
  let offsetIndex = 0;
  // Sample-to-chunk runs are sorted by first chunk, so one pointer walks them.
  let run = -1;
  for (
    let chunk = 0, sample = 0;
    chunk < chunks.count && sample < count;
    chunk++
  ) {
    while (run + 1 < toChunk.count && toChunk.at(run + 1, 0) - 1 <= chunk)
      run++;
    const perChunk = run < 0 ? 0 : toChunk.at(run, 1);
    let at = chunks.at(chunk, 0);
    for (let n = 0; n < perChunk && sample < count; n++, sample++) {
      const length = sizeOf(sample);
      if (length > LIMITS.sample || at + length > size)
        throw new Error("A sample lies outside the file.");
      samples.push({
        offset: at,
        size: length,
        time:
          (decodeTime +
            (offsetIndex < offsets.count ? offsetAt(offsetIndex) : 0) -
            shift) /
          timescale,
        key: keys ? keys.has(sample) : true,
      });
      at += length;
      decodeTime +=
        durationIndex < durations.count ? durations.at(durationIndex, 1) : 0;
      if (
        durationIndex < durations.count &&
        ++durationRun >= durations.at(durationIndex, 0)
      ) {
        durationIndex++;
        durationRun = 0;
      }
      if (
        offsetIndex < offsets.count &&
        ++offsetRun >= offsets.at(offsetIndex, 0)
      ) {
        offsetIndex++;
        offsetRun = 0;
      }
    }
  }
  if (!samples.length) throw new Error("The video track has no samples.");
  const shown = samples
    .map((_, index) => index)
    .sort((a, b) => samples[a]!.time - samples[b]!.time);
  return {
    codec: codecString(entry.type, config.data),
    description: new Uint8Array(
      config.data.buffer,
      config.data.byteOffset,
      config.data.byteLength,
    ),
    width,
    height,
    rotation,
    colour,
    samples,
    shown,
  };
}

/** Byte ranges of one URL, the way the media routes serve them. */
export async function openRanges(url: string, signal: AbortSignal) {
  const read: ReadRange = async (start, end) => {
    const response = await fetch(url, {
      headers: { range: `bytes=${start}-${end - 1}` },
      signal,
    });
    if (response.status !== 206 && response.status !== 200)
      throw new Error(`The media route answered ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return response.status === 200 ? bytes.subarray(start, end) : bytes;
  };
  const probe = await fetch(url, { headers: { range: "bytes=0-0" }, signal });
  await probe.body?.cancel();
  const total = Number(
    /\/(\d+)$/.exec(probe.headers.get("content-range") ?? "")?.[1] ??
      probe.headers.get("content-length"),
  );
  if (!Number.isFinite(total) || total <= 0)
    throw new Error("The media route did not say how long the file is.");
  return { read, size: total };
}
