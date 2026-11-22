import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { isCompositionVariable } from "@hyperframes/core/variables";
import hyperframesPackage from "hyperframes/package.json" with { type: "json" };
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import { LibraryNameSchema } from "../../shared/library";
import type { LibraryCategory, LibraryItem } from "../../shared/library";
import { protectedPath } from "../../shared/sourcePaths";
import { onlineReferences } from "./scripts";

/**
 * The HyperFrames release the Library reads: the one Cutroom pins, by the commit its tag names,
 * so a moved tag cannot change what is fetched. Update both together with the packages.
 */
export const LIBRARY_RELEASE = {
  version: "0.9.26",
  commit: "0c6c7fca45bddc9838ebc6c0f0280e9efea1f18a",
} as const;
export const LIBRARY_REF = `v${LIBRARY_RELEASE.version}`;
const REGISTRY = (commit: string) =>
  `https://raw.githubusercontent.com/heygen-com/hyperframes/${commit}/registry/`;
/** The registry repository's license, which an item without one of its own carries. */
export const REGISTRY_LICENSE = "Apache-2.0";
/** Where items keep posters, preview videos and binary assets: HyperFrames' folders on its CDN. */
const ASSET_PREFIXES = [
  "https://static.heygen.ai/hyperframes-oss/",
  "https://static.heygen.ai/hyperframes/templates/",
];

const TIMEOUT_MS = 10_000;
const CONCURRENCY = 16;
const MANIFEST_BYTES = 4 * 1024 * 1024;
const ITEM_BYTES = 512 * 1024;
const FILE_BYTES = 64 * 1024 * 1024;
const ITEM_TOTAL_BYTES = 256 * 1024 * 1024;
const POSTER_BYTES = 4 * 1024 * 1024;
const POSTER_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const unreachable = (detail?: string) =>
  new HttpError(
    502,
    `Can't reach the HyperFrames library.${detail ? ` ${detail}` : ""}`,
  );

/**
 * A path an item writes into a project, relative to its root: inside a folder, never at the root
 * where tools read their configuration (bunfig.toml, Makefile) and HTML becomes a timeline; never
 * under node_modules, which runtimes load; no absolute paths, no `..`, no hidden or tooling files.
 */
const TargetSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (target) =>
      !target.startsWith("/") &&
      !target.includes("\\") &&
      !target.includes("\0") &&
      posix.normalize(target) === target &&
      target.includes("/") &&
      !target
        .split("/")
        .some((part) => part === ".." || part === "node_modules") &&
      !protectedPath(target, false),
    "Unsafe registry file target.",
  );

/** The only files an item may fetch from outside the pinned registry: pictures, sound, fonts. */
const MEDIA_FILE =
  /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v|mp3|wav|m4a|aac|ogg|oga|flac|woff2?|ttf|otf)$/i;

const FileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(300)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !path.split("/").some((part) => part === ".." || part === ""),
        "Unsafe registry source path.",
      ),
    url: z.string().max(2_000).optional(),
    target: TargetSchema,
    type: z.enum([
      "hyperframes:composition",
      "hyperframes:asset",
      "hyperframes:snippet",
      "hyperframes:style",
      "hyperframes:timeline",
    ]),
  })
  .refine(
    (file) =>
      file.url === undefined ||
      (file.type === "hyperframes:asset" && MEDIA_FILE.test(file.target)),
    "Only pictures, sound and fonts may come from outside the registry.",
  );

/** What Cutroom reads of a registry-item.json; everything else in it is ignored. */
const RegistryItemSchema = z.object({
  name: LibraryNameSchema,
  type: z.enum(["hyperframes:block", "hyperframes:component"]),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000),
  tags: z.array(z.string().min(1).max(64)).max(64).default([]),
  author: z.string().max(200).optional(),
  license: z.string().max(100).optional(),
  minCliVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+/)
    .optional(),
  deprecated: z.string().max(2_000).optional(),
  dimensions: z
    .object({
      width: z.number().int().min(1).max(16_384),
      height: z.number().int().min(1).max(16_384),
    })
    .optional(),
  duration: z.number().positive().max(3_600).optional(),
  // Documentation (READMEs, templates, agent skills) never plays, so it is never copied.
  files: z
    .array(z.looseObject({ target: z.string().max(300) }))
    .max(1_000)
    .transform((files) =>
      files.filter((file) => !/\.(md|markdown)$/i.test(file.target)),
    )
    .pipe(z.array(FileSchema).min(1)),
  preview: z.object({ poster: z.string().max(2_000).optional() }).optional(),
  variables: z
    .array(z.unknown())
    .max(200)
    .default([])
    .transform((items) => items.filter(isCompositionVariable)),
});
export type RegistryItem = z.infer<typeof RegistryItemSchema>;
export type RegistryFile = RegistryItem["files"][number];

