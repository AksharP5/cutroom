import { createHash } from "node:crypto";
import { TimelineError } from "../../shared/timeline/apply";
import type { Project } from "../../shared/project";
import { compositionScope, parseComposition } from "../timeline/composition";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import { readSource } from "./store";

export type ClipVersions = Map<string | null, string>;
export const missingSignature = "v3:missing";
const signature = (content: string) =>
  `v3:${createHash("sha256").update(content).digest("hex")}`;

/** A null id covers every byte outside addressable clip elements, once per file. */
export async function clipVersions(project: Project, composition: string) {
  const source = await readSource(project, composition);
  return sourceClipVersions(
    source.content,
    composition,
    `${project.path}/${composition}`,
  );
}

// Reads dominate edits. Retain only the latest result for eight compositions.
const cache = new Map<string, { source: string; versions: ClipVersions }>();

export function sourceClipVersions(
  source: string,
  composition: string,
  cacheKey = composition,
): ClipVersions {
  const previous = cache.get(cacheKey);
  if (previous?.source === source) return previous.versions;
  const versions: ClipVersions = new Map();
  try {
    const parsed = parseComposition(source, emptyTimelineSettings(), {
      scope: compositionScope(composition),
    });
    const clips = parsed.timeline.clips
      .filter((clip) => !parsed.anonymous.has(clip.id))
      .map((clip) => ({ id: clip.id, element: parsed.elements.get(clip.id)! }))
      .sort((a, b) => a.element.start - b.element.start);
    const rest: (string | [string])[] = [];
    let end = 0;
    for (const { id, element } of clips) {
      versions.set(id, signature(source.slice(element.start, element.end)));
      rest.push(source.slice(end, element.start), [id]);
      end = element.end;
    }
    rest.push(source.slice(end));
    // Placeholders preserve ordering and insertion/deletion even for adjacent elements.
    versions.set(null, signature(JSON.stringify(rest)));
  } catch (error) {
    if (!(error instanceof TimelineError)) throw error;
    // Unprojectable source still has a composition row; an edit must never disappear.
    versions.set(null, signature(source));
  }
  cache.delete(cacheKey);
  cache.set(cacheKey, { source, versions });
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return versions;
}
