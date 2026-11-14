import { fileFingerprint, inMediaTrash } from "../../shared/media";
import { AGENT_HEADER } from "../../shared/review";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  defaultExportRange,
  exportFilename,
  exportRange,
  ExportOptionsSchema,
  ExportStartSchema,
} from "../../shared/export";
import type { ExportOptions } from "../../shared/export";
import { projectMutationGuard } from "../projects/authorization";
import { sourceWriteGuard } from "./source-guard";
import { projectStatePath } from "../projects/path";
import { watch } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { injectDeterministicFontFaces } from "@hyperframes/core/fonts/embed";
import { previewRuntimeScript } from "./previewRuntime";
import { lintHyperframeHtml, lintProject } from "@hyperframes/core/lint";
import {
  DELETED_VERSION,
  PREVIEW_BUNDLE_OPTIONS,
  STUDIO_SIGNATURE_MANIFEST_PATHS,
  affectsPreview,
  affectsProjectSignature,
  compositionsAffectedBy,
  createProjectSignatureAsync,
  createStudioApi,
  fileContentVersion,
  getMimeType,
  identifyFileWrite,
  requestSubPath,
} from "@hyperframes/studio-server";
import type {
  ResolvedProject,
  StudioApiAdapter,
} from "@hyperframes/studio-server";
import type { ProjectStore } from "../projects/store";
import { isMissing, projectPath, readSource } from "../projects/store";
import type { ReviewService } from "../projects/review";
import { HttpError } from "../../shared/errors";
import {
  createThumbnailRenderer,
  thumbnailRendererVersion,
} from "./thumbnails";
import { STAGING_PREFIX, createRenderWorkers } from "./jobs";
import { nextExportName } from "./exportName";
import { previewPolicy } from "./isolation";
import { withPreviewBridge, withPreviewClipIdentities } from "./previewBridge";
import { readTrackMix } from "../timeline/mix";
import {
  compositionScope,
  mixCompositionInstances,
  parseComposition,
  mediaSources,
} from "../timeline/composition";
import { mediaFacts } from "../timeline/media";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import { trackGainPreview } from "./trackGainPreview";
import { parseFps } from "@hyperframes/core";

export interface FileChange {
  projectId: string;
  path: string;
  version: string | null;
  content?: string;
  writeToken?: string;
  affectsPreview: boolean;
  affectedCompositions: string[] | null;
}

const ignored = new Set([
  "node_modules",
  ".git",
  ".cutroom",
  ".thumbnails",
  "renders",
]);

