import { lstat } from "node:fs/promises";
import { freezeExportPath } from "../../shared/media";
import type { Project } from "../../shared/project";
import { HttpError } from "../../shared/errors";
import { isMissing, projectStatePath } from "./path";

export async function freezeCompanion(project: Project, preview: string) {
  const path = freezeExportPath(preview);
  if (!path) return;
  const absolute = await projectStatePath(project, path, true);
  const info = await lstat(absolute).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
  if (!info) return;
  if (!info.isFile())
    throw new HttpError(409, "The freeze frame's export path must be a file.");
  return { path, absolute };
}
