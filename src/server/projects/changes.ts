import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { rewriteAssetPath } from "@hyperframes/parsers/asset-paths";
import { TimelineError } from "../../shared/timeline/apply";
import type { Project } from "../../shared/project";
import { fileFingerprint, localMediaPath } from "../../shared/media";
import { imageDeclarationUrls } from "../../shared/variables";
import { compositionScope, parseComposition } from "../timeline/composition";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import { imageOverridesAt, sceneImageReferences } from "./mediaReferences";
import { sceneSources } from "./sceneSources";
import { readSource } from "./store";
import { resolveProjectPath, unavailableProjectFile } from "./path";
import { freezeExportSource } from "../hyperframes/freezeSources";

export type ClipVersions = Map<string | null, string>;
export const missingSignature = "v3:missing";
const signature = (content: string) =>
  `v3:${createHash("sha256").update(content).digest("hex")}`;

type SourceVersions = {
  source: string;
  versions: ClipVersions;
  urls: Map<string | null, Set<string>>;
};
// Reads dominate edits. Retain only the latest parse for eight compositions.
const cache = new Map<string, SourceVersions>();

function references(text: string) {
  return [
    ...text.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi),
    // Script-created media has no certain clip owner. Keep it on the composition row.
    ...text.matchAll(
      /["'`]([^"'`\s]+\.(?:png|jpe?g|gif|webp|svg|avif|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|aac|flac|woff2?|ttf|otf)(?:[?#][^"'`\s]*)?)["'`]/gi,
    ),
  ].map((match) => match[1]!);
}

function sourceVersions(source: string, composition: string, cacheKey: string) {
  const previous = cache.get(cacheKey);
  if (previous?.source === source) return previous;
  const versions: ClipVersions = new Map();
  const media = new Map<string | null, Set<string>>();
  const add = (id: string | null, value: string) => {
    const url = value.trim();
    if (!url || url.startsWith("#")) return;
    let urls = media.get(id);
    if (!urls) media.set(id, (urls = new Set()));
    urls.add(url);
  };
  try {
    const parsed = parseComposition(source, emptyTimelineSettings(), {
      scope: compositionScope(composition),
    });
    const clips = parsed.timeline.clips
      .filter((clip) => !parsed.anonymous.has(clip.id))
      .map((clip) => ({ ...clip, element: parsed.elements.get(clip.id)! }))
      .sort((a, b) => a.element.start - b.element.start);
    const owners = new Map(clips.map((clip) => [clip.element, clip.id]));
    const visit = (elements: typeof parsed.roots, owner: string | null) => {
      for (const element of elements) {
        const id = owners.get(element) ?? owner;
        const target = ["script", "style", "link"].includes(element.tag)
          ? null
          : id;
        for (const name of ["src", "poster"])
          if (element.attrs[name]) add(target, element.attrs[name]);
        if (element.attrs["data-composition-variables"])
          for (const url of imageDeclarationUrls(
            element.attrs["data-composition-variables"],
          ))
            add(null, url);
        if (element.tag === "img" && element.attrs[freezeExportSource])
          add(target, element.attrs[freezeExportSource]);
        for (const candidate of (element.attrs.srcset ?? "").split(",")) {
          const url = candidate.trim().split(/\s+/)[0];
          if (url) add(target, url);
        }
        for (const url of references(element.attrs.style ?? "")) add(id, url);
        if (element.tag === "link" && element.attrs.href)
          add(null, element.attrs.href);
        if (element.tag === "script" || element.tag === "style")
          for (const url of references(
            source.slice(element.openEnd, element.end),
          ))
            add(null, url);
        visit(element.children, id);
        visit(element.content, id);
      }
    };
    visit(parsed.roots, null);
    for (const clip of clips) {
      if (!clip.link) continue;
      for (const partner of clips)
        if (
          partner.link === clip.link &&
          ["audio", "voiceover"].includes(partner.kind)
        )
          for (const path of media.get(partner.id) ?? []) {
            let paths = media.get(clip.id);
            if (!paths) media.set(clip.id, (paths = new Set()));
            paths.add(path);
          }
    }
    const rest: (string | [string])[] = [];
    let end = 0;
    for (const { id, element } of clips) {
      versions.set(id, signature(source.slice(element.start, element.end)));
      rest.push(source.slice(end, element.start), [id]);
      end = element.end;
    }
    rest.push(source.slice(end));
    versions.set(null, signature(JSON.stringify(rest)));
  } catch (error) {
    if (!(error instanceof TimelineError)) throw error;
    versions.set(null, signature(source));
    for (const url of references(source)) add(null, url);
  }
  const result = { source, versions, urls: media };
  cache.delete(cacheKey);
  cache.set(cacheKey, result);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return result;
}

export function sourceClipVersions(
  source: string,
  composition: string,
  cacheKey = composition,
): ClipVersions {
  return sourceVersions(source, composition, cacheKey).versions;
}

