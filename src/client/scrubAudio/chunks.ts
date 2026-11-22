import { CHUNK_SAMPLES } from "./render";
import { RAMP_STEP, sourceId, sourcePosition } from "./segment";
import type { Segment, SourceKey } from "./segment";

/** One chunk of one source's PCM file. */
export type Chunk = { source: SourceKey; index: number };

/** What a fetch found: the chunk's samples, a file still being made, or no sound to read. */
export type Loaded =
  | { kind: "samples"; samples: Int16Array }
  | { kind: "pending" }
  | { kind: "silent" };

const CHUNK_BYTES = CHUNK_SAMPLES * 2;
const CACHE_BYTES = 64 * 1024 * 1024;

const chunkId = ({ source, index }: Chunk) => `${sourceId(source)}#${index}`;

/**
 * The chunks the segments read over output samples `[from, to)`, nearest the output sample
 * `near` first.
 */
export function chunksNear(
  segments: readonly Segment[],
  from: number,
  to: number,
  near: number,
) {
  const reads = segments
    .filter(({ samples }) => samples.start < to && samples.end > from)
    .map((segment) => {
      const { start, end } = segment.samples;
      const first = Math.max(start, from);
      const last = Math.min(end, to) - 1;
      const at = Math.min(Math.max(near, first), last);
      // A ramp's table can turn back; its entries in the window bound what it reads.
      const positions = [first, last, at].map((n) =>
        sourcePosition(segment, n),
      );
      if (segment.map.kind === "table")
        for (let n = first; n < last; n += RAMP_STEP)
          positions.push(sourcePosition(segment, n));
      return {
        segment,
        distance: Math.abs(at - near),
        low: Math.floor(Math.min(...positions) / CHUNK_SAMPLES),
        high: Math.floor(Math.max(...positions) / CHUNK_SAMPLES),
        middle: sourcePosition(segment, at) / CHUNK_SAMPLES,
      };
    })
    .sort((a, b) => a.distance - b.distance);
  const chunks = new Map<string, Chunk>();
  for (const { segment, low, high, middle } of reads) {
    const indices = Array.from(
      { length: high - Math.max(0, low) + 1 },
      (_, k) => Math.max(0, low) + k,
    ).sort((a, b) => Math.abs(a + 0.5 - middle) - Math.abs(b + 0.5 - middle));
    for (const index of indices) {
      const chunk = { source: segment.source, index };
      chunks.set(chunkId(chunk), chunk);
    }
  }
  return [...chunks.values()];
}

/**
 * The PCM the audio thread holds, least recently wanted out first. Samples go to `send` and are
 * not kept here; `drop` tells the audio thread to let a chunk go. Nothing waits on a fetch: a
 * chunk that has not arrived plays as silence.
 */
export function createChunkCache({
  load,
  send,
  drop,
  capBytes = CACHE_BYTES,
}: {
  load(chunk: Chunk, signal: AbortSignal): Promise<Loaded>;
  send(chunk: Chunk, samples: Int16Array): void;
  drop(chunk: Chunk): void;
  capBytes?: number;
}) {
  const held = new Map<string, { chunk: Chunk; bytes: number }>();
  const loading = new Set<string>();
  const silent = new Set<string>();
  const closing = new AbortController();
  let wanted = new Set<string>();
  let latest: readonly Chunk[] = [];
  let retry: ReturnType<typeof setTimeout> | undefined;
  const bytes = () => [...held.values()].reduce((sum, c) => sum + c.bytes, 0);

  function evict() {
    let total = bytes();
    for (const [id, entry] of held) {
      if (total <= capBytes) return;
      if (wanted.has(id)) continue;
      held.delete(id);
      total -= entry.bytes;
      drop(entry.chunk);
    }
  }

  function fetchChunk(chunk: Chunk, id: string) {
    loading.add(id);
    load(chunk, closing.signal)
      .then((loaded) => {
        if (closing.signal.aborted) return;
        if (loaded.kind === "silent") silent.add(sourceId(chunk.source));
        if (loaded.kind === "pending")
          retry ??= setTimeout(() => {
            retry = undefined;
            cache.want(latest);
          }, 1000);
        if (loaded.kind !== "samples") return;
        held.set(id, { chunk, bytes: loaded.samples.byteLength });
        send(chunk, loaded.samples);
        evict();
      })
      .catch((error: unknown) => {
        if (closing.signal.aborted) return;
        // A source that fails to read stays silent until its version changes.
        silent.add(sourceId(chunk.source));
        console.warn(`Scrub audio could not read ${chunk.source.path}`, error);
      })
      .finally(() => loading.delete(id));
  }

  const cache = {
    /** Keeps these chunks, nearest first, as many as fit, and fetches the missing ones. */
    want(chunks: readonly Chunk[]) {
      latest = chunks;
      const fits = chunks
        .filter(({ source }) => !silent.has(sourceId(source)))
        .slice(0, Math.floor(capBytes / CHUNK_BYTES));
      wanted = new Set(fits.map(chunkId));
      for (const chunk of fits) {
        const id = chunkId(chunk);
        const entry = held.get(id);
        if (entry) {
          held.delete(id);
          held.set(id, entry);
        } else if (!loading.has(id)) fetchChunk(chunk, id);
      }
      evict();
    },
    /** Chunk ids held, least recently wanted first. */
    held: () => [...held.keys()],
    close() {
      closing.abort();
      clearTimeout(retry);
    },
  };
  return cache;
}

/** Reads one chunk of a source's PCM file with a byte range. */
export async function loadChunk(
  projectId: string,
  { source, index }: Chunk,
  signal: AbortSignal,
): Promise<Loaded> {
  const first = index * CHUNK_BYTES;
  const response = await fetch(
    `/api/cutroom/projects/${encodeURIComponent(projectId)}/media/pcm?path=${encodeURIComponent(source.path)}&v=${encodeURIComponent(source.version)}`,
    { headers: { range: `bytes=${first}-${first + CHUNK_BYTES - 1}` }, signal },
  );
  if (response.status === 202) {
    await response.body?.cancel();
    return { kind: "pending" };
  }
  if (response.status === 422) {
    await response.body?.cancel();
    return { kind: "silent" };
  }
  // The chunk starts past the end of the file: held as empty, so it is not asked for again.
  if (response.status === 416) {
    await response.body?.cancel();
    return { kind: "samples", samples: new Int16Array(0) };
  }
  if (!response.ok)
    throw new Error(`${response.status} ${await response.text()}`);
  const body = await response.arrayBuffer();
  // A server that ignores the range sends the whole file.
  const part =
    response.status === 206 ? body : body.slice(first, first + CHUNK_BYTES);
  return {
    kind: "samples",
    samples: new Int16Array(part, 0, part.byteLength >> 1),
  };
}
