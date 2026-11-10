import { createHash } from "node:crypto";
import { TimelineError } from "../../shared/timeline/apply";
import type { Project } from "../../shared/project";
import { compositionScope, parseComposition } from "../timeline/composition";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import { readSource } from "./store";
import type { ProjectStore } from "./store";

/** Stable clip ids and their authored content, including shared styles and animation. */
export async function clipVersions(
  store: ProjectStore,
  project: Project,
  composition: string,
) {
  const [source, document] = await Promise.all([
    readSource(project, composition),
    store.document(project),
  ]);
  try {
    const parsed = parseComposition(
      source.content,
      document.timelines[composition] ?? emptyTimelineSettings(),
      { scope: compositionScope(composition) },
    );
    const shared = createHash("sha256")
      .update(JSON.stringify(parsed.scriptsAndStyles))
      .digest("hex");
    return new Map(
      parsed.timeline.clips
        .filter((clip) => !parsed.anonymous.has(clip.id))
        .map((clip) => {
          const element = parsed.elements.get(clip.id)!;
          const { sourceDuration: _, hasAudio: _audio, ...authored } = clip;
          // HyperFrames stamps editor identity onto untouched nodes during script cuts.
          const html = source.content
            .slice(element.start, element.end)
            .replace(/\sdata-hf-id="[^"]*"/g, "");
          const signature = createHash("sha256")
            .update(JSON.stringify([authored, html, shared]))
            .digest("hex");
          return [clip.id, signature];
        }),
    );
  } catch (error) {
    // Source editing may temporarily leave a document the timeline cannot project.
    if (error instanceof TimelineError) return new Map<string, string>();
    throw error;
  }
}
