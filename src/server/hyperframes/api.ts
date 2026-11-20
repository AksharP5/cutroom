import {
  fileFingerprint,
  inMediaTrash,
  isFreezeExport,
  isMediaItem,
  localMediaPath,
} from "../../shared/media";
import { PROJECT_DOCUMENT_PATH } from "../../shared/project";
import { AGENT_HEADER } from "../../shared/review";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  defaultExportRange,
  compositionExportName,
  exportFilename,
  exportFps,
  exportRange,
  exportSize,
  ExportFormatSchema,
  ExportOptionsSchema,
  ExportStartSchema,
  retimeFrames,
  StillFrameRequestSchema,
  StillRequestSchema,
} from "../../shared/export";
import { projectMutationGuard } from "../projects/authorization";
import { sourceWriteGuard } from "./source-guard";
import { projectStatePath, unavailableProjectFile } from "../projects/path";
import { checkProjectVariableValues } from "../projects/variables";
import { rebasePreviewSceneSources } from "../projects/sceneSources";
import { watch } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { injectDeterministicFontFaces } from "@hyperframes/core/fonts/embed";
import { previewRuntimeScript } from "./previewRuntime";
import { AUDITION_PARAM, auditionDocument } from "./audition";
import {
  rebaseCompiledImageVariables,
  rebaseImageOverrides,
  rebaseSceneImageDeclarations,
} from "./imageVariables";
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
  registerRenderOutput,
  requestSubPath,
} from "@hyperframes/studio-server";
import type {
  ResolvedProject,
  StudioApiAdapter,
  createPreviewDocumentStore,
} from "@hyperframes/studio-server";
import type { ProjectStore } from "../projects/store";
import {
  ProjectDocumentError,
  isMissing,
  projectPath,
  readSource,
} from "../projects/store";
import type { ReviewService } from "../projects/review";
import { HttpError } from "../../shared/errors";
import {
  createThumbnailRenderer,
  thumbnailRendererVersion,
} from "./thumbnails";
import { STAGING_PREFIX, createRenderWorkers } from "./jobs";
import { createRenderIndex } from "./renders";
import type { ExportRequest } from "./jobs";
import { measureLoudness } from "../timeline/audio";
import { probeNvenc } from "./nvenc";
import { nextExportName } from "./exportName";
import { exportResolve } from "../resolve/export";
import { layerHtml, layerSources } from "../resolve/layers";
import { previewPolicy } from "./isolation";
import { APP_STATE_DIR, previewTimingPolicy } from "./previewTimingPolicy";
import {
  previewDependencies,
  previewSourceTiming,
  updatePreviewSourceTiming,
} from "./previewTiming";
import type { PreviewTiming, TrackGainPreview } from "../../shared/preview";
import { previewDocument, withPreviewClipIdentities } from "./previewBridge";
import { readTrackMix, trackMixStamp } from "../timeline/mix";
import {
  compositionScope,
  mixCompositionInstances,
  parseComposition,
  mediaSources,
  sourceVariables,
} from "../timeline/composition";
import { mediaFacts, missingMediaPaths } from "../timeline/media";
import {
  VariableError,
  VariableValuesSchema,
  variableDefaultValue,
} from "../../shared/variables";
import type { VariableValues } from "../../shared/variables";
import {
  emptyTimelineSettings,
  isAudioKind,
} from "../../shared/timeline/schema";
import { trackGainPreview } from "./trackGainPreview";
import { prepareRampPreview } from "./rampPreview";
import { frameTime } from "../../shared/timeline/apply";
import { formatTimecode } from "../../shared/timeline/timecode";
import { parseFps } from "@hyperframes/core";
import {
  PROXY_PIECE_PARAM,
  framesOf,
  proxyExposedHeaders,
  proxyPreview,
  proxySamplesPreview,
  scrubPreview,
} from "../media/routes";
import type { MediaService } from "../media/service";

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

function scheduleFileSettle(_path: string, read: () => Promise<void>) {
  const timer = setTimeout(() => void read(), 60);
  return () => clearTimeout(timer);
}

