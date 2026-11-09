import { readdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { parseSourceDocument } from "@hyperframes/studio-server";
import type { MediaClip, Project } from "../../shared/project";
import { projectPath, readSource } from "./store";

export async function listMedia(project: Project): Promise<MediaClip[]> {
  const sources: string[] = [];
  const ignored = new Set(["node_modules", "dist", "build"]);
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".html")
        sources.push(relative(project.path, path));
      if (sources.length > 1000) return;
    }
  };
  await walk(project.path);
  const media: MediaClip[] = [];
  for (const sourceFile of sources) {
    const source = await readSource(project, sourceFile);
    const { document } = parseSourceDocument(source.content);
    const elements = [...document.querySelectorAll("video, audio")];
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index]!;
      if (
        element.hasAttribute("data-cutroom-transcript") &&
        element.id.includes("-cut-")
      )
        continue;
      const src =
        element.getAttribute("src") ??
        element.querySelector("source")?.getAttribute("src");
      if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//"))
        continue;
      const mediaPath = join(
        dirname(sourceFile),
        decodeURIComponent(src.split(/[?#]/, 1)[0]!),
      );
      const exists = await projectPath(project, mediaPath).then(
        () => true,
        () => false,
      );
      if (!exists) continue;
      const start = Number(element.getAttribute("data-start") ?? "0");
      const duration = Number(element.getAttribute("data-duration") ?? "0");
      media.push({
        elementId: element.id || `media:${index}`,
        mediaPath,
        sourceFile,
        label: element.getAttribute("aria-label") ?? basename(mediaPath),
        kind: element.tagName.toUpperCase() === "VIDEO" ? "video" : "audio",
        start: Number.isFinite(start) ? start : 0,
        duration: Number.isFinite(duration) ? duration : 0,
      });
    }
  }
  return media;
}
