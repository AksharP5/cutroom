import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractMediaMetadata,
  videoStartOnMediaTimeline,
} from "@hyperframes/engine";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import type { Project } from "../../shared/project.ts";
import { HttpError } from "../../shared/errors.ts";
import { mediaKind } from "../../shared/media.ts";
import {
  MATTE_MODEL,
  MATTES_FOLDER,
  MatteManifestSchema,
  matteFrameAt,
} from "../../shared/matte.ts";
import type {
  MatteEntry,
  MatteJob,
  MatteManifest,
  MatteModelState,
  MatteStatus,
} from "../../shared/matte.ts";
import { frameGrid } from "../media/frames.ts";
import { localMediaInputOptions } from "../media/input.ts";
import { z } from "zod";
import { projectPath, resolveProjectPath } from "../projects/path.ts";
import { MatteEventSchema } from "./protocol.ts";
import type { MatteTask } from "./protocol.ts";
import {
  downloadWeights,
  hasRuntime,
  MODEL_FILE,
  hasWeights,
  matteModelPaths,
} from "./model.ts";
import type { MatteModelPaths, WeightsFile } from "./model.ts";

type MatteProject = Pick<Project, "id" | "path">;
export interface MatteRequest {
  src: string;
  from: number;
  to: number;
  retry?: boolean;
  composition?: string;
}
const MANIFEST = `${MATTES_FOLDER}/mattes.json`;
/** Status events are coalesced to at most four a second. */
const EVENT_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 5000;
const OUT_OF_MEMORY = /out of memory|bad_alloc|ENOMEM|Cannot allocate/i;

export interface MatteServiceOptions {
  model?: MatteModelPaths;
  /** The module that exports `createSegmenter`; tests give a stub. */
  segmenter?: URL;
  /** Threads the model may use, capped so the editor keeps its pace. */
  threads?: number;
  /** The weights to download and trust; tests point it at a local server and a small file. */
  modelFile?: WeightsFile;
}

/** A source's frame grid: frame k at `start + k / rate`. */
interface SourceFrames {
  absolute: string;
  path: string;
  size: number;
  mtimeMs: number;
  still: boolean;
  start: number;
  rate: number;
  /** The rate as FFmpeg reads it, such as `30000/1001`. */
  rateText: string;
  variable: boolean;
  /** Frames in the file. */
  count: number;
}

interface Job extends MatteJob {
  project: MatteProject;
  /** The composition whose clips asked for it, so a later read of that timeline can let it go. */
  composition?: string;
  source: SourceFrames;
  startedAt?: number;
  endedAt?: number;
  stop?: () => void;
}

/** `00-01-02` for 62 seconds: a time a file name can carry. */
const stamp = (seconds: number) =>
  [3600, 60, 1]
    .map((unit, index) =>
      String(
        index === 0
          ? Math.floor(seconds / unit)
          : Math.floor(seconds / unit) % 60,
      ).padStart(2, "0"),
    )
    .join("-");

const RatesSchema = z.object({
  streams: z.array(
    z.object({
      r_frame_rate: z.string().optional(),
      avg_frame_rate: z.string().optional(),
      nb_frames: z.string().optional(),
      duration: z.string().optional(),
    }),
  ),
});
/** `num/den` as FFmpeg writes it, or null for `0/0` and anything else. */
const fraction = (text: string | undefined) => {
  const match = /^(\d+)\/(\d+)$/.exec(text ?? "");
  const [num, den] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  return num > 0 && den > 0
    ? { text: `${num}/${den}`, value: num / den }
    : null;
};

/**
 * A video's frame grid and frame count. The rate stays a fraction, as FFmpeg reads it, so 29.97
 * fps footage is 30000/1001 everywhere and never a rounded decimal. A constant-rate file counts
 * its frames from the container where it records them; a file that plays to its last frame is
 * then matted to its last frame.
 */
