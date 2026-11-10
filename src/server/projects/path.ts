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
    if (!allowMissing) throw new HttpError(404, "Project file not found.");
    return join(await realpath(dirname(target)), basename(target));
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

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
