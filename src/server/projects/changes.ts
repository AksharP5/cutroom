import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { TimelineError } from "../../shared/timeline/apply";
import type { Project } from "../../shared/project";
import { fileFingerprint, localMediaPath } from "../../shared/media";
import { compositionScope, parseComposition } from "../timeline/composition";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import { isMissing, projectPath, readSource } from "./store";
import { HttpError } from "../../shared/errors";

export type ClipVersions = Map<string | null, string>;
export const missingSignature = "v3:missing";
const signature = (content: string) =>
  `v3:${createHash("sha256").update(content).digest("hex")}`;

type SourceVersions = {
  source: string;
  versions: ClipVersions;
  references: Map<string | null, Set<string>>;
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
    if (!value.trim() || value.startsWith("#")) return;
    const path = localMediaPath(composition, value.trim());
    if (path === null || path === "." || path.startsWith("..")) return;
    let paths = media.get(id);
    if (!paths) media.set(id, (paths = new Set()));
    paths.add(path);
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
  const result = { source, versions, references: media };
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
  project: Project,
  composition: string,
) {
  const source = await readSource(project, composition);
  const parsed = sourceVersions(
    source.content,
    composition,
    `${project.path}/${composition}`,
  );
  const paths = new Map(
    [...parsed.references].map(([id, refs]) => [id, new Set(refs)]),
  );
  const shared = paths.get(null) ?? new Set<string>();
  paths.set(null, shared);
  const files = new Map<
    string,
    Promise<{ fingerprint: string; content?: string }>
  >();
  const file = (path: string) => {
    let pending = files.get(path);
    if (!pending) {
      pending = (async () => {
        try {
          const absolute = await projectPath(project, path);
          const info = await stat(absolute);
          return {
            fingerprint: fileFingerprint(
              relative(project.path, absolute).replaceAll("\\", "/"),
              info,
            ),
            ...(/\.(?:css|[cm]?[jt]sx?)$/i.test(path) &&
            info.isFile() &&
            info.size <= 10 * 1024 * 1024
              ? { content: await readFile(absolute, "utf8") }
              : {}),
          };
        } catch (error) {
          if (
            isMissing(error) ||
            (error instanceof HttpError && [403, 404].includes(error.status))
          )
            return { fingerprint: JSON.stringify([path, "missing"]) };
          throw error;
        }
      })();
      files.set(path, pending);
    }
    return pending;
  };
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
      const resolved = localMediaPath(path, url);
      if (!resolved || resolved.startsWith("..") || shared.has(resolved))
        continue;
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
  return { versions, mediaFiles, references: paths };
}

/** A null id covers every authored byte outside addressable clip elements. */
export async function clipVersions(project: Project, composition: string) {
  return (await compositionVersions(project, composition)).versions;
}
