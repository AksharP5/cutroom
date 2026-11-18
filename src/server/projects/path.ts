import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Project } from "../../shared/project.ts";
import { HttpError } from "../../shared/errors.ts";
import { protectedPath } from "../../shared/sourcePaths.ts";

export async function resolveProjectPath(
  project: Pick<Project, "path">,
  path: string,
  allowMissing = false,
): Promise<{ absolute: string; path: string }> {
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
  return { absolute: canonical, path: canonicalRelative.split(sep).join("/") };
}

export async function projectPath(
  project: Pick<Project, "path">,
  path: string,
  allowMissing = false,
) {
  return (await resolveProjectPath(project, path, allowMissing)).absolute;
}

/** Find a local asset's owned path without changing the authored URL that references it. */
export async function canonicalAssetPath(project: Project, path: string) {
  try {
    return (await resolveProjectPath(project, path)).path;
  } catch (error) {
    if (error instanceof HttpError && [403, 404].includes(error.status))
      return null;
    throw error;
  }
}

/** User-controlled writes can change composition content, never native tooling or permissions. */
export async function projectWritePath(
  project: Pick<Project, "path">,
  path: string,
  options: { allowMissing?: boolean; sourceOnly?: boolean } = {},
) {
  const check = (path: string) => {
    if (protectedPath(path, options.sourceOnly !== false))
      throw new HttpError(
        403,
        "Edit HTML, CSS, JavaScript, TypeScript, SVG, or JSON source. Hidden files, instructions, and tool configuration are protected.",
      );
  };
  check(path);
  const resolved = await resolveProjectPath(
    project,
    path,
    options.allowMissing,
  );
  check(resolved.path);
  return resolved.absolute;
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

/** An optional dependency that cannot name a file inside the project. */
export function unavailableProjectFile(error: unknown): boolean {
  return (
    isMissing(error) ||
    (error instanceof Error && "code" in error && error.code === "ENOTDIR") ||
    (error instanceof HttpError && [403, 404].includes(error.status))
  );
}
