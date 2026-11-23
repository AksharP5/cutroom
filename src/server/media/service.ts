import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { fileFingerprint } from "../../shared/media";
import { HttpError } from "../../shared/errors";
import { createJobMachine } from "../../shared/jobs";
import type { JobState } from "../../shared/jobs";
import type { Project } from "../../shared/project";
import { projectPath } from "../projects/store";
import { projectStatePath } from "../projects/path";
import { FilmstripSchema, MediaInfoSchema, PiecesSchema } from "./protocol";
import type { MediaKind, MediaTask, Pieces, RampTask } from "./protocol";
import { RUN_MARGIN_SAMPLES } from "../../shared/timeline/rampRuns";
import type { RampRun } from "../../shared/timeline/rampRuns";
import {
  fragmentsStart,
  pieceAt,
  pieceSpans,
  proxySamplesFile,
} from "./pieces";
import { startMediaWorker } from "./process";
import { makesProxy } from "./settings";
import { probeNvenc } from "../hyperframes/nvenc";
import type { z } from "zod";

async function fingerprint(source: string) {
  const info = await stat(source, { bigint: true });
  if (!info.isFile()) throw new HttpError(400, "Choose a media file.");
  return `${fileFingerprint(source, { size: Number(info.size), mtimeMs: Number(info.mtimeNs) / 1e6 })}\0${info.mtimeNs}\0${info.ctimeNs}\0${info.ino}\0${info.dev}`;
}
type MediaResult = {
  key: string;
  artifact?: string;
  metadata?: z.infer<typeof FilmstripSchema>;
  /** An editing proxy's pieces, once they are planned. */
  pieces?: Pieces;
  state: Readonly<JobState>;
  job?: MediaJob;
};
/** An editing proxy made piece by piece, the pieces the preview asks for first. */
type ProxyWork = {
  pieces: Pieces;
  /** Where the pieces and the joined file are made, beside the cache entry. */
  directory: string;
  encoder?: "nvenc" | "x264";
  done: Set<number>;
  /** Requests waiting for a piece, by index; `first` waits for any. */
  waiters: Map<
    number | "first",
    Set<ReturnType<typeof Promise.withResolvers<void>>>
  >;
  /** Requests waiting now, which keep this proxy ahead of the others. */
  waiting: number;
  /** When the preview last asked whether it is ready, by `performance.now()`. */
  polledAt: number;
  /** The piece asked for last, and when, by request order. */
  asked?: number;
  askedAt: number;
  /** Where the encoder goes on when nothing is asked: after its last run. */
  cursor: number;
  run?: { next: number; end: number; stop(): void };
};
type MediaJob = {
  kind: MediaKind;
  sequence: number;
  machine: ReturnType<typeof createJobMachine>;
  run: () => Promise<void>;
  cancel?: () => void;
  retryAt?: number;
  work?: ProxyWork;
  ready?: ReturnType<typeof Promise.withResolvers<boolean>>;
  /** A ramp run an export waits for: it goes ahead of the background passes. */
  foreground?: boolean;
};
const artifacts = {
  probe: "probe.json",
  peaks: "peaks.bin",
  filmstrip: "filmstrip.json",
  frame: "frame.jpg",
  scrub: "scrub.mp4",
  proxy: "proxy.mp4",
  pieces: "pieces.json",
  ramp: "ramp.wav",
  pcm: "audio.pcm",
} satisfies Record<MediaKind, string>;
/** A clip with no editing proxy shows no picture at all, so its proxy comes before strips. */
const priority = {
  frame: 0,
  probe: 1,
  peaks: 1,
  pieces: 1,
  proxy: 2,
  ramp: 2,
  filmstrip: 3,
  pcm: 3,
  scrub: 4,
} satisfies Record<MediaKind, number>;
/** Each kind's recipe; a new one keys new cache entries. */
const recipe = {
  probe: "media-v9",
  peaks: "media-v6",
  filmstrip: "media-v6",
  frame: "media-v6",
  scrub: "media-v7",
  proxy: "media-v8",
  pieces: "media-v12",
  ramp: "ramp-run-v2",
  pcm: "pcm-v1",
} satisfies Record<MediaKind, string>;
/** Whole-file passes share one worker, so peaks and visible frames always have the other. */
/**
 * The preview waits on this proxy: a request waits for one of its pieces, or the preview asked
 * whether it is ready within its polling interval.
 */
