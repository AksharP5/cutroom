import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { CSS_URL_RE, decodeCssEscapes } from "@hyperframes/parsers/asset-paths";
import { isProjectIgnoredDir } from "@hyperframes/core/project-folders";
import { localMediaPath } from "../../shared/media";
import type { Project } from "../../shared/project";
import { HttpError } from "../../shared/errors";
import { projectSourceTypes } from "../../shared/sourcePaths";
import { isMissing, projectWritePath, rootHtmlFiles } from "./path";

function sourceReferences(source: string, path: string): string[] {
  const quoted = (text: string) =>
    [...text.matchAll(/(["'`])([^"'`\r\n]+)\1/g)].map((match) => match[2]!);
  const css = (text: string) =>
    [...text.matchAll(CSS_URL_RE)].map((match) => decodeCssEscapes(match[2]!));
  if (!/\.(?:html?|svg)$/i.test(path))
    return [...quoted(source), ...css(source)];
  const references: string[] = [];
  const visit = (nodes: DefaultTreeAdapterTypes.ChildNode[]) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      for (const attr of node.attrs) {
        if (
          [
            "src",
            "href",
            "xlink:href",
            "data-composition-src",
            "data",
          ].includes(attr.name)
        )
          references.push(attr.value);
        if (attr.name === "style") references.push(...css(attr.value));
      }
      if (node.tagName === "script" || node.tagName === "style") {
        const text = node.childNodes
          .filter((child) => child.nodeName === "#text")
          .map((child) => ("value" in child ? child.value : ""))
          .join("");
        references.push(...quoted(text), ...css(text));
      }
      visit(node.childNodes);
      if ("content" in node) visit(node.content.childNodes);
    }
  };
  visit(parse(source).childNodes);
  return references;
}

// Home lists every project; an unchanged file's references are not parsed again.
const parsed = new Map<
  string,
  { mtimeMs: number; size: number; references: string[]; composition: boolean }
>();

/** Follow authoring dependencies, never directory listings or media bytes. */
export async function projectEditedAt(project: Project) {
  const visited = new Set<string>();
  let newest: number | undefined;
  /** With `timelines`, a starting file counts only when it is a composition. */
  const follow = async (pending: Set<string>, timelines = false) => {
    const starts = new Set(pending);
    for (const path of pending) {
      if (path.split("/").some(isProjectIgnoredDir)) continue;
      try {
        const absolute = await projectWritePath(project, path);
        if (visited.has(absolute)) continue;
        visited.add(absolute);
        const info = await stat(absolute);
        if (!info.isFile()) continue;
        if (info.size > 10 * 1024 * 1024) {
          if (!timelines) newest = Math.max(newest ?? -Infinity, info.mtimeMs);
          continue;
        }
        const cached = parsed.get(absolute);
        const read =
          cached?.mtimeMs === info.mtimeMs && cached.size === info.size
            ? cached
            : await readFile(absolute, "utf8").then((source) => ({
                mtimeMs: info.mtimeMs,
                size: info.size,
                references: sourceReferences(source, path),
                composition: /data-composition-id\s*=/.test(source),
              }));
        parsed.set(absolute, read);
        if (timelines && starts.has(path) && !read.composition) continue;
        newest = Math.max(newest ?? -Infinity, info.mtimeMs);
        for (const url of read.references) {
          const linked = localMediaPath(path, url.trim());
          if (!linked || !projectSourceTypes.has(extname(linked).toLowerCase()))
            continue;
          // HyperFrames uses an existing sibling first, then a project-root asset.
          const rooted = localMediaPath("index.html", url.trim());
          if (rooted && linked !== rooted) {
            try {
              await projectWritePath(project, linked);
            } catch (error) {
              if (error instanceof HttpError && error.status === 404) {
                pending.add(rooted);
                continue;
              }
              if (error instanceof HttpError && error.status === 403) continue;
              throw error;
            }
          }
          pending.add(linked);
        }
      } catch (error) {
        if (
          isMissing(error) ||
          (error instanceof HttpError && [403, 404].includes(error.status))
        )
          continue;
        throw error;
      }
    }
  };
  await follow(new Set(["index.html", "cutroom.json"]));
  // Then every other timeline, a composition at the root, and what it links.
  await follow(
    new Set(await rootHtmlFiles(project).catch((): string[] => [])),
    true,
  );
  return newest === undefined
    ? project.updatedAt
    : new Date(newest).toISOString();
}
