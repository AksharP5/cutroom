import { writeGrade } from "../../shared/timeline/grade";
import type { Grade } from "../../shared/timeline/grade";
import type { GradeReply, GradeRequest } from "./gradeWorker";

export const GRADE_SIZE = 33;
/** 16 RGBA8 cubes total under 2.2 MiB, on either the CPU or the GPU. */
export const GRADE_CACHE_SIZE = 16;

export interface GradeTexture {
  key: string;
  data: Uint8Array<ArrayBuffer>;
}

export function previewGrades(projectId: string) {
  let worker: Worker | undefined;
  const pending = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<Uint8Array<ArrayBuffer>>>
  >();
  const recent = new Map<string, Uint8Array<ArrayBuffer>>();
  const clear = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    recent.clear();
    worker?.terminate();
    worker = undefined;
  };
  return {
    async get(grade: Grade): Promise<GradeTexture | null> {
      // Canonical grade text is the cache key. It is already available without rehashing it
      // separately, and comparisons cannot alias two grades through a hash collision.
      const key = writeGrade(grade);
      if (!key) return null;
      const cached = recent.get(key);
      if (cached) {
        recent.delete(key);
        recent.set(key, cached);
        return { key, data: cached };
      }
      const existing = pending.get(key);
      if (existing) return { key, data: await existing.promise };
      if (!worker) {
        worker = new Worker(new URL("./gradeWorker.ts", import.meta.url), {
          type: "module",
        });
        worker.onerror = (event) =>
          clear(new Error(event.message || "The grade worker failed."));
        worker.onmessage = ({ data: reply }: MessageEvent<GradeReply>) => {
          const request = pending.get(reply.key);
          if (!request) return;
          pending.delete(reply.key);
          if ("error" in reply) {
            request.reject(new Error(reply.error));
            return;
          }
          if (recent.size >= GRADE_CACHE_SIZE)
            recent.delete(recent.keys().next().value!);
          recent.set(reply.key, reply.data);
          request.resolve(reply.data);
        };
      }
      const request = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
      pending.set(key, request);
      const lutUrl = grade.lut
        ? `/api/cutroom/projects/${encodeURIComponent(projectId)}/luts/source?path=${encodeURIComponent(grade.lut.src)}`
        : undefined;
      worker.postMessage({
        key,
        grade,
        size: GRADE_SIZE,
        lutUrl,
      } satisfies GradeRequest);
      return { key, data: await request.promise };
    },
    dispose: () => clear(new Error("The viewer closed.")),
  };
}
