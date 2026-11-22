import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  checkSubCompositionUsability,
  parseHTMLContent,
  planCompositionAssembly,
  resolvePreviewCompositionSrc,
} from "@hyperframes/core/compiler";
import { resolveSubCompositionContent } from "@hyperframes/parsers/sub-composition-validity";
import { readProjectFile } from "@hyperframes/parsers/asset-resolution";
import {
  decodeAuthoredAttribute,
  encodeUrlPath,
  scanHtmlOpeningTags,
} from "@hyperframes/parsers";
import { parseDeclarations } from "../../shared/variables.ts";
import { isTimelinePath } from "../../shared/sourcePaths.ts";
import { rootHtmlFiles } from "./path.ts";

/** Both compilers read the document defaults, then the root selected by the mount. */
export function mountedSceneVariables(html: string, compositionId: string) {
  const document = parseHTMLContent(html);
  const { contentHtml, hasTemplate } = resolveSubCompositionContent(
    html,
    document,
  );
  const { variableDefaultCarriers } = planCompositionAssembly({
    contentNode: parseHTMLContent(contentHtml),
    documentElement: document.documentElement,
    hasTemplate,
    compositionId,
  });
  const byId = new Map<string, ReturnType<typeof parseDeclarations>>();
  for (const carrier of variableDefaultCarriers) {
    const entries = new Map<string, ReturnType<typeof parseDeclarations>>();
    for (const variable of parseDeclarations(
      carrier.getAttribute("data-composition-variables") ?? undefined,
    )) {
      const matches = entries.get(variable.id);
      if (matches) matches.push(variable);
      else entries.set(variable.id, [variable]);
    }
    for (const [id, matches] of entries) byId.set(id, matches);
  }
  return {
    declarations: [...byId.values()].flatMap((matches) => matches.slice(-1)),
    matches: (id: string) => byId.get(id) ?? [],
  };
}

export function sceneMountId(id: string | undefined, original?: string) {
  return id?.trim() ? (original || id).trim() : "";
}

/** Cache each physical scene and root selection for one operation. */
export function sceneSources(projectDir: string) {
  const cache = new Map<string, ReturnType<typeof readScene>>();
  function readScene(file: string, id: string) {
    const source = readProjectFile(file);
    if (
      source.kind !== "file" ||
      !checkSubCompositionUsability(source.text, parseHTMLContent).ok
    )
      return;
    return { html: source.text, ...mountedSceneVariables(source.text, id) };
  }
  return (owner: string, src: string, id: string) => {
    if (!id) return;
    const selected = resolvePreviewCompositionSrc(projectDir, owner, src);
    if (!selected || !/\.html?$/i.test(selected.file)) return;
    const key = JSON.stringify([selected.file, id]);
    if (!cache.has(key)) cache.set(key, readScene(selected.file, id));
    const scene = cache.get(key);
    if (scene)
      return {
        ...scene,
        path: relative(projectDir, selected.file).split(sep).join("/"),
        renderable: selected.renderable,
      };
  };
}

/** Studio's standalone preview loads its children from the project URL in the browser. */
export function rebasePreviewSceneSources(
  html: string,
  projectDir: string,
  owner: string,
) {
  if (!html.includes("data-composition-src")) return html;
  const parts: string[] = [];
  let end = 0;
  for (const { attributes } of scanHtmlOpeningTags(html)) {
    const attr = attributes.find(({ name }) => name === "data-composition-src");
    if (attr?.kind !== "value") continue;
    const src = decodeAuthoredAttribute(attr.value);
    const selected = resolvePreviewCompositionSrc(projectDir, owner, src);
    if (!selected || !existsSync(selected.file)) continue;
    const path = encodeUrlPath(
      relative(projectDir, selected.file).split(sep).join("/"),
    );
    if (path === src) continue;
    parts.push(html.slice(end, attr.valueStart), path);
    end = attr.valueEnd;
  }
  return end ? parts.join("") + html.slice(end) : html;
}

// Each file's own mounts, kept while its size and modification time stay the same.
const mountsByFile = new Map<
  string,
  { mtimeMs: number; size: number; mounts: string[] }
>();

/** The project files `path` mounts directly, through `data-composition-src`. */
async function directMounts(projectDir: string, path: string) {
  const absolute = join(projectDir, path);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) return [];
  const known = mountsByFile.get(absolute);
  if (known?.mtimeMs === info.mtimeMs && known.size === info.size)
    return known.mounts;
  const html = await readFile(absolute, "utf8").catch(() => "");
  const mounts: string[] = [];
  if (html.includes("data-composition-src"))
    for (const { attributes } of scanHtmlOpeningTags(html)) {
      const attr = attributes.find(
        ({ name }) => name === "data-composition-src",
      );
      if (attr?.kind !== "value") continue;
      const selected = resolvePreviewCompositionSrc(
        projectDir,
        path,
        decodeAuthoredAttribute(attr.value),
      );
      if (selected)
        mounts.push(relative(projectDir, selected.file).split(sep).join("/"));
    }
  mountsByFile.set(absolute, {
    mtimeMs: info.mtimeMs,
    size: info.size,
    mounts,
  });
  return mounts;
}

/** The compositions `composition` plays, itself included, through its scenes and theirs. */
export async function playedCompositions(
  projectDir: string,
  composition: string,
) {
  const played = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    if (played.has(path)) return;
    played.add(path);
    for (const mounted of await directMounts(projectDir, path))
      await visit(mounted);
  };
  await visit(composition);
  return played;
}

/**
 * The compositions a change to `path` shows in, from what HyperFrames reports, which follows
 * mounts from index.html only: every other timeline that plays it is added. A timeline it does
 * not reach is one nothing mounts, so a change to it affects only itself. Null means any.
 */
export async function affectedCompositions(
  projectDir: string,
  path: string,
  fromIndex: readonly string[] | null,
) {
  if (fromIndex === null) return isTimelinePath(path) ? [path] : null;
  const others = (await rootHtmlFiles({ path: projectDir })).filter(
    (timeline) => timeline !== "index.html" && !fromIndex.includes(timeline),
  );
  const playing = await Promise.all(
    others.map(async (timeline) =>
      (await playedCompositions(projectDir, timeline)).has(path)
        ? [timeline]
        : [],
    ),
  );
  return [...fromIndex, ...playing.flat()];
}
