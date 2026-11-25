import { CHUNK_SAMPLES } from "./render";
import {
  RAMP_STEP,
  sourceId,
  sourcePosition,
  unwrappedSourcePosition,
} from "./segment";
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

/** A window spanning a wrap needs the end and the beginning of the source. */
function sourceRanges(
  segment: Segment,
  first: number,
  last: number,
): [number, number][] {
  const low = sourcePosition(segment, first);
  const high = sourcePosition(segment, last);
  const { loop } = segment;
  if (loop) {
    const end = loop.start + loop.length;
    const through = unwrappedSourcePosition(segment, last);
    const span = through - unwrappedSourcePosition(segment, first);
    if (through >= end && span >= loop.length)
      return [[Math.min(low, loop.start), Math.ceil(end) - 1]];
    if (through >= end && span >= end - low)
      return [
        [low, Math.ceil(end) - 1],
        [loop.start, high],
      ];
  }
  if (segment.map.kind !== "table" || loop) return [[low, high]];
  // Include the intermediate ramp entries that bound this window's source reads.
  const positions = [low, high];
  const start = segment.samples.start;
  const firstStep = start + Math.ceil((first - start) / RAMP_STEP) * RAMP_STEP;
  for (let n = firstStep; n < last; n += RAMP_STEP)
    positions.push(sourcePosition(segment, n));
  return [[Math.min(...positions), Math.max(...positions)]];
}

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
      return {
        segment,
        distance: Math.abs(at - near),
        ranges: sourceRanges(segment, first, last),
        middle: sourcePosition(segment, at) / CHUNK_SAMPLES,
      };
    })
    .sort((a, b) => a.distance - b.distance);
  const chunks = new Map<string, Chunk>();
  for (const { segment, ranges, middle } of reads) {
    const indices = new Set<number>();
    for (const [low, high] of ranges) {
      for (
        let index = Math.max(0, Math.floor(low / CHUNK_SAMPLES));
        index <= Math.floor(high / CHUNK_SAMPLES);
        index++
      )
        indices.add(index);
    }
    for (const index of [...indices].sort(
      (a, b) => Math.abs(a + 0.5 - middle) - Math.abs(b + 0.5 - middle),
    )) {
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
 *
 * A source is read one chunk at a time until a chunk arrives: while its file is being made it is
 * asked again every `retryMs`, and after a failed read again after a doubling wait, up to 30
 * times that. A source with no sound is not asked again.
 */
export function createChunkCache({
  load,
  send,
  drop,
  capBytes = CACHE_BYTES,
  retryMs = 1000,
}: {
  load(chunk: Chunk, signal: AbortSignal): Promise<Loaded>;
  send(chunk: Chunk, samples: Int16Array): void;
  drop(chunk: Chunk): void;
  capBytes?: number;
  retryMs?: number;
}) {
  const held = new Map<string, { chunk: Chunk; bytes: number }>();
  const loading = new Map<string, AbortController>();
  const silent = new Set<string>();
  /** Sources a chunk has arrived from since their last failure. */
  const ready = new Set<string>();
  const probing = new Set<string>();
  const waiting = new Map<string, { until: number; delay: number }>();
  let wanted = new Set<string>();
  let latest: readonly Chunk[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
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

  function wait(source: string, delay: number) {
    ready.delete(source);
    waiting.set(source, { until: performance.now() + delay, delay });
    schedule();
  }

  function schedule() {
    if (timer !== undefined || closed || !waiting.size) return;
    const next = Math.min(...[...waiting.values()].map(({ until }) => until));
    timer = setTimeout(
      () => {
        timer = undefined;
        cache.want(latest);
      },
      Math.max(0, next - performance.now()),
    );
  }

  function fetchChunk(chunk: Chunk, id: string, source: string) {
    const controller = new AbortController();
    loading.set(id, controller);
    load(chunk, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        if (loaded.kind === "silent") {
          silent.add(source);
          waiting.delete(source);
          return;
        }
        if (loaded.kind === "pending") return wait(source, retryMs);
        held.set(id, { chunk, bytes: loaded.samples.byteLength });
        send(chunk, loaded.samples);
        evict();
        waiting.delete(source);
        if (ready.has(source)) return;
        ready.add(source);
        probing.delete(source);
        cache.want(latest);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const delay = Math.min(
          30 * retryMs,
          (waiting.get(source)?.delay ?? retryMs / 2) * 2,
        );
        console.warn(
          `Scrub audio could not read ${chunk.source.path}; trying again in ${delay} ms`,
          error,
        );
        wait(source, delay);
      })
      .finally(() => {
        if (loading.get(id) === controller) loading.delete(id);
        if (!ready.has(source)) probing.delete(source);
      });
  }

  const cache = {
    /** Keeps these chunks, nearest first, as many as fit, and fetches the missing ones. */
    want(chunks: readonly Chunk[]) {
      latest = chunks;
      const fits = chunks
        .filter(({ source }) => !silent.has(sourceId(source)))
        .slice(0, Math.floor(capBytes / CHUNK_BYTES));
      wanted = new Set(fits.map(chunkId));
      for (const [id, controller] of loading)
        if (!wanted.has(id)) {
          controller.abort();
          loading.delete(id);
        }
      const now = performance.now();
      for (const chunk of fits) {
        const id = chunkId(chunk);
        const entry = held.get(id);
        if (entry) {
          held.delete(id);
          held.set(id, entry);
          continue;
        }
        if (loading.has(id)) continue;
        const source = sourceId(chunk.source);
        if (!ready.has(source)) {
          if (probing.has(source) || (waiting.get(source)?.until ?? 0) > now)
            continue;
          probing.add(source);
        }
        fetchChunk(chunk, id, source);
      }
      evict();
      schedule();
    },
    /** Chunk ids held, least recently wanted first. */
    held: () => [...held.keys()],
    close() {
      closed = true;
      for (const controller of loading.values()) controller.abort();
      clearTimeout(timer);
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
  // The chunk starts past the end of the file: held as empty, so it is not asked for again.
  if (response.status === 416) {
    await response.body?.cancel();
    return { kind: "samples", samples: new Int16Array(0) };
  }
  // 422: the file has no sound. Any other refusal will not change by asking again.
  if (response.status >= 400 && response.status < 500) {
    await response.body?.cancel();
    return { kind: "silent" };
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
