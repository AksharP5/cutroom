import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../../shared/errors";
import { createJobMachine } from "../../shared/jobs";
import type { JobState } from "../../shared/jobs";
import type { Project } from "../../shared/project";
import { projectPath } from "../projects/store";
import { FilmstripSchema, MediaInfoSchema } from "./protocol";
import type { MediaKind } from "./protocol";
import { startMediaWorker } from "./process";
import type { z } from "zod";

async function fingerprint(source: string) {
  const info = await stat(source, { bigint: true });
  if (!info.isFile()) throw new HttpError(400, "Choose a media file.");
  return `${source}\0${info.size}\0${info.mtimeNs}\0${info.ctimeNs}\0${info.ino}\0${info.dev}`;
}
type MediaResult = {
  key: string;
  artifact?: string;
  metadata?: z.infer<typeof FilmstripSchema>;
  state: Readonly<JobState>;
};
type MediaJob = {
  kind: MediaKind;
  machine: ReturnType<typeof createJobMachine>;
  run: () => Promise<void>;
  cancel?: () => void;
  retryAt?: number;
};
const artifacts = {
  probe: "probe.json",
  peaks: "peaks.bin",
  filmstrip: "filmstrip.json",
  frame: "frame.jpg",
};
const priority = { frame: 0, probe: 1, peaks: 1, filmstrip: 2 };

export function createMediaService(
  options: {
    workerUrl?: URL;
    stopTimeoutMs?: number;
    failureTtlMs?: number;
    removeDirectory?: (directory: string) => Promise<void>;
  } = {},
) {
  const jobs = new Map<string, MediaJob>();
  const queue: MediaJob[] = [];
  const running = new Map<MediaJob, Promise<void>>();
  const cleanupErrors: Error[] = [];
  let closing = false;
  const removeDirectory =
    options.removeDirectory ??
    ((directory: string) => rm(directory, { recursive: true, force: true }));
  const pump = () => {
    queue.sort((a, b) => priority[a.kind] - priority[b.kind]);
    while (!closing && running.size < 2 && queue.length) {
      // An overview may never occupy the slot needed by peaks or visible frame requests.
      const overviewRunning = [...running.keys()].some(
        (job) => job.kind === "filmstrip",
      );
      const index = queue.findIndex(
        (job) => job.kind !== "filmstrip" || !overviewRunning,
      );
      if (index === -1) break;
      const job = queue.splice(index, 1)[0]!;
      job.machine.transition({ status: "running", progress: 0 });
      const task = job.run().finally(() => {
        running.delete(job);
        pump();
      });
      running.set(job, task);
    }
  };
  const request = async (
    project: Project,
    path: string,
    kind: MediaKind,
    time = 0,
  ): Promise<MediaResult> => {
    if (closing)
      throw new HttpError(503, "The media service is shutting down.");
    const source = await projectPath(project, path);
    const identity = await fingerprint(source);
    let info: z.infer<typeof MediaInfoSchema> | undefined;
    let frame: number | undefined;
    if (kind !== "probe") {
      const probe = await request(project, path, "probe");
      if (!probe.artifact) return probe;
      info = MediaInfoSchema.parse(await Bun.file(probe.artifact).json());
      if (kind === "frame") {
        if (!info.video)
          throw new HttpError(422, "The media has no video stream.");
        frame = Math.floor(time * info.video.fps + 1e-7);
        time = frame / info.video.fps;
        if (time >= info.video.duration && info.video.duration > 0)
          throw new HttpError(400, "The frame time is outside the video.");
      }
    }
    const key = createHash("sha256")
      .update(`media-v3\0${kind}\0${identity}\0${frame ?? ""}`)
      .digest("hex");
    await mkdir(await projectPath(project, ".cutroom", true), {
      recursive: true,
    });
    const cache = await projectPath(project, ".cutroom/cache", true);
    await mkdir(cache, { recursive: true });
    const directory = join(cache, key);
    const cached = await projectPath(
      project,
      `.cutroom/cache/${key}/${artifacts[kind]}`,
    ).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    });
    if (cached)
      return {
        key,
        artifact: cached,
        metadata:
          kind === "filmstrip"
            ? FilmstripSchema.parse(await Bun.file(cached).json())
            : undefined,
        state: { status: "done", progress: 1 },
      };
    if (closing)
      throw new HttpError(503, "The media service is shutting down.");
    for (const [key, job] of jobs)
      if (job.retryAt !== undefined && job.retryAt <= Date.now())
        jobs.delete(key);
    const existing = jobs.get(directory);
    if (existing) return { key, state: existing.machine.state };
    const ffmpeg = Bun.which("ffmpeg");
    const ffprobe = Bun.which("ffprobe");
    if (!ffmpeg || !ffprobe)
      throw new HttpError(
        503,
        "FFmpeg and ffprobe are required for timeline media previews.",
      );
    const machine = createJobMachine();
    const job: MediaJob = {
      kind,
      machine,
      run: async () => {
        let scratch: string | undefined;
        let failure: string | undefined;
        let cleanupFailure: string | undefined;
        try {
          scratch = await mkdtemp(join(cache, ".media-"));
          if (machine.state.status === "cancelling") return;
          const worker = startMediaWorker(
            { kind, source, directory: scratch, ffmpeg, ffprobe, info, time },
            options.workerUrl ?? new URL("./worker.ts", import.meta.url),
            options.stopTimeoutMs ?? 1000,
          );
          job.cancel = worker.cancel;
          try {
            await worker.done;
          } finally {
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
            if (scratch) await removeDirectory(scratch);
          } catch (error) {
            cleanupFailure = `Media cleanup failed for ${scratch}: ${error instanceof Error ? error.message : String(error)}`;
            cleanupErrors.push(new Error(cleanupFailure));
          }
          if (cleanupFailure)
            machine.transition({
              status: "failed",
              progress: machine.state.progress,
              error: cleanupFailure,
            });
          else if (machine.state.status === "cancelling")
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
          if (machine.state.status === "failed")
            job.retryAt = Date.now() + (options.failureTtlMs ?? 1000);
          else jobs.delete(directory);
        }
      },
    };
    jobs.set(directory, job);
    queue.push(job);
    pump();
    return { key, state: machine.state };
  };
  return {
    request,
    sprite(project: Project, key: string, sheet = 0) {
      return projectPath(project, `.cutroom/cache/${key}/sprite-${sheet}.jpg`);
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
      await Promise.all([...running.values()]);
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors,
          "Media cancellation cleanup failed.",
        );
    },
  };
}