/** `reviews` must be the server's one review service, so editor undo shares its per-project queue. */
export function createHyperframesApi(
  store: ProjectStore,
  reviews: ReviewService,
  /** Serves scrub proxies to the preview; without it the preview always seeks its sources. */
  media?: MediaService,
  scheduleSettle = scheduleFileSettle,
) {
  const api = new Hono();
  api.use("/projects/:id/thumbnail/*", async (c, next) => {
    const url = new URL(c.req.url);
    const time = Number.parseFloat(url.searchParams.get("t") ?? "");
    // Studio rounds time in its disk cache key. Include the exact seek in its version key so
    // nearby captures cannot reuse the wrong side of a cut, even with the cache already warm.
    // Keep the previous minimum key length for Studio's atomic cache filenames.
    const version = createHash("sha256")
      .update(
        JSON.stringify([
          thumbnailRendererVersion,
          url.searchParams.get("v") ?? "",
          Number.isFinite(time) ? time : 0.5,
        ]),
      )
      .digest("base64url")
      .slice(0, 22);
    url.searchParams.set("v", version);
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
  // Bound to a parent-owned navigation, never to a claim made by composition code.
  const timingDocuments = new Map<
    string,
    {
      projectId: string;
      allowed: boolean;
      ramp?: Pick<
        NonNullable<Awaited<ReturnType<typeof prepareRampPreview>>>,
        "assets" | "pending"
      >;
    }
  >();
  const sourceTimings = new Map<
    string,
    {
      ids: ReadonlySet<string>;
      dependencies: string;
      mixStamp: string;
      authored: PreviewTiming;
      compiled: PreviewTiming;
      mix: TrackGainPreview;
    }
  >();
  // Keep the compiler's decision outside authored HTML. The upstream cache's write
  // hook supplies the final, stable response bytes, including all augmentations.
  type TimingBuild = { allowed?: boolean; signature?: string };
  const timingBuild = new AsyncLocalStorage<TimingBuild>();
  const timingPolicies = new Set<string>();
  const eligiblePreviews = new Set<string>();
  const previewContext: MiddlewareHandler = (_c, next) =>
    timingBuild.getStore() ? next() : timingBuild.run({}, next);
  api.use("/projects/:id/preview", previewContext);
  api.use("/projects/:id/preview/*", previewContext);
  // Upstream signs the project, then compiles. A body compiled from files that changed in
  // between must not carry the older signature's ETag: after an undo back to that version,
  // a browser revalidating with it would get a 304 and keep showing the newer picture.
  const unstampStaleCompile: MiddlewareHandler = async (c, next) => {
    await next();
    const signed = timingBuild.getStore()?.signature;
    if (c.res.status !== 200 || !signed || !c.res.headers.has("ETag")) return;
    const project = await store.get(c.req.param("id") ?? "");
    if ((await createProjectSignatureAsync(project.path)) === signed) return;
    c.res.headers.delete("ETag");
    c.res.headers.set("Cache-Control", "no-store");
  };
  api.use("/projects/:id/preview", unstampStaleCompile);
  api.use("/projects/:id/preview/comp/*", unstampStaleCompile);
  api.use("/projects/:id/preview/*", async (c, next) => {
    if (c.req.method !== "GET") return next();
    const composition = requestSubPath(c.req.url, "projects/:id/preview");
    if (composition.startsWith("comp/") || !/\.html?$/i.test(composition))
      return next();
    // Studio's raw .htm validator only tracks the source file. A scene or image can
    // resolve differently when a sibling file appears without editing this file.
    const ifNoneMatch = c.req.header("Range")
      ? undefined
      : c.req.header("If-None-Match");
    if (ifNoneMatch) {
      const headers = new Headers(c.req.raw.headers);
      headers.delete("If-None-Match");
      c.req.raw = new Request(c.req.url, { headers, signal: c.req.raw.signal });
    }
    await next();
    if (c.res.status !== 200) return;
    let rewritten: string | undefined;
    if (!c.res.headers.has("Content-Encoding")) {
      const html = await c.res.clone().text();
      const { path } = await store.get(c.req.param("id"));
      const rebased = rebasePreviewSceneSources(
        rebaseSceneImageDeclarations(html, path, composition),
        path,
        composition,
      );
      if (rebased !== html) rewritten = rebased;
    }
    if (rewritten === undefined) {
      if (!ifNoneMatch || ifNoneMatch !== c.res.headers.get("ETag")) return;
      c.res = new Response(null, { status: 304 });
    } else {
      c.res = new Response(rewritten, c.res);
      c.res.headers.delete("ETag");
      c.res.headers.delete("Last-Modified");
      c.res.headers.set("Cache-Control", "no-store");
    }
    c.res.headers.delete("Content-Length");
    c.res.headers.delete("Accept-Ranges");
  });
  api.use("/projects/:id/preview/comp/*", async (c, next) => {
    const raw = c.req.query("variables");
    if (!raw) return next();
    let values: unknown;
    try {
      values = JSON.parse(raw);
    } catch {
      return next(); // Studio reports malformed JSON.
    }
    const overrides = z.record(z.string(), z.unknown()).safeParse(values);
    if (!overrides.success) return next();
    const project = await store.get(c.req.param("id"));
    const composition = requestSubPath(c.req.url, "projects/:id/preview/comp");
    const rebased = rebaseImageOverrides(
      project.path,
      composition,
      overrides.data,
    );
    if (rebased === overrides.data) return next();
    const url = new URL(c.req.url);
    url.searchParams.set("variables", JSON.stringify(rebased));
    c.req.raw = new Request(url, c.req.raw);
    return next();
  });
  const subscribers = new Set<(change: FileChange) => void>();
  const watchers = new Map<
    string,
    { users: number; ready: Promise<ReturnType<typeof watch>> }
  >();
  let disposed = false;
  const pendingSettles = new Map<string, () => void>();
  const announced = new Map<string, string>();
  /** Per file: reads started, the newest read announced, and the announcements in order. */
  const reads = new Map<
    string,
    { started: number; announced: number; queue: Promise<void> }
  >();
  const signatures = new Map<string, Promise<string>>();
  const thumbnails = createThumbnailRenderer();
  const renderIndex = createRenderIndex();
  const renders = createRenderWorkers({
    scratchDir: join(store.dataDir, "scratch"),
    gpu:
      process.env.CUTROOM_EXPORT_GPU === "0"
        ? undefined
        : () =>
            probeNvenc().then((works) => {
              console.info(
                works
                  ? "Exports drawn from their sources encode with NVENC."
                  : "No working NVENC encoder, so exports encode with libx264.",
              );
              return works;
            }),
    frameCache: {
      dir: join(store.dataDir, "cache", "frames"),
      maxBytes: 2 * 1024 ** 3,
    },
    workload: async (id, composition) => {
      const { timeline } = await readComposition(id, composition);
      return {
        mediaClips: timeline.clips.filter(
          (clip) => clip.kind === "video" || isAudioKind(clip.kind),
        ).length,
        durationFrames: timeline.duration,
      };
    },
    published: async (id, path) =>
      renderIndex.record(await store.get(id), path),
    sourceOverrides: async (id) => ({
      ...Object.fromEntries(
        (await readTrackMix(store, await store.get(id))).map(
          ({ path, html }) => [path, html],
        ),
      ),
      ...layerSources.getStore(),
    }),
  });
  const exportRequest = new AsyncLocalStorage<ExportRequest>();
  /** A composition's timeline and frame size, as the editor reads them, for an export. */
  const readComposition = async (projectId: string, composition: string) => {
    const project = await store.get(projectId);
    const [source, document] = await Promise.all([
      readSource(project, composition),
      store.document(project),
    ]);
    const scope = compositionScope(composition);
    const { lengths } = await mediaFacts(
      project,
      composition,
      mediaSources(source.content, scope),
    );
    const parsed = parseComposition(
      source.content,
      document.timelines[composition] ?? emptyTimelineSettings(),
      { scope, mediaLengths: lengths },
    );
    const { timeline, root } = parsed;
    // The preview and frame capture render a composition without a size at 1920 x 1080.
    const size = (name: string, fallback: number) => {
      const pixels = Math.floor(Number(root.attrs[name]));
      return Number.isSafeInteger(pixels) && pixels > 0 ? pixels : fallback;
    };
    let declared:
      ReturnType<typeof sourceVariables>["declarations"] | undefined;
    const declarations = () =>
      (declared ??= sourceVariables(source.content, scope).declarations);
    /** Overrides for this composition's declarations, without those that equal a default. */
    const variables = async (values: VariableValues | undefined) => {
      if (!values) return undefined;
      try {
        return await checkProjectVariableValues(
          project,
          composition,
          values,
          declarations(),
        );
      } catch (error) {
        if (error instanceof VariableError)
          throw new HttpError(422, error.message);
        throw error;
      }
    };
    return {
      parsed,
      timeline,
      size: {
        width: size("data-width", 1920),
        height: size("data-height", 1080),
      },
      variables,
      declarations,
    };
  };
  /** A composition named by a caller, as the project path the timeline routes use. */
  const exportedComposition = (requested: string | undefined) => {
    const composition = posix
      .normalize(requested ?? "index.html")
      .replace(/^\/+/, "");
    if (composition === ".." || composition.startsWith("../"))
      throw new HttpError(400, "The composition must be inside the project.");
    return composition;
  };
  api.post("/projects/:id/export", async (c) => {
    const input = ExportStartSchema.parse(await c.req.json());
    const project = await store.get(c.req.param("id"));
    const composition = exportedComposition(input.composition);
    const { timeline, size, variables, declarations, parsed } =
      await readComposition(project.id, composition);
    const overrides = await variables(input.variables);
    const { format } = input;
    if (format === "resolve") {
      if (input.filename)
        throw new HttpError(
          400,
          "A Resolve export is a folder named after the project; leave out filename.",
        );
      const images = new Map<string, string>();
      for (const variable of declarations()) {
        if (variable.type !== "image") continue;
        const value =
          overrides?.[variable.id] ?? variableDefaultValue(variable);
        if (typeof value === "string" && value) images.set(variable.id, value);
      }
      return c.json(
        await exportResolve(
          {
            project,
            composition,
            name: compositionExportName(project.name, composition),
            timeline,
            size,
            images,
          },
          {
            directory: input.directory,
            copyMedia: input.copyMedia,
            // Each layer is an ordinary MOV render job, so the editor shows its progress.
            render: async (layer, output) => {
              const started = await layerSources.run(
                {
                  [resolve(project.path, composition)]: layerHtml(
                    parsed,
                    layer,
                  ),
                },
                () =>
                  api.request(
                    new URL(
                      `/projects/${encodeURIComponent(project.id)}/render`,
                      c.req.url,
                    ),
                    {
                      method: "POST",
                      headers: c.req.raw.headers,
                      body: JSON.stringify({
                        format: "mov",
                        quality: "high",
                        fps: `${timeline.fps.num}/${timeline.fps.den}`,
                        ...(composition !== "index.html" && { composition }),
                        ...(overrides &&
                          Object.keys(overrides).length && {
                            variables: overrides,
                          }),
                        cutroom: {
                          ...output,
                          range: { start: layer.start, end: layer.end },
                          gpu: false,
                        },
                      }),
                    },
                  ),
              );
              if (!started.ok)
                throw new HttpError(
                  started.status === 409 ? 409 : 500,
                  await started.text(),
                );
              const { jobId, outputPath } = z
                .object({ jobId: z.string(), outputPath: z.string() })
                .parse(await started.json());
              for (;;) {
                await Bun.sleep(500);
                const job = renders.get(jobId);
                if (!job) continue;
                const { status, error } = snapshot(job);
                if (status === "complete") return outputPath;
                if (status !== "rendering")
                  throw new HttpError(
                    500,
                    `The ${output.filename} layer did not render: ${error ?? status}.`,
                  );
              }
            },
          },
        ),
      );
    }
    const output = exportSize(input.size, size);
    if ("problem" in output) throw new HttpError(400, output.problem);
    const fps = exportFps(
      format,
      input.fps ? { num: input.fps, den: 1 } : timeline.fps,
    );
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
      (await nextExportName(
        directory,
        exportFilename(
          compositionExportName(project.name, composition),
          format,
        ),
      ));
    // Enter the dialog's route with the caller's identity. It owns destination validation and registration.
    return api.request(
      new URL(`/projects/${encodeURIComponent(project.id)}/render`, c.req.url),
      {
        method: "POST",
        headers: c.req.raw.headers,
        body: JSON.stringify({
          format,
          gifLoop: format === "gif" ? input.gifLoop : undefined,
          quality: input.quality,
          fps: `${fps.num}/${fps.den}`,
          ...(output.resolution && { resolution: output.resolution }),
          ...(composition !== "index.html" && { composition }),
          ...(overrides &&
            Object.keys(overrides).length && { variables: overrides }),
          cutroom: {
            directory,
            filename,
            range: choice === "timeline" ? null : frames,
            gpu: input.gpu,
          },
        }),
      },
    );
  });
  // A still is the review-note frame capture, kept beside the project's exports.
  api.post("/projects/:id/still", async (c) => {
    const input = z
      .union([StillFrameRequestSchema, StillRequestSchema])
      .parse(await c.req.json());
    const project = await store.get(c.req.param("id"));
    const composition = exportedComposition(input.composition);
    let time: number;
    let timecode: string;
    if ("frame" in input) {
      const { timeline } = await readComposition(project.id, composition);
      if (input.frame >= timeline.duration)
        throw new HttpError(400, "Choose a frame inside the composition.");
      time = frameTime(input.frame, timeline.fps);
      timecode = formatTimecode(input.frame, timeline.fps);
    } else {
      ({ time, timecode } = input);
    }
    const frame = await api.request(
      new URL(
        `/projects/${encodeURIComponent(project.id)}/thumbnail/${encodeURIComponent(composition)}?${new URLSearchParams({ t: String(time), format: "png", output: "source" })}`,
        c.req.url,
      ),
      { headers: c.req.raw.headers },
    );
    if (!frame.ok)
      throw new HttpError(
        frame.status === 404 ? 404 : 500,
        `The frame could not be captured: ${await frame.text()}`,
      );
    const directory = await projectStatePath(project, ".cutroom/renders", true);
    await mkdir(directory, { recursive: true });
    const name = exportFilename(project.name).replace(
      /\.mp4$/,
      ` ${timecode.replaceAll(":", "-")}.png`,
    );
    const png = new Uint8Array(await frame.arrayBuffer());
    for (;;) {
      const filename = await nextExportName(directory, name);
      const path = join(directory, filename);
      try {
        await writeFile(path, png, { flag: "wx" });
        return c.json({ path, filename });
      } catch (error) {
        // Two clients can capture the same frame together. Retry the name, not the render.
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
    }
  });
  // Extend Studio's one job registry, progress stream and cancel route with Cutroom's output intent.
  api.use("/projects/:id/render", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const body = await c.req.json<unknown>().catch(() => ({}));
    const { cutroom } = z
      .object({ cutroom: ExportOptionsSchema.optional() })
      .parse(body);
    if (!cutroom) return next();
    const request = z
      .object({
        format: ExportFormatSchema,
        fps: z.union([z.string(), z.number()]),
        resolution: z.string().optional(),
        composition: z.string().optional(),
      })
      .safeParse(body);
    if (!request.success)
      throw new HttpError(
        400,
        "Named exports choose MP4, MOV, WebM or GIF, and a frame rate.",
      );
    const { format, composition, resolution } = request.data;
    if (extname(cutroom.filename).slice(1).toLowerCase() !== format)
      throw new HttpError(
        400,
        `Name a ${format.toUpperCase()} export with .${format}.`,
      );
    if (!isAbsolute(cutroom.directory))
      throw new HttpError(400, "Enter an absolute output folder.");
    const project = await store.get(c.req.param("id"));
    const source = exportedComposition(composition);
    const {
      timeline,
      size: composed,
      variables,
      declarations,
    } = await readComposition(project.id, source);
    // Every override must fit its declaration; the render route only checks that they are an object.
    const overrides = z
      .object({ variables: VariableValuesSchema.optional() })
      .safeParse(body);
    if (!overrides.success)
      throw new HttpError(
        400,
        overrides.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
    const values = await variables(overrides.data.variables);
    const imageSources = new Map<string, string>();
    if (timeline.clips.some((clip) => clip.variableBindings?.image))
      for (const variable of declarations()) {
        if (variable.type !== "image") continue;
        const value = values?.[variable.id] ?? variableDefaultValue(variable);
        if (typeof value === "string" && value)
          imageSources.set(variable.id, value);
      }
    const offline = await missingMediaPaths(
      project,
      source,
      timeline.clips.flatMap((clip) => {
        if (!clip.enabled || clip.kind === "composition") return [];
        const image = clip.variableBindings?.image;
        const src = (image ? imageSources.get(image) : undefined) ?? clip.src;
        return src ? [src] : [];
      }),
    );
    if (offline.length)
      throw new HttpError(
        422,
        `Restore these offline files before exporting: ${offline.join(", ")}.`,
      );
    const rate = parseFps(request.data.fps);
    if (!rate.ok) throw new HttpError(400, "Choose a valid frame rate.");
    // The render route plays GIF at 30 fps at most; the range follows the rate it renders.
    const fps = exportFps(format, rate.value);
    const size = (["project", "1080p", "4k"] as const)
      .map((choice) => exportSize(choice, composed))
      .find((size) => !("problem" in size) && size.resolution === resolution);
    if (!size || "problem" in size)
      throw new HttpError(
        400,
        `${resolution} doesn't fit this ${composed.width} × ${composed.height} composition. Choose its own size, 1080p or 4K.`,
      );
    if (cutroom.range && cutroom.range.end > timeline.duration)
      throw new HttpError(400, "In and Out must be inside the timeline.");
    const range =
      cutroom.range && retimeFrames(cutroom.range, timeline.fps, fps);
    if (range && range.end <= range.start)
      throw new HttpError(
        400,
        `In to Out is shorter than one frame at ${Number((fps.num / fps.den).toFixed(3))} fps.`,
      );
    const defaultDirectory = await projectStatePath(
      project,
      ".cutroom/renders",
      true,
    );
    if (cutroom.directory === defaultDirectory)
      await mkdir(defaultDirectory, { recursive: true });
    const directory = await realpath(cutroom.directory);
    await exportRequest.run(
      {
        ...cutroom,
        directory,
        range,
        size: { width: size.width, height: size.height },
        retimed: fps.num * timeline.fps.den !== timeline.fps.num * fps.den,
      },
      next,
    );
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
    const current = await store.get(project.id);
    await reviews.observeAssets(current);
    const readMix = () =>
      store.document(current).then(trackMixStamp, (error: unknown) => {
        if (!(error instanceof ProjectDocumentError)) throw error;
      });
    let mix = await readMix();
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
        const absolute = join(project.dir, path);
        const read = async () => {
          const order = reads.get(key) ?? {
            started: 0,
            announced: 0,
            queue: Promise.resolve(),
          };
          reads.set(key, order);
          const sequence = ++order.started;
          try {
            const info = await stat(absolute);
            if (!info.isFile() || info.size > 2_000_000)
              return { sequence, version: null, content: undefined };
            const bytes = await readFile(absolute);
            return {
              sequence,
              version: fileContentVersion(bytes),
              content: /\.(html?|css|m?[jt]sx?|json|srt|vtt)$/i.test(path)
                ? bytes.toString("utf8")
                : undefined,
            };
          } catch (error) {
            if (isMissing(error))
              return { sequence, version: null, content: undefined };
            throw error;
          }
        };
        // Two reads of one file can overlap, and announcing waits on review bookkeeping, so
        // announcements run one at a time and a read older than one already announced is dropped.
        const announce = (file: Awaited<ReturnType<typeof read>>) => {
          const order = reads.get(key);
          // The last tab closed while this file was being read.
          if (!order) return Promise.resolve();
          const run = order.queue.then(() => {
            if (file.sequence < order.announced) return;
            order.announced = file.sequence;
            return deliver(file);
          });
          // A failed announcement is reported by its caller and must not stop later ones.
          order.queue = run.catch(() => {});
          return run;
        };
        const deliver = async ({
          version,
          content,
        }: Awaited<ReturnType<typeof read>>) => {
          // Both paths below can see one write. Each version is announced once.
          if (version !== null && announced.get(key) === version) return;
          if (version === null) announced.delete(key);
          else announced.set(key, version);
          const receipt = identifyFileWrite(
            absolute,
            version ?? DELETED_VERSION,
          );
          let mixChanged = false;
          if (path === PROJECT_DOCUMENT_PATH) {
            const next = await readMix();
            if (next !== undefined) {
              mixChanged = next !== mix;
              mix = next;
            }
          }
          const affects = mixChanged || affectsPreview(project.dir, path);
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
          if (affects) await reviews.observeAssets(await store.get(project.id));
          for (const subscriber of subscribers) subscriber(change);
        };
        const failed = (error: unknown) =>
          console.error("Project watch failed:", error);
        // Outside editors can write a file in several steps, so wait for them to settle.
        pendingSettles.get(key)?.();
        pendingSettles.set(
          key,
          scheduleSettle(path, async () => {
            pendingSettles.delete(key);
            await read().then(announce).catch(failed);
          }),
        );
        // Cutroom's own writes are whole once their receipt exists, so they skip that wait.
        void read()
          .then((file) =>
            file.version !== null && identifyFileWrite(absolute, file.version)
              ? announce(file)
              : undefined,
          )
          .catch(failed);
      },
    );
    watcher.unref();
    watcher.on("error", (error) =>
      console.error(`Cannot watch ${project.title ?? project.id}:`, error),
    );
    return watcher;
  };

  // HyperFrames signs every project file it does not know to skip. Media caches written
  // during a compile would otherwise fail its post-compile check and withhold live timing.
  // The watcher and timing dependencies already treat app state as outside the preview.
  const unsignedAppState = new Map<string, Promise<void>>();
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
    let registered = unsignedAppState.get(project.path);
    if (!registered) {
      registered = registerRenderOutput(
        project.path,
        join(project.path, APP_STATE_DIR),
      ).catch((error: unknown) =>
        console.error(
          "Cannot exclude app state from the preview signature:",
          error,
        ),
      );
      unsignedAppState.set(project.path, registered);
    }
    await registered;
    const resolved = { id: project.id, dir: project.path, title: project.name };
    return resolved;
  };

  const adapter: StudioApiAdapter & {
    previewDocuments: ReturnType<typeof createPreviewDocumentStore>;
  } = {
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
      const policy = previewTimingPolicy(dir);
      const html = await bundleToSingleHtml(dir, {
        ...PREVIEW_BUNDLE_OPTIONS,
        ...options,
        onRead: (path) => {
          options?.onRead?.(path);
          policy.read(path);
        },
      });
      const build = timingBuild.getStore();
      if (build) {
        build.allowed = policy.contract() === "attributes";
        if (build.signature) {
          const key = `${dir}\0${build.signature}`;
          timingPolicies.delete(key);
          // The signature was taken before the compiler read the files; approve only if they did not change in between.
          if (
            build.allowed &&
            (await createProjectSignatureAsync(dir)) === build.signature
          ) {
            timingPolicies.add(key);
            if (timingPolicies.size > 64)
              timingPolicies.delete(timingPolicies.values().next().value!);
          }
        }
      }
      return html.replace(
        'data-hyperframes-preview-runtime="1" src=""',
        'data-hyperframes-preview-runtime="1" src="/api/runtime.js"',
      );
    },
    previewDocuments: {
      read: () => null,
      write: (_key, html) => {
        if (!timingBuild.getStore()?.allowed) return;
        eligiblePreviews.delete(html);
        eligiblePreviews.add(html);
        if (eligiblePreviews.size > 8)
          eligiblePreviews.delete(eligiblePreviews.values().next().value!);
      },
    },
    transformPreviewHtml: async ({ html, project, activeCompositionPath }) => {
      const currentProject = await store.get(project.id);
      if (activeCompositionPath !== "index.html")
        html = rebasePreviewSceneSources(
          html,
          project.dir,
          activeCompositionPath,
        );
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
        withPreviewClipIdentities(
          rebaseCompiledImageVariables(
            html,
            project.dir,
            activeCompositionPath,
          ),
          source.content,
          scope,
          lengths,
        ),
      );
    },
    async getProjectSignature(dir) {
      // Closed projects have no watcher to invalidate cached signatures.
      const watched = watchers.has(dir);
      let signature = watched ? signatures.get(dir) : undefined;
      if (!signature) {
        signature = createProjectSignatureAsync(dir).catch((error: unknown) => {
          signatures.delete(dir);
          throw error;
        });
        if (watched) signatures.set(dir, signature);
      }
      const value = await signature;
      const build = timingBuild.getStore();
      if (build) build.signature = value;
      return value;
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
    // A sub-composition previews as its own document, as Studio's drill-in does.
    const requested = url.searchParams.get("composition");
    url.searchParams.delete("composition");
    const composition =
      requested && posix.normalize(requested).replace(/^\/+/, "");
    if (composition && (composition === ".." || composition.startsWith("../")))
      throw new HttpError(400, "The composition must be inside the project.");
    url.pathname = `/api/projects/${encodeURIComponent(id)}/preview${
      composition && composition !== "index.html"
        ? `/comp/${composition.split("/").map(encodeURIComponent).join("/")}`
        : ""
    }`;
    return c.redirect(isolatedPreview(id, url.href));
  });
  // The runtime marks its editing proxy requests with a priority header, which needs a preflight.
  api.options("/isolated/:key/*", (c) => {
    if (![...previewKeys.values()].includes(c.req.param("key")))
      return c.notFound();
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "null",
        "Access-Control-Allow-Methods": "GET, HEAD",
        "Access-Control-Allow-Headers": "range, x-hf-proxy-priority",
        "Access-Control-Max-Age": "600",
      },
    });
  });
  api.get("/isolated/:key/*", async (c) => {
    const key = c.req.param("key");
    const projectId = [...previewKeys].find(([, value]) => value === key)?.[0];
    if (!projectId) return c.notFound();
    const prefix = `/api/isolated/${key}/`;
    const url = new URL(c.req.url);
    const path = url.pathname.slice(prefix.length);
    const isolate = (headers: Headers) => {
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
      headers.set("Access-Control-Expose-Headers", proxyExposedHeaders);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "no-referrer");
    };
    if (path === "frames") {
      const response = await framesOf(
        await store.get(projectId),
        url.searchParams.get("path") ?? undefined,
      ).then(
        (grid) =>
          Response.json(grid, { headers: { "cache-control": "no-store" } }),
        (error: unknown) => {
          if (error instanceof HttpError)
            return Response.json(
              { error: error.message },
              { status: error.status },
            );
          if (error instanceof z.ZodError)
            return Response.json(
              { error: "Choose a media path." },
              { status: 400 },
            );
          throw error;
        },
      );
      isolate(response.headers);
      return response;
    }
    if (media && path === "proxy-samples") {
      const response = await proxySamplesPreview(
        media,
        await store.get(projectId),
        url.searchParams,
      );
      isolate(response.headers);
      return response;
    }
    const rampFile = /^ramp-audio\/([a-f0-9]{64})\.wav$/.exec(path)?.[1];
    if (media && rampFile) {
      const project = await store.get(projectId);
      const file = await media
        .rampArtifact(project, rampFile)
        .catch(async (error: unknown) => {
          if (!(error instanceof HttpError) || error.status !== 404)
            throw error;
          for (const record of timingDocuments.values()) {
            const asset =
              record.projectId === projectId &&
              record.ramp?.assets.get(rampFile);
            if (!asset) continue;
            const prepared = await media.rampAudio(
              project,
              asset.path,
              asset.window,
            );
            if (
              prepared.key === rampFile &&
              (prepared.available || (await prepared.pending))
            )
              return media.rampArtifact(project, rampFile);
            break;
          }
          throw error;
        });
      const headers = new Headers({
        "Content-Type": "audio/wav",
        "Cache-Control": "private, max-age=31536000, immutable",
      });
      isolate(headers);
      return new Response(Bun.file(file), { headers });
    }
    if (media && (path === "scrub" || path.startsWith("scrub/"))) {
      // Returned as built, so Bun answers the video's byte-range requests from the file.
      const response = await scrubPreview(
        media,
        await store.get(projectId),
        path,
        url.searchParams.get("path"),
      );
      isolate(response.headers);
      return response;
    }
    let target =
      path === "runtime.js" || path.startsWith("vendor/npm/")
        ? `/${path}`
        : path === "preview" || path.startsWith("preview/")
          ? `/projects/${encodeURIComponent(projectId)}/${path}`
          : null;
    if (!target) return c.notFound();
    const documentId = url.searchParams.get("document");
    if (url.searchParams.has("cutroom-ramp")) {
      const record = timingDocuments.get(documentId ?? "");
      const pending =
        record?.projectId === projectId ? record.ramp?.pending : undefined;
      const signal = c.req.raw.signal;
      c.header("Cache-Control", "no-store");
      if (!pending?.length || signal.aborted) return c.json({ ready: false });
      const aborted = Promise.withResolvers<boolean>();
      const cancel = () => aborted.resolve(false);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const ready = await Promise.race([
          aborted.promise,
          Promise.all(pending).then((jobs) => jobs.some(Boolean)),
        ]);
        return c.json({
          ready: ready && timingDocuments.get(documentId ?? "") === record,
        });
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    if (url.searchParams.has("cutroom-status")) {
      c.header("Cache-Control", "no-store");
      const record = timingDocuments.get(documentId ?? "");
      return c.json({
        allowed: record?.projectId === projectId && record.allowed,
      });
    }
    const timingOnly = url.searchParams.has("cutroom-timing");
    url.searchParams.delete("cutroom-timing");
    const loaded = timingDocuments.get(documentId ?? "");
    if (timingOnly && (loaded?.projectId !== projectId || !loaded.allowed))
      return c.json({ error: "This document requires a reload." }, 409);
    const project = await store.get(projectId);
    const navigation =
      !!documentId &&
      documentId.length <= 100 &&
      c.req.header("sec-fetch-dest") === "iframe" &&
      c.req.header("sec-fetch-site") === "same-origin" &&
      !timingDocuments.has(documentId);
    // Preview variants still use the compiler, which applies their requested values.
    const sourceTimingNavigation =
      navigation &&
      path === "preview" &&
      !url.searchParams.has("variables") &&
      !url.searchParams.has(AUDITION_PARAM) &&
      !url.searchParams.has("hf-capture");
    const prior = !url.searchParams.has("variables")
      ? sourceTimings.get(documentId ?? "")
      : undefined;
    const readEntry = () =>
      readSource(project, "index.html").catch((error: unknown) => {
        if (
          isMissing(error) ||
          (error instanceof HttpError && error.status === 404)
        )
          return null;
        throw error;
      });
    const readMixStamp = () =>
      store.document(project).then(trackMixStamp, (error: unknown) => {
        if (error instanceof ProjectDocumentError) return null;
        throw error;
      });
    const [sourceBefore, dependenciesBefore, mixStampBefore] =
      await Promise.all([
        timingOnly || sourceTimingNavigation ? readEntry() : null,
        timingOnly ? previewDependencies(project.path, "index.html") : null,
        sourceTimingNavigation || (timingOnly && prior) ? readMixStamp() : null,
      ]);
    if (
      timingOnly &&
      prior &&
      sourceBefore &&
      dependenciesBefore === prior.dependencies &&
      mixStampBefore === prior.mixStamp
    ) {
      const authored = previewSourceTiming(sourceBefore.content, prior.ids);
      const timing =
        authored &&
        updatePreviewSourceTiming(prior.authored, authored, prior.compiled);
      if (timing) {
        const [source, dependencies, mixStamp] = await Promise.all([
          readEntry(),
          previewDependencies(project.path, "index.html"),
          readMixStamp(),
        ]);
        if (
          source?.version === sourceBefore.version &&
          dependencies === dependenciesBefore &&
          mixStamp === mixStampBefore
        ) {
          c.header("Cache-Control", "no-store");
          const mix =
            timing === prior.compiled
              ? prior.mix
              : { ...prior.mix, signature: timing.revision };
          return c.json({
            version: sourceBefore.version,
            timing,
            mix,
            live: true,
          });
        }
      }
    }
    // A disk write can beat its watch event. Do not label a cached compiled document
    // with the newer source version merely because the watcher has not invalidated it yet.
    if (timingOnly) signatures.delete(project.path);
    const timingRead: TimingBuild | null = timingOnly ? {} : null;
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
        // The runtime's request for a video its browser cannot decode. Cutroom's media service
        // makes it; posters, sized copies and the videos it declines stay with HyperFrames.
        const proxy =
          media &&
          !composition &&
          url.searchParams.get("hf-proxy") === "h264" &&
          [...url.searchParams.keys()].every((name) =>
            ["hf-proxy", "hf-proxy-retry", PROXY_PIECE_PARAM].includes(name),
          )
            ? await proxyPreview(
                media,
                project,
                relative(project.path, canonical),
                {
                  name: url.pathname.slice(url.pathname.lastIndexOf("/") + 1),
                  piece: url.searchParams.get(PROXY_PIECE_PARAM),
                  signal: c.req.raw.signal,
                },
              )
            : null;
        if (proxy) {
          isolate(proxy.headers);
          return proxy;
        }
      }
      const forward = () =>
        api.request(`${url.origin}${target}${url.search}`, {
          headers: c.req.raw.headers,
        });
      response = await (timingRead
        ? timingBuild.run(timingRead, forward)
        : forward());
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      response = c.text(error.message, error.status);
    }
    const headers = new Headers(response.headers);
    if (response.ok && assetContentType)
      headers.set("Content-Type", assetContentType);
    isolate(headers);
    if (!headers.get("content-type")?.includes("text/html"))
      return new Response(response.body, { status: response.status, headers });
    const compiled = await response.text();
    // Concurrent readers share the upstream compilation, not its async-local context.
    // Reuse that build's source policy by input signature for guarded comparisons only.
    // Approval of an executing document still requires a finalized response.
    const audition =
      path === "preview" ? url.searchParams.get(AUDITION_PARAM) : null;
    // A document carrying a clip's other versions differs from the source, so it always reloads.
    const eligible =
      !audition &&
      path === "preview" &&
      (timingRead
        ? timingRead.allowed === true ||
          (timingRead.allowed !== false &&
            !!timingRead.signature &&
            timingPolicies.has(`${project.path}\0${timingRead.signature}`))
        : eligiblePreviews.has(compiled));
    const rewritten = compiled
      .replaceAll(
        `/api/projects/${encodeURIComponent(projectId)}/preview/`,
        `${prefix}preview/`,
      )
      .replaceAll("/api/runtime.js", `${prefix}runtime.js`)
      .replaceAll("/api/vendor/npm/", `${prefix}vendor/npm/`);
    const html =
      audition && response.ok && audition.length <= 200
        ? await auditionDocument(
            rewritten,
            project,
            activeCompositionPath,
            audition,
          )
        : rewritten;
    const ramp =
      media &&
      response.ok &&
      !audition &&
      eligiblePreviews.has(compiled) &&
      !timingOnly &&
      !url.searchParams.has("cutroom-native-ramp") &&
      !url.searchParams.has("hf-capture") &&
      (path === "preview" || path.startsWith("preview/comp/"))
        ? await prepareRampPreview(html, url, prefix, project, media)
        : null;
    if (ramp) {
      headers.delete("ETag");
      headers.set("Cache-Control", "no-store");
    }
    const mix = trackGainPreview(ramp?.html ?? html, activeCompositionPath);
    if (url.searchParams.get("cutroom-mix") === "1") {
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify(mix), {
        status: response.status,
        headers,
      });
    }
    // The HTTP CSP applies before any authored markup, including malformed documents.
    // The root HTML is compared after masking timing. Other files, including nested
    // sources and assets, must remain identical even if their watcher event is late.
    const dependencies =
      eligible && !ramp
        ? await previewDependencies(project.path, activeCompositionPath)
        : null;
    const document = previewDocument(
      ramp?.html ?? html,
      activeCompositionPath,
      dependencies,
      mix.signature,
      Boolean(ramp?.pending.length),
      Array.from(ramp?.assets ?? [], ([key, { window }]) => [
        `${prefix}ramp-audio/${key}.wav`,
        window.duration,
      ]),
    );
    if (timingOnly) {
      c.header("Cache-Control", "no-store");
      const sourceAfter = await readEntry();
      if (
        !response.ok ||
        !sourceBefore ||
        sourceBefore.version !== sourceAfter?.version
      )
        return c.json(
          { error: "The preview changed while reading timing." },
          409,
        );
      if (!document.timing)
        return c.json({
          version: sourceBefore.version,
          timing: null,
          mix,
          live: true,
        });
      if (
        !dependenciesBefore ||
        dependencies === null ||
        dependenciesBefore !== dependencies
      )
        return c.json(
          { error: "The preview changed while reading timing." },
          409,
        );
      return c.json({
        version: sourceBefore.version,
        timing: document.timing,
        mix,
        live:
          timingDocuments.get(documentId ?? "")?.projectId === projectId &&
          timingDocuments.get(documentId ?? "")?.allowed === true,
      });
    }
    if (navigation && documentId && !timingDocuments.has(documentId)) {
      const compiled = document.timing;
      const ids = new Set(compiled?.clips.map(({ id }) => id));
      const authored =
        sourceTimingNavigation &&
        compiled &&
        sourceBefore &&
        dependencies &&
        response.ok &&
        response.headers.has("ETag") &&
        sourceBefore.version === (await readEntry())?.version &&
        mixStampBefore === (await readMixStamp())
          ? previewSourceTiming(sourceBefore.content, ids)
          : null;
      if (!timingDocuments.has(documentId)) {
        timingDocuments.set(documentId, {
          projectId,
          allowed: compiled !== null,
          ramp: ramp
            ? { assets: ramp.assets, pending: ramp.pending }
            : undefined,
        });
        if (timingDocuments.size > 64) {
          const oldest = timingDocuments.keys().next().value!;
          timingDocuments.delete(oldest);
          sourceTimings.delete(oldest);
        }
        if (
          authored?.clips.length === ids.size &&
          compiled &&
          dependencies &&
          mixStampBefore !== null
        ) {
          sourceTimings.set(documentId, {
            ids,
            dependencies,
            mixStamp: mixStampBefore,
            authored,
            compiled,
            mix,
          });
          if (sourceTimings.size > 8)
            sourceTimings.delete(sourceTimings.keys().next().value!);
        }
      }
    }
    return new Response(document.html, {
      status: response.status,
      headers,
    });
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
  // and so are trash files and the export PNGs that belong to freeze-frame Media items.
  api.get("/projects/:id", async (c, next) => {
    await next();
    if (!c.res.ok) return;
    const listing = z
      .looseObject({ files: z.array(z.string()) })
      .parse(await c.res.json());
    const files = listing.files.filter(
      (file) =>
        !file.split("/").some((part) => part.startsWith(".")) &&
        !inMediaTrash(file) &&
        !isFreezeExport(file),
    );
    const project = await store.get(c.req.param("id"));
    const versioned = new Set(files);
    const requested = c.req.query("mediaComposition");
    if (requested) {
      const composition = exportedComposition(requested);
      const source = await readSource(project, composition).catch(
        (error: unknown) => {
          if (unavailableProjectFile(error)) return null;
          throw error;
        },
      );
      // A directory symlink can be absent from Studio's walk even though its media still
      // resolves. Version the timeline's references without adding duplicate Media items.
      if (source)
        for (const src of mediaSources(
          source.content,
          compositionScope(composition),
          { images: true },
        )) {
          const path = localMediaPath(composition, src);
          if (
            path &&
            !path.startsWith("../") &&
            !path.includes("\0") &&
            isMediaItem(path)
          )
            versioned.add(path);
          if (
            composition.includes("/") &&
            !src.startsWith("../") &&
            !src.startsWith("/")
          ) {
            const root = localMediaPath("index.html", src);
            if (
              root &&
              !root.startsWith("../") &&
              !root.includes("\0") &&
              isMediaItem(root)
            )
              versioned.add(root);
          }
        }
    }
    const fileVersions = Object.fromEntries(
      await Promise.all(
        [...versioned].map(async (path) => {
          const info = await projectPath(project, path)
            .then((absolute) => stat(absolute))
            .catch((error: unknown) => {
              if (unavailableProjectFile(error)) return null;
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
    format: job.format,
    size: job.size,
    range: job.range,
    encoder: job.encoder,
  });
  // Past renders: listed for the dialog and agents, opened by the browser, deleted only by the owner.
  api.get("/projects/:id/exports", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      renders: await renderIndex.list(await store.get(c.req.param("id"))),
    });
  });
  api.get("/projects/:id/exports/file", async (c) => {
    const path = z.string().min(1).parse(c.req.query("path"));
    const project = await store.get(c.req.param("id"));
    const render = (await renderIndex.list(project)).find(
      (render) => render.path === path,
    );
    if (!render) throw new HttpError(404, "Render not found.");
    const file = Bun.file(path);
    c.header("Content-Type", file.type);
    c.header(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(path.split(sep).at(-1) ?? "render").replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    );
    return c.body(file.stream());
  });
  api.delete("/projects/:id/exports", async (c) => {
    if (c.req.header(AGENT_HEADER) !== undefined)
      throw new HttpError(409, "Only the owner can delete renders.");
    const { path } = z
      .object({ path: z.string().min(1) })
      .parse(await c.req.json());
    await renderIndex.remove(await store.get(c.req.param("id")), path);
    return c.json({ deleted: path });
  });
  api.get("/export-gpu", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ available: await renders.gpuAvailable() });
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
  // The whole mix as an export wrote it, measured with FFmpeg's EBU R128 meter.
  api.get("/render/:jobId/loudness", async (c) => {
    const job = renders.get(c.req.param("jobId"));
    if (!job) throw new HttpError(404, "Export job not found.");
    if (job.status !== "complete")
      throw new HttpError(409, "The export has not finished.");
    if (job.range)
      throw new HttpError(
        422,
        "A range export holds part of the mix. Export the whole timeline to measure it.",
      );
    c.header("Cache-Control", "no-store");
    return c.json(await measureLoudness(job.outputPath));
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
        for (const [key, cancel] of pendingSettles) {
          if (!key.startsWith(`${projectId}\0`)) continue;
          cancel();
          pendingSettles.delete(key);
        }
        for (const key of announced.keys())
          if (key.startsWith(`${projectId}\0`)) announced.delete(key);
        for (const key of reads.keys())
          if (key.startsWith(`${projectId}\0`)) reads.delete(key);
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
      for (const cancel of pendingSettles.values()) cancel();
      watchers.clear();
      pendingSettles.clear();
      await renders.cancelAll();
      await thumbnails.close();
    },
  });
}
