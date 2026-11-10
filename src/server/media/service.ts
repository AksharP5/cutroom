import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../../shared/errors";
import { createJobMachine } from "../../shared/jobs";
import type { Project } from "../../shared/project";
import { projectPath } from "../projects/store";
import { FilmstripSchema, MediaEventSchema } from "./protocol";
import type { MediaKind } from "./protocol";

async function fingerprint(source: string) {
  const info = await stat(source, { bigint: true });
  if (!info.isFile()) throw new HttpError(400, "Choose a media file.");
  return `${source}\0${info.size}\0${info.mtimeNs}\0${info.ctimeNs}`;
}

type MediaJob = {
  machine: ReturnType<typeof createJobMachine>;
  run: () => Promise<void>;
  cancel?: () => void;
};

export function createMediaService(options: { workerUrl?: URL } = {}) {
  const jobs = new Map<string, MediaJob>();
  const queue: MediaJob[] = [];
  const running = new Set<Promise<void>>();
  let closing = false;
  const pump = () => {
    while (!closing && running.size < 2 && queue.length) {
      const job = queue.shift()!;
      job.machine.transition({ status: "running", progress: 0 });
      const task = job.run().finally(() => {
        running.delete(task);
        pump();
      });
      running.add(task);
    }
  };

  return {
    async request(project: Project, path: string, kind: MediaKind) {
      if (closing)
        throw new HttpError(503, "The media service is shutting down.");
      const source = await projectPath(project, path);
      const identity = await fingerprint(source);
      const key = createHash("sha256")
        .update(`media-v2\0${kind}\0${identity}`)
        .digest("hex");
      await mkdir(await projectPath(project, ".cutroom", true), {
        recursive: true,
      });
      const cache = await projectPath(project, ".cutroom/cache", true);
      await mkdir(cache, { recursive: true });
      const directory = join(cache, key);
      const artifact = `.cutroom/cache/${key}/${kind === "peaks" ? "peaks.bin" : "filmstrip.json"}`;
      const cached = await projectPath(project, artifact).catch(
        (error: unknown) => {
          if (error instanceof HttpError && error.status === 404) return null;
          throw error;
        },
      );
      if (cached) {
        const metadata =
          kind === "filmstrip"
            ? FilmstripSchema.parse(await Bun.file(cached).json())
            : undefined;
        return {
          key,
          artifact: cached,
          metadata,
          state: { status: "done", progress: 1 } as const,
        };
      }
      if (closing)
        throw new HttpError(503, "The media service is shutting down.");
      const existing = jobs.get(directory);
      if (existing) return { key, state: existing.machine.state };
      const ffmpeg = Bun.which("ffmpeg");
      if (!ffmpeg)
        throw new HttpError(
          503,
          "FFmpeg is required for timeline media previews.",
        );
      const machine = createJobMachine();
      const job: MediaJob = {
        machine,
        run: async () => {
          let scratch: string | undefined;
          let failure: string | undefined;
          try {
            scratch = await mkdtemp(join(cache, ".media-"));
            if (machine.state.status === "cancelling") return;
            const worker = new Worker(
              options.workerUrl ?? new URL("./worker.ts", import.meta.url),
            );
            try {
              await new Promise<void>((resolve, reject) => {
                job.cancel = () => worker.postMessage({ type: "cancel" });
                worker.onmessage = (event: MessageEvent<unknown>) => {
                  const parsed = MediaEventSchema.safeParse(event.data);
                  if (!parsed.success) return reject(parsed.error);
                  if (parsed.data.type === "error")
                    reject(new Error(parsed.data.error));
                  else resolve();
                };
                worker.onerror = (event) => reject(new Error(event.message));
                worker.postMessage({
                  type: "generate",
                  kind,
                  source,
                  directory: scratch,
                  ffmpeg,
                });
              });
            } finally {
              worker.terminate();
              job.cancel = undefined;
            }
            if (machine.state.status !== "running") return;
            if ((await fingerprint(source)) !== identity)
              throw new Error(
                "The source media changed during preview generation. Request it again.",
              );
            if (machine.state.status !== "running") return;
            await rename(scratch, directory);
            scratch = undefined;
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
          } finally {
            try {
              if (scratch) await rm(scratch, { recursive: true, force: true });
            } catch (error) {
              failure = `Media cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
            }
            if (machine.state.status === "cancelling")
              machine.transition({
                status: "cancelled",
                progress: machine.state.progress,
              });
            else if (failure)
              machine.transition({
                status: "failed",
                progress: machine.state.progress,
                error: failure,
              });
            else machine.transition({ status: "done", progress: 1 });
            if (machine.state.status !== "failed") jobs.delete(directory);
            // Failed inputs must not spawn FFmpeg on every poll, but cannot grow memory without bound.
            if (jobs.size > 256)
              for (const [key, entry] of jobs) {
                if (entry.machine.state.status === "failed") jobs.delete(key);
                if (jobs.size <= 256) break;
              }
          }
        },
      };
      jobs.set(directory, job);
      queue.push(job);
      pump();
      return { key, state: machine.state };
    },
    async sprite(project: Project, key: string) {
      return projectPath(project, `.cutroom/cache/${key}/sprite.jpg`);
    },
    async dispose() {
      closing = true;
      for (const job of jobs.values()) {
        if (
          job.machine.state.status !== "queued" &&
          job.machine.state.status !== "running"
        )
          continue;
        job.machine.transition({
          status: "cancelling",
          progress: job.machine.state.progress,
        });
        job.cancel?.();
      }
      for (const job of queue.splice(0))
        job.machine.transition({
          status: "cancelled",
          progress: job.machine.state.progress,
        });
      await Promise.all([...running]);
    },
  };
}