/** `reviews` must be the server's one review service, so editor undo shares its per-project queue. */
export function createHyperframesApi(
  store: ProjectStore,
  reviews: ReviewService,
) {
  const api = new Hono();
  api.use("/projects/:id/thumbnail/*", async (c, next) => {
    const url = new URL(c.req.url);
    url.searchParams.set(
      "v",
      `${thumbnailRendererVersion}-${url.searchParams.get("v") ?? ""}`,
    );
    c.req.raw = new Request(url, c.req.raw);
    await next();
  });
  // Internal export forwarding must preserve errors for the application's HTTP boundary.
  api.onError((error) => {
    throw error;
  });
  api.use("/projects/:id/*", projectMutationGuard(reviews));
  api.use("/projects/:id/*", sourceWriteGuard(store));
  api.use("/projects/:id/*", async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    const family = requestSubPath(c.req.url, "projects/:id").split("/")[0];
    if (
      !["upload", "files", "duplicate-file", "file-mutations"].includes(
        family ?? "",
      )
    )
      return next();
    const project = await store.get(c.req.param("id") ?? "");
    await resolveProject(project.id);
    await reviews.editAssets(project, c.req.header(AGENT_HEADER), next);
  });
  api.use("/render/*", async (c, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.header(AGENT_HEADER) !== undefined
    ) {
      if (c.req.method !== "POST" || !c.req.path.endsWith("/cancel"))
        throw new HttpError(409, "Only the owner can control render jobs.");
    }
    await next();
  });
  const subscribers = new Set<(change: FileChange) => void>();
  const watchers = new Map<
    string,
    { users: number; ready: Promise<ReturnType<typeof watch>> }
  >();
  let disposed = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const signatures = new Map<string, Promise<string>>();
  const thumbnails = createThumbnailRenderer();
  const renders = createRenderWorkers({
    sourceOverrides: async (id) =>
      Object.fromEntries(
        (await readTrackMix(store, await store.get(id))).map(
          ({ path, html }) => [path, html],
        ),
      ),
  });
  const exportRequest = new AsyncLocalStorage<ExportOptions>();
  const readTimeline = async (projectId: string) => {
    const project = await store.get(projectId);
    const [source, document] = await Promise.all([
      readSource(project, "index.html"),
      store.document(project),
    ]);
    const { lengths } = await mediaFacts(
      project,
      "index.html",
      mediaSources(source.content, "document"),
    );
    return parseComposition(
      source.content,
      document.timelines["index.html"] ?? emptyTimelineSettings(),
      { mediaLengths: lengths },
    ).timeline;
  };
  api.post("/projects/:id/export", async (c) => {
    const input = ExportStartSchema.parse(await c.req.json());
    const project = await store.get(c.req.param("id"));
    const timeline = await readTimeline(project.id);
    const choice = input.range ?? defaultExportRange(timeline);
    let frames;
    try {
      frames =
        typeof choice === "string" ? exportRange(timeline, choice) : choice;
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (frames.end > timeline.duration)
      throw new HttpError(400, "In and Out must be inside the timeline.");
    const directory =
      input.directory ??
      (await projectStatePath(project, ".cutroom/renders", true));
    if (!isAbsolute(directory))
      throw new HttpError(400, "Enter an absolute output folder.");
    const filename =
      input.filename ??
      (await nextExportName(directory, exportFilename(project.name)));
    // Enter the dialog's route with the caller's identity. It owns destination validation and registration.
    return api.request(
      new URL(`/projects/${encodeURIComponent(project.id)}/render`, c.req.url),
      {
        method: "POST",
        headers: c.req.raw.headers,
        body: JSON.stringify({
          format: "mp4",
          quality: input.quality,
          fps: `${timeline.fps.num}/${timeline.fps.den}`,
          cutroom: {
            directory,
            filename,
            range: choice === "timeline" ? null : frames,
          },
        }),
      },
    );
  });
  // Extend Studio's one job registry, progress stream and cancel route with Cutroom's output intent.
  api.use("/projects/:id/render", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const body = await c.req.json<unknown>().catch(() => ({}));
    const { cutroom } = z
      .object({ cutroom: ExportOptionsSchema.optional() })
      .parse(body);
    if (!cutroom) return next();
    if (
      z.object({ format: z.literal("mp4") }).safeParse(body).success === false
    )
      throw new HttpError(400, "Named exports use MP4.");
    if (!isAbsolute(cutroom.directory))
      throw new HttpError(400, "Enter an absolute output folder.");
    const project = await store.get(c.req.param("id"));
    if (cutroom.range) {
      const timeline = await readTimeline(project.id);
      const { fps } = z
        .object({ fps: z.union([z.string(), z.number()]) })
        .parse(body);
      const rate = parseFps(fps);
      if (
        !rate.ok ||
        rate.value.num * timeline.fps.den !== timeline.fps.num * rate.value.den
      )
        throw new HttpError(
          400,
          "A marked export must use the project's frame rate.",
        );
      if (cutroom.range.end > timeline.duration)
        throw new HttpError(400, "In and Out must be inside the timeline.");
    }
    const defaultDirectory = await projectStatePath(
      project,
      ".cutroom/renders",
      true,
    );
    if (cutroom.directory === defaultDirectory)
      await mkdir(defaultDirectory, { recursive: true });
    const directory = await realpath(cutroom.directory);
    await exportRequest.run({ ...cutroom, directory }, next);
    if (c.res.ok) {
      const started = z
        .object({ jobId: z.string(), status: z.string() })
        .parse(await c.res.json());
      c.res = c.json({
        ...started,
        outputPath: join(directory, cutroom.filename),
      });
    }
  });
  const previewKeys = new Map<string, string>();
  const isolatedPreview = (projectId: string, previewUrl: string) => {
    let key = previewKeys.get(projectId);
    if (!key) {
      key = crypto.randomUUID();
      previewKeys.set(projectId, key);
    }
    const url = new URL(previewUrl);
    const previewPath = `/api/projects/${encodeURIComponent(projectId)}/preview`;
    if (
      url.pathname !== previewPath &&
      !url.pathname.startsWith(`${previewPath}/`)
    )
      throw new Error("Frame capture requires the project's preview URL.");
    url.pathname = url.pathname.replace(
      previewPath,
      `/api/isolated/${key}/preview`,
    );
    return url.href;
  };

  const watchProject = async (project: ResolvedProject) => {
    await reviews.observeAssets(await store.get(project.id));
    const watcher = watch(
      project.dir,
      { recursive: true },
      (_kind, filename) => {
        if (!filename) return;
        const path = filename.replaceAll("\\", "/");
        const parts = path.split("/");
        // An export's staging folder churns thousands of files that never affect the preview.
        if (
          parts.some(
            (part) => ignored.has(part) || part.startsWith(STAGING_PREFIX),
          )
        )
          return;
        if (
          parts[0] === ".hyperframes" &&
          !STUDIO_SIGNATURE_MANIFEST_PATHS.some((manifest) => manifest === path)
        )
          return;
        if (affectsProjectSignature(project.dir, join(project.dir, path)))
          signatures.delete(project.dir);
        const key = `${project.id}\0${path}`;
        clearTimeout(timers.get(key));
        timers.set(
          key,
          setTimeout(() => {
            timers.delete(key);
            void (async () => {
              const absolute = join(project.dir, path);
              let version: string | null = null;
              let content: string | undefined;
              try {
                const info = await stat(absolute);
                if (info.isFile() && info.size <= 2_000_000) {
                  const bytes = await readFile(absolute);
                  version = fileContentVersion(bytes);
                  if (/\.(html?|css|m?[jt]sx?|json|srt|vtt)$/i.test(path))
                    content = bytes.toString("utf8");
                }
              } catch (error) {
                if (!(
                  error &&
                  typeof error === "object" &&
                  "code" in error &&
                  error.code === "ENOENT"
                ))
                  throw error;
              }
              const receipt = identifyFileWrite(
                absolute,
                version ?? DELETED_VERSION,
              );
              const affects = affectsPreview(project.dir, path);
              const change: FileChange = {
                projectId: project.id,
                path,
                version,
                content,
                affectsPreview: affects,
                affectedCompositions: affects
                  ? compositionsAffectedBy(project.dir, path)
                  : [],
                ...(receipt ? { writeToken: receipt.writeToken } : {}),
              };
              if (affects)
                await reviews.observeAssets(await store.get(project.id));
              for (const subscriber of subscribers) subscriber(change);
            })().catch((error: unknown) =>
              console.error("Project watch failed:", error),
            );
          }, 60),
        );
      },
    );
    watcher.unref();
    watcher.on("error", (error) =>
      console.error(`Cannot watch ${project.title ?? project.id}:`, error),
    );
    return watcher;
  };

  const resolveProject = async (
    id: string,
  ): Promise<ResolvedProject | null> => {
    const project = await store.get(id).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    });
    if (!project) return null;
    // The upstream preview and animation writers own these fixed paths too.
    for (const path of [
      ".hyperframes",
      ".hyperframes/preview",
      ...STUDIO_SIGNATURE_MANIFEST_PATHS,
    ])
      await projectStatePath(project, path, true);
    const resolved = { id: project.id, dir: project.path, title: project.name };
    return resolved;
  };

  const adapter: StudioApiAdapter = {
    async listProjects() {
      return (await store.list()).map((project) => ({
        id: project.id,
        dir: project.path,
        title: project.name,
      }));
    },
    resolveProject,
    // The editor's undo, redo, and restore are the owner's, and can remove sent review notes.
    history: async (project) => {
      const history = await store.historyForDir(project.dir);
      return (
        history &&
        reviews.history(await store.get(project.id), history, { kind: "human" })
      );
    },
    async bundle(dir, options) {
      return (
        await bundleToSingleHtml(dir, { ...PREVIEW_BUNDLE_OPTIONS, ...options })
      ).replace(
        'data-hyperframes-preview-runtime="1" src=""',
        'data-hyperframes-preview-runtime="1" src="/api/runtime.js"',
      );
    },
    transformPreviewHtml: async ({ html, project, activeCompositionPath }) => {
      const currentProject = await store.get(project.id);
      for (const source of await readTrackMix(store, currentProject))
        html = mixCompositionInstances(
          html,
          source.settings,
          source.composition,
          activeCompositionPath,
          source.lengths,
        );
      const source = await readSource(currentProject, activeCompositionPath);
      const scope = compositionScope(activeCompositionPath);
      const { lengths } = await mediaFacts(
        currentProject,
        activeCompositionPath,
        mediaSources(source.content, scope),
      );
      const document = await store.document(currentProject);
      html = mixCompositionInstances(
        html,
        document.timelines[activeCompositionPath] ?? emptyTimelineSettings(),
        activeCompositionPath,
        activeCompositionPath,
        lengths,
      );
      return injectDeterministicFontFaces(
        withPreviewClipIdentities(html, source.content, scope, lengths),
      );
    },
    async getProjectSignature(dir) {
      // Closed projects have no watcher to invalidate cached signatures.
      if (!watchers.has(dir)) return createProjectSignatureAsync(dir);
      let signature = signatures.get(dir);
      if (!signature) {
        signature = createProjectSignatureAsync(dir).catch((error: unknown) => {
          signatures.delete(dir);
          throw error;
        });
        signatures.set(dir, signature);
      }
      return signature;
    },
    invalidateProjectSignature: (dir) => {
      signatures.delete(dir);
    },
    lint: (html, options) =>
      lintHyperframeHtml(html, { ...options, host: "studio" }),
    lintProject: (dir) => lintProject(dir, undefined, { host: "studio" }),
    runtimeUrl: "/api/runtime.js",
    gsapLocalRoot: "/api/vendor/npm",
    rendersDir: (project) => join(project.dir, ".cutroom", "renders"),
    generateThumbnail: (options) =>
      thumbnails.capture({
        ...options,
        previewUrl: isolatedPreview(options.project.id, options.previewUrl),
      }),
    startRender: (options) => renders.start(options, exportRequest.getStore()),
  };

  api.get("/projects/:id/isolated-preview", async (c) => {
    const id = c.req.param("id");
    if (!(await resolveProject(id))) return c.notFound();
    const url = new URL(c.req.url);
    url.pathname = `/api/projects/${encodeURIComponent(id)}/preview`;
    return c.redirect(isolatedPreview(id, url.href));
  });
  api.get("/isolated/:key/*", async (c) => {
    const key = c.req.param("key");
    const projectId = [...previewKeys].find(([, value]) => value === key)?.[0];
    if (!projectId) return c.notFound();
    const prefix = `/api/isolated/${key}/`;
    const url = new URL(c.req.url);
    const path = url.pathname.slice(prefix.length);
    let target =
      path === "runtime.js" || path.startsWith("vendor/npm/")
        ? `/${path}`
        : path === "preview" || path.startsWith("preview/")
          ? `/projects/${encodeURIComponent(projectId)}/${path}`
          : null;
    if (!target) return c.notFound();
    let response: Response;
    let activeCompositionPath = "index.html";
    let assetContentType: string | undefined;
    try {
      if (path.startsWith("preview/")) {
        const project = await store.get(projectId);
        const composition = path.startsWith("preview/comp/");
        const file = requestSubPath(
          c.req.url,
          composition ? "isolated/:key/preview/comp" : "isolated/:key/preview",
        );
        if (composition) activeCompositionPath = file;
        const canonical = await projectPath(project, file);
        const asset = relative(project.path, canonical)
          .split(sep)
          .map(encodeURIComponent)
          .join("/");
        target = `/projects/${encodeURIComponent(projectId)}/preview/${composition ? "comp/" : ""}${asset}`;
        if (!composition && !url.searchParams.has("hf-proxy"))
          assetContentType = getMimeType(file);
      }
      response = await api.request(`${url.origin}${target}${url.search}`, {
        headers: c.req.raw.headers,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      response = c.text(error.message, error.status);
    }
    const headers = new Headers(response.headers);
    if (response.ok && assetContentType)
      headers.set("Content-Type", assetContentType);
    headers.set(
      "Content-Security-Policy",
      previewPolicy(`${url.origin}${prefix}`),
    );
    headers.set(
      "Connection-Allowlist",
      `(${JSON.stringify(`${url.origin}${prefix}*`)})`,
    );
    headers.set("X-DNS-Prefetch-Control", "off");
    headers.set("Access-Control-Allow-Origin", "null");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    if (!headers.get("content-type")?.includes("text/html"))
      return new Response(response.body, { status: response.status, headers });
    const html = (await response.text())
      .replaceAll(
        `/api/projects/${encodeURIComponent(projectId)}/preview/`,
        `${prefix}preview/`,
      )
      .replaceAll("/api/runtime.js", `${prefix}runtime.js`)
      .replaceAll("/api/vendor/npm/", `${prefix}vendor/npm/`);
    const mix = trackGainPreview(html, activeCompositionPath);
    if (url.searchParams.get("cutroom-mix") === "1") {
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify(mix), {
        status: response.status,
        headers,
      });
    }
    // The HTTP CSP applies before any authored markup, including malformed documents.
    return new Response(
      withPreviewBridge(html, activeCompositionPath, mix.signature),
      {
        status: response.status,
        headers,
      },
    );
  });

  api.get("/runtime.js", (c) =>
    c.body(previewRuntimeScript(), 200, {
      "content-type": "application/javascript",
      "cache-control": "public, max-age=3600",
    }),
  );
  const gsapRoot = dirname(
    fileURLToPath(import.meta.resolve("gsap/package.json")),
  );
  api.get("/vendor/npm/:version/dist/:file", async (c) => {
    const version = c.req.param("version");
    const file = c.req.param("file");
    if (!/^gsap@3\.[\d.]+$/.test(version) || !/^[\w.-]+\.js$/.test(file))
      return c.notFound();
    const asset = Bun.file(join(gsapRoot, "dist", file));
    if (!(await asset.exists())) return c.notFound();
    return new Response(asset, {
      headers: {
        "content-type": "application/javascript",
        "cache-control": "public, max-age=86400",
      },
    });
  });
  api.get("/environment/ffmpeg", (c) =>
    c.json(
      Bun.which("ffmpeg")
        ? { ok: true }
        : {
            ok: false,
            title: "FFmpeg not found",
            hint: "Install FFmpeg to export video locally.",
          },
    ),
  );
  api.get("/telemetry-identity", (c) => c.json({ distinctId: null }));
  api.post("/telemetry", (c) => c.body(null, 204));
  api.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const listener = (change: FileChange) => {
        void stream
          .writeSSE({ event: "file-change", data: JSON.stringify(change) })
          .catch(() => {});
      };
      subscribers.add(listener);
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        if (!stream.aborted)
          await new Promise<void>((done) => stream.onAbort(done));
      } finally {
        subscribers.delete(listener);
      }
    }),
  );
  // Studio's listing feeds the Media panel, Assets, and the code tree. Dot folders hold app
  // state such as Cutroom's review captures, so they are hidden here like everywhere else,
  // and so are the files Remove moved to the project's trash.
  api.get("/projects/:id", async (c, next) => {
    await next();
    if (!c.res.ok) return;
    const listing = z
      .looseObject({ files: z.array(z.string()) })
      .parse(await c.res.json());
    const files = listing.files.filter(
      (file) =>
        !file.split("/").some((part) => part.startsWith(".")) &&
        !inMediaTrash(file),
    );
    const project = await store.get(c.req.param("id"));
    const fileVersions = Object.fromEntries(
      await Promise.all(
        files.map(async (path) => {
          const info = await projectPath(project, path)
            .then((absolute) => stat(absolute))
            .catch((error: unknown) => {
              if (
                isMissing(error) ||
                (error instanceof HttpError &&
                  [403, 404].includes(error.status))
              )
                return null;
              throw error;
            });
          return [path, info?.isFile() ? fileFingerprint(path, info) : null];
        }),
      ),
    );
    c.res = c.json({ ...listing, files, fileVersions });
  });
  api.get("/render/:jobId/download", async (c, next) => {
    await next();
    const filename = c.req.query("filename");
    if (!c.res.ok || !filename) return;
    // A response filename takes precedence over the link's download attribute.
    const encoded = encodeURIComponent(filename).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    c.header("Content-Disposition", `attachment; filename*=UTF-8''${encoded}`);
  });
  const snapshot = (job: NonNullable<ReturnType<typeof renders.get>>) => ({
    jobId: job.id,
    projectId: job.projectId,
    name: job.name,
    status: job.status,
    progress: job.progress,
    stage: job.stage ?? "Preparing",
    stageProgress: job.stageProgress,
    estimate: job.estimate,
    outputPath: job.outputPath,
    sizeBytes: job.sizeBytes ?? null,
    audioLoweredDb: job.audioLoweredDb,
    error: job.error ?? null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    fps: job.fps,
    quality: job.quality,
    range: job.range,
  });
  // One export runs at a time across projects, so any editor can find and control it.
  api.get("/export-jobs", (c) => {
    c.header("Cache-Control", "no-store");
    const job = renders.active();
    return c.json({ jobs: job ? [snapshot(job)] : [] });
  });
  api.get("/render/:jobId", (c) => {
    const job = renders.get(c.req.param("jobId"));
    if (!job) throw new HttpError(404, "Export job not found.");
    c.header("Cache-Control", "no-store");
    return c.json(snapshot(job));
  });
  api.post("/render/:jobId/cancel", async (c) => {
    const job = renders.get(c.req.param("jobId"));
    reviews.authorize(c.req.header(AGENT_HEADER), job?.projectId);
    if (!job) throw new HttpError(404, "Export job not found.");
    await job.cancel();
    return c.json(snapshot(job));
  });
  // Studio's stream serializes only its own fields. Keep its jobs and controls,
  // and include the producer's stage counts while our worker is running.
  api.get("/render/:jobId/progress", (c, next) => {
    const job = renders.get(c.req.param("jobId"));
    if (!job) return next();
    return streamSSE(c, async (stream) => {
      while (!stream.aborted) {
        await stream.writeSSE({
          event: "progress",
          data: JSON.stringify({
            progress: job.progress,
            status: job.status,
            stage: job.stage,
            stageProgress: job.stageProgress,
            error: job.error,
            ...(job.status === "complete" && {
              audioLoweredDb: job.audioLoweredDb,
              sizeBytes: job.sizeBytes,
            }),
          }),
        });
        if (job.status !== "rendering") break;
        await stream.sleep(500);
      }
    });
  });
  api.route("/", createStudioApi(adapter));
  return Object.assign(api, {
    subscribeExports(
      projectId: string,
      listener: (job: ReturnType<typeof snapshot>) => void,
    ) {
      let current = renders.active();
      if (current?.projectId !== projectId) current = undefined;
      const notify = (job: NonNullable<ReturnType<typeof renders.get>>) => {
        if (job.projectId !== projectId) return;
        current = job;
        listener(snapshot(job));
      };
      const stop = renders.subscribe(notify);
      if (current) notify(current);
      // Share progress with the project connection rather than consuming another HTTP slot per tab.
      const timer = setInterval(() => {
        if (!current) return;
        listener(snapshot(current));
        if (current.status !== "rendering") current = undefined;
      }, 500);
      return () => {
        clearInterval(timer);
        stop();
      };
    },
    async subscribe(projectId: string, listener: (change: FileChange) => void) {
      const project = await store.get(projectId);
      if (disposed) throw new HttpError(503, "The editor is shutting down.");
      const notify = (change: FileChange) => {
        if (change.projectId === projectId) listener(change);
      };
      let entry = watchers.get(project.path);
      if (!entry) {
        entry = {
          users: 0,
          ready: watchProject({
            id: project.id,
            dir: project.path,
            title: project.name,
          }),
        };
        watchers.set(project.path, entry);
      }
      const shared = entry;
      shared.users++;
      const release = () => {
        if (--shared.users) return;
        watchers.delete(project.path);
        signatures.delete(project.path);
        for (const [key, timer] of timers) {
          if (!key.startsWith(`${projectId}\0`)) continue;
          clearTimeout(timer);
          timers.delete(key);
        }
      };
      let watcher: ReturnType<typeof watch>;
      try {
        watcher = await shared.ready;
      } catch (error) {
        release();
        throw error;
      }
      subscribers.add(notify);
      return () => {
        if (!subscribers.delete(notify)) return;
        release();
        if (!shared.users) watcher.close();
      };
    },
    async dispose() {
      disposed = true;
      const opened = await Promise.allSettled(
        [...watchers.values()].map((entry) => entry.ready),
      );
      for (const result of opened)
        if (result.status === "fulfilled") result.value.close();
      for (const timer of timers.values()) clearTimeout(timer);
      watchers.clear();
      timers.clear();
      await renders.cancelAll();
      await thumbnails.close();
    },
  });
}
