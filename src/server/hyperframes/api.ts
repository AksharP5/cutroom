import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
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
  getMimeType,
  identifyFileWrite,
  requestSubPath,
} from "@hyperframes/studio-server";
import type {
  ResolvedProject,
  StudioApiAdapter,
} from "@hyperframes/studio-server";
import type { ProjectStore } from "../projects/store";
import { projectPath } from "../projects/store";
import type { ReviewService } from "../projects/review";
import { HttpError } from "../../shared/errors";
import { createThumbnailRenderer } from "./thumbnails";
import { createRenderWorkers } from "./jobs";
import { previewPolicy } from "./isolation";
import { withPreviewBridge } from "./previewBridge";

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
  const subscribers = new Set<(change: FileChange) => void>();
  const watchers = new Map<string, ReturnType<typeof watch>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const signatures = new Map<string, Promise<string>>();
  const thumbnails = createThumbnailRenderer();
  const renders = createRenderWorkers();
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
    generateThumbnail: (options) =>
      thumbnails.capture({
        ...options,
        previewUrl: isolatedPreview(options.project.id, options.previewUrl),
      }),
    startRender: (options) => renders.start(options),
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
    let assetContentType: string | undefined;
    try {
      if (path.startsWith("preview/")) {
        const project = await store.get(projectId);
        const composition = path.startsWith("preview/comp/");
        const file = requestSubPath(
          c.req.url,
          composition ? "isolated/:key/preview/comp" : "isolated/:key/preview",
        );
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
    // The HTTP CSP applies before any authored markup, including malformed documents.
    return new Response(withPreviewBridge(html), {
      status: response.status,
      headers,
    });
  });

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
  // Studio's listing feeds the Media panel, Assets, and the code tree. Dot folders hold app
  // state such as Cutroom's review captures, so they are hidden here like everywhere else.
  api.get("/projects/:id", async (c, next) => {
    await next();
    if (!c.res.ok) return;
    const listing = z
      .looseObject({ files: z.array(z.string()) })
      .parse(await c.res.json());
    c.res = c.json({
      ...listing,
      files: listing.files.filter(
        (file) => !file.split("/").some((part) => part.startsWith(".")),
      ),
    });
  });
  api.route("/", createStudioApi(adapter));
  return Object.assign(api, {
    subscribe(projectId: string, listener: (change: FileChange) => void) {
      const notify = (change: FileChange) => {
        if (change.projectId === projectId) listener(change);
      };
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
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
