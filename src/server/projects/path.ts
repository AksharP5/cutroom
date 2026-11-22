import { readFile, readdir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Project } from "../../shared/project.ts";
import { HttpError } from "../../shared/errors.ts";
import { isTimelinePath, protectedPath } from "../../shared/sourcePaths.ts";

/** Leading slashes, dot segments, and Windows separators all name files within the project. */
export function canonicalProjectPath(path: string) {
  return posix.normalize(path.replaceAll("\\", "/")).replace(/^\/+/, "");
}

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

/** HTML files at the project root, index.html first: the files that can be timelines. */
export async function rootHtmlFiles(project: Pick<Project, "path">) {
  const entries = await readdir(project.path, { withFileTypes: true });
  return entries
    .flatMap((entry) =>
      entry.isFile() && isTimelinePath(entry.name) ? [entry.name] : [],
    )
    .sort((a, b) =>
      a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b),
    );
}

/** The project's timelines: the compositions at its root, index.html first. */
export async function listTimelines(project: Pick<Project, "path">) {
  const files = await rootHtmlFiles(project);
  const compositions = await Promise.all(
    files.map((file) =>
      readFile(join(project.path, file), "utf8").then(
        (html) => /data-composition-id\s*=/.test(html),
        () => false,
      ),
    ),
  );
  return files.filter((_, index) => compositions[index]);
}
