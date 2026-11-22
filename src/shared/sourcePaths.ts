// HyperFrames' authored text types, plus the editor's .htm alias.
export const projectSourceTypes = new Set([
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

/**
 * Whether a project-relative path is closed to user-directed writes: hidden segments, native
 * tooling and instruction files, and (unless `sourceOnly` is false) anything but authored source.
 * The server's `projectWritePath` enforces it; the editor reads it to tell source from assets.
 */
export function protectedPath(path: string, sourceOnly = true) {
  const parts = path.replaceAll("\\", "/").split("/");
  const name = parts.at(-1)?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return (
    parts.some((part) => part !== "." && part.startsWith(".")) ||
    configNames.has(name) ||
    /^(?:claude|agents?|gemini|skill|instructions)(?:\.[^.]+)*\.(?:md|markdown)$/.test(
      name,
    ) ||
    /^(?:tsconfig|jsconfig)(?:\..+)?\.json$/.test(name) ||
    /(?:^|\.)config\.(?:[cm]?[jt]s|jsx|tsx|json)$/.test(name) ||
    (sourceOnly && !projectSourceTypes.has(dot > 0 ? name.slice(dot) : ""))
  );
}

/** A timeline is an HTML composition at the project root; files in folders are its scenes. */
export const isTimelinePath = (path: string) => /^[^/\\]+\.html?$/i.test(path);