async function probeVideo(absolute: string) {
  const ffprobe = findFfBinary("ffprobe", { configuredMustExist: true });
  if (!ffprobe) throw new HttpError(503, "FFmpeg is not installed.");
  const child = Bun.spawn(
    [
      ffprobe,
      ...["-v", "error", ...localMediaInputOptions, "-select_streams", "v:0"],
      ...[
        "-show_entries",
        "stream=r_frame_rate,avg_frame_rate,nb_frames,duration",
      ],
      ...["-of", "json", absolute],
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [text, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  const stream =
    code === 0 ? RatesSchema.parse(JSON.parse(text)).streams[0] : undefined;
  if (!stream) throw new HttpError(422, "FFmpeg could not read the video.");
  const [metadata, grid] = await Promise.all([
    extractMediaMetadata(absolute),
    frameGrid(absolute),
  ]);
  // A variable-rate file is read at the slots of its average rate.
  const rate = grid
    ? fraction(stream.r_frame_rate)
    : (fraction(stream.avg_frame_rate) ?? fraction(stream.r_frame_rate));
  if (!rate) throw new HttpError(422, "The video has no frame rate.");
  const seconds =
    Number(stream.duration) ||
    metadata.videoStreamDurationSeconds ||
    metadata.durationSeconds;
  const listed = Number(stream.nb_frames);
  return {
    still: false,
    start: grid?.start ?? videoStartOnMediaTimeline(metadata),
    rate: rate.value,
    rateText: rate.text,
    variable: !grid,
    count:
      grid && listed > 0
        ? listed
        : Math.max(1, Math.round(seconds * rate.value)),
  };
}

/**
 * Makes background mattes, one job at a time across every project, in the order asked. A matte
 * is the model's 8-bit mask of a source frame range, kept as an H.264 MP4 in the project's
 * `mattes` folder and listed in `mattes/mattes.json` with the source's size and modification time,
 * so replacing the source makes it stale. Jobs never touch the composition.
 */
export function createMatteService(options: MatteServiceOptions = {}) {
  const paths = options.model ?? matteModelPaths();
  // Browser tests run jobs on a stub model, as unit tests pass one in.
  const segmenter =
    options.segmenter ??
    new URL(
      process.env.CUTROOM_MATTE_SEGMENTER ?? "./u2net.ts",
      import.meta.url,
    );
  const threads = options.threads ?? 4;
  const weightsFile = options.modelFile ?? MODEL_FILE;
  const jobs: Job[] = [];
  const listeners = new Map<string, Set<(status: MatteStatus) => void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const writes = new Map<string, Promise<unknown>>();
  let model: MatteModelState | null = null;
  let download: AbortController | null = null;
  let running: Job | null = null;
  let closed = false;

  const modelState = async (): Promise<MatteModelState> => {
    if (model?.status === "downloading" || model?.status === "failed")
      return model;
    // A stub model for browser tests needs no weights.
    if (process.env.CUTROOM_MATTE_SEGMENTER) return { status: "ready" };
    if (!hasRuntime(paths))
      return {
        status: "no-runtime",
        error:
          "Remove background needs the ONNX runtime HyperFrames uses. Run `npx hyperframes remove-background` on any picture once to install it.",
      };
    return (await hasWeights(paths, weightsFile))
      ? { status: "ready" }
      : {
          status: "missing",
          bytes: weightsFile.bytes,
        };
  };

  /** Mattes whose source is unchanged since they were made, so the viewer and export can use them. */
  const freshMattes = async (project: MatteProject) => {
    const { mattes } = await readManifest(project);
    const sources = new Map(
      await Promise.all(
        [...new Set(mattes.map(({ src }) => src))].map(
          async (src) =>
            [
              src,
              await stat(join(project.path, src)).catch(() => null),
            ] as const,
        ),
      ),
    );
    return mattes.filter((entry) => {
      const info = sources.get(entry.src);
      return info?.size === entry.size && info.mtimeMs === entry.mtimeMs;
    });
  };

  const status = async (project: MatteProject): Promise<MatteStatus> => ({
    model: await modelState(),
    jobs: jobs
      .filter((job) => job.project.id === project.id)
      .map(
        ({
          project: _p,
          source: _s,
          composition: _c,
          startedAt,
          endedAt,
          stop: _s2,
          ...job
        }) => ({
          ...job,
          elapsed: startedAt ? ((endedAt ?? Date.now()) - startedAt) / 1000 : 0,
        }),
      ),
    mattes: await freshMattes(project),
  });

  const projects = new Map<string, MatteProject>();
  const flush = async (projectId: string) => {
    timers.delete(projectId);
    const subscribed = listeners.get(projectId);
    const project = projects.get(projectId);
    if (!subscribed?.size || !project) return;
    const snapshot = await status(project);
    for (const listener of subscribed) listener(snapshot);
  };
  /** Tells subscribers, at most four times a second, with the latest state. */
  const changed = (projectId?: string) => {
    for (const id of projectId ? [projectId] : listeners.keys())
      if (!timers.has(id))
        timers.set(
          id,
          setTimeout(() => void flush(id), EVENT_INTERVAL_MS),
        );
  };

  const readManifest = async (
    project: MatteProject,
  ): Promise<MatteManifest> => {
    const path = join(project.path, MANIFEST);
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return { version: 1, mattes: [] };
    const parsed = MatteManifestSchema.safeParse(
      (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })(),
    );
    // A damaged list only costs remaking mattes; the files stay for anyone who wants them.
    return parsed.success ? parsed.data : { version: 1, mattes: [] };
  };
  /** Serialised per project, written whole and renamed into place. */
  const updateManifest = (
    project: MatteProject,
    change: (manifest: MatteManifest) => MatteManifest,
  ) => {
    const write = (writes.get(project.id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const next = change(await readManifest(project));
        const path = await projectPath(project, MANIFEST, true);
        const partial = `${path}.${randomUUID()}.part`;
        await writeFile(partial, `${JSON.stringify(next, null, 2)}\n`);
        await rename(partial, path);
      });
    writes.set(project.id, write);
    return write;
  };

  const sourceFrames = async (
    project: MatteProject,
    src: string,
  ): Promise<SourceFrames> => {
    const kind = mediaKind(src)?.kind;
    if (kind !== "video" && kind !== "image")
      throw new HttpError(400, "Only video and image clips have a background.");
    const { absolute, path } = await resolveProjectPath(project, src);
    const info = await stat(absolute);
    if (kind === "image")
      return {
        absolute,
        path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        still: true,
        start: 0,
        rate: 1,
        rateText: "1",
        variable: false,
        count: 1,
      };
    const version = `${path}:${info.size}:${info.mtimeMs}`;
    let probed = probes.get(version);
    if (!probed) {
      probed = probeVideo(absolute);
      probes.set(version, probed);
      if (probes.size > 256) probes.delete(probes.keys().next().value!);
      probed.catch(() => probes.delete(version));
    }
    return {
      absolute,
      path,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ...(await probed),
    };
  };

  /** Probe results by source version, so edits never re-run ffprobe on an unchanged file. */
  const probes = new Map<string, ReturnType<typeof probeVideo>>();

  /** Mattes made from this version of the source. */ /** Mattes made from this version of the source. */
  const fresh = (manifest: MatteManifest, source: SourceFrames) =>
    manifest.mattes.filter(
      (entry) =>
        entry.src === source.path &&
        entry.size === source.size &&
        entry.mtimeMs === source.mtimeMs &&
        entry.rate === source.rate &&
        entry.start === source.start,
    );

  /** Source frames in `[first, end)` that no fresh matte, job or failure accounts for. */
  const missing = (
    covered: { first: number; frames: number }[],
    first: number,
    end: number,
  ) => {
    const gaps: [number, number][] = [];
    let at = first;
    for (const piece of [...covered].sort((a, b) => a.first - b.first)) {
      if (piece.first + piece.frames <= at) continue;
      if (piece.first >= end) break;
      if (piece.first > at) gaps.push([at, piece.first]);
      at = Math.max(at, piece.first + piece.frames);
    }
    if (at < end) gaps.push([at, end]);
    return gaps;
  };

  const pump = async () => {
    if (running || closed) return;
    const next = jobs.find(
      (job) => job.status === "waiting" || job.status === "needs-model",
    );
    if (!next) return;
    const state = await modelState();
    if (state.status !== "ready") {
      for (const job of jobs)
        if (job.status === "waiting") {
          job.status = "needs-model";
          changed(job.project.id);
        }
      return;
    }
    if (running) return;
    running = next;
    // Any failure, such as the project folder disappearing, ends as this job's error.
    void run(next)
      .catch((error: unknown) =>
        fail(next, error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        running = null;
        void pump();
      });
  };

  const run = async (job: Job) => {
    const ffmpeg = findFfBinary("ffmpeg", { configuredMustExist: true });
    if (!ffmpeg) return fail(job, "FFmpeg is not installed.");
    const { source, project } = job;
    const from = source.start + job.first / source.rate;
    const to = source.start + (job.first + job.frames) / source.rate;
    const name = basename(source.path, extname(source.path));
    const folder = await projectPath(project, MATTES_FOLDER, true);
    await mkdir(folder, { recursive: true });
    // FFmpeg writes into a file this service just created, never through a name that may already
    // be a link; the finished matte is renamed to a free name.
    const output = join(folder, `.${randomUUID()}.part.mp4`);
    await (await open(output, "wx")).close();
    const task: MatteTask = {
      ffmpeg,
      source: source.absolute,
      output,
      range: source.still
        ? null
        : {
            seek: Math.max(0, (job.first - 0.5) / source.rate),
            frames: job.frames,
            rate: source.rateText,
            variable: source.variable,
          },
      segmenter: segmenter.href,
      model: { ...paths, threads },
    };
    job.status = "running";
    job.startedAt = Date.now();
    changed(project.id);
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./worker.ts", import.meta.url)),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env },
    );
    let stopped = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    job.stop = () => {
      stopped = true;
      child.kill("SIGTERM");
      killer ??= setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    };
    child.stdin.write(JSON.stringify(task));
    await child.stdin.end();
    const errors = new Response(child.stderr).text();
    let outcome:
      | { type: "done"; done: number; subject: boolean }
      | { type: "error"; message: string }
      | undefined;
    let line = "";
    const decoder = new TextDecoder();
    const read = (text: string) => {
      // A model or library that prints to stdout leaves lines that are not events.
      const event = (() => {
        try {
          return MatteEventSchema.safeParse(JSON.parse(text)).data;
        } catch {
          return undefined;
        }
      })();
      if (!event) return;
      if (event.type === "progress") {
        job.done = event.done;
        changed(project.id);
      } else outcome = event;
    };
    for await (const chunk of child.stdout) {
      const lines = (line + decoder.decode(chunk, { stream: true })).split(
        "\n",
      );
      line = lines.pop()!;
      for (const complete of lines) read(complete);
    }
    read(line);
    const code = await child.exited;
    clearTimeout(killer);
    job.endedAt = Date.now();
    job.stop = undefined;
    if (outcome?.type === "done") {
      let file = "";
      if (outcome.done > 0 && outcome.subject) {
        const stem = `${name} ${stamp(from)} to ${stamp(Math.ceil(to))}`;
        file = `${MATTES_FOLDER}/${stem}.mp4`;
        for (let copy = 2; await taken(join(folder, basename(file))); copy++)
          file = `${MATTES_FOLDER}/${stem} ${copy}.mp4`;
        await rename(output, join(folder, basename(file)));
      }
      await rm(output, { force: true });
      if (outcome.done > 0)
        await record(
          project,
          source,
          file,
          job.first,
          outcome.done,
          outcome.subject,
        );
      job.done = outcome.done;
      job.status = stopped
        ? "stopped"
        : outcome.subject
          ? "done"
          : "no-subject";
      changed(project.id);
      return;
    }
    await rm(output, { force: true });
    if (stopped) {
      job.status = "stopped";
      changed(project.id);
      return;
    }
    const message =
      outcome?.message ??
      `The worker stopped (exit ${code}). ${(await errors).slice(-2000)}`;
    // A worker the system killed outright ran out of memory.
    fail(
      job,
      message,
      OUT_OF_MEMORY.test(message) || child.signalCode === "SIGKILL",
    );
  };

  /** Whether anything, a dangling link included, has the name. */
  const taken = (path: string) =>
    lstat(path).then(
      () => true,
      () => false,
    );

  const fail = (job: Job, error: string, memory = false) => {
    job.status = "failed";
    job.error = error;
    if (memory) job.memory = true;
    changed(job.project.id);
  };

  const record = async (
    project: MatteProject,
    source: SourceFrames,
    file: string,
    first: number,
    frames: number,
    subject: boolean,
  ) => {
    const dropped: string[] = [];
    await updateManifest(project, (manifest) => {
      // Mattes of an older version of the source are stale.
      const stale = (entry: MatteEntry) =>
        entry.src === source.path &&
        (entry.size !== source.size || entry.mtimeMs !== source.mtimeMs);
      dropped.push(
        ...manifest.mattes
          .filter(stale)
          .flatMap(({ file }) => (file ? [file] : [])),
      );
      return {
        ...manifest,
        mattes: [
          ...manifest.mattes.filter((entry) => !stale(entry)),
          {
            file: subject ? file : "",
            src: source.path,
            size: source.size,
            mtimeMs: source.mtimeMs,
            first,
            frames,
            start: source.start,
            rate: source.rate,
            count: source.count,
            variable: source.variable,
            model: MATTE_MODEL.name,
            subject,
          } satisfies MatteEntry,
        ],
      };
    });
    // A file no entry names any more is only disk space; the schema keeps it inside mattes/.
    for (const stale of dropped)
      await rm(await projectPath(project, stale, true), { force: true }).catch(
        () => {},
      );
  };

  const service = {
    status,

    /**
     * Queues the source frames between media times `from` and `to` that have no fresh matte and
     * no job. A range that failed is asked again only with `retry`.
     */
    async queue(project: MatteProject, request: MatteRequest) {
      const source = await sourceFrames(project, request.src);
      const first = source.still
        ? 0
        : Math.min(source.count - 1, matteFrameAt(source, request.from));
      const end = source.still
        ? 1
        : Math.min(
            source.count,
            Math.max(
              first + 1,
              Math.ceil((request.to - source.start) * source.rate - 1e-6),
            ),
          );
      const mine = (job: Job) =>
        job.project.id === project.id && job.src === source.path;
      const current = (job: Job) =>
        job.source.size === source.size &&
        job.source.mtimeMs === source.mtimeMs;
      // Results for an older version of the file, and failures being retried, are forgotten.
      for (const job of jobs.filter(mine))
        if (
          (!current(job) && job !== running) ||
          (request.retry && job.status === "failed")
        )
          jobs.splice(jobs.indexOf(job), 1);
      const busy = jobs.filter(
        (job) =>
          mine(job) &&
          !["done", "stopped"].includes(job.status) &&
          current(job),
      );
      const covered = [...fresh(await readManifest(project), source), ...busy];
      for (const [gapFirst, gapEnd] of missing(covered, first, end))
        jobs.push({
          id: randomUUID(),
          project,
          composition: request.composition,
          source,
          src: source.path,
          start: source.start,
          rate: source.rate,
          first: gapFirst,
          frames: gapEnd - gapFirst,
          count: source.count,
          done: 0,
          status: "waiting",
          elapsed: 0,
        });
      // Finished jobs leave the list once asked about again; the manifest remembers them.
      for (const job of jobs.filter(
        (job) =>
          mine(job) && (job.status === "done" || job.status === "stopped"),
      ))
        jobs.splice(jobs.indexOf(job), 1);
      changed(project.id);
      void pump();
      return status(project);
    },

    /** Stops a job; the frames already made are kept. */
    stop(projectId: string, id: string) {
      const job = jobs.find(
        (job) => job.project.id === projectId && job.id === id,
      );
      if (!job) throw new HttpError(404, "That matte job is not running.");
      if (job.stop) job.stop();
      else {
        jobs.splice(jobs.indexOf(job), 1);
        changed(projectId);
      }
    },

    /**
     * Stops the jobs a composition's clips asked for that none of `needed` covers any more: the
     * clip went back to Keep, was deleted, or an undo took its Remove away. Frames already made
     * are kept.
     */
    async release(
      project: MatteProject,
      composition: string,
      needed: readonly { src: string; from: number; to: number }[],
    ) {
      const sources = new Map(
        await Promise.all(
          needed.map(
            async ({ src }) =>
              [
                src,
                (await resolveProjectPath(project, src).catch(() => null))
                  ?.path,
              ] as const,
          ),
        ),
      );
      for (const job of jobs.filter(
        (job) =>
          job.project.id === project.id &&
          job.composition === composition &&
          (job.status === "waiting" ||
            job.status === "needs-model" ||
            job.status === "running"),
      )) {
        const used = needed.some(
          (need) =>
            sources.get(need.src) === job.src &&
            job.first < Math.ceil((need.to - job.start) * job.rate - 1e-6) &&
            job.first + job.frames >
              Math.floor((need.from - job.start) * job.rate + 1e-6),
        );
        if (used) continue;
        if (job.stop) job.stop();
        else jobs.splice(jobs.indexOf(job), 1);
        changed(project.id);
      }
    },

    /** The fresh mattes of a source, for the viewer and export. */
    async mattes(project: MatteProject, src: string) {
      const source = await sourceFrames(project, src);
      return fresh(await readManifest(project), source);
    },

    /** Downloads the weights when the person asks; jobs waiting on them start after. */
    async downloadModel() {
      if (download) return;
      const state = await modelState();
      if (state.status !== "missing" && state.status !== "failed") return;
      download = new AbortController();
      model = { status: "downloading", progress: 0 };
      changed();
      try {
        await downloadWeights(
          paths,
          (progress) => {
            model = { status: "downloading", progress };
            changed();
          },
          download.signal,
          weightsFile,
        );
        model = null;
      } catch (error) {
        model = download.signal.aborted
          ? null
          : {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            };
      } finally {
        download = null;
        changed();
        void pump();
      }
    },

    cancelDownload() {
      download?.abort();
    },

    subscribe(project: MatteProject, listener: (status: MatteStatus) => void) {
      const projectId = project.id;
      projects.set(projectId, project);
      let set = listeners.get(projectId);
      if (!set) listeners.set(projectId, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) {
          listeners.delete(projectId);
          projects.delete(projectId);
        }
      };
    },

    /** Stops the running job and waits for it; queued jobs are dropped. */
    async close() {
      closed = true;
      download?.abort();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      const current = running;
      jobs.length = 0;
      current?.stop?.();
      while (running) await new Promise((done) => setTimeout(done, 20));
    },
  };
  const requests = new Map<string, Promise<unknown>>();
  const { queue, ...exposed } = service;
  return {
    ...exposed,
    /**
     * Requests for one project run one after another, so two at once never queue the same
     * frames twice.
     */
    request(project: MatteProject, request: MatteRequest) {
      const queued = (requests.get(project.id) ?? Promise.resolve())
        .catch(() => {})
        .then(() => queue(project, request));
      requests.set(project.id, queued);
      return queued;
    },
  };
}

export type MatteService = ReturnType<typeof createMatteService>;
