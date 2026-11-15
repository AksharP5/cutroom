import { statSync } from "node:fs";
import { join, sep } from "node:path";

const planCopy = `${sep}${join(".plan-work", "compiled")}${sep}`;

/**
 * The path a marked export's extracted frames are cached under. The plan copies the project to a
 * per-export folder, which would give every export new cache keys; the project's own file keeps
 * them stable. It is used only while it is still the file that was copied.
 */
export function frameCacheSource(path: string, projectDir: string) {
  const at = path.lastIndexOf(planCopy);
  if (at === -1) return path;
  const original = join(projectDir, path.slice(at + planCopy.length));
  try {
    const copy = statSync(path);
    const source = statSync(original);
    return source.size === copy.size && source.mtimeMs <= copy.mtimeMs
      ? original
      : path;
  } catch {
    // Media the plan downloaded has no project file; its copy keeps the per-export key.
    return path;
  }
}
