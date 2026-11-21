import { acquireGrades } from "../pipeline/grades";
import type { GradeKey } from "../pipeline/grades";
import type { FilmGradeJob, FilmGradeResult } from "./filmGradeWorker";

const CACHE_BYTES = 32 * 2 ** 20;
const BATCH = 8;
type Rect = [number, number, number, number];
type Pending = {
  key: string;
  source: ImageBitmap;
  rect: Rect;
  grade: GradeKey;
};

/** Bake visible tiles first and prewarm as much of the canvas as fits in the cache. */
export function filmGrades(projectId: string, redraw: () => void) {
  const cubes = acquireGrades(projectId);
  const stamps = new WeakMap<ImageBitmap, number>();
  const recent = new Map<string, ImageBitmap>();
  const lastByTile = new Map<string, string>();
  const failed = new Map<number, Set<string>>();
  const active = new Set<string>();
  const visible = new Map<string, Pending>();
  const buffered = new Map<string, Pending>();
  const retained = new Map<string, boolean>();
  let stamp = 0;
  let bytes = 0;
  let worker: Worker | undefined;
  let busy = false;
  let closed = false;
  let settled = false;
  let visibleChanged = false;
  let bufferChanged = false;

  function fail(job: Pending, reason: unknown) {
    let tiles = failed.get(job.grade.key);
    if (!tiles) {
      console.warn("A timeline filmstrip grade could not be drawn.", reason);
      if (failed.size >= 256) failed.delete(failed.keys().next().value!);
      tiles = new Set();
      failed.set(job.grade.key, tiles);
    }
    tiles.add(job.key);
  }

  function finish(batch: readonly Pending[], results: FilmGradeResult[]) {
    if (closed) {
      for (const result of results) if ("image" in result) result.image.close();
      return;
    }
    busy = false;
    active.clear();
    for (const result of results) {
      if ("error" in result) {
        const job = batch.find(({ key }) => key === result.key);
        if (job) fail(job, result.error);
        continue;
      }
      const { key, image } = result;
      const onscreen = retained.get(key);
      if (onscreen === undefined) {
        image.close();
        continue;
      }
      recent.set(key, image);
      bytes += image.width * image.height * 4;
      if (onscreen) visibleChanged = true;
      else bufferChanged = true;
    }
    for (const [key, image] of recent) {
      if (bytes <= CACHE_BYTES) break;
      if (retained.has(key)) continue;
      recent.delete(key);
      bytes -= image.width * image.height * 4;
      image.close();
    }
    pump();
  }

  function pump() {
    if (busy || closed || !settled) return;
    // Paint the viewport together, then update the canvas once prewarming completes.
    if (!visible.size && visibleChanged) {
      visibleChanged = false;
      redraw();
    }
    if (!visible.size && !buffered.size) {
      if (bufferChanged) {
        bufferChanged = false;
        redraw();
      }
      return;
    }
    const queue = visible.size ? visible : buffered;
    const batch: Pending[] = [];
    for (const [key, item] of queue) {
      batch.push(item);
      queue.delete(key);
      active.add(key);
      if (batch.length === BATCH) break;
    }
    busy = true;
    worker ??= new Worker(new URL("./filmGradeWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }: MessageEvent<FilmGradeResult[]>) =>
      finish(batch, data);
    worker.onerror = (event) => {
      console.warn("The timeline filmstrip worker stopped.", event.message);
      worker?.terminate();
      worker = undefined;
      closed = true;
    };
    void Promise.allSettled(
      batch.map(
        async ({ key, source, rect, grade }) =>
          ({
            key,
            cube: await cubes.get(grade, true),
            image: await createImageBitmap(source, ...rect),
          }) satisfies FilmGradeJob,
      ),
    ).then((results) => {
      const jobs = results.flatMap((result, index) => {
        if (result.status === "fulfilled") return [result.value];
        if (!closed) fail(batch[index]!, result.reason);
        return [];
      });
      if (closed) {
        for (const { image } of jobs) image.close();
      } else if (jobs.length)
        worker!.postMessage(jobs, { transfer: jobs.map(({ image }) => image) });
      else finish(batch, []);
    });
  }

  function useImage(key: string) {
    const image = recent.get(key);
    if (!image) return;
    recent.delete(key);
    recent.set(key, image);
    return image;
  }

  return {
    identify: cubes.identify,
    beginPaint(atRest: boolean) {
      settled = atRest;
      visible.clear();
      buffered.clear();
    },
    pause() {
      settled = false;
    },
    tile(
      clip: string,
      source: ImageBitmap,
      rect: Rect,
      grade: GradeKey,
      onscreen: boolean,
    ) {
      let id = stamps.get(source);
      if (id === undefined) {
        id = stamp++;
        stamps.set(source, id);
      }
      const tile = `${id}:${rect.join(":")}`;
      const key = `${tile}:${grade.key}`;
      if (settled && !closed && !failed.get(grade.key)?.has(key)) {
        if (!visible.has(key) && (onscreen || !buffered.has(key))) {
          if (onscreen) buffered.delete(key);
          const queue = onscreen ? visible : buffered;
          queue.set(key, { key, grade, source, rect });
        }
      }
      const lastKey = `${clip}:${tile}`;
      const image = useImage(key);
      if (image) {
        lastByTile.delete(lastKey);
        if (lastByTile.size >= 4096)
          lastByTile.delete(lastByTile.keys().next().value!);
        lastByTile.set(lastKey, key);
        return image;
      }
      const previous = lastByTile.get(lastKey);
      return previous === undefined ? undefined : useImage(previous);
    },
    endPaint() {
      if (!settled || closed) return;
      // Admit the same tiles whether they are cached or missing. Prefetch must never
      // evict a tile that this paint would immediately queue again.
      retained.clear();
      let available = CACHE_BYTES;
      for (const queue of [visible, buffered]) {
        for (const [key, { rect }] of queue) {
          const size = rect[2] * rect[3] * 4;
          if (size > available) {
            queue.delete(key);
            continue;
          }
          available -= size;
          retained.set(key, queue === visible);
          if (recent.has(key) || active.has(key)) queue.delete(key);
        }
      }
      pump();
    },
    dispose() {
      closed = true;
      worker?.terminate();
      cubes.dispose();
      visible.clear();
      buffered.clear();
      retained.clear();
      for (const image of recent.values()) image.close();
      recent.clear();
      lastByTile.clear();
      failed.clear();
    },
  };
}
