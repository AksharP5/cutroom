import { z } from "zod";
import { localMediaPath, mediaSettings, peakLevels } from "../../shared/media";
import { waveformPeak } from "./math";

/** Waveform buckets fetched per request: 16 seconds at the finest level, 18 hours at the coarsest. */
export const PEAK_CHUNK = 8192;
/**
 * Decoded pixels kept, in bytes. A sprite sheet is up to 5.8 MB, so 192 MB is about 33 sheets,
 * over an hour of footage in view at once; a single frame is 58 KB, so 32 MB is about 550.
 */
const SHEET_BYTES = 192 * 2 ** 20;
const FRAME_BYTES = 32 * 2 ** 20;
const STILL_BYTES = 16 * 2 ** 20;
/** Single frames asked for at once; the rest wait, newest first. */
const FRAME_REQUESTS = 4;
/** A frame is one FFmpeg seek, so it is asked for again sooner than the server's one second. */
const FRAME_POLL_MS = 200;
const POLL_MS = 1000;
/** Bytes before the bucket pairs in a ranged waveform response. */
const PEAK_HEADER = 48;

const FilmSchema = z.object({
  tileWidth: z.number().positive(),
  tileHeight: z.number().positive(),
  count: z.number().int().positive(),
  sheets: z.array(
    z.object({
      start: z.number().int().nonnegative(),
      columns: z.number().int().positive(),
      spriteUrl: z.string(),
    }),
  ),
});
export type Film = z.infer<typeof FilmSchema>;

export type TimelineMedia = ReturnType<typeof createTimelineMedia>;

interface Cache<T> {
  start(key: string): Promise<void>;
  known(key: string): boolean;
  failed(key: string): boolean;
  /** The value if it is in memory; never starts a load. */
  peek(key: string): T | undefined;
  get(key: string): T | undefined;
  clear(): void;
}

/**
 * Filmstrips, frames and waveforms for one composition's clips, from the server's media cache.
 * Every read answers at once from memory: undefined means not there yet, or never. A first read
 * starts the fetch, and `onLoad` runs when something new can be drawn.
 */
