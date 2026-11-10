import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { injectDeterministicFontFaces } from "@hyperframes/core/fonts/embed";
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";
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
  identifyFileWrite,
} from "@hyperframes/studio-server";
import type {
  ResolvedProject,
  StudioApiAdapter,
} from "@hyperframes/studio-server";
import type { ProjectStore } from "../projects/store";
import type { ReviewService } from "../projects/review";
import { HttpError } from "../../shared/errors";
import { createThumbnailRenderer } from "./thumbnails";
import { createRenderWorkers } from "./jobs";

interface FileChange {
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
  const subscribers = new Set<(change: FileChange) => void>();
  const watchers = new Map<string, ReturnType<typeof watch>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const signatures = new Map<string, Promise<string>>();
  const thumbnails = createThumbnailRenderer();
  const renders = createRenderWorkers();

  const watchProject = (project: ResolvedProject) => {
    if (watchers.has(project.dir)) return;
    const watcher = watch(
      project.dir,
      { recursive: true },
      (_kind, filename) => {
        if (!filename) return;
        const path = filename.replaceAll("\\", "/");
        const parts = path.split("/");
        if (parts.some((part) => ignored.has(part))) return;
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
    watchers.set(project.dir, watcher);
  };

  const resolveProject = async (
    id: string,
  ): Promise<ResolvedProject | null> => {
    const project = await store.get(id).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    });
    if (!project) return null;
    const resolved = { id: project.id, dir: project.path, title: project.name };
    watchProject(resolved);
    return resolved;
  };

  const adapter: StudioApiAdapter = {
    async listProjects() {
      return (await store.list()).map((project) => {
        const resolved = {
          id: project.id,
          dir: project.path,
          title: project.name,
        };
        watchProject(resolved);
        return resolved;
      });
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
    transformPreviewHtml: ({ html }) => injectDeterministicFontFaces(html),
    async getProjectSignature(dir) {
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
    generateThumbnail: (options) => thumbnails.capture(options),
    startRender: (options) => renders.start(options),
  };

  api.get("/runtime.js", (c) =>
    c.body(getHyperframeRuntimeScript(), 200, {
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
  api.route("/", createStudioApi(adapter));
  return Object.assign(api, {
    async dispose() {
      for (const watcher of watchers.values()) watcher.close();
      for (const timer of timers.values()) clearTimeout(timer);
      watchers.clear();
      timers.clear();
      await renders.cancelAll();
      await thumbnails.close();
    },
  });
}
