import { isApplicationUrl } from "./runtime";

/** Microphone access belongs to the editor's main frame, never camera or composition content. */
export function desktopPermission(
  permission: string,
  url: string,
  baseUrl: string,
  mainFrame: boolean,
  mediaTypes: readonly string[] = [],
) {
  if (!isApplicationUrl(url, baseUrl)) return false;
  if (permission === "fullscreen") return true;
  if (!mainFrame) return false;
  if (permission === "clipboard-sanitized-write") return true;
  return (
    permission === "media" &&
    mediaTypes.length > 0 &&
    mediaTypes.every((type) => type === "audio")
  );
}