export function createTimelineMedia(
  projectId: string,
  composition: string,
  onLoad: () => void,
  versions: Readonly<Record<string, string | null>> = {},
) {
  const project = `/api/cutroom/projects/${encodeURIComponent(projectId)}/media`;
  const closing = new AbortController();
  // Every clip asks on every paint, so a source's path is resolved and encoded once.
  const paths = new Map<
    string,
    { path: string; encoded: string; version: string } | null
  >();
  const pathOf = (src: string) => {
    let path = paths.get(src);
    if (path === undefined) {
      const resolved = localMediaPath(composition, src);
      // Null is the watcher's word that the file is gone: renamed or removed while a clip
      // still names it. There is nothing to ask the server for.
      path =
        resolved === null || versions[resolved] === null
          ? null
          : {
              path: resolved,
              encoded: encodeURIComponent(resolved),
              version: encodeURIComponent(versions[resolved] ?? ""),
            };
      paths.set(src, path);
    }
    return path;
  };
  const route = (kind: string, src: string, query = "") => {
    const path = pathOf(src);
    return path === null
      ? null
      : `${project}/${kind}?path=${path.encoded}&v=${path.version}${query}`;
  };

  /** Asks again while the server is still generating. Null when it has nothing to give. */
  async function fetchReady(url: string, pollMs: number) {
    for (;;) {
      const response = await fetch(url, { signal: closing.signal });
      if (response.status !== 202) return response.ok ? response : null;
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      closing.signal.throwIfAborted();
    }
  }

  /** Keys read since the last paint began, which are never dropped to make room. */
  const drawn = new Set<string>();

  /**
   * One value per key, loaded on first read. A key that failed or has nothing stays null and is
   * not asked for again. With `bytes`, pictures past that many decoded bytes are closed, least
   * recently drawn first, except those the latest paint drew: a view that needs more than the
   * limit keeps what it shows.
   */
  function cache<T>(load: (key: string) => Promise<T | null>): Cache<T>;
  function cache(
    load: (key: string) => Promise<ImageBitmap | null>,
    bytes: number,
  ): Cache<ImageBitmap>;
  function cache<T>(
    load: (key: string) => Promise<T | null>,
    bytes = Infinity,
  ): Cache<T> {
    const values = new Map<string, T | null>();
    const loading = new Set<string>();
    const weigh = (value: T | null) =>
      value instanceof ImageBitmap ? value.width * value.height * 4 : 0;
    const drop = (value: T | null) => {
      if (value instanceof ImageBitmap) value.close();
    };
    let held = 0;
    const start = (key: string) => {
      loading.add(key);
      return load(key)
        .catch((error: unknown) => {
          if (!closing.signal.aborted)
            console.warn(`Timeline media failed to load: ${key}`, error);
          return null;
        })
        .then((value) => {
          loading.delete(key);
          if (closing.signal.aborted) return drop(value);
          values.set(key, value);
          held += weigh(value);
          for (const [old, picture] of values) {
            if (held <= bytes) break;
            if (old === key || drawn.has(old)) continue;
            values.delete(old);
            held -= weigh(picture);
            drop(picture);
          }
          if (value !== null) onLoad();
        });
    };
    return {
      start,
      known: (key: string) => values.has(key) || loading.has(key),
      failed: (key: string) => values.get(key) === null,
      peek(key: string): T | undefined {
        const value = values.get(key);
        if (value === undefined || value === null) return undefined;
        if (bytes !== Infinity) {
          values.delete(key);
          values.set(key, value);
          drawn.add(key);
        }
        return value;
      },
      get(key: string): T | undefined {
        if (!values.has(key) && !loading.has(key)) void start(key);
        return this.peek(key);
      },
      clear() {
        for (const value of values.values()) drop(value);
        values.clear();
        held = 0;
      },
    };
  }

  const films = cache(async (url) => {
    const response = await fetchReady(url, POLL_MS);
    return response && FilmSchema.parse(await response.json());
  });
  const loadPicture = async (
    url: string,
    pollMs: number,
    options?: ImageBitmapOptions,
  ) => {
    const response = await fetchReady(url, pollMs);
    return response && createImageBitmap(await response.blob(), options);
  };
  const pictures = cache((url) => loadPicture(url, POLL_MS), SHEET_BYTES);
  const stills = cache(
    (url) =>
      loadPicture(url, POLL_MS, {
        resizeHeight: mediaSettings.tileHeight,
        resizeQuality: "high",
      }),
    STILL_BYTES,
  );
  const frames = cache((url) => loadPicture(url, FRAME_POLL_MS), FRAME_BYTES);
  const peaks = cache(async (url) => {
    const response = await fetchReady(url, POLL_MS);
    if (!response) return null;
    const bytes = await response.arrayBuffer();
    const pairs = new Int16Array(
      bytes,
      PEAK_HEADER,
      (bytes.byteLength - PEAK_HEADER) >> 1,
    );
    // Remap once per cached range, never per column or animation frame.
    return Float32Array.from(pairs, (peak) => waveformPeak(peak / 32768));
  });

  const firstPeaks = new Map<string, string>();

  let wanted: string[] = [];
  let fetching = 0;
  function pump() {
    while (fetching < FRAME_REQUESTS) {
      const url = wanted.find((candidate) => !frames.known(candidate));
      if (!url) return;
      fetching++;
      void frames.start(url).then(() => {
        fetching--;
        pump();
      });
    }
  }

  const frameUrl = (src: string, time: number) =>
    route("frame", src, `&time=${time}`);
  const peakUrl = (src: string, level: number, chunk: number) => {
    const seconds = peakLevels[level]! / mediaSettings.peakSampleRate;
    // Half a bucket inside each end, so rounding cannot widen the range by one.
    const start = (chunk * PEAK_CHUNK + 0.5) * seconds;
    const end = ((chunk + 1) * PEAK_CHUNK - 0.5) * seconds;
    return route("peaks", src, `&level=${level}&start=${start}&end=${end}`);
  };

  return {
    /** Only a source already used by this canvas needs its decoded media replaced. */
    updateVersions(next: Readonly<Record<string, string | null>>) {
      const changed = [...paths.entries()].some(([src, path]) => {
        const file = path?.path ?? localMediaPath(composition, src);
        // A file reported gone and a file the listing no longer has are the same state.
        return (
          file !== null && (versions[file] ?? null) !== (next[file] ?? null)
        );
      });
      versions = next;
      return changed;
    },
    /** Call when a paint begins: what it reads from here on is what the view shows. */
    beginPaint: () => drawn.clear(),
    /** A video's sprite sheets: one tile every `filmstripInterval` seconds. */
    film(src: string) {
      const url = route("filmstrip", src);
      return url === null ? undefined : films.get(url);
    },
    sheet: (url: string) => pictures.get(url),
    /** An image file, scaled down to the height of a filmstrip tile. */
    still(src: string) {
      const path = pathOf(src);
      if (path === null) return undefined;
      return stills.get(
        `/api/projects/${encodeURIComponent(projectId)}/preview/${path.encoded.replaceAll("%2F", "/")}?v=${path.version}`,
      );
    },
    /** The frame at a time, if it has arrived. `wantFrames` asks for it. */
    frame(src: string, time: number) {
      const url = frameUrl(src, time);
      return url === null ? undefined : frames.peek(url);
    },
    /**
     * Replaces the frames being waited for with these, most wanted first. Frames no longer in
     * the list are not started, so an empty list stops everything not already on its way.
     */
    wantFrames(list: readonly { src: string; time: number }[]) {
      wanted = list.flatMap(({ src, time }) => frameUrl(src, time) ?? []);
      pump();
    },
    /**
     * Minimum and maximum pairs of one chunk of a waveform level, bucket `chunk * PEAK_CHUNK`
     * onward. With `fetch` false it only answers from memory.
     */
    peaks(src: string, level: number, chunk: number, fetch: boolean) {
      const url = peakUrl(src, level, chunk);
      if (url === null) return undefined;
      // A source whose first request found no audio is not asked for any other range.
      const first = firstPeaks.get(src);
      if (first === undefined) firstPeaks.set(src, url);
      else if (peaks.failed(first)) return undefined;
      return fetch ? peaks.get(url) : peaks.peek(url);
    },
    dispose() {
      closing.abort();
      wanted = [];
      firstPeaks.clear();
      paths.clear();
      for (const held of [films, pictures, stills, frames, peaks]) held.clear();
    },
  };
}