const ManifestSchema = z.object({
  items: z
    .array(
      z.object({
        name: LibraryNameSchema,
        type: z.enum([
          "hyperframes:block",
          "hyperframes:component",
          "hyperframes:example",
        ]),
      }),
    )
    .max(10_000),
});

/** An item as the list keeps it: whether it loads anything from the network was read once. */
const CachedItemSchema = RegistryItemSchema.extend({
  /** Its HTML, CSS or scripts load from the network, which preview and export cannot reach. */
  online: z.boolean(),
});
type CachedItem = z.infer<typeof CachedItemSchema>;

const CatalogCacheSchema = z.object({
  version: z.literal(2),
  savedAt: z.string(),
  /** Every manifest entry was read, so the pinned list never needs the network again. */
  complete: z.boolean(),
  items: z.array(CachedItemSchema),
});

/** One file of an item as cached: its target and the hash of its bytes. */
const FilesCacheSchema = z.object({
  files: z.array(z.object({ target: TargetSchema, sha256: z.string() })),
});
export type CachedFile = z.infer<typeof FilesCacheSchema>["files"][number];

const ITEM_DIRS = {
  "hyperframes:block": "blocks",
  "hyperframes:component": "components",
} as const;

const newer = (wanted: string, have: string) => {
  const parse = (value: string) => value.split(/[.-]/).slice(0, 3).map(Number);
  const [a, b] = [parse(wanted), parse(have)];
  for (let index = 0; index < 3; index++)
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  return false;
};

/**
 * HyperFrames' block category (`resolveBlockCategory` in @hyperframes/core, not exported), with
 * titles and lower thirds split out because they are most of what an editor reaches for.
 */
export function libraryCategory(tags: readonly string[]): LibraryCategory {
  const has = (...names: string[]) => names.some((name) => tags.includes(name));
  if (has("lower-third")) return "lower-thirds";
  if (has("title-card")) return "titles";
  if (has("captions", "caption-style")) return "captions";
  if (has("transition")) return "transitions";
  if (has("social", "overlay")) return "overlays";
  if (has("data", "chart", "map")) return "data";
  if (has("html-in-canvas", "webgl", "shader")) return "vfx";
  if (has("text-effect", "text-effects")) return "text-effects";
  if (has("effect", "effects", "grain", "vignette")) return "effects";
  return "scenes";
}

