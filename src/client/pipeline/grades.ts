import { writeGrade } from "../../shared/timeline/grade";
import type { Grade } from "../../shared/timeline/grade";
import type { GradeReply, GradeRequest } from "./gradeWorker";

const GRADE_SIZE = 33;
const DRAFT_SIZE = 17;
/** The compositor keeps only the grades it has used most recently on the GPU. */
export const GRADE_CACHE_SIZE = 16;
/** Retain the cubes of a 240-shot edit across seeks, zooms and timeline edits. */
const SAVED_CUBES = 256;

type Versions = Readonly<Record<string, string | null>>;

export type GradeKey = GradeRequest & { lutPath: string | null };

export interface GradeTexture {
  key: number;
  size: number;
  data: Uint8Array<ArrayBuffer>;
}

type Job = {
  request: GradeKey;
  result: ReturnType<typeof Promise.withResolvers<GradeTexture>>;
};

function projectGrades(projectId: string) {
  const byObject = new WeakMap<
    Grade,
    {
      composition: string;
      version: string | null;
      size: number;
      request: GradeKey | null;
    }
  >();
  const identities = new Map<string, GradeKey>();
  const saved = new Map<number, GradeTexture>();
  const drafts = new Map<number, GradeTexture>();
  const pending = new Map<number, Job>();
  const foreground = new Map<number, Job>();
  const background = new Map<number, Job>();
  // Background work uses two lanes. A viewer draw can always submit a job directly.
  const lanes: { worker?: Worker; running?: Job }[] = [{}, {}, {}];
  const prefix = `/api/cutroom/projects/${encodeURIComponent(projectId)}/luts/source`;
  let nextId = 0;

  function pick(queue: Map<number, Job>) {
    const job = queue.values().next().value;
    if (job) queue.delete(job.request.key);
    return job;
  }

  function pump() {
    for (const [index, lane] of lanes.entries()) {
      if (lane.running) continue;
      const job =
        pick(foreground) ?? (index > 0 ? pick(background) : undefined);
      if (!job) continue;
      lane.running = job;
      if (!lane.worker) {
        const worker = new Worker(
          new URL("./gradeWorker.ts", import.meta.url),
          {
            type: "module",
          },
        );
        worker.onmessage = ({ data: reply }: MessageEvent<GradeReply>) => {
          const current = lane.running;
          if (!current || current.request.key !== reply.key) return;
          lane.running = undefined;
          pending.delete(reply.key);
          if ("error" in reply) current.result.reject(new Error(reply.error));
          else {
            const { size } = current.request;
            const texture = { key: reply.key, size, data: reply.data };
            const ready = size === DRAFT_SIZE ? drafts : saved;
            const limit = ready === drafts ? GRADE_CACHE_SIZE : SAVED_CUBES;
            if (ready.size >= limit) ready.delete(ready.keys().next().value!);
            ready.set(reply.key, texture);
            current.result.resolve(texture);
          }
          pump();
        };
        worker.onerror = (event) => {
          const current = lane.running;
          lane.running = undefined;
          lane.worker = undefined;
          worker.terminate();
          if (current) {
            pending.delete(current.request.key);
            current.result.reject(
              new Error(event.message || "The grade worker failed."),
            );
          }
          pump();
        };
        lane.worker = worker;
      }
      lane.worker.postMessage(job.request);
    }
  }

  return {
    identify(
      grade: Grade,
      composition: string,
      versions: Versions,
      draft = false,
    ): GradeKey | null {
      const size = draft ? DRAFT_SIZE : GRADE_SIZE;
      // LUT paths are relative to the composition, just as the export's LUT reader resolves them.
      const path = grade.lut
        ? composition.slice(0, composition.lastIndexOf("/") + 1) + grade.lut.src
        : null;
      const version = path === null ? null : (versions[path] ?? null);
      const last = byObject.get(grade);
      if (
        last?.composition === composition &&
        last.version === version &&
        last.size === size
      )
        return last.request;

      const attr = writeGrade(grade);
      let request: GradeKey | null = null;
      if (attr) {
        const look =
          path === null
            ? undefined
            : `${prefix}?path=${encodeURIComponent(path)}${version === null ? "" : `&v=${encodeURIComponent(version)}`}`;
        const canonical = JSON.stringify([size, attr, look]);
        request = identities.get(canonical) ?? {
          key: nextId++,
          grade,
          size,
          lutUrl: look,
          lutPath: path,
        };
        identities.delete(canonical);
        if (identities.size >= SAVED_CUBES * 4)
          identities.delete(identities.keys().next().value!);
        identities.set(canonical, request);
      }
      byObject.set(grade, { composition, version, size, request });
      return request;
    },
    get(request: GradeKey, warm = false): Promise<GradeTexture> {
      const ready = request.size === DRAFT_SIZE ? drafts : saved;
      const cached = ready.get(request.key);
      if (cached) {
        ready.delete(request.key);
        ready.set(request.key, cached);
        return Promise.resolve(cached);
      }
      let job = pending.get(request.key);
      if (!job) {
        job = { request, result: Promise.withResolvers<GradeTexture>() };
        pending.set(request.key, job);
        (warm ? background : foreground).set(request.key, job);
      } else if (!warm && background.delete(request.key))
        foreground.set(request.key, job);
      pump();
      return job.result.promise;
    },
    dispose() {
      for (const lane of lanes) lane.worker?.terminate();
      for (const job of pending.values())
        job.result.reject(new Error("The project grade cache closed."));
      pending.clear();
      foreground.clear();
      background.clear();
    },
  };
}

const projects = new Map<
  string,
  { cache: ReturnType<typeof projectGrades>; users: number }
>();

/** Viewer draws and filmstrip tiles share in-flight work and baked cubes for an open project. */
export function acquireGrades(projectId: string) {
  const shared = projects.get(projectId) ?? {
    cache: projectGrades(projectId),
    users: 0,
  };
  shared.users++;
  projects.set(projectId, shared);
  const { identify, get, dispose } = shared.cache;
  let released = false;
  return {
    identify,
    get,
    dispose() {
      if (released) return;
      released = true;
      if (--shared.users > 0) return;
      projects.delete(projectId);
      dispose();
    },
  };
}
