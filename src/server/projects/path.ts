import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Project } from "../../shared/project.ts";
import { HttpError } from "../../shared/errors.ts";

export async function projectPath(
  project: Pick<Project, "path">,
  path: string,
  allowMissing = false,
): Promise<string> {
  if (!path || isAbsolute(path) || path.includes("\0"))
    throw new HttpError(400, "Use a project-relative file path.");
  const target = resolve(project.path, path);
  const rel = relative(project.path, target);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
    throw new HttpError(403, "That path is outside the project.");
  const canonical = await realpath(target).catch(async (error: unknown) => {
    if (!isMissing(error)) throw error;
    // dirname(".") cannot make progress once the project folder itself is gone.
    if (!allowMissing || rel === "")
      throw new HttpError(404, "Project file not found.");
    return join(
      await projectPath(project, dirname(path), true),
      basename(target),
    );
  });
  const canonicalRoot = await realpath(project.path);
  const canonicalRelative = relative(canonicalRoot, canonical);
  if (
    canonicalRelative.startsWith(`..${sep}`) ||
    canonicalRelative === ".." ||
    isAbsolute(canonicalRelative)
  ) {
    throw new HttpError(403, "Links outside the project cannot be accessed.");
  }
  return canonical;
}

// HyperFrames' authored text types, plus the editor's .htm alias.
const sourceTypes = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".svg",
]);
const configNames = new Set([
  "package.json",
  "package-lock.json",
  "deno.json",
  "deno.jsonc",
  "mcp.json",
  "claude.json",
  "codex.json",
  "opencode.json",
  "opencode.jsonc",
  "agents.json",
]);

/** User-controlled writes can change composition content, never native tooling or permissions. */
export async function projectWritePath(
  project: Pick<Project, "path">,
  path: string,
  options: { allowMissing?: boolean; sourceOnly?: boolean } = {},
) {
  const check = (path: string) => {
    const parts = path.replaceAll("\\", "/").split("/");
    const name = parts.at(-1)?.toLowerCase() ?? "";
    if (
      parts.some((part) => part !== "." && part.startsWith(".")) ||
      configNames.has(name) ||
      /^(?:claude|agents?|gemini|skill|instructions)(?:\.[^.]+)*\.(?:md|markdown)$/.test(
        name,
      ) ||
      /^(?:tsconfig|jsconfig)(?:\..+)?\.json$/.test(name) ||
      /(?:^|\.)config\.(?:[cm]?[jt]s|jsx|tsx|json)$/.test(name) ||
      (options.sourceOnly !== false && !sourceTypes.has(extname(name)))
    )
      throw new HttpError(
        403,
        "Edit HTML, CSS, JavaScript, TypeScript, SVG, or JSON source. Hidden files, instructions, and tool configuration are protected.",
      );
  };
  check(path);
  const absolute = await projectPath(project, path, options.allowMissing);
  check(relative(await realpath(project.path), absolute));
  return absolute;
}

/** App-owned sidecars must stay at their reserved paths, without redirected write targets. */
export async function projectStatePath(
  project: Pick<Project, "path">,
  path: string,
  allowMissing = false,
) {
  const absolute = await projectPath(project, path, allowMissing);
  if (
    relative(await realpath(project.path), absolute) !==
    relative(project.path, resolve(project.path, path))
  )
    throw new HttpError(
      403,
      "App state cannot be linked to another file or folder.",
    );
  return absolute;
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
