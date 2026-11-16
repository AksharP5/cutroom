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
  width: number;
  height: number;
  /** Tags from the container's `colr` box, or null when it has none. */
  colour: VideoColorSpaceInit | null;
  /** Decode order. */
  samples: Sample[];
  /** Sample indexes in presentation order. */
  shown: number[];
}

export type ReadRange = (start: number, end: number) => Promise<Uint8Array>;

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
    const head = new DataView((await read(at, Math.min(size, at + 16))).buffer);
    let length = head.getUint32(0);
    const type = fourcc(head, 4);
    let header = 8;
    if (length === 1) {
      length = Number(head.getBigUint64(8));
      header = 16;
    } else if (length === 0) length = size - at;
    if (length < header) break;
    if (type === "moov") {
      const bytes = await read(at + header, at + length);
      return new Box("moov", new DataView(bytes.buffer, bytes.byteOffset));
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
  const mdhd = track.path("mdia", "mdhd")!.data;
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
  const colr = extensions.find(
    (box) => box.type === "colr" && fourcc(box.data, 0) === "nclx",
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
        fullRange: (colr.data.getUint8(10) & 0x80) !== 0,
      }
    : null;

  // Decode times, presentation offsets, chunk offsets and sizes, as the sample table stores them.
  const entries = (box: Box | undefined, fields: number, from = 8) => {
    if (!box) return [];
    const count = box.data.getUint32(4);
    return Array.from({ length: count }, (_, index) =>
      Array.from({ length: fields }, (_, field) =>
        box.data.getUint32(from + (index * fields + field) * 4),
      ),
    );
  };
  const durations = entries(table.child("stts"), 2);
  const ctts = table.child("ctts");
  const offsets = ctts
    ? entries(ctts, 2).map(([count, offset]) => [
        count!,
        ctts.data.getUint8(0) === 1 ? offset! | 0 : offset!,
      ])
    : [];
  const chunks = table.child("stco")
    ? entries(table.child("stco"), 1).map(([offset]) => offset!)
    : (() => {
        const co64 = table.child("co64");
        if (!co64) return [];
        const count = co64.data.getUint32(4);
        return Array.from({ length: count }, (_, index) =>
          Number(co64.data.getBigUint64(8 + index * 8)),
        );
      })();
  const stsz = table.child("stsz");
  if (!stsz) throw new Error("The video track has no sample sizes.");
  const fixed = stsz.data.getUint32(4);
  const count = stsz.data.getUint32(8);
  const sizes = Array.from(
    { length: count },
    (_, index) => fixed || stsz.data.getUint32(12 + index * 4),
  );
  const stss = table.child("stss");
  const keys = stss
    ? new Set(entries(stss, 1).map(([sample]) => sample! - 1))
    : null;
  const toChunk = entries(table.child("stsc"), 3);

  // The edit list's first media time is where presentation starts.
  let shift = 0;
  const elst = track.path("edts", "elst");
  if (elst) {
    const version = elst.data.getUint8(0);
    const edits = elst.data.getUint32(4);
    for (let index = 0, at = 8; index < edits; index++) {
      const mediaTime =
        version === 1
          ? Number(elst.data.getBigInt64(at + 8))
          : elst.data.getInt32(at + 4);
      at += version === 1 ? 20 : 12;
      if (mediaTime >= 0) {
        shift = mediaTime;
        break;
      }
    }
  }

  const samples: Sample[] = [];
  let decodeTime = 0;
  let durationRun = 0;
  let durationIndex = 0;
  let offsetRun = 0;
  let offsetIndex = 0;
  for (let chunk = 0, sample = 0; chunk < chunks.length; chunk++) {
    const run = toChunk.findLast(([first]) => first! - 1 <= chunk);
    let at = chunks[chunk]!;
    for (let n = 0; n < (run?.[1] ?? 0) && sample < count; n++, sample++) {
      const offset = offsets[offsetIndex]?.[1] ?? 0;
      samples.push({
        offset: at,
        size: sizes[sample]!,
        time: (decodeTime + offset - shift) / timescale,
        key: keys ? keys.has(sample) : true,
      });
      at += sizes[sample]!;
      decodeTime += durations[durationIndex]?.[1] ?? 0;
      if (++durationRun >= (durations[durationIndex]?.[0] ?? Infinity)) {
        durationIndex++;
        durationRun = 0;
      }
      if (offsets.length && ++offsetRun >= offsets[offsetIndex]![0]!) {
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
