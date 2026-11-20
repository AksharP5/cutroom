import { writeGrade } from "../../shared/timeline/grade";
import type { Grade } from "../../shared/timeline/grade";
import type { FilmGradeJob, FilmGradeResult } from "./filmGradeWorker";

const CACHE_BYTES = 16 * 2 ** 20;
const BATCH = 6;

/** Recolour only the tiles a resting timeline needs, using the already decoded media. */
export function filmGrades(
  projectId: string,
  composition: string,
  version: (path: string) => string | null,
  redraw: () => void,
) {
  const stamps = new WeakMap<ImageBitmap, number>();
  const attributes = new WeakMap<Grade, string | null>();
  const recent = new Map<string, ImageBitmap>();
  const drawn = new Set<string>();
  const failed = new Set<string>();
  const active = new Set<string>();
  const needed = new Map<
    string,
    Omit<FilmGradeJob, "image"> & {
      source: ImageBitmap;
      rect: [number, number, number, number];
    }
  >();
  let stamp = 0;
  let bytes = 0;
  let worker: Worker | undefined;
  let busy = false;
  let closed = false;

  function finish(results: FilmGradeResult[]) {
    if (closed) {
      for (const result of results) if ("image" in result) result.image.close();
      return;
    }
    busy = false;
    active.clear();
    for (const result of results) {
      if ("error" in result) {
        if (failed.size >= 256) failed.delete(failed.keys().next().value!);
        failed.add(result.key);
        continue;
      }
      const { key, image } = result;
      recent.set(key, image);
      bytes += image.width * image.height * 4;
    }
    for (const [key, image] of recent) {
      if (bytes <= CACHE_BYTES) break;
      if (drawn.has(key)) continue;
      recent.delete(key);
      bytes -= image.width * image.height * 4;
      image.close();
    }
    if (results.some((result) => "image" in result)) redraw();
    else pump();
  }

  function pump() {
    if (busy || closed || !needed.size) return;
    const batch = [...needed.values()].slice(0, BATCH);
    for (const item of batch) {
      needed.delete(item.key);
      active.add(item.key);
    }
    busy = true;
    worker ??= new Worker(new URL("./filmGradeWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }: MessageEvent<FilmGradeResult[]>) =>
      finish(data);
    worker.onerror = () => {
      worker?.terminate();
      closed = true;
    };
    void Promise.allSettled(
      batch.map(async ({ source, rect, ...job }) => ({
        ...job,
        image: await createImageBitmap(source, ...rect),
      })),
    ).then((results) => {
      const jobs = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (closed) {
        for (const { image } of jobs) image.close();
      } else if (jobs.length)
        worker!.postMessage(jobs, { transfer: jobs.map(({ image }) => image) });
      else finish([]);
    });
  }

  return {
    beginPaint() {
      needed.clear();
      drawn.clear();
    },
    tile(
      source: ImageBitmap,
      rect: [number, number, number, number],
      grade: Grade,
      request: boolean,
    ) {
      let attribute = attributes.get(grade);
      if (attribute === undefined) {
        attribute = writeGrade(grade);
        attributes.set(grade, attribute);
      }
      if (!attribute) return;
      let look: string | undefined;
      if (grade.lut) {
        const path =
          composition.slice(0, composition.lastIndexOf("/") + 1) +
          grade.lut.src;
        const current = version(path);
        if (current === null) return;
        look = `/api/cutroom/projects/${encodeURIComponent(projectId)}/luts/source?path=${encodeURIComponent(path)}&v=${encodeURIComponent(current)}`;
      }
      const gradeKey = look ? `${attribute}\n${look}` : attribute;
      let id = stamps.get(source);
      if (id === undefined) {
        id = stamp++;
        stamps.set(source, id);
      }
      const key = `${id}:${rect.join(":")}:${gradeKey}`;
      if (request) drawn.add(key);
      const image = recent.get(key);
      if (image) {
        recent.delete(key);
        recent.set(key, image);
        return image;
      }
      if (request && !closed && !active.has(key) && !failed.has(key))
        needed.set(key, { key, gradeKey, grade, look, source, rect });
    },
    endPaint: pump,
    dispose() {
      closed = true;
      worker?.terminate();
      needed.clear();
      for (const image of recent.values()) image.close();
      recent.clear();
      failed.clear();
    },
  };
}