/** Stat each referenced path once per read, shared by every clip using that file. */
export async function compositionVersions(
  project: Pick<Project, "path">,
  composition: string,
  options?: {
    content: string;
    mounted?: boolean;
    resolveScene?: ReturnType<typeof sceneSources>;
    readChanged?: (path: string) => Promise<string | null | undefined>;
  },
) {
  const content =
    options?.content ?? (await readSource(project, composition)).content;
  const parsed = sourceVersions(
    content,
    composition,
    `${project.path}/${composition}`,
  );
  const canonicalMedia = new Map<string, string>();
  const files = new Map<
    string,
    Promise<{ exists: boolean; fingerprint: string; content?: string }>
  >();
  const file = (path: string) => {
    let pending = files.get(path);
    if (!pending) {
      pending = (async () => {
        const isSource = /\.(?:css|[cm]?[jt]sx?)$/i.test(path);
        const unavailable = {
          exists: false,
          fingerprint: JSON.stringify([path, "missing"]),
        };
        const changed = isSource
          ? await options?.readChanged?.(path)
          : undefined;
        if (changed !== undefined)
          return {
            ...unavailable,
            exists: changed !== null,
            content: changed ?? undefined,
          };
        try {
          const { absolute, path: owned } = await resolveProjectPath(
            project,
            path,
          );
          const info = await stat(absolute);
          if (info.isFile()) canonicalMedia.set(path, owned);
          const fingerprint = fileFingerprint(owned, info);
          if (!isSource || !info.isFile() || info.size > 10 * 1024 * 1024)
            return { exists: true, fingerprint };
          const replacement =
            owned !== path ? await options?.readChanged?.(owned) : undefined;
          if (replacement === null) return unavailable;
          const content = replacement ?? (await readFile(absolute, "utf8"));
          return { exists: true, fingerprint, content };
        } catch (error) {
          if (unavailableProjectFile(error)) return unavailable;
          throw error;
        }
      })();
      files.set(path, pending);
    }
    return pending;
  };
  const localPath = (source: string, url: string) => {
    const path = localMediaPath(source, url);
    return path &&
      path !== "." &&
      !path.startsWith("..") &&
      !path.includes("\0")
      ? path
      : null;
  };
  const authoredPath = async (url: string) => {
    // HyperFrames rebases mounted HTML to the project root, preferring existing siblings.
    const rooted = localPath("index.html", rewriteAssetPath(composition, url));
    const sibling = localPath(
      "index.html",
      rewriteAssetPath(composition, url, () => true),
    );
    return sibling && sibling !== rooted && (await file(sibling)).exists
      ? sibling
      : rooted;
  };
  const resolvedUrls = new Map<string, string | null>();
  if (options?.mounted) {
    const urls = new Set(
      [...parsed.urls.values()].flatMap((urls) => [...urls]),
    );
    await Promise.all(
      [...urls].map(async (url) =>
        resolvedUrls.set(url, await authoredPath(url)),
      ),
    );
  }
  const paths = new Map(
    [...parsed.urls].map(([id, urls]) => {
      const paths = [...urls].map((url) =>
        options?.mounted ? resolvedUrls.get(url) : localPath(composition, url),
      );
      return [id, new Set(paths.filter((path) => path != null))];
    }),
  );
  const shared = paths.get(null) ?? new Set<string>();
  paths.set(null, shared);
  // Follow local styles/scripts for media URLs, relative to the file declaring them.
  const dependencies = [
    ...new Set([...paths.values()].flatMap((refs) => [...refs])),
  ];
  for (const path of dependencies) {
    if (!/\.(?:css|[cm]?[jt]sx?)$/i.test(path)) continue;
    const { content } = await file(path);
    if (content === undefined) continue;
    for (const url of [
      ...references(content),
      ...[
        ...content.matchAll(
          /(?:import\s*(?:[^"']*?from\s*)?|@import\s*)["']([^"']+)["']/g,
        ),
      ].map((match) => match[1]!),
    ]) {
      const source =
        options?.mounted && url.startsWith("/") ? "index.html" : path;
      const resolved = localPath(source, url);
      if (!resolved || shared.has(resolved)) continue;
      shared.add(resolved);
      dependencies.push(resolved);
    }
  }
  const versions = new Map(parsed.versions);
  const mediaFiles = new Map<string, string>();
  await Promise.all(
    [...paths].map(async ([id, refs]) => {
      // Script/style source edits already have their own source row. Only their media belongs here.
      const fingerprints = await Promise.all(
        [...refs]
          .filter((path) => !/\.(?:css|[cm]?[jt]sx?)$/i.test(path))
          .sort()
          .map(async (path) => {
            const { fingerprint } = await file(path);
            mediaFiles.set(path, fingerprint);
            return fingerprint;
          }),
      );
      if (!fingerprints.length) return;
      const media = JSON.stringify(fingerprints);
      versions.set(id, signature(JSON.stringify([versions.get(id), media])));
    }),
  );
  // Mount overrides use the project root even when the owner has a sibling asset.
  const sceneImages = new Map<string | number, Set<string>>();
  if (content.includes("data-variable-values")) {
    const resolveScene = options?.resolveScene ?? sceneSources(project.path);
    for (const { owner, url } of sceneImageReferences(
      content,
      imageOverridesAt(composition, resolveScene),
    )) {
      const path = localPath("index.html", url);
      if (!path) continue;
      let refs = sceneImages.get(owner);
      if (!refs) sceneImages.set(owner, (refs = new Set()));
      refs.add(path);
    }
    await Promise.all(
      [...sceneImages.values()].flatMap((refs) => [...refs].map(file)),
    );
  }
  return {
    versions,
    mediaFiles,
    canonicalMedia,
    references: paths,
    sceneImages,
  };
}

/** A null id covers every authored byte outside addressable clip elements. */
export async function clipVersions(project: Project, composition: string) {
  return (await compositionVersions(project, composition)).versions;
}
