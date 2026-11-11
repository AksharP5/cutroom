import { createHash } from "node:crypto";
import { TimelineError } from "../../shared/timeline/apply";
import type { Project } from "../../shared/project";
import { compositionScope, parseComposition } from "../timeline/composition";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import { readSource } from "./store";

/** Stable clip ids and their authored content, including shared styles and animation. */
export async function clipVersions(project: Project, composition: string) {
  const source = await readSource(project, composition);
  return sourceClipVersions(source.content, composition);
}

/** Clip signatures depend on authored HTML, not the sidecar's tracks, markers or range. */
export function sourceClipVersions(source: string, composition: string) {
  try {
    const parsed = parseComposition(source, emptyTimelineSettings(), {
      scope: compositionScope(composition),
    });
    const shared = createHash("sha256")
      .update(JSON.stringify(parsed.scriptsAndStyles))
      .digest("hex");
    return new Map(
      parsed.timeline.clips
        .filter((clip) => !parsed.anonymous.has(clip.id))
        .map((clip) => {
          const element = parsed.elements.get(clip.id)!;
          // These properties are already in the HTML hash. Keep persisted #30 signatures unchanged.
          const {
            sourceDuration: _,
            hasAudio: _audio,
            opacity: _opacity,
            x: _x,
            y: _y,
            fadeIn: _fadeIn,
            fadeOut: _fadeOut,
            automation: _automation,
            ...authored
          } = clip;
          // HyperFrames stamps editor identity onto untouched nodes during script cuts.
          const html = source
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