const wanted = (job: MediaJob) =>
  !!job.work &&
  (job.work.waiting > 0 || performance.now() - job.work.polledAt < 3000);
const background = (kind: MediaKind) =>
  kind === "filmstrip" || kind === "scrub" || kind === "ramp" || kind === "pcm";

export type MediaService = ReturnType<typeof createMediaService>;
export type RampPins = { hold(file: string): void; release(): void };
const RUNS = "ramp-runs";

export function createMediaService(
  options: {
    workerUrl?: URL;
    stopTimeoutMs?: number;
    failureTtlMs?: number;
    maxCacheEntries?: number;
    removeDirectory?: (directory: string) => Promise<void>;
    /** Whether NVENC works here; asked once, before the first editing proxy. */
    nvenc?: () => Promise<boolean>;
    /** Bytes of ramp audio runs a project keeps. Runs in use stay even past it. */
    rampRunBytes?: number;
  } = {},
) {
  const budget = process.env.CUTROOM_RAMP_CACHE_MB?.trim() || "1024";
  if (options.rampRunBytes === undefined && !(Number(budget) > 0))
    throw new Error(
      `CUTROOM_RAMP_CACHE_MB must be a positive number of MiB, not "${budget}".`,
    );
  const rampRunBytes = options.rampRunBytes ?? Number(budget) * 2 ** 20;
  /** How many holders keep each run file: an open preview document or a running export. */
  const pinned = new Map<string, number>();
  /** Projects whose last trim ended over budget, by run folder, so each says so once per crossing. */
  const overBudget = new Set<string>();
  let nvenc: Promise<boolean> | undefined;
  const jobs = new Map<string, MediaJob>();
  const queue: MediaJob[] = [];
  const running = new Map<MediaJob, Promise<void>>();
  const cleanupErrors: Error[] = [];
  let closing = false;
  let sequence = 0;
  let maintenance = Promise.resolve();
  // Bound disposable artifacts across replacements and server restarts, including exact frames.
  const trimCache = (cache: string, current: string) => {
    const task = maintenance.then(async () => {
      const entries = await readdir(cache, { withFileTypes: true });
      const cached = entries.filter(
        (entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name),
      );
      if (cached.length <= (options.maxCacheEntries ?? 256)) return;
      const directories = await Promise.all(
        cached.map(async (entry) => {
          const path = join(cache, entry.name);
          return { path, modified: (await stat(path)).mtimeMs };
        }),
      );
      directories.sort((a, b) => a.modified - b.modified);
      let remaining = directories.length;
      for (const { path } of directories) {
        if (remaining <= (options.maxCacheEntries ?? 256)) break;
        if (path === current || jobs.has(path)) continue;
        await removeDirectory(path);
        remaining--;
      }
    });
    maintenance = task.catch(() => {});
    return task;
  };
  /** The project's run folder, made if missing; refused if it or a folder above it is a link. */
  const runFolder = async (project: Project) => {
    const path = `.cutroom/cache/${RUNS}`;
    await mkdir(await projectStatePath(project, path, true), {
      recursive: true,
    });
    return projectStatePath(project, path);
  };
  /** Whether a run file holds `frames` settled samples, past which only the flush lies. */
  const covers = async (file: string, frames: number) =>
    ((await lstat(file).catch(() => null))?.size ?? 0) >=
    44 + (frames + RUN_MARGIN_SAMPLES) * 4;
  /** Remove the least recently used ramp runs until the project is under its budget. */
  const trimRuns = (runs: string) => {
    const task = maintenance.then(async () => {
      const files = await Promise.all(
        (await readdir(runs, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".wav"))
          .map(async (entry) => {
            const path = join(runs, entry.name);
            const info = await stat(path).catch(() => null);
            return info && { path, size: info.size, used: info.mtimeMs };
          }),
      );
      const present = files.filter((file) => file !== null);
      let total = present.reduce((sum, file) => sum + file.size, 0);
      if (total <= rampRunBytes) {
        overBudget.delete(runs);
        return;
      }
      present.sort((a, b) => a.used - b.used);
      for (const { path, size } of present) {
        if (total <= rampRunBytes) break;
        if (pinned.has(path)) continue;
        await rm(path, { force: true });
        total -= size;
      }
      if (total <= rampRunBytes) {
        overBudget.delete(runs);
        return;
      }
      if (overBudget.has(runs)) return;
      overBudget.add(runs);
      console.warn(
        `Ramp audio in use takes ${Math.ceil(total / 2 ** 20)} MB, over the ${Math.round(rampRunBytes / 2 ** 20)} MB budget. It stays until it is no longer used.`,
      );
    });
    maintenance = task.catch(() => {});
    return task;
  };
  const removeDirectory =
    options.removeDirectory ??
    ((directory: string) => rm(directory, { recursive: true, force: true }));
  // An export waits on its ramp runs before it can start, as the preview waits on a probe.
  const rank = (job: MediaJob) => (job.foreground ? 1 : priority[job.kind]);
  const pump = () => {
    // A proxy the preview waits on goes before the others, the latest asked first.
    const askedAt = (job: MediaJob) =>
      job.work && wanted(job) ? job.work.askedAt : -1;
    queue.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        askedAt(b) - askedAt(a) ||
        (a.kind === "frame"
          ? b.sequence - a.sequence
          : a.sequence - b.sequence),
    );
    while (!closing && running.size < 2 && queue.length) {
      const busy = (kind: (kind: MediaKind) => boolean) =>
        [...running.keys()].some((job) => kind(job.kind));
      // A clip shows no picture until its editing proxy exists, so one proxy at a time may
      // also take the worker the other whole-file passes leave free.
      const index = queue.findIndex((job) =>
        job.kind === "proxy"
          ? !busy((kind) => kind === "proxy")
          : job.foreground || !background(job.kind) || !busy(background),
      );
      if (index === -1) break;
      const job = queue.splice(index, 1)[0]!;
      // A proxy that gave way to another keeps its progress.
      job.machine.transition({
        status: "running",
        progress:
          job.machine.state.status === "running"
            ? job.machine.state.progress
            : 0,
      });
      const task = job.run().finally(() => {
        running.delete(job);
        pump();
      });
      running.set(job, task);
    }
  };
  const workerUrl =
    options.workerUrl ?? new URL("./worker.ts", import.meta.url);
  /** Lets the requests waiting for a piece, or for any piece, go on. */
  const settle = (work: ProxyWork, piece: number | "first", error?: Error) => {
    for (const waiter of work.waiters.get(piece) ?? [])
      if (error) waiter.reject(error);
      else waiter.resolve();
    work.waiters.delete(piece);
  };
  /** Pieces of finished or abandoned proxies, removed once nothing can be reading them. */
  const retiring = new Map<string, ReturnType<typeof setTimeout>>();
  const retire = (directory: string, delay = 30_000) => {
    clearTimeout(retiring.get(directory));
    retiring.set(
      directory,
      setTimeout(() => {
        retiring.delete(directory);
        removeDirectory(directory).catch((error: unknown) =>
          cleanupErrors.push(
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
      }, delay),
    );
  };
  /**
   * The preview waits for a piece of this proxy, or for any piece: the piece is made next,
   * and this proxy takes the encoder from one nobody waits on.
   */
  const demand = (job: MediaJob, piece?: number) => {
    const work = job.work!;
    work.askedAt = sequence++;
    if (piece !== undefined) {
      work.asked = piece;
      const run = work.run;
      // A piece the current run makes next, or the one after, is on its way.
      if (run && piece >= run.next && piece <= run.next + 1 && piece < run.end)
        return;
      run?.stop();
    }
    if (!running.has(job))
      for (const other of running.keys())
        if (other.kind === "proxy" && !wanted(other)) other.work?.run?.stop();
    pump();
  };
  /** A piece cut from a finished proxy, for a preview that started on its pieces. */
  const extract = async (file: string, pieces: Pieces, piece: number) => {
    const ffmpeg = Bun.which("ffmpeg");
    if (!ffmpeg)
      throw new HttpError(
        503,
        "FFmpeg and ffprobe are required for timeline media previews.",
      );
    const from = piece ? pieces.cuts[piece - 1] : undefined;
    const to = pieces.cuts[piece];
    const sound = pieces.audio === "aac";
    // Copying starts at the keyframe before the cut; the packets before it are the last piece's.
    const drop = `noise=drop=lt(pts*tb\\,${from ?? 0})`;
    const child = Bun.spawn(
      [
        ...[ffmpeg, "-nostdin", "-v", "error", "-copyts"],
        ...(from === undefined ? [] : ["-ss", String(from)]),
        ...["-i", file],
        ...(to === undefined ? [] : ["-to", String(to)]),
        ...["-map", "0:v:0", ...(sound ? ["-map", "0:a:0"] : [])],
        ...["-c", "copy", "-bsf:v", drop, ...(sound ? ["-bsf:a", drop] : [])],
        ...["-avoid_negative_ts", "disabled", "-fflags", "+bitexact"],
        ...["-f", "mp4", "-movflags"],
        "+frag_keyframe+empty_moov+default_base_moof+frag_discont+skip_trailer",
        "pipe:1",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [bytes, errors, code] = await Promise.all([
      new Response(child.stdout).bytes(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(errors.trim() || `FFmpeg exited with code ${code}.`);
    return bytes;
  };
  /**
   * A proxy nobody waits on is background work: after its piece it gives way to a proxy the
   * preview waits on, and to the short jobs (frames, probes, peaks, plans) the queue holds back.
   */
  const givesWay = (job: MediaJob) =>
    !wanted(job) &&
    queue.some((other) =>
      other.kind === "proxy" ? wanted(other) : !background(other.kind),
    );
  const runProxy = async (
    job: MediaJob,
    work: ProxyWork,
    context: Pick<MediaTask, "source" | "ffmpeg" | "ffprobe" | "info"> & {
      identity: string;
      directory: string;
      cache: string;
    },
  ) => {
    const { machine } = job;
    const { pieces } = work;
    const spans = pieceSpans(pieces);
    const task = (proxy: MediaTask["proxy"]) =>
      startMediaWorker(
        {
          kind: "proxy",
          source: context.source,
          directory: work.directory,
          ffmpeg: context.ffmpeg,
          ffprobe: context.ffprobe,
          info: context.info,
          encoder: work.encoder,
          proxy,
        },
        workerUrl,
        options.stopTimeoutMs ?? 1000,
        (event) => {
          if (event.type !== "piece") return;
          work.done.add(event.index);
          work.cursor = event.index + 1;
          if (work.run) work.run.next = event.index + 1;
          settle(work, event.index);
          settle(work, "first");
          if (machine.state.status === "running")
            machine.transition({
              status: "running",
              progress:
                (0.99 *
                  [...work.done].reduce(
                    (sum, index) => sum + spans[index]!.length,
                    0,
                  )) /
                pieces.end,
            });
          if (givesWay(job)) work.run?.stop();
        },
      );
    let failure: string | undefined;
    try {
      if (work.encoder === undefined) {
        work.encoder = (await (nvenc ??= (options.nvenc ?? probeNvenc)()))
          ? "nvenc"
          : "x264";
        // Pieces a crash or an earlier attempt left are not trusted.
        clearTimeout(retiring.get(work.directory));
        retiring.delete(work.directory);
        await removeDirectory(work.directory);
        await mkdir(work.directory, { recursive: true });
      }
      while (work.done.size < spans.length) {
        if (machine.state.status !== "running") return;
        if (givesWay(job)) {
          queue.push(job);
          return;
        }
        // The piece asked for last, else the next one on from the last run, so the pieces
        // after the playhead follow it.
        const missing = (index: number) => !work.done.has(index);
        const first =
          work.asked !== undefined && missing(work.asked)
            ? work.asked
            : ([...spans.keys()].find(
                (index) => index >= work.cursor && missing(index),
              ) ?? [...spans.keys()].find(missing)!);
        let end = first + 1;
        while (end < spans.length && missing(end)) end++;
        const worker = task({ step: "encode", pieces, first, end });
        let stopped = false;
        work.run = {
          next: first,
          end,
          stop() {
            stopped = true;
            worker.cancel();
          },
        };
        job.cancel = worker.cancel;
        try {
          await worker.done;
        } catch (error) {
          if (stopped || machine.state.status !== "running") continue;
          // NVENC can still fail on a frame wider than 4096 pixels or at the driver's session
          // limit. Pieces from two encoders do not join, so libx264 makes them all again.
          if (work.encoder !== "nvenc") throw error;
          work.encoder = "x264";
          work.done.clear();
          await removeDirectory(work.directory);
          await mkdir(work.directory, { recursive: true });
        } finally {
          job.cancel = undefined;
          work.run = undefined;
        }
      }
      if (machine.state.status !== "running") return;
      const joining = task({ step: "join", pieces });
      job.cancel = joining.cancel;
      try {
        await joining.done;
      } finally {
        job.cancel = undefined;
      }
      if (machine.state.status !== "running") return;
      if ((await fingerprint(context.source)) !== context.identity)
        throw new Error(
          "The source media changed during preview generation. Request it again.",
        );
      await mkdir(context.directory, { recursive: true });
      await rename(
        join(work.directory, artifacts.proxy),
        join(context.directory, artifacts.proxy),
      );
      await trimCache(context.cache, context.directory);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      // A proxy that gave way is still queued, with its pieces.
      if (!queue.includes(job)) {
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
        const ended =
          machine.state.status === "done"
            ? undefined
            : new Error(
                machine.state.status === "failed"
                  ? machine.state.error
                  : "The editing proxy was cancelled.",
              );
        for (const piece of [...work.waiters.keys()])
          settle(work, piece, ended);
        if (machine.state.status === "failed")
          job.retryAt = Date.now() + (options.failureTtlMs ?? 30_000);
        else jobs.delete(context.directory);
        // A preview that started on the pieces may still ask for one, which the finished file
        // then answers; the pieces go once nothing can be reading them.
        retire(work.directory);
      }
    }
  };
  const request = async (
    project: Project,
    path: string,
    kind: MediaKind,
    time = 0,
    ramp?: RampTask & { pins?: RampPins; foreground?: boolean },
  ): Promise<MediaResult> => {
    if (closing)
      throw new HttpError(503, "The media service is shutting down.");
    const requestSequence = sequence++;
    const source = await projectPath(project, path);
    const identity = await fingerprint(source);
    let info: z.infer<typeof MediaInfoSchema> | undefined;
    let frame: number | undefined;
    if (kind !== "probe" && kind !== "ramp") {
      const probe = await request(project, path, "probe");
      if (!probe.artifact) return probe;
      info = MediaInfoSchema.parse(await Bun.file(probe.artifact).json());
      if ((kind === "peaks" || kind === "pcm") && !info.channels)
        throw new HttpError(422, "The media has no audio stream.");
      if (
        (kind === "filmstrip" ||
          kind === "scrub" ||
          kind === "proxy" ||
          kind === "pieces") &&
        !info.video
      )
        throw new HttpError(422, "The media has no video stream.");
      if ((kind === "proxy" || kind === "pieces") && !makesProxy(info.video!))
        throw new HttpError(422, "This video needs no editing proxy.");
      if (kind === "frame") {
        if (!info.video)
          throw new HttpError(422, "The media has no video stream.");
        frame = Math.floor(time * info.video.fps + 1e-7);
        time = frame / info.video.fps;
        if (time >= info.video.duration && info.video.duration > 0)
          throw new HttpError(400, "The frame time is outside the video.");
      }
    }
    let pieces: Pieces | undefined;
    if (kind === "proxy") {
      const plan = await request(project, path, "pieces");
      if (!plan.artifact) return plan;
      pieces = PiecesSchema.parse(await Bun.file(plan.artifact).json());
    }
    const key = createHash("sha256")
      .update(
        `${recipe[kind]}\0${kind}\0${identity}\0${ramp ? JSON.stringify(ramp.run) : (frame ?? "")}`,
      )
      .digest("hex");
    await mkdir(await projectPath(project, ".cutroom", true), {
      recursive: true,
    });
    const cache = await projectPath(project, ".cutroom/cache", true);
    await mkdir(cache, { recursive: true });
    // A run is one file in its own tier, kept within a byte budget rather than an entry count.
    // Its folder is app state: a link there is refused, so no write or removal leaves it.
    const runs = kind === "ramp" ? await runFolder(project) : "";
    const directory =
      kind === "ramp" ? join(runs, `${key}.wav`) : join(cache, key);
    ramp?.pins?.hold(directory);
    const cached =
      kind === "ramp"
        ? (await lstat(directory).catch(() => null))?.isFile()
          ? directory
          : null
        : await projectPath(
            project,
            `.cutroom/cache/${key}/${artifacts[kind]}`,
          ).catch((error: unknown) => {
            if (error instanceof HttpError && error.status === 404) return null;
            throw error;
          });
    // A run is keyed by where it starts, so a file too short for this request is made again
    // longer under the same key. The stretcher is causal: the samples it had stay the same.
    const short = ramp && cached && !(await covers(cached, ramp.frames));
    if (cached && ramp && !short) {
      // Marks the run as recently used for the budget.
      const now = new Date();
      await utimes(cached, now, now).catch(() => {});
    }
    if (cached && !short)
      return {
        key,
        artifact: cached,
        metadata:
          kind === "filmstrip"
            ? FilmstripSchema.parse(await Bun.file(cached).json())
            : undefined,
        pieces,
        state: { status: "done", progress: 1 },
      };
    if (closing)
      throw new HttpError(503, "The media service is shutting down.");
    for (const [key, job] of jobs)
      if (job.retryAt !== undefined && job.retryAt <= Date.now())
        jobs.delete(key);
    const existing = jobs.get(directory);
    if (existing && ramp?.foreground && !existing.foreground) {
      existing.foreground = true;
      pump();
    }
    if (existing) {
      if (kind === "frame" && existing.machine.state.status === "queued")
        existing.sequence = Math.max(existing.sequence, requestSequence);
      return { key, pieces, state: existing.machine.state, job: existing };
    }
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
      sequence: requestSequence,
      machine,
      ready: ramp ? Promise.withResolvers<boolean>() : undefined,
      foreground: ramp?.foreground,
      run: async () => {
        let scratch: string | undefined;
        let failure: string | undefined;
        let cleanupFailure: string | undefined;
        try {
          scratch = await mkdtemp(join(cache, ".media-"));
          if (machine.state.status === "cancelling") return;
          const worker = startMediaWorker(
            {
              kind,
              source,
              directory: scratch,
              ...(kind === "pieces" && { projectDir: project.path }),
              ffmpeg,
              ffprobe,
              info,
              time,
              ramp: ramp && { run: ramp.run, frames: ramp.frames },
            },
            workerUrl,
            options.stopTimeoutMs ?? 1000,
            (event) => {
              if (
                event.type === "progress" &&
                machine.state.status === "running"
              )
                machine.transition({
                  status: "running",
                  progress: event.progress,
                });
            },
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
          if (kind === "ramp") {
            // Resolved again: the folder may have been replaced while the run was made.
            if ((await runFolder(project)) !== runs)
              throw new Error("The ramp audio folder moved while it was made.");
            await rename(join(scratch, artifacts.ramp), directory);
            await removeDirectory(scratch);
            scratch = undefined;
            await trimRuns(runs);
          } else {
            await rename(scratch, directory);
            scratch = undefined;
            await trimCache(cache, directory);
          }
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
          job.ready?.resolve(machine.state.status === "done");
          if (machine.state.status === "failed")
            job.retryAt = Date.now() + (options.failureTtlMs ?? 30_000);
          else jobs.delete(directory);
        }
      },
    };
    if (pieces) {
      const work: ProxyWork = {
        pieces,
        directory: join(cache, `.pieces-${key}`),
        done: new Set(),
        waiters: new Map(),
        waiting: 0,
        polledAt: -Infinity,
        askedAt: 0,
        cursor: 0,
      };
      job.work = work;
      job.run = () =>
        runProxy(job, work, {
          source,
          identity,
          info,
          ffmpeg,
          ffprobe,
          directory,
          cache,
        });
    }
    jobs.set(directory, job);
    queue.push(job);
    pump();
    return { key, pieces, state: machine.state, job };
  };
  /**
   * A ramp run of a source file, built once per key. Holding it in `pins` first keeps it
   * from being evicted while the document or export that asked for it is open. An export asks
   * in the foreground, ahead of background passes.
   */
  const rampRun = async (
    project: Project,
    path: string,
    run: RampRun,
    frames: number,
    pins?: RampPins,
    foreground = false,
  ) => {
    const ramp = { run, frames, foreground };
    const result = await request(project, path, "ramp", 0, { ...ramp, pins });
    const building =
      result.state.status === "queued" || result.state.status === "running"
        ? result.job?.ready?.promise
        : undefined;
    const file = async () =>
      join(await runFolder(project), `${result.key}.wav`);
    return {
      key: result.key,
      available: Boolean(result.artifact),
      // A job another request started may make the run shorter than this one needs. Only then
      // is it asked for once more. A run evicted meanwhile is not made again from here.
      pending: building
        ?.then(async (made) => {
          if (!made) return false;
          const built = await file();
          if (!(await lstat(built).catch(() => null))?.isFile()) return false;
          if (await covers(built, frames)) return true;
          const again = await request(project, path, "ramp", 0, ramp);
          return (
            Boolean(again.artifact) ||
            (await again.job?.ready?.promise) === true
          );
        })
        .catch(() => false),
    };
  };
  return {
    request,
    rampRun,
    rampRunFile(project: Project, key: string) {
      return projectStatePath(project, `.cutroom/cache/${RUNS}/${key}.wav`);
    },
    /** Whether a run file holds `frames` settled samples. */
    rampRunCovers: covers,
    /** Pins for the runs one document or export uses, released together. */
    rampPins(): RampPins {
      const held = new Set<string>();
      // Once released, a late request from the same document or export pins nothing.
      let released = false;
      return {
        hold(file) {
          if (released || held.has(file)) return;
          held.add(file);
          pinned.set(file, (pinned.get(file) ?? 0) + 1);
        },
        release() {
          released = true;
          for (const file of held) {
            const count = (pinned.get(file) ?? 1) - 1;
            if (count) pinned.set(file, count);
            else pinned.delete(file);
          }
          held.clear();
        },
      };
    },
    /** The requested piece's presentation times, with its neighbours at either boundary. */
    async proxySamples(project: Project, path: string, time: number) {
      const plan = await request(project, path, "pieces").catch(
        (error: unknown) => {
          if (error instanceof HttpError && error.status === 422) return null;
          throw error;
        },
      );
      if (!plan) return null;
      if (!plan.artifact)
        throw new HttpError(409, "The editing proxy is not planned yet.");
      const pieces = PiecesSchema.parse(await Bun.file(plan.artifact).json());
      const index = pieceAt(pieces, time);
      const file = Bun.file(
        await projectPath(
          project,
          `.cutroom/cache/${plan.key}/${proxySamplesFile}`,
        ),
      );
      const width = Float64Array.BYTES_PER_ELEMENT;
      const offsets = new Float64Array(
        await file.slice(index * width, (index + 2) * width).arrayBuffer(),
      );
      const header = pieces.cuts.length + 2;
      const first = header + Math.max(0, offsets[0]! - 1);
      const last = header + offsets[1]! + (index < pieces.cuts.length ? 1 : 0);
      const bytes = await file.slice(first * width, last * width).arrayBuffer();
      return {
        from: pieces.cuts[index - 1] ?? null,
        to: pieces.cuts[index] ?? null,
        times: Array.from(new Float64Array(bytes)),
      };
    },
    sprite(project: Project, key: string, sheet = 0) {
      return projectPath(project, `.cutroom/cache/${key}/sprite-${sheet}.jpg`);
    },
    scrub(project: Project, key: string) {
      return projectPath(project, `.cutroom/cache/${key}/${artifacts.scrub}`);
    },
    /** A video's editing proxy job, started if it has none; null for a video that needs none. */
    async proxyState(project: Project, path: string) {
      const result = await request(project, path, "proxy").catch(
        (error: unknown) => {
          if (
            error instanceof HttpError &&
            (error.status === 422 || error.status === 404)
          )
            return null;
          throw error;
        },
      );
      return result?.state ?? null;
    },
    /** A video's editing proxy as the preview asks for it, which marks it as waited on. */
    async proxyPoll(project: Project, path: string) {
      const result = await request(project, path, "proxy");
      if (result.job?.work && !result.artifact) {
        result.job.work.polledAt = performance.now();
        demand(result.job);
      }
      return result;
    },
    /**
     * One piece of a video's editing proxy, or the header every piece shares, for the preview's
     * playlist: made next if it is not made yet, and cut from the finished file once that
     * exists. Null for a video that needs no proxy.
     */
    async proxyPiece(
      project: Project,
      path: string,
      piece: number | "init",
      signal: AbortSignal,
    ): Promise<Blob | null> {
      const result = await request(project, path, "proxy").catch(
        (error: unknown) => {
          if (error instanceof HttpError && error.status === 422) return null;
          throw error;
        },
      );
      if (!result) return null;
      const { pieces, job } = result;
      if (!pieces)
        throw new HttpError(409, "The editing proxy is not planned yet.");
      if (piece !== "init" && piece > pieces.cuts.length)
        throw new HttpError(404, "The editing proxy has no such piece.");
      if (result.artifact) {
        const bytes = await extract(
          result.artifact,
          pieces,
          piece === "init" ? 0 : piece,
        );
        const start = fragmentsStart(bytes);
        return new Blob([
          piece === "init" ? bytes.subarray(0, start) : bytes.subarray(start),
        ]);
      }
      const work = job?.work;
      if (!work || result.state.status === "failed")
        throw new HttpError(
          422,
          result.state.status === "failed"
            ? result.state.error
            : "The editing proxy is not being made.",
        );
      const made = () =>
        piece === "init" ? work.done.size > 0 : work.done.has(piece);
      if (!made()) {
        const waiter = Promise.withResolvers<void>();
        const key = piece === "init" ? "first" : piece;
        const waiters = work.waiters.get(key) ?? new Set();
        work.waiters.set(key, waiters.add(waiter));
        const abort = () => waiter.reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        work.waiting++;
        try {
          demand(job, piece === "init" ? undefined : piece);
          await waiter.promise;
        } finally {
          work.waiting--;
          waiters.delete(waiter);
          signal.removeEventListener("abort", abort);
        }
      }
      return Bun.file(
        join(
          work.directory,
          "pieces",
          `${piece === "init" ? "init" : piece}.mp4`,
        ),
      );
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
      for (const job of queue.splice(0)) {
        job.machine.transition({
          status: "cancelled",
          progress: job.machine.state.progress,
        });
        job.ready?.resolve(false);
        if (!job.work) continue;
        for (const piece of [...job.work.waiters.keys()])
          settle(
            job.work,
            piece,
            new Error("The editing proxy was cancelled."),
          );
        retire(job.work.directory, 0);
      }
      await Promise.all([...running.values()]);
      await Promise.all(
        [...retiring].map(([directory, timer]) => {
          clearTimeout(timer);
          retiring.delete(directory);
          return removeDirectory(directory).catch((error: unknown) =>
            cleanupErrors.push(
              error instanceof Error ? error : new Error(String(error)),
            ),
          );
        }),
      );
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors,
          "Media cancellation cleanup failed.",
        );
    },
  };
}
