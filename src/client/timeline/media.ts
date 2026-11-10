import { z } from "zod";
import { mediaSettings, peakLevels } from "../../shared/media";

/** Waveform buckets fetched per request: 16 seconds at the finest level, 18 hours at the coarsest. */
export const PEAK_CHUNK = 8192;
/** Decoded pictures kept: sprite sheets, single frames and stills. */
const MAX_PICTURES = 512;
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

/** The project file a clip's `src` names, as the server resolves it; null for remote media. */
export function mediaPath(composition: string, src: string): string | null {
  try {
    const base = new URL(composition, "file:///");
    const url = new URL(src, base);
    return url.protocol === "file:" && !url.host
      ? decodeURIComponent(url.pathname.slice(1))
      : null;
  } catch {
    return null;
  }
}

export type TimelineMedia = ReturnType<typeof createTimelineMedia>;

/**
 * Filmstrips, frames and waveforms for one composition's clips, from the server's media cache.
 * Every read answers at once from memory: undefined means not there yet, or never. A first read
 * starts the fetch, and `onLoad` runs when something new can be drawn.
 */
export function createTimelineMedia(
  projectId: string,
  composition: string,
  onLoad: () => void,
) {
  const project = `/api/cutroom/projects/${encodeURIComponent(projectId)}/media`;
  const closing = new AbortController();
  // Every clip asks on every paint, so a source's path is resolved and encoded once.
  const paths = new Map<string, string | null>();
  const pathOf = (src: string) => {
    let path = paths.get(src);
    if (path === undefined) {
      const resolved = mediaPath(composition, src);
      path = resolved === null ? null : encodeURIComponent(resolved);
      paths.set(src, path);
    }
    return path;
  };
  const route = (kind: string, src: string, query = "") => {
    const path = pathOf(src);
    return path === null ? null : `${project}/${kind}?path=${path}${query}`;
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

  /**
   * One value per key, loaded on first read. A key that failed or has nothing stays null and is
   * not asked for again. Past `max` values the least recently read is dropped.
   */
  function cache<T>(
    load: (key: string) => Promise<T | null>,
    max = Infinity,
    drop: (value: T) => void = () => {},
  ) {
    const values = new Map<string, T | null>();
    const loading = new Set<string>();
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
          if (closing.signal.aborted) {
            if (value !== null) drop(value);
            return;
          }
          values.set(key, value);
          if (values.size > max) {
            const [oldest, dropped] = values.entries().next().value!;
            values.delete(oldest);
            if (dropped !== null) drop(dropped);
          }
          if (value !== null) onLoad();
        });
    };
    return {
      start,
      known: (key: string) => values.has(key) || loading.has(key),
      failed: (key: string) => values.get(key) === null,
      /** The value if it is in memory; never starts a load. */
      peek(key: string): T | undefined {
        const value = values.get(key);
        if (value === undefined || value === null) return undefined;
        if (max !== Infinity) {
          values.delete(key);
          values.set(key, value);
        }
        return value;
      },
      get(key: string): T | undefined {
        if (!values.has(key) && !loading.has(key)) void start(key);
        return this.peek(key);
      },
      clear() {
        for (const value of values.values()) if (value !== null) drop(value);
        values.clear();
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
  const close = (picture: ImageBitmap) => picture.close();
  const pictures = cache(
    (url) => loadPicture(url, POLL_MS),
    MAX_PICTURES,
    close,
  );
  const stills = cache(
    (url) =>
      loadPicture(url, POLL_MS, {
        resizeHeight: mediaSettings.tileHeight,
        resizeQuality: "high",
      }),
    MAX_PICTURES,
    close,
  );
  const frames = cache(
    (url) => loadPicture(url, FRAME_POLL_MS),
    MAX_PICTURES,
    close,
  );
  const peaks = cache(async (url) => {
    const response = await fetchReady(url, POLL_MS);
    if (!response) return null;
    const bytes = await response.arrayBuffer();
    return new Int16Array(
      bytes,
      PEAK_HEADER,
      (bytes.byteLength - PEAK_HEADER) >> 1,
    );
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
        `/api/projects/${encodeURIComponent(projectId)}/preview/${path.replaceAll("%2F", "/")}`,
      );
    },
    /** The frame at a time, if it has arrived. `wantFrames` asks for it. */
    frame(src: string, time: number) {
      const url = frameUrl(src, time);
      return url === null ? undefined : frames.peek(url);
    },
    /**
     * Replaces the frames being waited for with these, most wanted first. Frames no longer in
     * the list are not started, so a fast scroll does not queue every frame it passed.
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
      for (const held of [pictures, stills, frames]) held.clear();
    },
  };
}
