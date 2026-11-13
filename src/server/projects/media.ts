import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, normalize, relative } from "node:path";
import { parseSourceDocument } from "@hyperframes/studio-server";
import { localMediaPath } from "../../shared/media";
import type { MediaClip, Project } from "../../shared/project";
import { ProjectDocumentSchema } from "../../shared/project";
import { projectPath, readSource } from "./store";

/** Every HTML file in the project, as project-relative paths. Hidden and vendored folders are skipped. */
export async function compositionFiles(project: Project): Promise<string[]> {
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
  return sources;
}

export async function listMedia(project: Project): Promise<MediaClip[]> {
  const sources = await compositionFiles(project);
  const media: MediaClip[] = [];
  let metadata: ReturnType<typeof ProjectDocumentSchema.parse> | undefined;
  for (const sourceFile of sources) {
    const source = await readSource(project, sourceFile);
    const { document } = parseSourceDocument(source.content);
    const elements = [...document.querySelectorAll("video, audio")];
    const groups = new Map<string, Element[]>();
    for (const element of elements) {
      const id = element.getAttribute("data-cutroom-transcript");
      if (!id) continue;
      const group = groups.get(id) ?? [];
      group.push(element);
      groups.set(id, group);
    }
    const displayedTranscripts = new Set(
      elements
        .filter((element) => !element.id.includes("-cut-"))
        .map((element) => element.getAttribute("data-cutroom-transcript")),
    );
    const missing = [
      ...document.querySelectorAll("template[data-cutroom-anchor]"),
    ].filter(
      (anchor) =>
        !displayedTranscripts.has(anchor.getAttribute("data-cutroom-anchor")),
    );
    if (missing.length) {
      metadata ??= ProjectDocumentSchema.parse(
        JSON.parse(
          await readFile(await projectPath(project, "cutroom.json"), "utf8"),
        ),
      );
      for (const anchor of missing) {
        const transcript = metadata.transcripts.find(
          (item) =>
            item.id === anchor.getAttribute("data-cutroom-anchor") &&
            normalize(item.sourceFile) === normalize(sourceFile),
        );
        if (!transcript) continue;
        const original = parseSourceDocument(
          transcript.original.html,
        ).document.querySelector("video, audio");
        if (!original) continue;
        const pieces = groups.get(transcript.id) ?? [];
        const start = pieces.length
          ? Math.min(
              ...pieces.map((element) =>
                Number(element.getAttribute("data-start") ?? 0),
              ),
            )
          : Number(
              anchor.getAttribute("data-cutroom-start") ??
                transcript.original.start,
            );
        const duration = pieces.reduce(
          (sum, element) =>
            sum + Number(element.getAttribute("data-duration") ?? 0),
          0,
        );
        original.setAttribute("id", transcript.elementId);
        original.setAttribute("data-start", String(start));
        original.setAttribute("data-duration", String(duration));
        original.removeAttribute("data-cutroom-transcript");
        elements.push(original);
      }
    }
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
      const mediaPath = src && localMediaPath(sourceFile, src);
      if (!mediaPath) continue;
      const exists = await projectPath(project, mediaPath).then(
        () => true,
        () => false,
      );
      if (!exists) continue;
      const group = groups.get(
        element.getAttribute("data-cutroom-transcript") ?? "",
      );
      const start = group
        ? Math.min(
            ...group.map((piece) =>
              Number(piece.getAttribute("data-start") ?? 0),
            ),
          )
        : Number(element.getAttribute("data-start") ?? "0");
      const duration = group
        ? group.reduce(
            (sum, piece) =>
              sum + Number(piece.getAttribute("data-duration") ?? 0),
            0,
          )
        : Number(element.getAttribute("data-duration") ?? "0");
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