async function atomicWrite(path: string, bytes: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * The registry over HTTPS at one tag, cached in Cutroom's data folder. Only two prefixes are
 * reachable: the registry folder at that tag, and HyperFrames' asset folder on its CDN. Redirects
 * are refused, every body is size-capped, and every manifest is validated before it is used or
 * cached. `fetchImpl` is the only way out to the network, so tests stand in for the registry.
 */
export function createLibrary({
  dataDir,
  fetchImpl = fetch,
  ref = LIBRARY_REF,
  commit = LIBRARY_RELEASE.commit,
  retryMs = 30_000,
}: {
  dataDir: string;
  fetchImpl?: typeof fetch;
  ref?: string;
  commit?: string;
  /** How long an unreachable registry waits before a list read checks it again. */
  retryMs?: number;
}) {
  const base = REGISTRY(commit);
  const root = join(dataDir, "library", ref);
  const catalogPath = join(root, "catalog.json");
  const itemsRoot = join(root, "items");

  const allowed = (url: URL) =>
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    [base, ...ASSET_PREFIXES].some((prefix) => url.href.startsWith(prefix));

  /** The last request could not reach the registry: a network failure or a server error. */
  let down = false;
  let checked = 0;
  async function get(href: string, limit: number) {
    const url = new URL(href);
    if (!allowed(url))
      throw new HttpError(
        422,
        `The HyperFrames library refers to a file outside it: ${url.origin}.`,
      );
    let response: Response;
    try {
      response = await fetchImpl(url.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      down = true;
      throw unreachable(error instanceof Error ? error.message : String(error));
    }
    down = response.status >= 500;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw unreachable(`${url.href} redirected, which the library refuses.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw unreachable(`${url.href} answered ${response.status}.`);
    }
    if (Number(response.headers.get("content-length")) > limit)
      throw unreachable(`${url.href} is larger than ${limit} bytes.`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > limit)
        throw unreachable(`${url.href} is larger than ${limit} bytes.`);
      chunks.push(chunk);
    }
    return { bytes: new Uint8Array(Buffer.concat(chunks)), response };
  }
  const getJson = async (href: string, limit: number) => {
    const { bytes } = await get(href, limit);
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw unreachable(`${href} is not JSON.`);
    }
  };

  const itemUrl = (item: Pick<RegistryItem, "name" | "type">, path: string) =>
    new URL(
      `${ITEM_DIRS[item.type]}/${item.name}/${path.split("/").map(encodeURIComponent).join("/")}`,
      base,
    ).href;

  async function readCatalogCache() {
    const raw = await readFile(catalogPath, "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      return CatalogCacheSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async function fetchCatalog(
    cached: z.infer<typeof CatalogCacheSchema> | null,
  ) {
    const manifest = ManifestSchema.safeParse(
      await getJson(new URL("registry.json", base).href, MANIFEST_BYTES),
    );
    if (!manifest.success)
      throw unreachable("The registry manifest is not in the expected shape.");
    const have = new Map(cached?.items.map((item) => [item.name, item]));
    const wanted = manifest.data.items.filter(
      (entry): entry is { name: string; type: RegistryItem["type"] } =>
        entry.type !== "hyperframes:example",
    );
    const items: CachedItem[] = [];
    let complete = true;
    let next = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < wanted.length) {
          const entry = wanted[next++]!;
          const known = have.get(entry.name);
          if (known?.type === entry.type) {
            items.push(known);
            continue;
          }
          const parsed = await getJson(
            itemUrl(entry, "registry-item.json"),
            ITEM_BYTES,
          ).then(
            (value) => RegistryItemSchema.safeParse(value),
            () => null,
          );
          // An item that fails to validate is left out rather than failing the whole list.
          if (
            !parsed?.success ||
            parsed.data.name !== entry.name ||
            parsed.data.type !== entry.type
          ) {
            if (!parsed) complete = false;
            continue;
          }
          // Read its code once, to know whether it needs the network; it is fetched again to add.
          const online = await Promise.all(
            parsed.data.files
              .filter(
                (file) =>
                  file.url === undefined &&
                  /\.(html?|m?js|css)$/i.test(file.target),
              )
              .map(async (file) => {
                const { bytes } = await get(
                  itemUrl(parsed.data, file.path),
                  FILE_BYTES,
                );
                return (
                  onlineReferences(new TextDecoder().decode(bytes)).length > 0
                );
              }),
          ).then(
            (found) => found.some(Boolean),
            () => null,
          );
          if (online === null) complete = false;
          else items.push({ ...parsed.data, online });
        }
      }),
    );
    if (!items.length) throw unreachable("No library item could be read.");
    const order = new Map(wanted.map((entry, index) => [entry.name, index]));
    items.sort((a, b) => order.get(a.name)! - order.get(b.name)!);
    const saved = {
      version: 2 as const,
      savedAt: new Date().toISOString(),
      complete,
      items,
    };
    await atomicWrite(catalogPath, JSON.stringify(saved));
    return saved;
  }

  let catalogLoad: Promise<{
    items: CachedItem[];
    savedAt: string;
    offline: boolean;
  }> | null = null;
  /** The pinned list: from the cache once complete, otherwise read and saved. */
  function catalog() {
    catalogLoad ??= (async () => {
      const cached = await readCatalogCache();
      if (cached?.complete) return { ...cached, offline: false };
      try {
        return { ...(await fetchCatalog(cached)), offline: false };
      } catch (error) {
        if (cached?.items.length) return { ...cached, offline: true };
        throw error;
      }
    })();
    const load = catalogLoad;
    // A failed or offline read is tried again on the next request.
    void load.then(
      ({ offline }) => {
        if (offline && catalogLoad === load) catalogLoad = null;
      },
      () => {
        if (catalogLoad === load) catalogLoad = null;
      },
    );
    return load;
  }

  async function item(name: string) {
    const found = (await catalog()).items.find((entry) => entry.name === name);
    if (!found)
      throw new HttpError(404, `"${name}" is not in the HyperFrames library.`);
    return found;
  }

  const itemDir = (name: string) => join(itemsRoot, name);
  const filesRecord = (name: string) => join(itemDir(name), ".files.json");

  /**
   * The item's saved files, when the record is readable, names every file the item lists, and
   * each file still has the bytes it was saved with. Anything else counts as not downloaded.
   */
  async function cachedFiles(entry: RegistryItem) {
    const raw = await readFile(filesRecord(entry.name), "utf8").catch(
      () => null,
    );
    if (raw === null) return null;
    let parsed;
    try {
      parsed = FilesCacheSchema.safeParse(JSON.parse(raw));
    } catch {
      return null;
    }
    if (!parsed.success) return null;
    const files = parsed.data.files;
    const wanted = entry.files.map(({ target }) => target).sort();
    const have = files.map(({ target }) => target).sort();
    if (wanted.join("\0") !== have.join("\0")) return null;
    for (const file of files) {
      const bytes = await readFile(
        join(itemDir(entry.name), file.target),
      ).catch(() => null);
      if (!bytes || sha256(bytes) !== file.sha256) return null;
    }
    return files;
  }

  const downloads = new Map<string, Promise<CachedFile[]>>();
  /** The item's files in the cache, downloaded once; each lands at its target under the item. */
  function files(entry: RegistryItem) {
    let pending = downloads.get(entry.name);
    if (pending) return pending;
    pending = (async () => {
      const cached = await cachedFiles(entry);
      if (cached) return cached;
      const written: CachedFile[] = [];
      let total = 0;
      for (const file of entry.files) {
        const { bytes } = await get(
          file.url ?? itemUrl(entry, file.path),
          FILE_BYTES,
        );
        total += bytes.byteLength;
        if (total > ITEM_TOTAL_BYTES)
          throw unreachable(`${entry.name} is larger than the library allows.`);
        await atomicWrite(join(itemDir(entry.name), file.target), bytes);
        written.push({ target: file.target, sha256: sha256(bytes) });
      }
      await atomicWrite(
        filesRecord(entry.name),
        JSON.stringify({ files: written }),
      );
      return written;
    })().finally(() => downloads.delete(entry.name));
    downloads.set(entry.name, pending);
    return pending;
  }

  /** The item's poster, cached on first request; null when it has none. */
  async function poster(entry: RegistryItem) {
    const href = entry.preview?.poster;
    const extension =
      href &&
      /\.([a-z]+)(?:\?|$)/i.exec(new URL(href).pathname)?.[1]?.toLowerCase();
    const type = extension && POSTER_TYPES[extension];
    if (!href || !type) return null;
    const path = join(root, "posters", `${entry.name}.${extension}`);
    if (!(await stat(path).catch(() => null))) {
      const { bytes } = await get(href, POSTER_BYTES);
      await atomicWrite(path, bytes);
    }
    return { path, type };
  }

  /** An item as the panel and agents see it. */
  const describe = (entry: CachedItem, cached: boolean): LibraryItem => ({
    name: entry.name,
    title: entry.title,
    kind: entry.type === "hyperframes:block" ? "block" : "component",
    category: libraryCategory(entry.tags),
    description: entry.description,
    tags: entry.tags,
    duration: entry.duration,
    dimensions: entry.dimensions,
    hasPoster: !!entry.preview?.poster,
    variables: entry.variables.map(({ id, type, default: value }) => ({
      id,
      type,
      default: value,
    })),
    cached,
    disabled: entry.deprecated
      ? `Deprecated: ${entry.deprecated}`
      : entry.minCliVersion &&
          newer(entry.minCliVersion, hyperframesPackage.version)
        ? `Needs HyperFrames ${entry.minCliVersion.split(".").slice(0, 2).join(".")}`
        : entry.online
          ? "Needs online scripts"
          : undefined,
    hidden:
      !!entry.deprecated ||
      (!!entry.minCliVersion &&
        newer(entry.minCliVersion, hyperframesPackage.version)),
  });

  /**
   * Whether the registry answers. Once a request has failed, a list read asks again with the
   * small manifest, at most every `retryMs`, so the panel says when it is back.
   */
  async function reachable() {
    if (!down) return true;
    if (Date.now() - checked < retryMs) return false;
    checked = Date.now();
    return get(new URL("registry.json", base).href, MANIFEST_BYTES).then(
      () => true,
      () => false,
    );
  }

  return {
    ref,
    catalog,
    reachable,
    item,
    files,
    cachedFiles,
    poster,
    describe,
    /** Where an item's cached files live, for preview and copying. */
    itemDir,
    /** Where an item's preview at one size is built. */
    previewDir: (folder: string) => join(root, "previews", folder),
  };
}
export type Library = ReturnType<typeof createLibrary>;
