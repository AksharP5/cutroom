import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { Hono } from "hono";
import { HttpError } from "../../shared/errors";
import { z } from "zod";
import { COMPONENT_SECONDS } from "../../shared/library";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import { previewPolicy } from "../hyperframes/isolation";
import { previewRuntimeScript } from "../hyperframes/previewRuntime";
import { compositionScope, parseComposition } from "../timeline/composition";
import { itemProjectFiles } from "./add";
import type { Library, RegistryItem } from "./registry";

const SizeSchema = z.object({
  width: z.coerce.number().int().min(16).max(7680),
  height: z.coerce.number().int().min(16).max(7680),
});
type Size = z.infer<typeof SizeSchema>;

const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/**
 * The page a library item previews in: a timeline at the project's size holding the item as one
 * scene clip, as an add would place it, over black.
 */
function previewPage(
  scene: string,
  root: Record<string, string | undefined>,
  size: Size,
  seconds: number,
) {
  const sceneSize =
    root["data-width"] && root["data-height"]
      ? ` data-width="${attribute(root["data-width"])}" data-height="${attribute(root["data-height"])}"`
      : "";
  const id = root["data-composition-id"]
    ? ` data-composition-id="${attribute(root["data-composition-id"])}"`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<script src="assets/vendor/gsap.min.js"></script>
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000000; }
.stage { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000000; }
</style></head>
<body><main id="main" data-composition-id="main" data-no-timeline data-width="${size.width}" data-height="${size.height}" data-duration="${seconds}" class="stage">
<div id="item" class="clip"${id} data-composition-src="${attribute(scene)}" data-start="0" data-duration="${seconds}" data-track-index="0"${sceneSize}></div>
</main></body></html>
`;
}

/**
 * Library items play in the source viewer from Cutroom's cache, outside any project, in the same
 * sandbox as project previews: an opaque origin whose CSP lets it load only files under one
 * random, per-session prefix. That prefix serves the HyperFrames runtime and each built preview's
 * files, read-only, and nothing else.
 */
export function createLibraryPreviews(library: Library) {
  const key = crypto.randomUUID();
  // Under /api/isolated/, the one prefix that answers requests from opaque frames.
  const base = `/isolated/${key}/`;
  const builds = new Map<string, Promise<void>>();
  /** Each item's files, written once per server run and shared by every size. */
  const written = new Map<string, Promise<void>>();

  /**
   * Builds the item's preview at `size` once per server run, into the library cache: its files
   * once, then for each size a page that mounts it. Only a fragment component's host is drawn at
   * the size, so it alone is written again, beside the shared files.
   */
  function build(item: RegistryItem, size: Size) {
    const sized = `${size.width}x${size.height}`;
    const key = `${item.name}/${sized}`;
    let pending = builds.get(key);
    if (pending) return pending.then(() => key);
    pending = (async () => {
      const dir = library.previewDir(item.name);
      const { scene, files, fragment } = await itemProjectFiles(
        library,
        item,
        size,
      );
      let shared = written.get(item.name);
      if (!shared) {
        shared = (async () => {
          await rm(dir, { recursive: true, force: true });
          for (const file of files) {
            if (fragment && file.path === scene) continue;
            await mkdir(dirname(join(dir, file.path)), { recursive: true });
            await writeFile(join(dir, file.path), file.bytes);
          }
        })();
        written.set(item.name, shared);
        shared.catch(() => written.delete(item.name));
      }
      await shared;
      const sceneFile = files.find(({ path }) => path === scene)!;
      // A host sits beside the path an add gives it, so its relative URLs are the same.
      const mounted = fragment
        ? scene.replace(/\.html$/, `@${sized}.html`)
        : scene;
      if (fragment) {
        await mkdir(dirname(join(dir, mounted)), { recursive: true });
        await writeFile(join(dir, mounted), sceneFile.bytes);
      }
      const root = parseComposition(
        typeof sceneFile.bytes === "string"
          ? sceneFile.bytes
          : new TextDecoder().decode(sceneFile.bytes),
        emptyTimelineSettings(),
        { scope: compositionScope(mounted) },
      ).root;
      const entryFile = `index@${sized}.html`;
      await writeFile(
        join(dir, entryFile),
        previewPage(
          mounted,
          root.attrs,
          size,
          item.duration ?? COMPONENT_SECONDS,
        ),
      );
      // One document with the item's scene inside and the runtime from this prefix.
      const html = await bundleToSingleHtml(dir, {
        entryFile,
        runtime: "placeholder",
        inlineAssets: false,
        staticGuard: false,
        sceneParts: false,
      });
      await writeFile(
        join(dir, `.preview@${sized}.html`),
        html.replace(
          'data-hyperframes-preview-runtime="1" src=""',
          `data-hyperframes-preview-runtime="1" src="../../runtime.js"`,
        ),
      );
    })();
    builds.set(key, pending);
    // A failed build, such as a download that stopped, is tried again on the next open.
    pending.catch(() => builds.delete(key));
    return pending.then(() => key);
  }

  const api = new Hono();

  /** Where the source viewer loads an item: its built preview, under the session's prefix. */
  api.get("/cutroom/library/:name/preview", async (c) => {
    const size = SizeSchema.parse(c.req.query());
    const item = await library.item(c.req.param("name"));
    // Items that cannot play here, such as ones that need online scripts, are not previewed.
    const { disabled } = library.describe(item, false);
    if (disabled) throw new HttpError(422, `${item.title}: ${disabled}`);
    const folder = await build(item, size);
    return c.redirect(`/api${base}${folder}/`);
  });

  api.get(`${base}*`, async (c) => {
    const url = new URL(c.req.url);
    const end = url.pathname.indexOf(base) + base.length;
    const prefix = `${url.origin}${url.pathname.slice(0, end)}`;
    const path = decodeURIComponent(url.pathname.slice(end));
    const headers = new Headers({
      "Content-Security-Policy": previewPolicy(prefix),
      "Connection-Allowlist": `(${JSON.stringify(`${prefix}*`)})`,
      "X-DNS-Prefetch-Control": "off",
      "Access-Control-Allow-Origin": "null",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    if (path === "runtime.js") {
      headers.set("Content-Type", "application/javascript");
      return new Response(previewRuntimeScript(), { headers });
    }
    // <name>/<width>x<height>/ is the page; anything below it is one of the item's files.
    const match = /^([a-z0-9-]+)\/(\d+x\d+)\/(.*)$/.exec(path);
    if (!match || !builds.has(`${match[1]}/${match[2]}`)) return c.notFound();
    const dir = library.previewDir(match[1]!);
    const rest = match[3]!;
    const file = rest
      ? resolve(dir, rest)
      : join(dir, `.preview@${match[2]}.html`);
    const inside = relative(dir, file);
    // Only the page's own files: nothing outside its folder, and no hidden file by name.
    if (
      rest &&
      (inside.startsWith(`..${sep}`) ||
        inside === ".." ||
        isAbsolute(inside) ||
        inside.split(sep).some((part) => part.startsWith(".")))
    )
      return c.notFound();
    const body = Bun.file(file);
    if (!(await body.exists())) return c.notFound();
    if (!rest) headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(body, { headers });
  });
  return api;
}
