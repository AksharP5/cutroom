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

/** Bake the visible tiles first, then the rest of the canvas that will scroll into view. */
export function filmGrades(projectId: string, redraw: () => void) {
  const cubes = acquireGrades(projectId);
  const stamps = new WeakMap<ImageBitmap, number>();
  const recent = new Map<string, ImageBitmap>();
  const lastByTile = new Map<string, string>();
  const drawn = new Set<string>();
  const failed = new Map<number, Set<string>>();
  const active = new Set<string>();
  const visible = new Map<string, Pending>();
  const buffered = new Map<string, Pending>();
  const inView = new Set<string>();
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
      recent.set(key, image);
      bytes += image.width * image.height * 4;
      if (inView.has(key)) visibleChanged = true;
      else bufferChanged = true;
    }
    for (const [key, image] of recent) {
      if (bytes <= CACHE_BYTES) break;
      if (drawn.has(key)) continue;
      recent.delete(key);
      bytes -= image.width * image.height * 4;
      image.close();
    }
    pump();
  }

  function pump() {
    if (busy || closed || !settled) return;
    // Paint a completed viewport at once. The rest of the canvas gets one paint after
    // prewarming, so moving the viewport over it doesn't expose raw or half-graded tiles.
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
    drawn.add(key);
    return image;
  }

  return {
    identify: cubes.identify,
    beginPaint(atRest: boolean) {
      settled = atRest;
      visible.clear();
      buffered.clear();
      inView.clear();
      drawn.clear();
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
      if (onscreen) inView.add(key);
      const lastKey = `${clip}:${tile}`;
      const image = useImage(key);
      if (image) {
        lastByTile.delete(lastKey);
        if (lastByTile.size >= 4096)
          lastByTile.delete(lastByTile.keys().next().value!);
        lastByTile.set(lastKey, key);
        return image;
      }
      if (
        settled &&
        !closed &&
        !active.has(key) &&
        !failed.get(grade.key)?.has(key)
      ) {
        if (onscreen) {
          buffered.delete(key);
          visible.set(key, { key, grade, source, rect });
        } else if (!visible.has(key))
          buffered.set(key, { key, grade, source, rect });
      }
      const previous = lastByTile.get(lastKey);
      return previous === undefined ? undefined : useImage(previous);
    },
    endPaint: pump,
    dispose() {
      closed = true;
      worker?.terminate();
      cubes.dispose();
      visible.clear();
      buffered.clear();
      for (const image of recent.values()) image.close();
      recent.clear();
      lastByTile.clear();
      failed.clear();
    },
  };
}
