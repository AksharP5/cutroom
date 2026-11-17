import type { Pieces } from "./protocol";

/** About this much video per piece: one is made in well under a second at 1080p60. */
const pieceSeconds = 4;

/** One Float64 index per piece plus a terminal index, then the presentation times. */
export const proxySamplesFile = "samples.f64";

/**
 * Cuts a video's frame times, sorted, into pieces of about four seconds. Each cut lies midway
 * between two frames, so a seek or a trim to it can never round onto the wrong one.
 */
export function cutPieces(times: number[], frameDuration: number) {
  if (!times.length) throw new Error("The media has no video frames.");
  const cuts: number[] = [];
  const starts: number[] = [];
  const sampleOffsets = [0];
  let start = times[0]!;
  for (const [index, time] of times.entries()) {
    if (time - start < pieceSeconds) continue;
    cuts.push((times[index - 1]! + time) / 2);
    starts.push(time);
    sampleOffsets.push(index);
    start = time;
  }
  const last = times.at(-1)!;
  const end = last + (times.length > 1 ? last - times.at(-2)! : frameDuration);
  sampleOffsets.push(times.length);
  return { cuts, starts, end, sampleOffsets };
}

/** Where each piece starts and how long it lasts. */
export function pieceSpans(pieces: Pieces) {
  const starts = [0, ...pieces.starts];
  return starts.map((start, index) => ({
    start,
    length: (starts[index + 1] ?? pieces.end) - start,
  }));
}

/** The piece a time falls in. */
export const pieceAt = (pieces: Pieces, time: number) =>
  pieces.cuts.findLastIndex((cut) => cut <= time) + 1;

const fourCC = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** The ISO BMFF boxes in `bytes`, each with its type, offset and contents after its header. */
function* boxes(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 8 <= bytes.byteLength;) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1 && offset + 16 <= bytes.byteLength) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) size = bytes.byteLength - offset;
    if (size < header || offset + size > bytes.byteLength) return;
    yield {
      type: fourCC(bytes.subarray(offset + 4, offset + 8)),
      offset,
      body: bytes.subarray(offset + header, offset + size),
    };
    offset += size;
  }
}
const child = (bytes: Uint8Array, type: string) =>
  [...boxes(bytes)].find((box) => box.type === type)?.body;
const uint32 = (bytes: Uint8Array, at: number) =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);

/** Where a piece's movie fragments begin, after its header. */
export function fragmentsStart(head: Uint8Array) {
  const fragment = [...boxes(head)].find((box) => box.type === "moof");
  if (!fragment)
    throw new Error("The editing proxy piece has no movie fragment.");
  return fragment.offset;
}

/** The first track's id and clock, from a movie header: the proxy maps its video first. */
export function firstTrack(moov: Uint8Array) {
  const trak = child(moov, "trak");
  const tkhd = trak && child(trak, "tkhd");
  const mdhd = trak && child(child(trak, "mdia") ?? new Uint8Array(), "mdhd");
  if (!tkhd || !mdhd) throw new Error("The editing proxy has no video track.");
  // Version 1 headers carry 64-bit times before the fields read here.
  return {
    id: uint32(tkhd, tkhd[0] === 1 ? 20 : 12),
    timescale: uint32(mdhd, mdhd[0] === 1 ? 20 : 12),
  };
}

/** When a movie fragment's samples of `track` start, in that track's clock. */
export function fragmentStart(moof: Uint8Array, track: number) {
  for (const traf of boxes(moof)) {
    if (traf.type !== "traf") continue;
    const tfhd = child(traf.body, "tfhd");
    const tfdt = child(traf.body, "tfdt");
    if (!tfhd || !tfdt || uint32(tfhd, 4) !== track) continue;
    return tfdt[0] === 1
      ? Number(new DataView(tfdt.buffer, tfdt.byteOffset).getBigUint64(4))
      : uint32(tfdt, 4);
  }
  throw new Error("The editing proxy fragment has no video.");
}

/** Complete top-level boxes from a stream, such as a fragmented MP4 FFmpeg is writing. */
export async function* streamBoxes(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const take = (count: number) => {
    const out = new Uint8Array(count);
    for (let filled = 0; filled < count;) {
      const chunk = chunks[0]!;
      const used = Math.min(chunk.byteLength, count - filled);
      out.set(chunk.subarray(0, used), filled);
      filled += used;
      if (used === chunk.byteLength) chunks.shift();
      else chunks[0] = chunk.subarray(used);
    }
    length -= count;
    return out;
  };
  const peek = (count: number) => {
    const head = take(count);
    chunks.unshift(head);
    length += count;
    return head;
  };
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.byteLength;
    while (length >= 16) {
      const head = peek(16);
      const view = new DataView(head.buffer);
      const size =
        view.getUint32(0) === 1
          ? Number(view.getBigUint64(8))
          : view.getUint32(0);
      if (size < 8) throw new Error("The editing proxy stream is malformed.");
      if (length < size) break;
      yield take(size);
    }
  }
  while (length >= 8) {
    const size = new DataView(peek(8).buffer).getUint32(0);
    if (size < 8 || length < size) break;
    yield take(size);
  }
  if (length) throw new Error("The editing proxy stream ended inside a box.");
}

/**
 * The pieces as an HLS playlist the preview's `<video>` plays on its own: every piece listed
 * from the start, each fetched when the playhead needs it. `uri` names a piece, or the header.
 */
export function piecePlaylist(
  pieces: Pieces,
  uri: (piece: number | "init") => string,
) {
  const spans = pieceSpans(pieces);
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...spans.map((span) => span.length)))}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="${uri("init")}"`,
    ...spans.flatMap(({ start, length }, index) => {
      // Chromium can align the fragment's first PTS to the playlist's segment start.
      // Round the endpoints so rounding the lengths never accumulates clock drift.
      const micros =
        Math.round((start + length) * 1e6) - Math.round(start * 1e6);
      return [`#EXTINF:${(micros / 1e6).toFixed(6)},`, uri(index)];
    }),
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}
